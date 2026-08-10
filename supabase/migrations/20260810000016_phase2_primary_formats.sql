-- Migration 16: Phase 2 two-person best-ball + skins field-trial workflow.
--
-- One draft transaction creates the frozen team roster, tee groups, and six
-- simultaneous competitions. All competitions consume the same individual
-- hole scores; their own rules_json supplies the handicap allowance.

alter table public.event_teams
  add column if not exists snapshot_hash text;

comment on column public.event_teams.snapshot_hash is
  'SHA-256 of the ordered frozen team roster and member entry snapshot hashes.';

create or replace function public.save_phase2_event_draft(
  p_actor uuid,
  p_event_id uuid,
  p_league_id uuid,
  p_season_id uuid,
  p_name text,
  p_timezone text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_visibility public.event_visibility,
  p_tee_set_id uuid,
  p_participant_ids uuid[],
  p_scorer_profile_ids uuid[] default '{}',
  p_competition_preset text default 'individual_gross',
  p_teams jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base jsonb;
  v_event_id uuid;
  v_round_id uuid;
  v_hole_count integer;
  v_team jsonb;
  v_team_id uuid;
  v_team_ids uuid[] := '{}';
  v_member_ids uuid[];
  v_assigned_ids uuid[] := '{}';
  v_group_id uuid;
  v_group_number integer := 0;
  v_team_index integer;
  v_competition_id uuid;
  v_competition_ids uuid[] := '{}';
  v_definition jsonb;
  v_definitions jsonb[];
  v_common jsonb;
  v_none_handicap jsonb;
  v_full_handicap jsonb;
  v_fourball_handicap jsonb;
begin
  if p_competition_preset not in ('individual_gross', 'two_person_throwdown') then
    raise exception 'unsupported competition preset' using errcode = '23514';
  end if;
  if jsonb_typeof(coalesce(p_teams, '[]'::jsonb)) <> 'array' then
    raise exception 'teams must be an array' using errcode = '23514';
  end if;
  if p_competition_preset = 'two_person_throwdown'
     and (
       cardinality(p_participant_ids) < 4
       or cardinality(p_participant_ids) % 4 <> 0
       or jsonb_array_length(p_teams) % 2 <> 0
     ) then
    raise exception 'two-person throwdowns require two teams (four players) in every group'
      using errcode = '23514';
  end if;

  v_base := public.save_phase1_event_draft(
    p_actor, p_event_id, p_league_id, p_season_id, p_name, p_timezone,
    p_starts_at, p_ends_at, p_visibility, p_tee_set_id,
    p_participant_ids, p_scorer_profile_ids
  );
  v_event_id := (v_base ->> 'eventId')::uuid;
  v_round_id := (v_base ->> 'roundId')::uuid;

  if p_competition_preset = 'individual_gross' then
    if jsonb_array_length(coalesce(p_teams, '[]'::jsonb)) <> 0 then
      raise exception 'individual gross events cannot include teams' using errcode = '23514';
    end if;
    return v_base || jsonb_build_object(
      'competitionIds', jsonb_build_array(v_base ->> 'competitionId'),
      'competitionPreset', p_competition_preset
    );
  end if;

  if exists (
    select 1 from public.event_entries
    where event_id = v_event_id and handicap_source = 'scratch_fallback'
  ) then
    raise exception 'net competitions require a current handicap for every selected player'
      using errcode = '23514';
  end if;

  if jsonb_array_length(p_teams) < 2 then
    raise exception 'two-person throwdowns require at least two teams'
      using errcode = '23514';
  end if;

  for v_team in select value from jsonb_array_elements(p_teams) loop
    if nullif(trim(v_team ->> 'name'), '') is null then
      raise exception 'team names are required' using errcode = '23514';
    end if;
    select array_agg(value::uuid order by ordinality)
      into v_member_ids
    from jsonb_array_elements_text(v_team -> 'participantIds')
      with ordinality as members(value, ordinality);
    if cardinality(v_member_ids) <> 2 or v_member_ids[1] = v_member_ids[2] then
      raise exception 'each team requires two different participants'
        using errcode = '23514';
    end if;
    if exists (
      select 1 from unnest(v_member_ids) member_id
      where not member_id = any(p_participant_ids)
    ) then
      raise exception 'team member is not selected for the event' using errcode = '23514';
    end if;
    v_assigned_ids := v_assigned_ids || v_member_ids;
  end loop;

  if cardinality(v_assigned_ids) <> cardinality(p_participant_ids)
     or cardinality(v_assigned_ids) <> (
       select count(distinct member_id) from unnest(v_assigned_ids) member_id
     ) then
    raise exception 'every selected participant must belong to exactly one team'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_teams) team
    group by lower(trim(team ->> 'name'))
    having count(*) > 1
  ) then
    raise exception 'team names must be unique' using errcode = '23514';
  end if;

  delete from public.groups where round_id = v_round_id;
  delete from public.competitions where event_id = v_event_id;
  delete from public.event_teams where event_id = v_event_id;

  for v_team in select value from jsonb_array_elements(p_teams) loop
    v_team_id := gen_random_uuid();
    v_team_ids := array_append(v_team_ids, v_team_id);
    insert into public.event_teams (id, event_id, name, status)
    values (v_team_id, v_event_id, trim(v_team ->> 'name'), 'active');

    select array_agg(value::uuid order by ordinality)
      into v_member_ids
    from jsonb_array_elements_text(v_team -> 'participantIds')
      with ordinality as members(value, ordinality);
    insert into public.event_team_members (event_team_id, event_entry_id, position)
    select v_team_id, ee.id, members.ordinality::integer
    from unnest(v_member_ids) with ordinality as members(participant_id, ordinality)
    join public.event_entries ee
      on ee.event_id = v_event_id and ee.participant_id = members.participant_id;
  end loop;

  -- Exactly two teams (four players) per tee group for the field-trial preset.
  v_team_index := 1;
  while v_team_index <= cardinality(v_team_ids) loop
    v_group_number := v_group_number + 1;
    v_group_id := gen_random_uuid();
    insert into public.groups (id, round_id, label, start_hole_ordinal, sort_order)
    values (v_group_id, v_round_id, 'Group ' || v_group_number, 1, v_group_number);

    insert into public.group_members (group_id, event_team_id, sort_order)
    select v_group_id, v_team_ids[i], i - v_team_index + 1
    from generate_series(
      v_team_index,
      least(v_team_index + 1, cardinality(v_team_ids))
    ) i;

    -- Every linked player in the group may mark every individual card in the
    -- same group. Existing self and explicitly assigned marker grants remain.
    insert into public.scoring_permissions (
      event_id, round_id, scorer_profile_id, participant_id, permission_type
    )
    select distinct v_event_id, v_round_id, scorer.profile_id,
      target.participant_id, 'marker'
    from public.group_members gm_scorer
    join public.event_team_members etm_scorer
      on etm_scorer.event_team_id = gm_scorer.event_team_id
    join public.event_entries ee_scorer on ee_scorer.id = etm_scorer.event_entry_id
    join public.participants scorer
      on scorer.id = ee_scorer.participant_id and scorer.profile_id is not null
    cross join public.group_members gm_target
    join public.event_team_members etm_target
      on etm_target.event_team_id = gm_target.event_team_id
    join public.event_entries target on target.id = etm_target.event_entry_id
    where gm_scorer.group_id = v_group_id and gm_target.group_id = v_group_id;

    v_team_index := v_team_index + 2;
  end loop;

  select hole_count into v_hole_count from public.rounds where id = v_round_id;
  v_none_handicap := jsonb_build_object(
    'profile', 'none', 'allowance', 1,
    'rounding', 'half_up_toward_positive_infinity',
    'matchNormalizeFromLowest', false, 'allocation', 'stroke_index'
  );
  v_full_handicap := jsonb_build_object(
    'profile', 'usga_whs_2024', 'allowance', 1,
    'rounding', 'half_up_toward_positive_infinity',
    'matchNormalizeFromLowest', false, 'allocation', 'stroke_index'
  );
  v_fourball_handicap := jsonb_build_object(
    'profile', 'usga_whs_2024', 'allowance', 0.85,
    'rounding', 'half_up_toward_positive_infinity',
    'matchNormalizeFromLowest', false, 'allocation', 'stroke_index'
  );
  v_common := jsonb_build_object(
    'schemaVersion', 1,
    'holeScope', (select jsonb_agg(i order by i) from generate_series(1, v_hole_count) i),
    'ties', jsonb_build_object('mode', 'tied', 'sequence', '[]'::jsonb),
    'incomplete', jsonb_build_object('live', 'provisional', 'final', 'no_return'),
    'visibility', p_visibility::text
  );

  v_definitions := array[
    jsonb_build_object(
      'name', 'Individual Gross', 'format', 'individual_stroke', 'metric', 'gross',
      'target', 'entry', 'sortOrder', 1,
      'rules', v_common || jsonb_build_object(
        'format', 'individual_stroke', 'metric', 'gross', 'handicap', v_none_handicap
      ),
      'rulesText', 'Individual gross stroke play from the shared raw scorecards.'
    ),
    jsonb_build_object(
      'name', 'Individual Net', 'format', 'individual_stroke', 'metric', 'net',
      'target', 'entry', 'sortOrder', 2,
      'rules', v_common || jsonb_build_object(
        'format', 'individual_stroke', 'metric', 'net', 'handicap', v_full_handicap
      ),
      'rulesText', 'Individual net stroke play at 100% allowance.'
    ),
    jsonb_build_object(
      'name', 'Two-Person Best Ball Gross', 'format', 'best_k', 'metric', 'gross',
      'target', 'team', 'sortOrder', 3,
      'rules', v_common || jsonb_build_object(
        'format', 'best_k', 'metric', 'gross', 'handicap', v_none_handicap,
        'team', jsonb_build_object(
          'teamSize', 2, 'bestK', 1, 'scoreSource', 'individual'
        )
      ),
      'rulesText', 'The lower gross score from the two team members counts on each hole.'
    ),
    jsonb_build_object(
      'name', 'Two-Person Best Ball Net', 'format', 'best_k', 'metric', 'net',
      'target', 'team', 'sortOrder', 4,
      'rules', v_common || jsonb_build_object(
        'format', 'best_k', 'metric', 'net', 'handicap', v_fourball_handicap,
        'team', jsonb_build_object(
          'teamSize', 2, 'bestK', 1, 'scoreSource', 'individual'
        )
      ),
      'rulesText', 'Each player receives strokes at 85%; the lower net score then counts.'
    ),
    jsonb_build_object(
      'name', 'Gross Skins', 'format', 'skins', 'metric', 'gross',
      'target', 'entry', 'sortOrder', 5,
      'rules', v_common || jsonb_build_object(
        'format', 'skins', 'metric', 'gross', 'handicap', v_none_handicap,
        'skins', jsonb_build_object(
          'population', 'field', 'carryMode', 'carry_forward',
          'unitsPerHole', 1, 'finalCarry', 'expire', 'fractionalUnits', false
        )
      ),
      'rulesText', 'Field-wide gross skins with one unit per hole and carry-forward ties.'
    ),
    jsonb_build_object(
      'name', 'Net Skins', 'format', 'skins', 'metric', 'net',
      'target', 'entry', 'sortOrder', 6,
      'rules', v_common || jsonb_build_object(
        'format', 'skins', 'metric', 'net', 'handicap', v_full_handicap,
        'skins', jsonb_build_object(
          'population', 'field', 'carryMode', 'carry_forward',
          'unitsPerHole', 1, 'finalCarry', 'expire', 'fractionalUnits', false
        )
      ),
      'rulesText', 'Field-wide net skins at 100% allowance with carry-forward ties.'
    )
  ];

  foreach v_definition in array v_definitions loop
    v_competition_id := gen_random_uuid();
    v_competition_ids := array_append(v_competition_ids, v_competition_id);
    insert into public.competitions (
      id, event_id, name, format, metric, status, rules_schema_version,
      rules_json, rules_text, engine_version, visibility, sort_order
    ) values (
      v_competition_id, v_event_id, v_definition ->> 'name',
      v_definition ->> 'format', v_definition ->> 'metric', 'draft', 1,
      v_definition -> 'rules', v_definition ->> 'rulesText', '0.1.0',
      p_visibility, (v_definition ->> 'sortOrder')::integer
    );
    insert into public.competition_rounds (competition_id, round_id, hole_scope, weight)
    values (v_competition_id, v_round_id, null, 1);

    if v_definition ->> 'target' = 'team' then
      insert into public.competition_entities (
        competition_id, event_team_id, eligibility_status
      )
      select v_competition_id, id, 'eligible'
      from public.event_teams where event_id = v_event_id and status = 'active';
    else
      insert into public.competition_entities (
        competition_id, event_entry_id, eligibility_status
      )
      select v_competition_id, id, 'eligible'
      from public.event_entries where event_id = v_event_id and status = 'active';
    end if;
  end loop;

  insert into public.audit_events (
    actor_profile_id, action, scope_league_id, scope_event_id,
    target_type, target_id, after_json
  ) values (
    p_actor, 'event.phase2_preset_saved', p_league_id, v_event_id,
    'event', v_event_id,
    jsonb_build_object(
      'preset', p_competition_preset,
      'teams', cardinality(v_team_ids),
      'competitions', cardinality(v_competition_ids)
    )
  );

  return jsonb_build_object(
    'eventId', v_event_id,
    'roundId', v_round_id,
    'competitionId', v_competition_ids[1],
    'competitionIds', to_jsonb(v_competition_ids),
    'competitionPreset', p_competition_preset,
    'status', 'draft'
  );
