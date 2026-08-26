-- Migration 35: USGA Playing Handicap rounding order for the Throwdown preset.
--
-- Spec §9.3-9.4 as written retains full precision through the allowance and
-- rounds once. Common USGA WHS 2024 published practice instead rounds the
-- Course Handicap to a whole number FIRST, applies the allowance, then rounds
-- again. The two orders disagree: HI 10.4 / Slope 130 / CR 71.3 / par 72 at an
-- 85% allowance yields 10 under the single-round order and 9 under the USGA
-- order. The owner has approved the USGA order for this league
-- (docs/adr/0005-playing-handicap-rounding-order.md).
--
-- This is a rules change, not an engine change. packages/scoring already
-- implements both orders: playingHandicap() applies the intermediate rounding
-- step when the frozen profile is committee_custom with
-- stepOrder 'round_then_allowance'.
--
-- The 'usga_whs_2024' token deliberately KEEPS its single-round meaning:
--   * already-frozen rules_json must not change meaning retroactively, or the
--     byte-for-byte reproducibility guarantee of a published snapshot breaks;
--   * match play normalizes from the UNROUNDED Course Handicap (§8.6) and
--     calls playingHandicap() with that token — redefining it would silently
--     move match-play strokes too.
-- Only the preset's frozen competition rules move to the new profile.
--
-- Numerically this changes Two-Person Best Ball Net (85%) alone. At the 100%
-- allowance used by Individual Net and Net Skins both orders agree, and the
-- frozen 100% playing_handicap on event_entries is likewise unchanged; the
-- full-allowance rules still adopt the new profile so one event describes one
-- committee policy rather than two.

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

-- create or replace preserves existing privileges; re-stated for explicitness.
revoke all on function public.save_phase2_event_draft(
  uuid, uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  public.event_visibility, uuid, uuid[], uuid[], text, jsonb
) from public, anon, authenticated;
grant execute on function public.save_phase2_event_draft(
  uuid, uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  public.event_visibility, uuid, uuid[], uuid[], text, jsonb
) to service_role;
