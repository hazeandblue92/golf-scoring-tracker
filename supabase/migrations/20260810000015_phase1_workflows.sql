-- Migration 15: complete the Phase 1 organizer lifecycle (spec §22).
--
-- Browser clients remain read-only at the table privilege layer. These
-- transaction-scoped RPCs are callable only by service_role Edge Functions,
-- accept the authenticated actor explicitly, and repeat authorization inside
-- PostgreSQL before touching authoritative state.

alter table public.rounds
  add column source_tee_set_id uuid references public.tee_sets (id) on delete restrict;

comment on column public.rounds.source_tee_set_id is
  'Draft-only tee selection. publish-event copies it into immutable event_tee_snapshots/event_holes.';

create or replace function app.actor_has_league_role(
  p_actor uuid,
  p_league_id uuid,
  p_roles public.app_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles pr
    join public.role_assignments ra on ra.profile_id = pr.id
    where pr.id = p_actor
      and pr.status = 'active'
      and ra.league_id = p_league_id
      and ra.role = any (p_roles)
      and ra.revoked_at is null
  );
$$;

create or replace function app.actor_is_event_director(p_actor uuid, p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.events e
    join public.profiles pr on pr.id = p_actor and pr.status = 'active'
    join public.role_assignments ra
      on ra.profile_id = p_actor
     and ra.revoked_at is null
     and (
       (ra.role = 'event_director' and ra.event_id = e.id)
       or (ra.role in ('owner', 'league_admin') and ra.league_id = e.league_id)
     )
    where e.id = p_event_id
  );
$$;

revoke all on function app.actor_has_league_role(uuid, uuid, public.app_role[]) from public;
revoke all on function app.actor_is_event_director(uuid, uuid) from public;
grant execute on function app.actor_has_league_role(uuid, uuid, public.app_role[]) to service_role;
grant execute on function app.actor_is_event_director(uuid, uuid) to service_role;

-- Save the complete launch-format draft in one transaction. Re-saving a draft
-- replaces its derived setup children, which prevents half-configured event
-- state from leaking between builder steps.
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
    event_id, round_id, scorer_profile_id, participant_id, permission_type
  )
  select v_event_id, v_round_id, p.profile_id, p.id, 'self'
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
    insert into public.scoring_permissions (
      event_id, round_id, scorer_profile_id, participant_id, permission_type
    )
    select v_event_id, v_round_id, v_profile_id, unnest(p_participant_ids), 'marker';
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

revoke all on function public.save_phase1_event_draft(
  uuid, uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  public.event_visibility, uuid, uuid[], uuid[]
) from public, anon, authenticated;
grant execute on function public.save_phase1_event_draft(
  uuid, uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  public.event_visibility, uuid, uuid[], uuid[]
) to service_role;

-- Freeze course, tee, holes, roster handicaps, and competition state. All
-- snapshot hashes are computed from ordered jsonb values inside the same
-- transaction that advances the lifecycle.
create or replace function public.publish_phase1_event(
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

  select ts.*
    into v_tee
  from public.tee_sets ts
  where ts.id = v_round.source_tee_set_id;
  select c.name, cl.name
    into v_course_name, v_layout_name
  from public.tee_sets ts
  join public.course_layouts cl on cl.id = ts.course_layout_id
  join public.courses c on c.id = cl.course_id
  where ts.id = v_round.source_tee_set_id;

  select count(*) into v_hole_count
  from public.tee_holes where tee_set_id = v_tee.id;
  if v_hole_count <> v_round.hole_count then
    raise exception 'tee hole count does not match round' using errcode = '23514';
  end if;
  if not exists (select 1 from public.event_entries where event_id = p_event_id) then
    raise exception 'at least one event entry is required' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.competitions c
    join public.competition_rounds cr on cr.competition_id = c.id
    where c.event_id = p_event_id and cr.round_id = v_round.id
      and c.format = 'individual_stroke' and c.metric = 'gross'
  ) then
    raise exception 'individual gross competition is required' using errcode = '23514';
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
  v_hash := encode(extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');

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
  from public.tee_holes
  where tee_set_id = v_tee.id
  order by hole_ordinal;

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
    p_actor, case when p_open_scoring then 'event.published_and_opened' else 'event.published' end,
    v_event.league_id, p_event_id, 'event', p_event_id,
    jsonb_build_object('snapshotVersion', v_snapshot_version, 'snapshotHash', v_hash)
  );

  return jsonb_build_object(
    'status', case when p_open_scoring then 'scoring_open' else 'published' end,
    'eventId', p_event_id, 'roundId', v_round.id,
    'snapshotVersion', v_snapshot_version, 'snapshotHash', v_hash
  );