end;
$$;

revoke all on function public.save_phase2_event_draft(
  uuid, uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  public.event_visibility, uuid, uuid[], uuid[], text, jsonb
) from public, anon, authenticated;
grant execute on function public.save_phase2_event_draft(
  uuid, uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  public.event_visibility, uuid, uuid[], uuid[], text, jsonb
) to service_role;

create or replace function public.publish_phase2_event(
  p_actor uuid,
  p_event_id uuid,
  p_open_scoring boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if exists (select 1 from public.event_teams where event_id = p_event_id)
     and (
       (select count(*) from public.event_teams where event_id = p_event_id) < 2
       or (select count(*) from public.event_teams where event_id = p_event_id) % 2 <> 0
     ) then
    raise exception 'two-person throwdowns require two teams in every group'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.event_teams et
    where et.event_id = p_event_id
      and (
        select count(*) from public.event_team_members etm
        where etm.event_team_id = et.id
      ) <> 2
  ) then
    raise exception 'every event team must contain exactly two members'
      using errcode = '23514';
  end if;
  if exists (select 1 from public.event_teams where event_id = p_event_id)
     and exists (
       select 1 from public.event_entries
       where event_id = p_event_id and handicap_source = 'scratch_fallback'
     ) then
    raise exception 'net competitions require a current handicap for every selected player'
      using errcode = '23514';
  end if;
  if exists (select 1 from public.event_teams where event_id = p_event_id)
     and exists (
       select 1 from public.event_entries ee
       where ee.event_id = p_event_id and not exists (
         select 1
         from public.event_team_members etm
         join public.event_teams et on et.id = etm.event_team_id
         where etm.event_entry_id = ee.id and et.event_id = p_event_id
       )
     ) then
    raise exception 'every event entry must belong to a team' using errcode = '23514';
  end if;

  v_result := public.publish_phase1_event(p_actor, p_event_id, p_open_scoring);

  update public.event_teams et set
    snapshot_hash = encode(extensions.digest(convert_to(jsonb_build_object(
      'name', et.name,
      'members', (
        select jsonb_agg(jsonb_build_object(
          'position', etm.position,
          'entryId', ee.id,
          'entrySnapshotHash', ee.snapshot_hash
        ) order by etm.position, ee.id)
        from public.event_team_members etm
        join public.event_entries ee on ee.id = etm.event_entry_id
        where etm.event_team_id = et.id
      )
    )::text, 'UTF8'), 'sha256'), 'hex')
  where et.event_id = p_event_id;

  return v_result || jsonb_build_object(
    'teamSnapshotCount', (
      select count(*) from public.event_teams where event_id = p_event_id
    )
  );
