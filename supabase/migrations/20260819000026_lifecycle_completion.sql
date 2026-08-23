-- Migration 26: complete independent competition lifecycle enforcement.
--
-- Migration 25 introduced independent finalization. This append-only follow-up
-- makes the lifecycle boundaries exact: only score fact kinds actually read
-- by a sealed competition are locked, hole-scoped competitions validate only
-- their authoritative holes, the sealed projection revision cannot be
-- replaced, and all non-cancelled rounds reach a terminal state with the last
-- competition.

-- Record the event revision whose exact projection hash was sealed. Older
-- finalized rows are backfilled from their final artifact, with the event
-- revision as a conservative fallback for pre-two-stage imports.
alter table public.competitions
  add column if not exists finalized_revision bigint;

update public.competitions c
set finalized_revision = coalesce(
  (
    select max(cp.event_revision)
    from public.competition_projections cp
    where cp.competition_id = c.id
      and cp.projection_hash = c.final_result_hash
      and cp.status = 'final'
  ),
  (
    select e.scoring_revision
    from public.events e
    where e.id = c.event_id
  )
)
where c.status in ('finalized', 'archived')
  and c.finalized_revision is null;

comment on column public.competitions.finalized_revision is
  'Event scoring revision of the exact final projection sealed by final_result_hash. Cleared by an audited reopen.';

-- Capture and clear the sealed revision on the same state transitions that
-- set and clear final_result_hash. This also keeps restores of older portable
-- exports compatible: a missing revision is reconstructed from the restored
-- event row before projection history is inserted.
create or replace function app.manage_competition_finalized_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('app.allow_finalized_projection_restore', true), '') = 'on' then
    return new;
  end if;

  if new.status in ('finalized', 'archived')
    and new.finalized_revision is null
    and (tg_op = 'INSERT' or old.status <> 'finalized')
  then
    select e.scoring_revision into new.finalized_revision
    from public.events e
    where e.id = new.event_id;
  elsif tg_op = 'UPDATE'
    and old.status = 'finalized'
    and new.status = 'scoring_closed'
  then
    new.finalized_revision := null;
    perform set_config('app.allow_scoring_revision_change', 'on', true);
    update public.events
    set scoring_revision = scoring_revision + 1
    where id = new.event_id;
    perform set_config('app.allow_scoring_revision_change', '', true);
  elsif tg_op = 'UPDATE'
    and old.status = 'finalized'
    and new.status = 'finalized'
    and new.finalized_revision is distinct from old.finalized_revision
  then
    raise exception 'a sealed competition revision is immutable; reopen first'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists competitions_finalized_revision on public.competitions;
create trigger competitions_finalized_revision
  before insert or update of status, finalized_revision
  on public.competitions
  for each row execute function app.manage_competition_finalized_revision();

-- A score intersects a competition only when that exact raw fact kind is an
-- engine input. Team-ball formats do not consume member cards; individual-
-- source team formats do not consume the parallel team-ball table.
create or replace function app.score_fact_intersects_competition(
  p_competition_id uuid,
  p_round_id uuid,
  p_hole_id uuid,
  p_entry_id uuid,
  p_team_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.competitions c
    join public.competition_rounds cr
      on cr.competition_id = c.id
     and cr.round_id = p_round_id
    join public.event_holes eh
      on eh.id = p_hole_id
     and eh.round_id = cr.round_id
    join public.competition_entities ce
      on ce.competition_id = c.id
     and ce.eligibility_status = 'eligible'
    where c.id = p_competition_id
      and case
        when cr.hole_scope is not null then
          cardinality(cr.hole_scope) = 0
          or eh.hole_ordinal = any(cr.hole_scope)
        when jsonb_typeof(c.rules_json -> 'holeScope') = 'array'
          and jsonb_array_length(c.rules_json -> 'holeScope') > 0 then
          exists (
            select 1
            from jsonb_array_elements_text(c.rules_json -> 'holeScope') scope(value)
            where scope.value::integer = eh.hole_ordinal
          )
        else true
      end
      and (
        (
          p_entry_id is not null
          and (
            ce.event_entry_id = p_entry_id
            or (
              ce.event_team_id is not null
              and (
                c.format in ('best_k', 'aggregate', 'shamble')
                or (
                  c.format = 'match'
                  and c.rules_json #>> '{team,scoreSource}' = 'individual'
                )
              )
              and exists (
                select 1
                from public.event_team_members etm
                where etm.event_team_id = ce.event_team_id
                  and etm.event_entry_id = p_entry_id
              )
            )
          )
        )
        or (
          p_team_id is not null
          and ce.event_team_id = p_team_id
          and (
            c.format in ('scramble', 'foursomes', 'greensomes', 'chapman')
            or (
              c.format = 'skins'
              and c.rules_json #>> '{skins,population}' = 'teams'
            )
            or (
              c.format = 'match'
              and c.rules_json #>> '{team,scoreSource}' = 'team_ball'
            )
          )
        )
      )
  );
