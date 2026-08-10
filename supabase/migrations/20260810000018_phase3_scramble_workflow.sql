-- Migration 18: Phase 3 three- and four-player scramble workflow.
--
-- Scramble events have one team ball per hole. The draft transaction creates
-- complete team rosters and gross/net scramble competitions; publish freezes
-- the reviewed weight preset, derived team handicap, tee, holes, and hashes.

create or replace function public.save_phase3_scramble_event_draft(
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
  p_competition_preset text default 'three_player_scramble',
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
  v_team_size integer;
  v_weights numeric[];
  v_team jsonb;
  v_team_id uuid;
  v_member_ids uuid[];
  v_assigned_ids uuid[] := '{}';
  v_group_id uuid;
  v_group_number integer := 0;
  v_team_ch numeric(12,6);
  v_team_ph smallint;
  v_common jsonb;
  v_team_rules jsonb;
  v_handicap jsonb;
  v_competition_id uuid;
  v_competition_ids uuid[] := '{}';
  v_metric text;
  v_label text;
begin
  if p_competition_preset = 'three_player_scramble' then
    v_team_size := 3;
    v_weights := array[0.30, 0.20, 0.10]::numeric[];
    v_label := 'Three-Player Scramble';
  elsif p_competition_preset = 'four_player_scramble' then
    v_team_size := 4;
    v_weights := array[0.25, 0.20, 0.15, 0.10]::numeric[];
    v_label := 'Four-Player Scramble';
  else
    raise exception 'unsupported scramble preset' using errcode = '23514';
  end if;

  if jsonb_typeof(coalesce(p_teams, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_teams, '[]'::jsonb)) < 2 then
    raise exception 'scramble events require at least two teams' using errcode = '23514';
  end if;
  if cardinality(p_participant_ids) <> jsonb_array_length(p_teams) * v_team_size then
    raise exception 'scramble field does not match the configured team size'
      using errcode = '23514';
  end if;

  v_base := public.save_phase1_event_draft(
    p_actor, p_event_id, p_league_id, p_season_id, p_name, p_timezone,
    p_starts_at, p_ends_at, p_visibility, p_tee_set_id,
    p_participant_ids, p_scorer_profile_ids
  );
  v_event_id := (v_base ->> 'eventId')::uuid;
  v_round_id := (v_base ->> 'roundId')::uuid;

  if exists (
    select 1 from public.event_entries
    where event_id = v_event_id and handicap_source = 'scratch_fallback'
  ) then
    raise exception 'net scramble requires a current handicap for every selected player'
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
    if cardinality(v_member_ids) <> v_team_size
       or cardinality(v_member_ids) <> (
         select count(distinct member_id) from unnest(v_member_ids) member_id
       ) then
      raise exception 'every scramble team requires % different participants', v_team_size
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

  -- Remove the individual launch-format competition/group created by the
  -- shared draft helper. Scramble records team facts only.
  delete from public.groups where round_id = v_round_id;
  delete from public.competitions where event_id = v_event_id;
  delete from public.event_teams where event_id = v_event_id;

  for v_team in select value from jsonb_array_elements(p_teams) loop
    v_group_number := v_group_number + 1;
    v_team_id := gen_random_uuid();
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

    -- Pair the preset weights with Course Handicaps sorted from low to high.
    select round(sum(ranked.course_handicap_unrounded * weight.weight), 6)
      into v_team_ch
    from (
      select ee.course_handicap_unrounded,
        row_number() over (order by ee.course_handicap_unrounded, ee.id) as ordinality
      from public.event_team_members etm
      join public.event_entries ee on ee.id = etm.event_entry_id
      where etm.event_team_id = v_team_id
    ) ranked
    join unnest(v_weights) with ordinality as weight(weight, ordinality)
      on weight.ordinality = ranked.ordinality;
    v_team_ph := floor(v_team_ch + 0.5)::smallint;
    update public.event_teams set
      course_handicap_unrounded = v_team_ch,
      playing_handicap = v_team_ph,
      allowance = 1
    where id = v_team_id;

    v_group_id := gen_random_uuid();
    insert into public.groups (id, round_id, label, start_hole_ordinal, sort_order)
    values (
      v_group_id, v_round_id,
      'Group ' || v_group_number || ' - ' || trim(v_team ->> 'name'),
      1, v_group_number
    );
    insert into public.group_members (group_id, event_team_id, sort_order)
    values (v_group_id, v_team_id, 1);
  end loop;

  select hole_count into v_hole_count from public.rounds where id = v_round_id;
  v_common := jsonb_build_object(
    'schemaVersion', 1,
    'holeScope', (select jsonb_agg(i order by i) from generate_series(1, v_hole_count) i),
    'ties', jsonb_build_object('mode', 'tied', 'sequence', '[]'::jsonb),
    'incomplete', jsonb_build_object('live', 'provisional', 'final', 'no_return'),
    'visibility', p_visibility::text
  );
  v_team_rules := jsonb_build_object(
    'teamSize', v_team_size,
    'bestK', 1,
    'scoreSource', 'team_ball',
    'weights', to_jsonb(v_weights)
  );

  foreach v_metric in array array['gross', 'net'] loop
    v_competition_id := gen_random_uuid();
    v_competition_ids := array_append(v_competition_ids, v_competition_id);
    v_handicap := jsonb_build_object(
      'profile', case when v_metric = 'gross' then 'none' else 'usga_whs_2024' end,
      'allowance', 1,
      'rounding', 'half_up_toward_positive_infinity',
      'matchNormalizeFromLowest', false,
      'allocation', 'stroke_index'
    );
    insert into public.competitions (
      id, event_id, name, format, metric, status, rules_schema_version,
      rules_json, rules_text, engine_version, visibility, sort_order
    ) values (
      v_competition_id, v_event_id,
      v_label || case when v_metric = 'gross' then ' Gross' else ' Net' end,
      'scramble', v_metric, 'draft', 1,
      v_common || jsonb_build_object(
        'format', 'scramble', 'metric', v_metric,
        'handicap', v_handicap, 'team', v_team_rules
      ),
      case when v_metric = 'gross'
        then 'One team ball per hole; lowest completed gross team total wins.'
        else 'One team ball per hole; the frozen weighted team Playing Handicap is allocated by stroke index.'
      end,
      '0.1.0', p_visibility,
      case when v_metric = 'gross' then 1 else 2 end
    );
    insert into public.competition_rounds (competition_id, round_id, hole_scope, weight)
    values (v_competition_id, v_round_id, null, 1);
    insert into public.competition_entities (
      competition_id, event_team_id, eligibility_status
    )
    select v_competition_id, id, 'eligible'
    from public.event_teams where event_id = v_event_id and status = 'active';
  end loop;

  insert into public.audit_events (
    actor_profile_id, action, scope_league_id, scope_event_id,
    target_type, target_id, after_json
  ) values (
    p_actor, 'event.phase3_scramble_saved', p_league_id, v_event_id,
    'event', v_event_id,
    jsonb_build_object(
      'preset', p_competition_preset,
      'teamSize', v_team_size,
      'teams', jsonb_array_length(p_teams),
      'weights', to_jsonb(v_weights)
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

revoke all on function public.save_phase3_scramble_event_draft(
  uuid, uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  public.event_visibility, uuid, uuid[], uuid[], text, jsonb
) from public, anon, authenticated;
grant execute on function public.save_phase3_scramble_event_draft(
  uuid, uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  public.event_visibility, uuid, uuid[], uuid[], text, jsonb
) to service_role;

create or replace function public.publish_phase3_scramble_event(
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
  v_event public.events%rowtype;
  v_round public.rounds%rowtype;
  v_snapshot_id uuid := gen_random_uuid();
  v_snapshot_version integer;
  v_course_name text;
  v_layout_name text;
  v_tee public.tee_sets%rowtype;
  v_hash text;
  v_payload jsonb;
  v_hole_count integer;
  v_rules jsonb;
  v_team_size integer;
  v_weights numeric[];
  v_team public.event_teams%rowtype;
  v_expected_ch numeric(12,6);
  v_expected_ph smallint;
begin
  if not app.actor_is_event_director(p_actor, p_event_id) then
    raise exception 'event director role required' using errcode = '42501';
  end if;
  select * into v_event from public.events where id = p_event_id for update;
  if not found or v_event.status <> 'draft' then
    raise exception 'only a draft event can be published' using errcode = '23514';
  end if;
  select * into v_round
  from public.rounds where event_id = p_event_id order by round_number limit 1;
  if not found or v_round.source_tee_set_id is null then
    raise exception 'round tee selection is required' using errcode = '23514';
  end if;
  if exists (select 1 from public.event_tee_snapshots where round_id = v_round.id) then
    raise exception 'event snapshot already exists' using errcode = '23514';
  end if;

  select rules_json into v_rules
  from public.competitions
  where event_id = p_event_id and format = 'scramble' and metric = 'net'
  order by sort_order limit 1;
  if not found then
    raise exception 'net scramble competition is required' using errcode = '23514';
  end if;
  v_team_size := (v_rules #>> '{team,teamSize}')::integer;
  select array_agg(value::numeric order by ordinality)
    into v_weights
  from jsonb_array_elements_text(v_rules #> '{team,weights}')
    with ordinality as weights(value, ordinality);
  if v_team_size not in (3, 4) or cardinality(v_weights) <> v_team_size then
    raise exception 'scramble team rules are invalid' using errcode = '23514';
  end if;
  if (select count(*) from public.event_teams where event_id = p_event_id) < 2 then
    raise exception 'scramble events require at least two teams' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.event_teams et
    where et.event_id = p_event_id
      and (select count(*) from public.event_team_members etm
           where etm.event_team_id = et.id) <> v_team_size
  ) then
    raise exception 'every scramble team must match the frozen team size'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from public.event_entries ee
    where ee.event_id = p_event_id and (
      select count(*)
      from public.event_team_members etm
      join public.event_teams et on et.id = etm.event_team_id
      where etm.event_entry_id = ee.id and et.event_id = p_event_id
    ) <> 1
  ) then
    raise exception 'every event entry must belong to exactly one scramble team'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from public.event_entries
    where event_id = p_event_id and handicap_source = 'scratch_fallback'
  ) then
    raise exception 'net scramble requires a current handicap for every selected player'
      using errcode = '23514';
  end if;

  for v_team in select * from public.event_teams where event_id = p_event_id loop
    select round(sum(ranked.course_handicap_unrounded * weight.weight), 6)
      into v_expected_ch
    from (
      select ee.course_handicap_unrounded,
        row_number() over (order by ee.course_handicap_unrounded, ee.id) as ordinality
      from public.event_team_members etm
      join public.event_entries ee on ee.id = etm.event_entry_id
      where etm.event_team_id = v_team.id
    ) ranked
    join unnest(v_weights) with ordinality as weight(weight, ordinality)
      on weight.ordinality = ranked.ordinality;
    v_expected_ph := floor(v_expected_ch + 0.5)::smallint;
    if v_team.course_handicap_unrounded is distinct from v_expected_ch
       or v_team.playing_handicap is distinct from v_expected_ph then
      raise exception 'scramble team handicap is stale; save the draft again'
        using errcode = '23514';
    end if;
  end loop;

  select ts.* into v_tee
  from public.tee_sets ts where ts.id = v_round.source_tee_set_id;
  select c.name, cl.name into v_course_name, v_layout_name
  from public.tee_sets ts
  join public.course_layouts cl on cl.id = ts.course_layout_id
  join public.courses c on c.id = cl.course_id
  where ts.id = v_round.source_tee_set_id;
  select count(*) into v_hole_count
  from public.tee_holes where tee_set_id = v_tee.id;
  if v_hole_count <> v_round.hole_count then
    raise exception 'tee hole count does not match round' using errcode = '23514';
  end if;

  v_snapshot_version := coalesce(v_event.published_snapshot_version, 0) + 1;
  v_payload := jsonb_build_object(
    'courseName', v_course_name, 'layoutName', v_layout_name,
    'teeName', v_tee.name, 'courseRating', v_tee.course_rating::text,
    'slopeRating', v_tee.slope_rating, 'par', v_tee.par,
    'holeCount', v_round.hole_count,
    'holes', (
      select jsonb_agg(jsonb_build_object(
        'ordinal', th.hole_ordinal, 'label', th.course_hole_label,
        'par', th.par, 'yardage', th.yardage, 'strokeIndex', th.stroke_index
      ) order by th.hole_ordinal)
      from public.tee_holes th where th.tee_set_id = v_tee.id
    )
  );
  v_hash := encode(
    extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex'
  );

  insert into public.event_tee_snapshots (
    id, round_id, source_tee_set_id, course_name, layout_name, tee_name,
    rating_category, course_rating, slope_rating, par, hole_count,
    snapshot_version, snapshot_hash
  ) values (
    v_snapshot_id, v_round.id, v_tee.id, v_course_name, v_layout_name,
    v_tee.name, v_tee.rating_category, v_tee.course_rating,
    v_tee.slope_rating, v_tee.par, v_round.hole_count,
    v_snapshot_version, v_hash
  );
  insert into public.event_holes (
    round_id, event_tee_snapshot_id, hole_ordinal, label, par, yardage, stroke_index
  )
  select v_round.id, v_snapshot_id, hole_ordinal, course_hole_label,
    par, yardage, stroke_index
  from public.tee_holes where tee_set_id = v_tee.id order by hole_ordinal;

  update public.event_entries set
    tee_snapshot_id = v_snapshot_id,
    snapshot_hash = encode(extensions.digest(convert_to(jsonb_build_object(
      'participantId', participant_id,
      'handicapSource', handicap_source,
      'handicapValue', handicap_value::text,
      'courseHandicap', course_handicap_unrounded::text,
      'playingHandicap', playing_handicap,
      'allowance', allowance::text,
      'teeSnapshotHash', v_hash
    )::text, 'UTF8'), 'sha256'), 'hex')
  where event_id = p_event_id;

  update public.event_teams et set
    snapshot_hash = encode(extensions.digest(convert_to(jsonb_build_object(
      'name', et.name,
      'courseHandicap', et.course_handicap_unrounded::text,
      'playingHandicap', et.playing_handicap,
      'weights', to_jsonb(v_weights),
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

  update public.rounds set snapshot_version = v_snapshot_version where id = v_round.id;
  update public.competitions set status = 'published' where event_id = p_event_id;
  update public.events set
    status = 'published', published_snapshot_version = v_snapshot_version
  where id = p_event_id;
  if p_open_scoring then
    update public.competitions set status = 'scoring_open' where event_id = p_event_id;
    update public.rounds set status = 'in_progress' where id = v_round.id;
    update public.events set status = 'scoring_open' where id = p_event_id;
  end if;

  insert into public.audit_events (
    actor_profile_id, action, scope_league_id, scope_event_id,
    target_type, target_id, after_json
  ) values (
    p_actor,
    case when p_open_scoring then 'event.published_and_opened' else 'event.published' end,
    v_event.league_id, p_event_id, 'event', p_event_id,
    jsonb_build_object(
      'snapshotVersion', v_snapshot_version,
      'snapshotHash', v_hash,
      'format', 'scramble',
      'teamSize', v_team_size,
      'weights', to_jsonb(v_weights)
    )
  );

  return jsonb_build_object(
    'status', case when p_open_scoring then 'scoring_open' else 'published' end,
    'eventId', p_event_id,
    'roundId', v_round.id,
    'snapshotVersion', v_snapshot_version,
    'snapshotHash', v_hash,
    'teamSnapshotCount', (
      select count(*) from public.event_teams where event_id = p_event_id
    )
  );
end;
$$;

revoke all on function public.publish_phase3_scramble_event(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.publish_phase3_scramble_event(uuid, uuid, boolean)
  to service_role;
