-- Migration 37: record WHY each scoring permission exists.
--
-- Phase 1 creates two kinds of grant: a player's own 'self' grant, and a
-- field-wide 'marker' grant for each explicitly selected scorer. Phase 2 then
-- adds a third: every linked player in a tee group may mark every card in
-- that same group. All three landed as permission_type = 'marker' with nothing
-- to tell them apart.
--
-- The event builder reloads the marker control from those rows, so reopening
-- and resaving a Throwdown read the automatic same-group grants back as if an
-- organizer had chosen them as field-wide markers — and resaving promoted
-- them, widening every group scorer to the whole field. Access silently grew
-- each time a draft was edited.
--
-- grant_origin makes the distinction durable:
--   self           player scoring their own card
--   explicit_field organizer deliberately selected this scorer for the field
--   group_auto     derived from tee-group membership by the phase 2 preset
--   legacy         created before this migration; origin unknown
--
-- Existing rows become 'legacy' rather than being guessed at. The builder
-- loads only 'explicit_field' back into the marker control and tells the
-- organizer when legacy grants exist, so a human re-states the intent instead
-- of the app inventing it.

alter table public.scoring_permissions
  add column if not exists grant_origin text not null default 'legacy';

alter table public.scoring_permissions
  drop constraint if exists scoring_permissions_grant_origin_check;

alter table public.scoring_permissions
  add constraint scoring_permissions_grant_origin_check
  check (grant_origin in ('self', 'explicit_field', 'group_auto', 'legacy'));

comment on column public.scoring_permissions.grant_origin is
  'Why this grant exists: self, explicit_field (organizer choice), group_auto (tee-group derived), or legacy (pre-migration, unknown).';

create index if not exists scoring_permissions_origin_idx
  on public.scoring_permissions (event_id, grant_origin);