$$;

revoke all on function app.score_fact_intersects_competition(
  uuid, uuid, uuid, uuid, uuid
) from public, anon, authenticated;

create or replace function app.score_fact_intersects_finalized_competition(
  p_event_id uuid,
  p_round_id uuid,
  p_hole_id uuid,
  p_entry_id uuid,
  p_team_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.competitions c
    where c.event_id = p_event_id
      and c.status in ('finalized', 'archived')
      and app.score_fact_intersects_competition(
        c.id,
        p_round_id,
        p_hole_id,
        p_entry_id,
        p_team_id
      )
  );
$$;

revoke all on function app.score_fact_intersects_finalized_competition(
  uuid, uuid, uuid, uuid, uuid
) from public, anon, authenticated;

-- Sealed projections are historical artifacts. Normal projection building
-- already skips finalized competitions; these triggers make that rule true
-- even for a mistaken service-role publish. A dedicated fresh-project restore
-- RPC below is the only bypass.
create or replace function app.enforce_sealed_projection_header()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_competition_id uuid := case when tg_op = 'DELETE' then old.competition_id else new.competition_id end;
  v_status text;
begin
  if coalesce(current_setting('app.allow_finalized_projection_restore', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  select c.status
  into v_status
  from public.competitions c
  where c.id = v_competition_id;

  if v_status in ('finalized', 'archived') then
    raise exception 'sealed competition projections are immutable; reopen or use the fresh-project restore RPC'
      using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists competition_projections_sealed_revision_guard
  on public.competition_projections;
create trigger competition_projections_sealed_revision_guard
  before insert or update or delete on public.competition_projections
  for each row execute function app.enforce_sealed_projection_header();

create or replace function app.enforce_sealed_projection_result()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_competition_id uuid := case when tg_op = 'DELETE' then old.competition_id else new.competition_id end;
  v_status text;
begin
  if coalesce(current_setting('app.allow_finalized_projection_restore', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  select c.status
  into v_status
  from public.competitions c
  where c.id = v_competition_id;

  if v_status in ('finalized', 'archived') then
    raise exception 'sealed competition projection results are immutable; reopen or use the fresh-project restore RPC'
      using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists leaderboard_rows_sealed_revision_guard
  on public.leaderboard_rows;
create trigger leaderboard_rows_sealed_revision_guard
  before insert or update or delete on public.leaderboard_rows
  for each row execute function app.enforce_sealed_projection_result();

drop trigger if exists hole_results_sealed_revision_guard
  on public.hole_results;
create trigger hole_results_sealed_revision_guard
  before insert or update or delete on public.hole_results
  for each row execute function app.enforce_sealed_projection_result();

revoke all on function app.manage_competition_finalized_revision()
  from public, anon, authenticated;
revoke all on function app.enforce_sealed_projection_header()
  from public, anon, authenticated;
revoke all on function app.enforce_sealed_projection_result()
  from public, anon, authenticated;

-- Finalized match facts use the same fresh-project restore boundary as raw
-- scores and projections. Outside this transaction-local bypass, migration
-- 24's match trigger continues to reject every INSERT/UPDATE/DELETE.
create or replace function app.enforce_finalized_match_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old_competition_id uuid;
  v_new_competition_id uuid;
begin
  if coalesce(current_setting('app.allow_finalized_match_restore', true), '') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op <> 'INSERT' then v_old_competition_id := old.competition_id; end if;
  if tg_op <> 'DELETE' then v_new_competition_id := new.competition_id; end if;
  if exists (
    select 1
    from public.competitions c
    join public.events e on e.id = c.event_id
    where c.id in (v_old_competition_id, v_new_competition_id)
      and (
        c.status in ('finalized', 'archived')
        or e.status in ('finalized', 'archived')
      )
  ) then
    raise exception 'finalized match facts are immutable; reopen first'
      using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.restore_portable_matches(p_rows jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restored bigint;
begin
  if coalesce((select auth.role()), '') <> 'service_role'
    and session_user <> 'postgres'
  then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'match restore payload must be an array' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_populate_recordset(null::public.matches, p_rows) restored
    where restored.concession_by is not null
  ) then
    raise exception 'portable match identities must be sanitized'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_populate_recordset(null::public.matches, p_rows) restored
    join public.competitions c on c.id = restored.competition_id
    where exists (
      select 1
      from public.audit_events audit
      where audit.scope_event_id = c.event_id
    )
      or exists (
        select 1
        from public.competitions event_competition
        join public.competition_projections cp
          on cp.competition_id = event_competition.id
        where event_competition.event_id = c.event_id
      )
  ) then
    raise exception 'portable matches may only be restored before event audit and projection history'
      using errcode = '23514';
  end if;

  perform set_config('app.allow_finalized_match_restore', 'on', true);
  insert into public.matches
  select restored.*
  from jsonb_populate_recordset(null::public.matches, p_rows) restored;
  get diagnostics v_restored = row_count;
  return v_restored;
end;
$$;

revoke all on function public.restore_portable_matches(jsonb)
  from public, anon, authenticated;
grant execute on function public.restore_portable_matches(jsonb)
  to service_role;

-- The migration 24 provenance guard remains authoritative during normal
-- publishing. The restore GUC is accepted only inside the guarded RPC below,
-- allowing historical rows from an older engine to be reconstructed before
-- the exact sealed header is validated.
create or replace function app.enforce_projection_engine_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_comp public.competitions%rowtype;
begin
  if coalesce(current_setting('app.allow_finalized_projection_restore', true), '') = 'on' then
    return new;
  end if;

  select * into v_comp
  from public.competitions
  where id = new.competition_id
  for update;

  if not found then
    raise exception 'competition not found for projection' using errcode = '23503';
  end if;

  if v_comp.status = 'finalized' and v_comp.engine_version <> new.engine_version then
    raise exception
      'finalized competition engine version mismatch: stored %, attempted %',
      v_comp.engine_version, new.engine_version
      using errcode = '23514';
  end if;

  if v_comp.status = 'finalized'
    and v_comp.final_result_hash is not null
    and v_comp.final_result_hash <> new.projection_hash
  then
    raise exception
      'finalized competition projection hash mismatch: stored %, attempted %',
      v_comp.final_result_hash, new.projection_hash
      using errcode = '23514';
  end if;

  if v_comp.status <> 'finalized' and v_comp.engine_version <> new.engine_version then
    update public.competitions
      set engine_version = new.engine_version, updated_at = now()
    where id = new.competition_id;
  end if;
  return new;
end;
$$;

-- Replace migration 25's score restore helpers with a fresh-project guard.
-- Finalized score inputs may be bypassed only before that event has any audit
-- or projection history in the target project. Each helper remains INSERT-
-- only, so an existing raw fact can never be rewritten through this path.
create or replace function public.restore_portable_individual_scores(p_rows jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restored bigint;
begin
  if coalesce((select auth.role()), '') <> 'service_role'
    and session_user <> 'postgres'
  then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'score restore payload must be an array' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_populate_recordset(null::public.individual_hole_scores, p_rows) restored
    where exists (
      select 1
      from public.audit_events audit
      where audit.scope_event_id = restored.event_id
    )
      or exists (
        select 1
        from public.competitions c
        join public.competition_projections cp on cp.competition_id = c.id
        where c.event_id = restored.event_id
      )
  ) then
    raise exception 'portable scores may only be restored before event audit and projection history'
      using errcode = '23514';
  end if;

  perform set_config('app.allow_finalized_score_restore', 'on', true);
  insert into public.individual_hole_scores
  select restored.*
  from jsonb_populate_recordset(
    null::public.individual_hole_scores,
    p_rows
  ) restored;
  get diagnostics v_restored = row_count;
  return v_restored;
end;
$$;

create or replace function public.restore_portable_team_scores(p_rows jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restored bigint;
begin
  if coalesce((select auth.role()), '') <> 'service_role'
    and session_user <> 'postgres'
  then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'score restore payload must be an array' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_populate_recordset(null::public.team_hole_scores, p_rows) restored
    where exists (
      select 1
      from public.audit_events audit
      where audit.scope_event_id = restored.event_id
    )
      or exists (
        select 1
        from public.competitions c
        join public.competition_projections cp on cp.competition_id = c.id
        where c.event_id = restored.event_id
      )
  ) then
    raise exception 'portable scores may only be restored before event audit and projection history'
      using errcode = '23514';
  end if;

  perform set_config('app.allow_finalized_score_restore', 'on', true);
  insert into public.team_hole_scores
  select restored.*
  from jsonb_populate_recordset(
    null::public.team_hole_scores,
    p_rows
  ) restored;
  get diagnostics v_restored = row_count;
  return v_restored;
end;
$$;

revoke all on function public.restore_portable_individual_scores(jsonb)
  from public, anon, authenticated;
revoke all on function public.restore_portable_team_scores(jsonb)
  from public, anon, authenticated;
grant execute on function public.restore_portable_individual_scores(jsonb)
  to service_role;
grant execute on function public.restore_portable_team_scores(jsonb)
  to service_role;

-- Restore projection headers and their children atomically. Every involved
-- competition must have no projection history in the target. For a finalized
-- competition, the payload must contain one final header matching the sealed
-- hash and no revision after it. This both supports portable recovery and
-- prevents the bypass from becoming a mutation channel on a live event.
create or replace function public.restore_portable_projection_artifact(
  p_projections jsonb,
  p_leaderboard_rows jsonb,
  p_hole_results jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_projection_count bigint;
  v_leaderboard_count bigint;
  v_hole_count bigint;
begin
  if coalesce((select auth.role()), '') <> 'service_role'
    and session_user <> 'postgres'
  then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_projections) <> 'array'
    or jsonb_typeof(p_leaderboard_rows) <> 'array'
    or jsonb_typeof(p_hole_results) <> 'array'
  then
    raise exception 'projection restore payloads must be arrays' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_populate_recordset(null::public.competition_projections, p_projections) restored
    join public.competition_projections existing
      on existing.competition_id = restored.competition_id
  ) then
    raise exception 'portable projections may only be restored before competition projection history'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_populate_recordset(null::public.leaderboard_rows, p_leaderboard_rows) child
    where not exists (
      select 1
      from jsonb_populate_recordset(null::public.competition_projections, p_projections) header
      where header.competition_id = child.competition_id
        and header.event_revision = child.event_revision
    )
  ) or exists (
    select 1
    from jsonb_populate_recordset(null::public.hole_results, p_hole_results) child
    where not exists (
      select 1
      from jsonb_populate_recordset(null::public.competition_projections, p_projections) header
      where header.competition_id = child.competition_id
        and header.event_revision = child.event_revision
    )
  ) then
    raise exception 'projection result row has no header in the restore payload'
      using errcode = '23503';
  end if;

  if exists (
    select 1
    from public.competitions c
    join (
      select distinct restored.competition_id
      from jsonb_populate_recordset(null::public.competition_projections, p_projections) restored
    ) involved on involved.competition_id = c.id
    where c.status in ('finalized', 'archived')
      and (
        not exists (
          select 1
          from jsonb_populate_recordset(null::public.competition_projections, p_projections) sealed
          where sealed.competition_id = c.id
            and sealed.projection_hash = c.final_result_hash
            and sealed.engine_version = c.engine_version
        )
        or exists (
          select 1
          from jsonb_populate_recordset(null::public.competition_projections, p_projections) later
          where later.competition_id = c.id
            and later.event_revision > (
              select max(sealed.event_revision)
              from jsonb_populate_recordset(null::public.competition_projections, p_projections) sealed
              where sealed.competition_id = c.id
                and sealed.projection_hash = c.final_result_hash
                and sealed.engine_version = c.engine_version
            )
        )
      )
  ) then
    raise exception 'finalized projection payload does not terminate at the sealed hash'
      using errcode = '23514';
  end if;

  perform set_config('app.allow_finalized_projection_restore', 'on', true);

  update public.competitions c
  set finalized_revision = (
    select max(sealed.event_revision)
    from jsonb_populate_recordset(null::public.competition_projections, p_projections) sealed
    where sealed.competition_id = c.id
      and sealed.projection_hash = c.final_result_hash
      and sealed.engine_version = c.engine_version
  )
  where c.status in ('finalized', 'archived')
    and exists (
      select 1
      from jsonb_populate_recordset(null::public.competition_projections, p_projections) involved
      where involved.competition_id = c.id
    );

  insert into public.competition_projections
  select restored.*
  from jsonb_populate_recordset(
    null::public.competition_projections,
    p_projections
  ) restored;
  get diagnostics v_projection_count = row_count;

  -- Schema-v1 exports produced before two-stage finalization may label the
  -- exact sealed header live even though final_result_hash proves it is the
  -- terminal artifact. Normalize only that hash inside the guarded restore.
  update public.competition_projections cp
  set status = 'final'
  from public.competitions c
  where c.id = cp.competition_id
    and c.status in ('finalized', 'archived')
    and cp.projection_hash = c.final_result_hash
    and cp.event_revision = c.finalized_revision;

  insert into public.leaderboard_rows
  select restored.*
  from jsonb_populate_recordset(
    null::public.leaderboard_rows,
    p_leaderboard_rows
  ) restored;
  get diagnostics v_leaderboard_count = row_count;

  insert into public.hole_results
  select restored.*
  from jsonb_populate_recordset(
    null::public.hole_results,
    p_hole_results
  ) restored;
  get diagnostics v_hole_count = row_count;

  return jsonb_build_object(
    'status', 'restored',
    'projections', v_projection_count,
    'leaderboardRows', v_leaderboard_count,
    'holeResults', v_hole_count
  );
end;
$$;

revoke all on function public.restore_portable_projection_artifact(jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.restore_portable_projection_artifact(jsonb, jsonb, jsonb)
  to service_role;

-- The finalizer definition below is migration 25's authoritative blocker
-- logic with scoped-hole validation and complete terminal round handling.
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
  v_match_blockers integer := 0;
  v_carry_blockers integer := 0;
  v_projection_hash text;
  v_projection_engine_version text;
  v_projection_status text;
  v_projection_warnings jsonb;
  v_best_k integer;
begin
  select * into v_comp from public.competitions
  where id = p_competition_id for update;
  if not found then raise exception 'competition not found' using errcode = 'P0002'; end if;
  if not app.actor_is_event_director(p_actor, v_comp.event_id) then
    raise exception 'event director role required' using errcode = '42501';
  end if;
  select * into v_event from public.events where id = v_comp.event_id for update;

  if v_comp.status = 'finalized' then
    return jsonb_build_object(
      'status', 'finalized',
      'eventId', v_event.id,
      'competitionId', p_competition_id,
      'finalResultHash', v_comp.final_result_hash,
      'engineVersion', v_comp.engine_version
    );
  end if;
  if v_event.status not in ('scoring_open', 'scoring_closed') then
    raise exception 'event must be open or closed for scoring' using errcode = '23514';
  end if;
  -- Report an unscorable competition directly instead of letting the sealing
  -- update below fail against the transition trigger.
  if v_comp.status not in ('scoring_open', 'scoring_closed') then
    raise exception 'competition must be open or closed for scoring, not %', v_comp.status
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from public.competition_rounds cr
    where cr.competition_id = p_competition_id
  ) then
    raise exception 'competition has no authoritative round scope'
      using errcode = '23514';
  end if;

  -- A current projection is required before the workflow changes lifecycle
  -- state. This prevents a failed preflight from silently closing scoring.
  select projection_hash, engine_version, status, warnings
    into v_projection_hash, v_projection_engine_version,
      v_projection_status, v_projection_warnings
  from public.competition_projections
  where competition_id = p_competition_id
    and event_revision = v_event.scoring_revision
    and status <> 'error';
  if v_projection_hash is null then
    return jsonb_build_object(
      'status', 'blocked', 'projectionStale', true,
      'missingScores', 0, 'openConflicts', 0,
      'unattestedCards', 0, 'matchBlockers', 0, 'carryBlockers', 0
    );
  end if;

  if v_comp.format = 'match' then
    -- Match completion is defined by the pairing lifecycle, not by eighteen
    -- stroke-card holes: clinched and conceded matches intentionally leave
    -- later holes unplayed. A competition with no pairing is also unresolved.
    select case
      when count(*) = 0 then 1
      else count(*) filter (
        where status not in ('complete', 'conceded', 'walkover')
      )
    end::integer
    into v_match_blockers
    from public.matches
    where competition_id = p_competition_id;
  elsif v_comp.format in ('best_k', 'aggregate', 'shamble') then
    v_best_k := coalesce((v_comp.rules_json #>> '{team,bestK}')::integer, 1);
    select count(*) into v_missing
    from public.competition_entities ce
    join public.competition_rounds cr on cr.competition_id = ce.competition_id
    join public.event_teams et on et.id = ce.event_team_id
    join public.event_holes eh on eh.round_id = cr.round_id
    where ce.competition_id = p_competition_id
      and ce.event_team_id is not null
      and ce.eligibility_status = 'eligible'
      and et.status = 'active'
      and case
        when cr.hole_scope is not null then
          cardinality(cr.hole_scope) = 0
          or eh.hole_ordinal = any(cr.hole_scope)
        when jsonb_typeof(v_comp.rules_json -> 'holeScope') = 'array'
          and jsonb_array_length(v_comp.rules_json -> 'holeScope') > 0 then
          exists (
            select 1
            from jsonb_array_elements_text(v_comp.rules_json -> 'holeScope') scope(value)
            where scope.value::integer = eh.hole_ordinal
          )
        else true
      end
      and (
        select count(*)
        from public.event_team_members etm
        join public.individual_hole_scores s
          on s.event_entry_id = etm.event_entry_id
         and s.event_hole_id = eh.id
         and s.score_status <> 'not_started'
        where etm.event_team_id = ce.event_team_id
      ) < v_best_k;
  elsif v_comp.format in ('scramble', 'foursomes', 'greensomes', 'chapman')
    or (v_comp.format = 'skins' and v_comp.rules_json #>> '{skins,population}' = 'teams')
  then
    select count(*) into v_missing
    from public.competition_entities ce
    join public.competition_rounds cr on cr.competition_id = ce.competition_id
    join public.event_teams et on et.id = ce.event_team_id
    join public.event_holes eh on eh.round_id = cr.round_id
    where ce.competition_id = p_competition_id
      and ce.event_team_id is not null
      and ce.eligibility_status = 'eligible'
      and et.status = 'active'
      and case
        when cr.hole_scope is not null then
          cardinality(cr.hole_scope) = 0
          or eh.hole_ordinal = any(cr.hole_scope)
        when jsonb_typeof(v_comp.rules_json -> 'holeScope') = 'array'
          and jsonb_array_length(v_comp.rules_json -> 'holeScope') > 0 then
          exists (
            select 1
            from jsonb_array_elements_text(v_comp.rules_json -> 'holeScope') scope(value)
            where scope.value::integer = eh.hole_ordinal
          )
        else true
      end
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
    join public.rounds r on r.id = cr.round_id
    join public.event_entries ee on ee.id = ce.event_entry_id
    join public.event_holes eh on eh.round_id = cr.round_id
    where ce.competition_id = p_competition_id
      and ce.event_entry_id is not null
      and ce.eligibility_status = 'eligible'
      and ee.status = 'active'
      and case
        when cr.hole_scope is not null then
          cardinality(cr.hole_scope) = 0
          or eh.hole_ordinal = any(cr.hole_scope)
        when jsonb_typeof(v_comp.rules_json -> 'holeScope') = 'array'
          and jsonb_array_length(v_comp.rules_json -> 'holeScope') > 0 then
          exists (
            select 1
            from jsonb_array_elements_text(v_comp.rules_json -> 'holeScope') scope(value)
            where scope.value::integer = eh.hole_ordinal
          )
        else true
      end
      and (
        ee.effective_from_round_id is null
        or exists (
          select 1 from public.rounds entry_start
          where entry_start.id = ee.effective_from_round_id
            and entry_start.round_number <= r.round_number
        )
      )
      and not exists (
        select 1
        from public.event_entries successor
        join public.rounds successor_start
          on successor_start.id = successor.effective_from_round_id
        where successor.replaces_entry_id = ee.id
          and successor_start.round_number <= r.round_number
      )
      and not exists (
        select 1 from public.individual_hole_scores s
        where s.event_entry_id = ce.event_entry_id
          and s.event_hole_id = eh.id
          and s.score_status <> 'not_started'
      );
  end if;

  -- Only conflicts over this competition's own inputs block it. A dispute on
  -- a hole or player that this competition never reads belongs to whichever
  -- sibling competition actually scores it.
  select count(*) into v_conflicts
  from public.score_conflicts sc
  where sc.event_id = v_event.id
    and sc.status = 'open'
    and app.score_fact_intersects_competition(
      p_competition_id,
      sc.round_id,
      sc.event_hole_id,
      sc.event_entry_id,
      sc.event_team_id
    );

  if v_comp.format = 'skins' then
    select count(*) into v_carry_blockers
    from jsonb_array_elements(coalesce(v_projection_warnings, '[]'::jsonb)) warning
    where warning ->> 'code' = 'SKINS_SUDDEN_DEATH_PENDING';
  end if;

  if v_comp.format = 'match' then
    select count(*) into v_unattested
    from (
      -- Individual sides always use their own card.
      select distinct
        m.round_id,
        ce.event_entry_id,
        null::uuid as event_team_id
      from public.matches m
      join public.competition_entities ce
        on ce.id in (m.side_a_entity_id, m.side_b_entity_id)
      where m.competition_id = p_competition_id
        and ce.eligibility_status = 'eligible'
        and ce.event_entry_id is not null
      union
      -- Team best-ball is frozen explicitly in Terms and requires each
      -- member card that actually supplied a score.
      select distinct
        m.round_id,
        etm.event_entry_id,
        null::uuid as event_team_id
      from public.matches m
      join public.competition_entities ce
        on ce.id in (m.side_a_entity_id, m.side_b_entity_id)
      join public.event_teams et
        on et.id = ce.event_team_id and et.status = 'active'
      join public.event_team_members etm on etm.event_team_id = ce.event_team_id
      where m.competition_id = p_competition_id
        and ce.eligibility_status = 'eligible'
        and ce.event_team_id is not null
        and v_comp.rules_json #>> '{team,scoreSource}' = 'individual'
      union
      -- Team-ball matches use one team card and therefore require a team
      -- attestation, not attestations for unrelated member cards.
      select distinct
        m.round_id,
        null::uuid as event_entry_id,
        ce.event_team_id
      from public.matches m
      join public.competition_entities ce
        on ce.id in (m.side_a_entity_id, m.side_b_entity_id)
      join public.event_teams et
        on et.id = ce.event_team_id and et.status = 'active'
      where m.competition_id = p_competition_id
        and ce.eligibility_status = 'eligible'
        and ce.event_team_id is not null
        and v_comp.rules_json #>> '{team,scoreSource}' = 'team_ball'
    ) cards
    where (
      cards.event_entry_id is not null
      and exists (
        select 1
        from public.individual_hole_scores scored
        where scored.round_id = cards.round_id
          and scored.event_entry_id = cards.event_entry_id
          and scored.score_status <> 'not_started'
      )
      and not exists (
        select 1
        from public.scorecard_attestations sa
        where sa.event_entry_id = cards.event_entry_id
          and sa.round_id = cards.round_id
          and sa.score_revision = (
            select coalesce(sum(s.revision), 0)
            from public.individual_hole_scores s
            where s.round_id = cards.round_id
              and s.event_entry_id = cards.event_entry_id
          )
      )
    ) or (
      cards.event_team_id is not null
      and exists (
        select 1
        from public.team_hole_scores scored
        where scored.round_id = cards.round_id
          and scored.event_team_id = cards.event_team_id
          and scored.score_status <> 'not_started'
      )
      and not exists (
        select 1
        from public.scorecard_attestations sa
        where sa.event_team_id = cards.event_team_id
          and sa.round_id = cards.round_id
          and sa.score_revision = (
            select coalesce(sum(s.revision), 0)
            from public.team_hole_scores s
            where s.round_id = cards.round_id
              and s.event_team_id = cards.event_team_id
          )
      )
    );
  elsif v_comp.format in ('scramble', 'foursomes', 'greensomes', 'chapman')
    or (v_comp.format = 'skins' and v_comp.rules_json #>> '{skins,population}' = 'teams')
  then
    select count(*) into v_unattested
    from public.competition_entities ce
    join public.competition_rounds cr on cr.competition_id = ce.competition_id
    join public.event_teams et on et.id = ce.event_team_id
    where ce.competition_id = p_competition_id
      and ce.event_team_id is not null
      and ce.eligibility_status = 'eligible'
      and et.status = 'active'
      and not exists (
        select 1
        from public.scorecard_attestations sa
        where sa.event_team_id = ce.event_team_id
          and sa.round_id = cr.round_id
          and sa.score_revision = (
            select coalesce(sum(s.revision), 0)
            from public.team_hole_scores s
            where s.round_id = cr.round_id
              and s.event_team_id = ce.event_team_id
          )
      );
  elsif v_comp.format in ('best_k', 'aggregate', 'shamble') then
    select count(*) into v_unattested
    from (
      select distinct cr.round_id, etm.event_entry_id
      from public.competition_entities ce
      join public.competition_rounds cr on cr.competition_id = ce.competition_id
      join public.event_teams et on et.id = ce.event_team_id
      join public.event_team_members etm on etm.event_team_id = ce.event_team_id
      join public.event_entries ee on ee.id = etm.event_entry_id
      where ce.competition_id = p_competition_id
        and ce.event_team_id is not null
        and ce.eligibility_status = 'eligible'
        and et.status = 'active'
        and ee.status = 'active'
    ) cards
    where not exists (
      select 1
      from public.scorecard_attestations sa
      where sa.event_entry_id = cards.event_entry_id
        and sa.round_id = cards.round_id
        and sa.score_revision = (
          select coalesce(sum(s.revision), 0)
          from public.individual_hole_scores s
          where s.round_id = cards.round_id
            and s.event_entry_id = cards.event_entry_id
        )
    );
  else
    select count(*) into v_unattested
    from public.competition_entities ce
    join public.competition_rounds cr on cr.competition_id = ce.competition_id
    join public.rounds r on r.id = cr.round_id
    join public.event_entries ee on ee.id = ce.event_entry_id
    where ce.competition_id = p_competition_id
      and ce.event_entry_id is not null
      and ce.eligibility_status = 'eligible'
      and ee.status = 'active'
      and (
        ee.effective_from_round_id is null
        or exists (
          select 1 from public.rounds entry_start
          where entry_start.id = ee.effective_from_round_id
            and entry_start.round_number <= r.round_number
        )
      )
      and not exists (
        select 1
        from public.event_entries successor
        join public.rounds successor_start
          on successor_start.id = successor.effective_from_round_id
        where successor.replaces_entry_id = ee.id
          and successor_start.round_number <= r.round_number
      )
      and not exists (
        select 1
        from public.scorecard_attestations sa
        where sa.event_entry_id = ee.id
          and sa.round_id = cr.round_id
          and sa.score_revision = (
            select coalesce(sum(s.revision), 0)
            from public.individual_hole_scores s
            where s.round_id = cr.round_id and s.event_entry_id = ee.id
          )
      );
  end if;

  -- A free-text committee override can document incomplete cards, conflicts,
  -- or missing attestations. It cannot manufacture a match winner or resolve
  -- a skins carry: those require an authoritative terminal/result fact before
  -- the final projection can become final.
  if v_match_blockers > 0
    or v_carry_blockers > 0
    or (
      (
        v_missing > 0
        or v_conflicts > 0
        or v_unattested > 0
      )
      and nullif(trim(coalesce(p_override_reason, '')), '') is null
    ) then
    return jsonb_build_object(
      'status', 'blocked', 'missingScores', v_missing,
      'openConflicts', v_conflicts, 'unattestedCards', v_unattested,
      'matchBlockers', v_match_blockers, 'carryBlockers', v_carry_blockers
    );
  end if;

  -- Preflight passed but the published artifact is still the live one. The
  -- caller republishes this target under final missing-data policy and calls
  -- again to seal that exact hash. Nothing changes status here, so an
  -- interrupted attempt leaves the competition exactly where it started.
  if v_projection_status <> 'final' then
    return jsonb_build_object(
      'status', 'ready',
      'eventId', v_event.id,
      'competitionId', p_competition_id,
      'missingScores', v_missing, 'openConflicts', v_conflicts,
      'unattestedCards', v_unattested,
      'matchBlockers', v_match_blockers, 'carryBlockers', v_carry_blockers
    );
  end if;

  -- Walk this competition alone through the enforced transition graph. Its
  -- siblings keep scoring; their inputs are untouched.
  if v_comp.status = 'scoring_open' then
    update public.competitions set status = 'scoring_closed'
      where id = p_competition_id;
  end if;

  update public.competitions set
    status = 'finalized', finalized_at = now(), finalized_by = p_actor,
    final_result_hash = v_projection_hash,
    engine_version = v_projection_engine_version
  where id = p_competition_id;

  -- A round is complete once no competition spanning it is still open.
  update public.rounds r
  set status = 'complete'
  where r.event_id = v_event.id
    and r.status in ('scheduled', 'in_progress')
    and (
      exists (
        select 1
        from public.competition_rounds linked
        where linked.round_id = r.id
      )
      or not exists (
        select 1
        from public.competitions remaining
        where remaining.event_id = v_event.id
          and remaining.status not in ('finalized', 'archived')
      )
    )
    and not exists (
      select 1
      from public.competition_rounds cr
      join public.competitions c on c.id = cr.competition_id
      where cr.round_id = r.id
        and c.status not in ('finalized', 'archived')
    );

  if not exists (
    select 1 from public.competitions
    where event_id = v_event.id and status not in ('finalized', 'archived')
  ) then
    if v_event.status = 'scoring_open' then
      update public.events set status = 'scoring_closed' where id = v_event.id;
      v_event.status := 'scoring_closed';
    end if;
    update public.events set status = 'finalized' where id = v_event.id;
    v_event.status := 'finalized';
  end if;

  insert into public.audit_events (
    actor_profile_id, action, scope_league_id, scope_event_id,
    target_type, target_id, reason, after_json
  ) values (
    p_actor, 'competition.finalized', v_event.league_id, v_event.id,
    'competition', p_competition_id,
    nullif(trim(coalesce(p_override_reason, '')), ''),
    jsonb_build_object(
      'finalResultHash', v_projection_hash,
      'engineVersion', v_projection_engine_version,
      'missingScoreOverrides', v_missing,
      'conflictOverrides', v_conflicts,
      'attestationOverrides', v_unattested
    )
  );

  return jsonb_build_object(
    'status', 'finalized', 'eventId', v_event.id,
    'competitionId', p_competition_id,
    'finalResultHash', v_projection_hash,
    'engineVersion', v_projection_engine_version,
    'missingScoreOverrides', v_missing,
    'conflictOverrides', v_conflicts,
    'attestationOverrides', v_unattested
  );
end;
$$;

revoke all on function public.finalize_phase1_competition(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.finalize_phase1_competition(uuid, uuid, text)
  to service_role;

comment on function public.finalize_phase1_competition(uuid, uuid, text) is
  'Seal one competition independently (Appendix B): blockers are scoped to the competition''s own inputs, only the sealing call changes status, and the event/rounds close only after every competition is sealed.';

comment on function public.reopen_competition(uuid, uuid, text) is
  'Reopen one finalized competition for audited corrections (§26 runbook). Clears that competition''s final hash only; sibling sealed results and their score facts stay locked.';