end;
$$;

revoke all on function public.publish_phase1_event(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.publish_phase1_event(uuid, uuid, boolean) to service_role;

-- Close and finalize the Phase 1 competition. Missing score/conflict blockers
-- require an explicit, audited override; a current deterministic projection is
-- always required because it supplies the frozen final result hash.
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
  v_missing integer;
  v_conflicts integer;
  v_projection_hash text;
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

  select count(*) into v_conflicts
  from public.score_conflicts
  where event_id = v_event.id and status = 'open';

  if (v_missing > 0 or v_conflicts > 0)
     and nullif(trim(coalesce(p_override_reason, '')), '') is null then
    return jsonb_build_object(
      'status', 'blocked',
      'missingScores', v_missing,
      'openConflicts', v_conflicts
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
      'missingScores', v_missing, 'openConflicts', v_conflicts
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
      'conflictOverrides', v_conflicts
    )
  );

  return jsonb_build_object(
    'status', 'finalized', 'eventId', v_event.id,
    'competitionId', p_competition_id,
    'finalResultHash', v_projection_hash,
    'missingScoreOverrides', v_missing,
    'conflictOverrides', v_conflicts
  );
end;
$$;

revoke all on function public.finalize_phase1_competition(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.finalize_phase1_competition(uuid, uuid, text) to service_role;

create or replace function public.mark_score_conflict_resolved(
  p_actor uuid,
  p_conflict_id uuid,
  p_choice text,
  p_value jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conflict public.score_conflicts%rowtype;
  v_league_id uuid;
begin
  select * into v_conflict from public.score_conflicts
  where id = p_conflict_id for update;
  if not found then raise exception 'conflict not found' using errcode = 'P0002'; end if;
  if v_conflict.status <> 'open' then
    return jsonb_build_object('status', 'duplicate', 'conflictId', p_conflict_id);
  end if;
  if p_choice not in ('local', 'server', 'manual') then
    raise exception 'invalid conflict choice' using errcode = '23514';
  end if;
  if not app.actor_is_event_director(p_actor, v_conflict.event_id) then
    raise exception 'event director role required' using errcode = '42501';
  end if;
  select league_id into v_league_id from public.events where id = v_conflict.event_id;

  update public.score_conflicts set
    status = 'resolved', resolution_choice = p_choice,
    resolution_value = p_value, resolution_reason = trim(p_reason),
    resolved_by = p_actor, resolved_at = now()
  where id = p_conflict_id;

  insert into public.audit_events (
    actor_profile_id, action, scope_league_id, scope_event_id,
    target_type, target_id, reason, after_json
  ) values (
    p_actor, 'score_conflict.resolved', v_league_id, v_conflict.event_id,
    'score_conflict', p_conflict_id, trim(p_reason),
    jsonb_build_object('choice', p_choice, 'value', p_value)
  );
  return jsonb_build_object('status', 'resolved', 'conflictId', p_conflict_id);
end;
$$;

revoke all on function public.mark_score_conflict_resolved(uuid, uuid, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.mark_score_conflict_resolved(uuid, uuid, text, jsonb, text)
  to service_role;