create or replace function public.save_phase1_event_draft(
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
  p_scorer_profile_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id uuid := coalesce(p_event_id, gen_random_uuid());
  v_round_id uuid;
  v_competition_id uuid := gen_random_uuid();
  v_group_id uuid := gen_random_uuid();
  v_participant_id uuid;
  v_entry_id uuid;
  v_profile_id uuid;
  v_handicap public.participant_handicaps%rowtype;
  v_course_rating numeric(5,1);
  v_slope smallint;
  v_par smallint;
  v_hole_count smallint;
  v_course_handicap numeric(12,6);
  v_playing_handicap smallint;
  v_rules jsonb;
begin
  if cardinality(p_participant_ids) is null or cardinality(p_participant_ids) < 1 then
    raise exception 'at least one participant is required' using errcode = '23514';
  end if;
  if cardinality(p_participant_ids) <> (
    select count(distinct x) from unnest(p_participant_ids) as x
  ) then
    raise exception 'participant ids must be unique' using errcode = '23514';
  end if;
  if p_ends_at is not null and p_ends_at <= p_starts_at then
    raise exception 'event end must be after start' using errcode = '23514';
  end if;

  if p_event_id is null then
    if not app.actor_has_league_role(
      p_actor, p_league_id, array['owner', 'league_admin']::public.app_role[]
    ) then
      raise exception 'owner or league admin role required' using errcode = '42501';
    end if;
    insert into public.events (
      id, league_id, season_id, name, slug, timezone, starts_at, ends_at,
      status, visibility, created_by
    ) values (
      v_event_id, p_league_id, p_season_id, trim(p_name),
      lower(regexp_replace(trim(p_name), '[^a-zA-Z0-9]+', '-', 'g'))
        || '-' || left(v_event_id::text, 8),
      p_timezone, p_starts_at, p_ends_at, 'draft', p_visibility, p_actor
    );
  else
    if not app.actor_is_event_director(p_actor, p_event_id) then
      raise exception 'event director role required' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.events
      where id = p_event_id and league_id = p_league_id and status = 'draft'
      for update
    ) then
      raise exception 'event is not an editable draft' using errcode = '23514';
    end if;
    update public.events set
      season_id = p_season_id,
      name = trim(p_name),
      timezone = p_timezone,
      starts_at = p_starts_at,
      ends_at = p_ends_at,
      visibility = p_visibility
    where id = p_event_id;
  end if;

  if not exists (
    select 1 from public.seasons
    where id = p_season_id and league_id = p_league_id
  ) then
    raise exception 'season does not belong to league' using errcode = '23514';
  end if;

  select ts.course_rating, ts.slope_rating, ts.par, cl.hole_count
    into v_course_rating, v_slope, v_par, v_hole_count
  from public.tee_sets ts
  join public.course_layouts cl on cl.id = ts.course_layout_id
  join public.courses c on c.id = cl.course_id
  where ts.id = p_tee_set_id
    and ts.status = 'active'
    and c.league_id = p_league_id;
  if not found then
    raise exception 'active tee set does not belong to league' using errcode = '23514';
  end if;
  if (select count(*) from public.tee_holes where tee_set_id = p_tee_set_id) <> v_hole_count then
    raise exception 'tee set hole data is incomplete' using errcode = '23514';
  end if;

  select id into v_round_id
  from public.rounds
  where event_id = v_event_id
  order by round_number
  limit 1;
  if v_round_id is null then
    v_round_id := gen_random_uuid();
    insert into public.rounds (
      id, event_id, round_number, name, starts_at, status, hole_count,
      source_tee_set_id
    ) values (
      v_round_id, v_event_id, 1, 'Round 1', p_starts_at, 'scheduled',
      v_hole_count, p_tee_set_id
    );
  else
    update public.rounds set
      starts_at = p_starts_at,
      hole_count = v_hole_count,
      source_tee_set_id = p_tee_set_id
    where id = v_round_id;
  end if;

  delete from public.scoring_permissions where event_id = v_event_id;
  delete from public.groups where round_id = v_round_id;
  delete from public.competitions where event_id = v_event_id;
  delete from public.event_teams where event_id = v_event_id;
  delete from public.event_entries where event_id = v_event_id;

  insert into public.groups (id, round_id, label, start_hole_ordinal, sort_order)
  values (v_group_id, v_round_id, 'Field', 1, 1);

  foreach v_participant_id in array p_participant_ids loop
    if not exists (
      select 1 from public.participants
      where id = v_participant_id and league_id = p_league_id and status = 'active'
    ) then
      raise exception 'active participant % does not belong to league', v_participant_id
        using errcode = '23514';
    end if;

    select * into v_handicap
    from public.participant_handicaps
    where participant_id = v_participant_id
      and effective_from <= p_starts_at::date
      and (effective_to is null or effective_to > p_starts_at::date)
    order by effective_from desc
    limit 1;

    if found then
      v_course_handicap := round(
        (v_handicap.value * v_slope::numeric / 113)
          + (v_course_rating - v_par),
        6
      );
      v_playing_handicap := floor(v_course_handicap + 0.5)::smallint;
    else
      v_course_handicap := 0;
      v_playing_handicap := 0;
    end if;

    v_entry_id := gen_random_uuid();
    insert into public.event_entries (
      id, event_id, participant_id, status, handicap_source,
      handicap_value, course_handicap_unrounded, playing_handicap,
      allowance, handicap_profile
    ) values (
      v_entry_id, v_event_id, v_participant_id, 'active',
      case when v_handicap.id is null then 'scratch_fallback'::public.handicap_source
           else v_handicap.source end,
      coalesce(v_handicap.value, 0), v_course_handicap, v_playing_handicap,
      1, 'usga_whs_2024'
    );

    insert into public.group_members (group_id, event_entry_id, sort_order)
    values (v_group_id, v_entry_id, array_position(p_participant_ids, v_participant_id));
  end loop;

  v_rules := jsonb_build_object(
    'format', 'individual_stroke',
    'schemaVersion', 1,
    'metric', 'gross',
    'holeScope', (select jsonb_agg(i order by i) from generate_series(1, v_hole_count) i),
    'handicap', jsonb_build_object(
      'profile', 'none', 'allowance', 1,
      'rounding', 'half_up_toward_positive_infinity',
      'matchNormalizeFromLowest', false, 'allocation', 'stroke_index'
    ),
    'ties', jsonb_build_object('mode', 'tied', 'sequence', '[]'::jsonb),
    'incomplete', jsonb_build_object('live', 'provisional', 'final', 'no_return'),
    'visibility', p_visibility::text
  );

  insert into public.competitions (
    id, event_id, name, format, metric, status, rules_schema_version,
    rules_json, rules_text, engine_version, visibility, sort_order
  ) values (
    v_competition_id, v_event_id, 'Individual Gross', 'individual_stroke',
    'gross', 'draft', 1, v_rules,
    'Individual gross stroke play. Lowest completed gross total wins; incomplete cards remain provisional.',
    '0.1.0', p_visibility, 1
  );
  insert into public.competition_rounds (competition_id, round_id, hole_scope, weight)
  values (v_competition_id, v_round_id, null, 1);
  insert into public.competition_entities (competition_id, event_entry_id, eligibility_status)
  select v_competition_id, id, 'eligible'
  from public.event_entries
  where event_id = v_event_id;

  -- A linked player can score self; named markers can score the entire field.
  insert into public.scoring_permissions (
    event_id, round_id, scorer_profile_id, participant_id, permission_type,
    grant_origin
  )
  select v_event_id, v_round_id, p.profile_id, p.id, 'self', 'self'
  from public.participants p
  where p.id = any(p_participant_ids) and p.profile_id is not null;

  foreach v_profile_id in array coalesce(p_scorer_profile_ids, '{}'::uuid[]) loop
    if not exists (
      select 1 from public.league_memberships
      where league_id = p_league_id and profile_id = v_profile_id
        and member_status = 'active'
    ) then
      raise exception 'scorer % is not an active league member', v_profile_id
        using errcode = '23514';
    end if;
    -- Deliberately chosen by the organizer for the whole field: this is the
    -- ONLY origin the event builder reads back into the marker control.
    insert into public.scoring_permissions (
      event_id, round_id, scorer_profile_id, participant_id, permission_type,
      grant_origin
    )
    select v_event_id, v_round_id, v_profile_id, unnest(p_participant_ids),
      'marker', 'explicit_field';
  end loop;

  insert into public.audit_events (
    actor_profile_id, action, scope_league_id, scope_event_id,
    target_type, target_id, after_json
  ) values (
    p_actor, 'event.draft_saved', p_league_id, v_event_id,
    'event', v_event_id,
    jsonb_build_object('participants', cardinality(p_participant_ids), 'teeSetId', p_tee_set_id)
  );

  return jsonb_build_object(
    'eventId', v_event_id,
    'roundId', v_round_id,
    'competitionId', v_competition_id,
    'status', 'draft'
  );
end;
$$;

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
  v_usga_rounding jsonb;
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
      event_id, round_id, scorer_profile_id, participant_id, permission_type,
      grant_origin
    )
    select distinct v_event_id, v_round_id, scorer.profile_id,
      target.participant_id, 'marker', 'group_auto'
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
  -- Round the Course Handicap to a whole number, apply the allowance, then
  -- round again (USGA WHS 2024 published practice). Ties break toward positive
  -- infinity at both steps, matching half_up_toward_positive_infinity.
  v_usga_rounding := jsonb_build_object(
    'kind', 'committee_custom',
    'intermediatePrecision', 0,
    'tieDirection', 'up',
    'stepOrder', 'round_then_allowance'
  );
  v_full_handicap := jsonb_build_object(
    'profile', 'committee_custom', 'allowance', 1,
    'rounding', v_usga_rounding,
    'matchNormalizeFromLowest', false, 'allocation', 'stroke_index'
  );
  v_fourball_handicap := jsonb_build_object(
    'profile', 'committee_custom', 'allowance', 0.85,
    'rounding', v_usga_rounding,
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
