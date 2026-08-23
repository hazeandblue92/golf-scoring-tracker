-- Migration 31: make portable recovery one fresh-project transaction and
-- close the remaining sealed-artifact mutation paths.

-- An UPDATE must protect both the source and destination competition. The
-- migration-26 guard looked only at NEW, which allowed a service writer to
-- move a sealed row to an unsealed competition.
create or replace function app.enforce_sealed_projection_header()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_competition_id uuid;
  v_new_competition_id uuid;
begin
  if coalesce(current_setting('app.allow_finalized_projection_restore', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op <> 'INSERT' then v_old_competition_id := old.competition_id; end if;
  if tg_op <> 'DELETE' then v_new_competition_id := new.competition_id; end if;
  if exists (
    select 1
    from public.competitions competition
    where competition.id in (v_old_competition_id, v_new_competition_id)
      and competition.status in ('finalized', 'archived')
  ) then
    raise exception 'sealed competition projections are immutable; reopen or use the atomic fresh-project restore RPC'
      using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function app.enforce_sealed_projection_result()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_competition_id uuid;
  v_new_competition_id uuid;
begin
  if coalesce(current_setting('app.allow_finalized_projection_restore', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op <> 'INSERT' then v_old_competition_id := old.competition_id; end if;
  if tg_op <> 'DELETE' then v_new_competition_id := new.competition_id; end if;
  if exists (
    select 1
    from public.competitions competition
    where competition.id in (v_old_competition_id, v_new_competition_id)
      and competition.status in ('finalized', 'archived')
  ) then
    raise exception 'sealed competition projection results are immutable; reopen or use the atomic fresh-project restore RPC'
      using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- Once sealed, the result hash and its provenance are one immutable tuple.
-- The only exception is the audited reopen wrapper below (or an atomic fresh
-- restore before any league exists).
create or replace function app.enforce_sealed_competition_metadata()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status not in ('finalized', 'archived') then
    return new;
  end if;
  if coalesce(current_setting('app.allow_finalized_projection_restore', true), '') = 'on'
    or coalesce(current_setting('app.allow_competition_reopen', true), '') = 'on'
  then
    return new;
  end if;

  -- Archiving/unarchiving preserves the exact sealed tuple. It does not
  -- authorize changing the claimed result or provenance.
  if new.status in ('finalized', 'archived')
    and new.final_result_hash is not distinct from old.final_result_hash
    and new.engine_version is not distinct from old.engine_version
    and new.finalized_at is not distinct from old.finalized_at
    and new.finalized_by is not distinct from old.finalized_by
    and new.finalized_revision is not distinct from old.finalized_revision
  then
    return new;
  end if;

  raise exception 'sealed competition metadata is immutable; use the audited reopen workflow'
    using errcode = '23514';
end;
$$;

drop trigger if exists competitions_sealed_metadata_guard on public.competitions;
create trigger competitions_sealed_metadata_guard
  before update of status, final_result_hash, engine_version,
    finalized_at, finalized_by, finalized_revision
  on public.competitions
  for each row execute function app.enforce_sealed_competition_metadata();

revoke all on function app.enforce_sealed_competition_metadata()
  from public, anon, authenticated;

-- Preserve migration 25's audited implementation as a private core, and put
-- the narrowly scoped metadata bypass only around calls through the public
-- service-role workflow.
alter function public.reopen_competition(uuid, uuid, text) set schema app;
revoke all on function app.reopen_competition(uuid, uuid, text)
  from public, anon, authenticated, service_role;

create function public.reopen_competition(
  p_actor uuid,
  p_competition_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if coalesce((select auth.role()), '') <> 'service_role'
    and session_user <> 'postgres'
  then
    raise exception 'service role required' using errcode = '42501';
  end if;

  perform set_config('app.allow_competition_reopen', 'on', true);
  v_result := app.reopen_competition(p_actor, p_competition_id, p_reason);
  perform set_config('app.allow_competition_reopen', '', true);
  return v_result;
end;
$$;

revoke all on function public.reopen_competition(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.reopen_competition(uuid, uuid, text)
  to service_role;

comment on function public.reopen_competition(uuid, uuid, text) is
  'MFA-gated Edge workflow entrypoint. It alone may clear an exact sealed result tuple and delegates to the audited lifecycle implementation.';

-- Restore every portable table in one database transaction. A valid call is
-- accepted only before the target contains any league, so the temporary GUC
-- exceptions cannot append facts to a live or partially restored deployment.
create or replace function public.restore_portable_export(p_tables jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order constant text[] := array[
    'leagues',
    'seasons',
    'participants',
    'participant_handicaps',
    'teams',
    'team_members',
    'courses',
    'course_layouts',
    'tee_sets',
    'tee_holes',
    'events',
    'rounds',
    'event_tee_snapshots',
    'event_holes',
    'flights',
    'event_entries',
    'event_teams',
    'event_team_members',
    'groups',
    'group_members',
    'competitions',
    'competition_rounds',
    'competition_entities',
    'matches',
    'individual_hole_scores',
    'team_hole_scores',
    'competition_projections',
    'leaderboard_rows',
    'hole_results'
  ];
  v_table text;
  v_rows jsonb;
  v_count bigint;
  v_total bigint := 0;
  v_counts jsonb := '{}'::jsonb;
begin
  if coalesce((select auth.role()), '') <> 'service_role'
    and session_user <> 'postgres'
  then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_tables) <> 'object' then
    raise exception 'portable restore tables must be an object'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_each(p_tables) supplied(key, value)
    where not supplied.key = any(v_order || array['score_conflicts'])
      or jsonb_typeof(supplied.value) <> 'array'
  ) then
    raise exception 'portable restore contains an unknown table or non-array table value'
      using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_tables -> 'leagues', '[]'::jsonb)) <> 1 then
    raise exception 'portable restore must contain exactly one league'
      using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_tables -> 'score_conflicts', '[]'::jsonb)) <> 0 then
    raise exception 'open or resolved score conflicts are not portable authority'
      using errcode = '22023';
  end if;

  -- Identity authority is deliberately excluded. These checks happen before
  -- the first insert and do not trust the client-side integrity hash alone.
  if exists (
    select 1
    from jsonb_populate_recordset(
      null::public.participants,
      coalesce(p_tables -> 'participants', '[]'::jsonb)
    ) restored
    where restored.profile_id is not null
      or restored.organizer_notes is not null
  ) or exists (
    select 1
    from jsonb_populate_recordset(
      null::public.participant_handicaps,
      coalesce(p_tables -> 'participant_handicaps', '[]'::jsonb)
    ) restored
    where restored.verified_by is not null
  ) or exists (
    select 1
    from jsonb_populate_recordset(
      null::public.events,
      coalesce(p_tables -> 'events', '[]'::jsonb)
    ) restored
    where restored.created_by is not null
  ) or exists (
    select 1
    from jsonb_populate_recordset(
      null::public.groups,
      coalesce(p_tables -> 'groups', '[]'::jsonb)
    ) restored
    where restored.marker_profile_id is not null
  ) or exists (
    select 1
    from jsonb_populate_recordset(
      null::public.competitions,
      coalesce(p_tables -> 'competitions', '[]'::jsonb)
    ) restored
    where restored.finalized_by is not null
  ) or exists (
    select 1
    from jsonb_populate_recordset(
      null::public.matches,
      coalesce(p_tables -> 'matches', '[]'::jsonb)
    ) restored
    where restored.concession_by is not null
  ) or exists (
    select 1
    from jsonb_populate_recordset(
      null::public.individual_hole_scores,
      coalesce(p_tables -> 'individual_hole_scores', '[]'::jsonb)
    ) restored
    where restored.entered_by is not null
      or restored.device_id_hash is not null
  ) or exists (
    select 1
    from jsonb_populate_recordset(
      null::public.team_hole_scores,
      coalesce(p_tables -> 'team_hole_scores', '[]'::jsonb)
    ) restored
    where restored.entered_by is not null
      or restored.device_id_hash is not null
  ) then
    raise exception 'portable restore contains identity-linked authority'
      using errcode = '22023';
  end if;

  -- Serialize the empty-target decision with any competing league insert.
  lock table public.leagues in share row exclusive mode;
  if exists (select 1 from public.leagues) then
    raise exception 'portable restore requires a fresh target with no league data'
      using errcode = '23514';
  end if;

  perform set_config('app.allow_finalized_score_restore', 'on', true);
  perform set_config('app.allow_finalized_match_restore', 'on', true);
  perform set_config('app.allow_finalized_projection_restore', 'on', true);

  foreach v_table in array v_order loop
    v_rows := coalesce(p_tables -> v_table, '[]'::jsonb);
    if jsonb_array_length(v_rows) = 0 then
      continue;
    end if;
    execute format(
      'insert into public.%I select restored.* from jsonb_populate_recordset(null::public.%I, $1) restored',
      v_table,
      v_table
    ) using v_rows;
    get diagnostics v_count = row_count;
    v_counts := v_counts || jsonb_build_object(v_table, v_count);
    v_total := v_total + v_count;
  end loop;

  -- Schema-v1 exports made before finalized_revision existed are repaired from
  -- the exact restored hash. Older live-labelled sealed headers are normalized
  -- only inside this fresh-target transaction.
  update public.competition_projections projection
  set status = 'final'
  from public.competitions competition
  where competition.id = projection.competition_id
    and competition.status in ('finalized', 'archived')
    and projection.projection_hash = competition.final_result_hash
    and projection.engine_version = competition.engine_version;

  update public.competitions competition
  set finalized_revision = (
    select max(projection.event_revision)
    from public.competition_projections projection
    where projection.competition_id = competition.id
      and projection.projection_hash = competition.final_result_hash
      and projection.engine_version = competition.engine_version
      and projection.status = 'final'
  )
  where competition.status in ('finalized', 'archived')
    and competition.id in (
      select restored.id
      from jsonb_populate_recordset(
        null::public.competitions,
        coalesce(p_tables -> 'competitions', '[]'::jsonb)
      ) restored
    );

  if exists (
    select 1
    from public.competitions competition
    where competition.id in (
      select restored.id
      from jsonb_populate_recordset(
        null::public.competitions,
        coalesce(p_tables -> 'competitions', '[]'::jsonb)
      ) restored
    )
      and competition.status in ('finalized', 'archived')
      and (
        competition.final_result_hash is null
        or competition.finalized_revision is null
        or not exists (
          select 1
          from public.competition_projections projection
          where projection.competition_id = competition.id
            and projection.event_revision = competition.finalized_revision
            and projection.projection_hash = competition.final_result_hash
            and projection.engine_version = competition.engine_version
            and projection.status = 'final'
        )
        or exists (
          select 1
          from public.competition_projections later
          where later.competition_id = competition.id
            and later.event_revision > competition.finalized_revision
        )
      )
  ) then
    raise exception 'portable restore does not contain an exact terminal sealed projection'
      using errcode = '23514';
  end if;

  perform set_config('app.allow_finalized_score_restore', '', true);
  perform set_config('app.allow_finalized_match_restore', '', true);
  perform set_config('app.allow_finalized_projection_restore', '', true);

  return jsonb_build_object(
    'status', 'restored',
    'totalRows', v_total,
    'counts', v_counts
  );
end;
$$;

revoke all on function public.restore_portable_export(jsonb)
  from public, anon, authenticated;
grant execute on function public.restore_portable_export(jsonb)
  to service_role;

-- The migration-26 component helpers were useful while recovery was split
-- across requests. Service callers now get only the all-or-nothing entrypoint.
revoke execute on function public.restore_portable_matches(jsonb)
  from service_role;
revoke execute on function public.restore_portable_individual_scores(jsonb)
  from service_role;
revoke execute on function public.restore_portable_team_scores(jsonb)
  from service_role;
revoke execute on function public.restore_portable_projection_artifact(
  jsonb, jsonb, jsonb
) from service_role;

comment on function public.restore_portable_export(jsonb) is
  'Service-only disaster recovery entrypoint. Validates identity exclusion and restores one export atomically into a target with no league data.';