end;
$$;

revoke all on function public.publish_phase2_event(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.publish_phase2_event(uuid, uuid, boolean) to service_role;

create unique index scorecard_attestations_entry_revision_unique
  on public.scorecard_attestations (
    round_id, event_entry_id, profile_id, attestation_type, score_revision
  ) where event_entry_id is not null;
create unique index scorecard_attestations_team_revision_unique
  on public.scorecard_attestations (
    round_id, event_team_id, profile_id, attestation_type, score_revision
  ) where event_team_id is not null;

create or replace function public.attest_phase2_scorecard(
  p_actor uuid,
  p_round_id uuid,
  p_target_kind text,
  p_target_id uuid,
  p_attestation_type public.attestation_type,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_league_id uuid;
  v_participant_id uuid;
  v_team_id uuid;
  v_revision bigint;
  v_attestation_id uuid;
  v_allowed boolean := false;
begin
  if p_target_kind not in ('individual', 'team') then
    raise exception 'invalid attestation target kind' using errcode = '23514';
  end if;
  if p_attestation_type = 'director_override'
     and nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'director override requires a reason' using errcode = '23514';
  end if;

  select r.event_id, e.league_id into v_event_id, v_league_id
  from public.rounds r join public.events e on e.id = r.event_id
  where r.id = p_round_id;
  if not found then raise exception 'round not found' using errcode = 'P0002'; end if;

  if p_target_kind = 'individual' then
    select participant_id into v_participant_id
    from public.event_entries where id = p_target_id and event_id = v_event_id;
    if not found then raise exception 'event entry not found' using errcode = 'P0002'; end if;
    select coalesce(sum(revision), 0) into v_revision
    from public.individual_hole_scores
    where round_id = p_round_id and event_entry_id = p_target_id;

    if p_attestation_type = 'player' then
      select exists (
        select 1 from public.participants
        where id = v_participant_id and profile_id = p_actor
      ) into v_allowed;
    elsif p_attestation_type = 'marker' then
      select app.actor_is_event_director(p_actor, v_event_id) or exists (
        select 1 from public.scoring_permissions sp
        where sp.event_id = v_event_id and sp.round_id = p_round_id
          and sp.scorer_profile_id = p_actor
          and sp.participant_id = v_participant_id
          and sp.permission_type = 'marker'
          and sp.valid_from <= now()
          and (sp.valid_to is null or sp.valid_to > now())
      ) into v_allowed;
    else
      v_allowed := app.actor_is_event_director(p_actor, v_event_id);
    end if;
  else
    select id into v_team_id from public.event_teams
    where id = p_target_id and event_id = v_event_id;
    if not found then raise exception 'event team not found' using errcode = 'P0002'; end if;
    select coalesce(sum(revision), 0) into v_revision
    from public.team_hole_scores
    where round_id = p_round_id and event_team_id = p_target_id;

    if p_attestation_type = 'player' then
      select exists (
        select 1
        from public.event_team_members etm
        join public.event_entries ee on ee.id = etm.event_entry_id
        join public.participants p on p.id = ee.participant_id
        where etm.event_team_id = p_target_id and p.profile_id = p_actor
      ) into v_allowed;
    elsif p_attestation_type = 'marker' then
      select app.actor_is_event_director(p_actor, v_event_id) or exists (
        select 1
        from public.event_team_members etm
        join public.event_entries ee on ee.id = etm.event_entry_id
        join public.scoring_permissions sp
          on sp.participant_id = ee.participant_id
        where etm.event_team_id = p_target_id
          and sp.event_id = v_event_id and sp.round_id = p_round_id
          and sp.scorer_profile_id = p_actor
          and sp.permission_type = 'marker'
          and sp.valid_from <= now()
          and (sp.valid_to is null or sp.valid_to > now())
      ) into v_allowed;
    else
      v_allowed := app.actor_is_event_director(p_actor, v_event_id);
    end if;
  end if;

  if not v_allowed then
    raise exception 'attestation permission required' using errcode = '42501';
  end if;

  insert into public.scorecard_attestations (
    round_id, event_entry_id, event_team_id, profile_id,
    attestation_type, score_revision, reason
  ) values (
    p_round_id,
    case when p_target_kind = 'individual' then p_target_id end,
    case when p_target_kind = 'team' then p_target_id end,
    p_actor, p_attestation_type, v_revision,
    nullif(trim(coalesce(p_reason, '')), '')
  ) on conflict do nothing
  returning id into v_attestation_id;

  if v_attestation_id is null then
    return jsonb_build_object(
      'status', 'duplicate', 'roundId', p_round_id,
      'targetId', p_target_id, 'scoreRevision', v_revision
    );
  end if;

  insert into public.audit_events (
    actor_profile_id, action, scope_league_id, scope_event_id,
    target_type, target_id, reason, after_json
  ) values (
    p_actor, 'scorecard.attested', v_league_id, v_event_id,
    'scorecard_attestation', v_attestation_id,
    nullif(trim(coalesce(p_reason, '')), ''),
    jsonb_build_object(
      'roundId', p_round_id, 'targetKind', p_target_kind,
      'targetId', p_target_id, 'attestationType', p_attestation_type,
      'scoreRevision', v_revision
    )
  );

  return jsonb_build_object(
    'status', 'attested', 'attestationId', v_attestation_id,
    'roundId', p_round_id, 'targetId', p_target_id,
    'scoreRevision', v_revision
  );
end;
$$;

revoke all on function public.attest_phase2_scorecard(
  uuid, uuid, text, uuid, public.attestation_type, text
) from public, anon, authenticated;
grant execute on function public.attest_phase2_scorecard(
  uuid, uuid, text, uuid, public.attestation_type, text
) to service_role;

-- Replace the Phase 1 finalizer with format-aware completeness and current-card
-- attestation checks. The function name remains stable for existing clients.
create or replace function public.finalize_phase1_competition(
  p_actor uuid,
  p_competition_id uuid,
  p_override_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_comp public.competitions%rowtype;
  v_event public.events%rowtype;
  v_missing integer := 0;
  v_conflicts integer;
  v_unattested integer;
  v_projection_hash text;
  v_best_k integer;
begin
  select * into v_comp from public.competitions
  where id = p_competition_id for update;
  if not found then raise exception 'competition not found' using errcode = 'P0002'; end if;
  if not app.actor_is_event_director(p_actor, v_comp.event_id) then
    raise exception 'event director role required' using errcode = '42501';
  end if;
  select * into v_event from public.events where id = v_comp.event_id for update;

  if v_event.status = 'scoring_open' then
    update public.competitions set status = 'scoring_closed'
      where event_id = v_event.id and status = 'scoring_open';
    update public.rounds set status = 'complete'
      where event_id = v_event.id and status = 'in_progress';
    update public.events set status = 'scoring_closed' where id = v_event.id;
    v_event.status := 'scoring_closed';
  end if;
  if v_event.status <> 'scoring_closed' then
    raise exception 'event must be open or closed for scoring' using errcode = '23514';
  end if;

  if v_comp.format = 'best_k' then
    v_best_k := coalesce((v_comp.rules_json #>> '{team,bestK}')::integer, 1);
    select count(*) into v_missing
    from public.competition_entities ce
    join public.competition_rounds cr on cr.competition_id = ce.competition_id
    join public.event_holes eh on eh.round_id = cr.round_id
    where ce.competition_id = p_competition_id
      and ce.event_team_id is not null
      and (
        select count(*)
        from public.event_team_members etm
        join public.individual_hole_scores s
          on s.event_entry_id = etm.event_entry_id
         and s.event_hole_id = eh.id
         and s.score_status <> 'not_started'
        where etm.event_team_id = ce.event_team_id
      ) < v_best_k;
  elsif v_comp.format in ('scramble', 'foursomes', 'greensomes', 'chapman') then
    select count(*) into v_missing
    from public.competition_entities ce
    join public.competition_rounds cr on cr.competition_id = ce.competition_id
    join public.event_holes eh on eh.round_id = cr.round_id
    where ce.competition_id = p_competition_id
      and ce.event_team_id is not null
      and not exists (
        select 1 from public.team_hole_scores s
        where s.event_team_id = ce.event_team_id
          and s.event_hole_id = eh.id
          and s.score_status <> 'not_started'
      );
  else
    select count(*) into v_missing
    from public.competition_entities ce
    join public.competition_rounds cr on cr.competition_id = ce.competition_id
    join public.event_holes eh on eh.round_id = cr.round_id
    where ce.competition_id = p_competition_id
      and ce.event_entry_id is not null
      and not exists (
        select 1 from public.individual_hole_scores s
        where s.event_entry_id = ce.event_entry_id
          and s.event_hole_id = eh.id
          and s.score_status <> 'not_started'
      );
  end if;

  select count(*) into v_conflicts
  from public.score_conflicts
  where event_id = v_event.id and status = 'open';

  select count(*) into v_unattested
  from public.event_entries ee
  where ee.event_id = v_event.id and ee.status = 'active'
    and not exists (
      select 1
      from public.scorecard_attestations sa
      join public.rounds r on r.id = sa.round_id and r.event_id = v_event.id
      where sa.event_entry_id = ee.id
        and sa.score_revision = (
          select coalesce(sum(s.revision), 0)
          from public.individual_hole_scores s
          where s.round_id = r.id and s.event_entry_id = ee.id
        )
    );

  if (v_missing > 0 or v_conflicts > 0 or v_unattested > 0)
     and nullif(trim(coalesce(p_override_reason, '')), '') is null then
    return jsonb_build_object(
      'status', 'blocked', 'missingScores', v_missing,
      'openConflicts', v_conflicts, 'unattestedCards', v_unattested
    );
  end if;

  select projection_hash into v_projection_hash
  from public.competition_projections
  where competition_id = p_competition_id
    and event_revision = v_event.scoring_revision
    and status <> 'error';
  if v_projection_hash is null then
    return jsonb_build_object(
      'status', 'blocked', 'projectionStale', true,
      'missingScores', v_missing, 'openConflicts', v_conflicts,
      'unattestedCards', v_unattested
    );
  end if;

  update public.competitions set
    status = 'finalized', finalized_at = now(), finalized_by = p_actor,
    final_result_hash = v_projection_hash
  where id = p_competition_id;

  if not exists (
    select 1 from public.competitions
    where event_id = v_event.id and status <> 'finalized'
  ) then
    update public.events set status = 'finalized' where id = v_event.id;
  end if;

  insert into public.audit_events (
    actor_profile_id, action, scope_league_id, scope_event_id,
    target_type, target_id, reason, after_json
  ) values (
    p_actor, 'competition.finalized', v_event.league_id, v_event.id,
    'competition', p_competition_id, nullif(trim(coalesce(p_override_reason, '')), ''),
    jsonb_build_object(
      'finalResultHash', v_projection_hash,
      'missingScoreOverrides', v_missing,
      'conflictOverrides', v_conflicts,
      'attestationOverrides', v_unattested
    )
  );

  return jsonb_build_object(
    'status', 'finalized', 'eventId', v_event.id,
    'competitionId', p_competition_id,
    'finalResultHash', v_projection_hash,
    'missingScoreOverrides', v_missing,
    'conflictOverrides', v_conflicts,
    'attestationOverrides', v_unattested
  );
end;
$$;

revoke all on function public.finalize_phase1_competition(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.finalize_phase1_competition(uuid, uuid, text) to service_role;
