-- Phase 4: measurable operations, cost circuit breakers, sanitized error
-- aggregation, and repair visibility (spec §§17, 19, 23.3–23.4, 24.2).

alter table public.app_error_events
  alter column window_started_at set default date_trunc('hour', now());

update public.app_error_events
set window_started_at = date_trunc('hour', coalesce(first_seen_at, now()))
where window_started_at is null;

alter table public.app_error_events
  alter column window_started_at set not null;

alter table public.app_error_events
  add constraint app_error_events_error_code_sanitized
    check (error_code ~ '^[A-Z0-9][A-Z0-9_:-]{0,79}$'),
  add constraint app_error_events_release_sanitized
    check (release is null or release ~ '^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$'),
  add constraint app_error_events_route_family_sanitized
    check (route_family is null or route_family ~ '^/[A-Za-z0-9_:/.-]{0,79}$');

-- A single server-owned counter bounds total unauthenticated ingestion work,
-- regardless of how requests are distributed across valid aggregate buckets.
create table app.error_ingest_windows (
  window_started_at timestamptz primary key,
  accepted_count integer not null check (accepted_count between 0 and 5000)
);

revoke all on app.error_ingest_windows from public, anon, authenticated;

-- Only the report-error Edge Function (service role) can write these
-- aggregates. The function serializes a code/release/route/hour bucket and
-- caps it at 1,000 occurrences so a failing client cannot grow hot rows
-- without bound. It intentionally accepts no message, stack, name, or URL.
create or replace function public.record_phase4_error(
  p_error_code text,
  p_release text,
  p_route_family text,
  p_correlation_id uuid,
  p_severity text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz := date_trunc('hour', now());
  v_id uuid;
  v_count integer;
  v_ingest_count integer;
begin
  if coalesce((select auth.role()), '') <> 'service_role'
     and session_user <> 'postgres' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_error_code <> all(array[
       'GLOBAL_ERROR', 'RENDER_BOUNDARY', 'UNHANDLED_REJECTION'
     ])
     or p_release !~ '^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$'
     or p_route_family <> all(array[
       '/', '/activate', '/admin/events/:eventId/audit',
       '/admin/events/:eventId/scoring', '/admin/events/:eventId/setup',
       '/admin/operations', '/dashboard', '/events/:eventId',
       '/events/:eventId/leaderboards/:competitionId',
       '/events/:eventId/matches/:competitionId', '/events/:eventId/rules',
       '/events/:eventId/score', '/events/:eventId/scorecard/:entityId',
       '/events/:eventId/skins/:competitionId', '/league/:leagueId',
       '/league/:leagueId/courses', '/league/:leagueId/players',
       '/league/:leagueId/seasons', '/offline', '/privacy', '/settings',
       '/sign-in', '/unknown'
     ])
     or p_severity not in ('warning', 'error', 'critical') then
    raise exception 'invalid sanitized error aggregate' using errcode = '23514';
  end if;

  insert into app.error_ingest_windows (window_started_at, accepted_count)
  values (v_window, 1)
  on conflict (window_started_at) do update
    set accepted_count = app.error_ingest_windows.accepted_count + 1
    where app.error_ingest_windows.accepted_count < 5000
  returning accepted_count into v_ingest_count;

  if v_ingest_count is null then
    return jsonb_build_object('status', 'dropped', 'reason', 'hourly_limit');
  end if;

  perform pg_advisory_xact_lock(hashtext(concat_ws('|',
    p_error_code, p_release, p_route_family, v_window::text)));

  update public.app_error_events
  set occurrence_count = least(1000, occurrence_count + 1),
      last_seen_at = now(),
      correlation_id = coalesce(p_correlation_id, correlation_id),
      severity = case
        when severity = 'critical' or p_severity = 'critical' then 'critical'
        when severity = 'error' or p_severity = 'error' then 'error'
        else 'warning'
      end
  where error_code = p_error_code
    and release is not distinct from p_release
    and route_family is not distinct from p_route_family
    and window_started_at = v_window
  returning id, occurrence_count into v_id, v_count;

  if v_id is null then
    insert into public.app_error_events (
      error_code, release, route_family, correlation_id, severity,
      occurrence_count, window_started_at
    ) values (
      p_error_code, p_release, p_route_family, p_correlation_id, p_severity,
      1, v_window
    ) returning id, occurrence_count into v_id, v_count;
  end if;

  return jsonb_build_object('status', 'recorded', 'id', v_id, 'count', v_count);
end;
$$;

revoke all on function public.record_phase4_error(text, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_phase4_error(text, text, text, uuid, text)
  to service_role;

-- Operator snapshot: all measured values come from authoritative database
-- state. Free-plan limits without a metrics endpoint remain explicit manual
-- checks in the UI; they are never presented as fabricated usage values.
create or replace function public.phase4_operations_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_database_bytes bigint := pg_database_size(current_database());
  v_database_limit_bytes bigint := 524288000;
  v_event_health jsonb;
  v_errors jsonb;
  v_backup jsonb;
begin
  if not app.is_operator() then
    raise exception 'operator role required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(to_jsonb(h) order by h.starts_at desc), '[]'::jsonb)
  into v_event_health
  from (
    select e.id, e.name, e.status, e.starts_at,
      e.scoring_revision as "eventRevision",
      (select count(*)::integer from public.competitions c
       where c.event_id = e.id) as "competitionCount",
      (select count(*)::integer
       from public.competitions c
       where c.event_id = e.id
         and coalesce((
           select max(cp.event_revision)
           from public.competition_projections cp
           where cp.competition_id = c.id
         ), 0) < e.scoring_revision) as "laggingCompetitions",
      greatest(0, e.scoring_revision - coalesce((
        select min(latest.latest_revision)
        from (
          select coalesce(max(cp.event_revision), 0) as latest_revision
          from public.competitions c
          left join public.competition_projections cp on cp.competition_id = c.id
          where c.event_id = e.id
          group by c.id
        ) latest
      ), e.scoring_revision)) as "maxProjectionLag"
    from public.events e
    where e.status <> 'archived'
    order by e.starts_at desc
    limit 25
  ) h;

  select coalesce(jsonb_agg(to_jsonb(x) order by x."lastSeenAt" desc), '[]'::jsonb)
  into v_errors
  from (
    select error_code as "errorCode", release, route_family as "routeFamily",
      severity, occurrence_count as "occurrenceCount",
      first_seen_at as "firstSeenAt", last_seen_at as "lastSeenAt",
      correlation_id as "correlationId"
    from public.app_error_events
    where last_seen_at >= now() - interval '30 days'
    order by last_seen_at desc
    limit 20
  ) x;

  select to_jsonb(b) into v_backup
  from (
    select status, started_at as "startedAt", completed_at as "completedAt",
      artifact_checksum as "artifactChecksum",
      artifact_size_bytes as "artifactSizeBytes",
      (select max(history.last_tested_restore_on)
       from public.backup_runs history) as "lastTestedRestoreOn",
      workflow_run_url as "workflowRunUrl"
    from public.backup_runs
    order by started_at desc
    limit 1
  ) b;

  return jsonb_build_object(
    'generatedAt', now(),
    'database', jsonb_build_object(
      'usedBytes', v_database_bytes,
      'limitBytes', v_database_limit_bytes,
      'usedFraction', round(v_database_bytes::numeric / v_database_limit_bytes, 6),
      'warningLevel', case
        when v_database_bytes >= v_database_limit_bytes * 0.90 then 'critical'
        when v_database_bytes >= v_database_limit_bytes * 0.75 then 'action'
        when v_database_bytes >= v_database_limit_bytes * 0.60 then 'warning'
        else 'healthy'
      end,
      'publishBlocked', v_database_bytes >= v_database_limit_bytes * 0.95
    ),
    'manualQuotas', jsonb_build_array(
      jsonb_build_object('name', 'Egress', 'limit', '5 GB/month'),
      jsonb_build_object('name', 'Realtime connections', 'limit', '200 concurrent'),
      jsonb_build_object('name', 'Realtime messages', 'limit', '2,000,000/month'),
      jsonb_build_object('name', 'Edge Functions', 'limit', '500,000/month')
    ),
    'events', v_event_health,
    'recentErrors', v_errors,
    'backup', v_backup,
    'retention', jsonb_build_object('errorDays', 30, 'revisionRowsPerEvent', 20)
  );
end;
$$;

revoke all on function public.phase4_operations_snapshot()
  from public, anon;
grant execute on function public.phase4_operations_snapshot() to authenticated;

-- The free profile degrades before it can incur cost. Publication is the only
-- blocked core action, and only at 95% of the current 500 MB database limit;
-- existing scoring and exports remain available for recovery.
create or replace function app.enforce_phase4_publish_capacity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'draft' and new.status = 'published'
     and pg_database_size(current_database()) >= 498073600 then
    raise exception 'database capacity hard ceiling reached; export and archive disposable history before publishing'
      using errcode = '53100';
  end if;
  return new;
end;
$$;

create trigger events_phase4_capacity_guard
  before update on public.events
  for each row execute function app.enforce_phase4_publish_capacity();

-- CI/operator cleanup for the only Phase 4 table with time-based retention.
-- Raw scores, score mutations, snapshots, projections, results, and audits are
-- deliberately excluded.
create or replace function public.prune_phase4_error_events(
  p_before timestamptz default now() - interval '30 days'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
  v_windows_deleted integer;
begin
  if coalesce((select auth.role()), '') <> 'service_role'
     and session_user <> 'postgres' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  delete from public.app_error_events where last_seen_at < p_before;
  get diagnostics v_deleted = row_count;
  delete from app.error_ingest_windows where window_started_at < p_before;
  get diagnostics v_windows_deleted = row_count;
  return jsonb_build_object(
    'status', 'pruned',
    'deleted', v_deleted,
    'windowsDeleted', v_windows_deleted,
    'before', p_before
  );
end;
$$;

revoke all on function public.prune_phase4_error_events(timestamptz)
  from public, anon, authenticated;
grant execute on function public.prune_phase4_error_events(timestamptz)
  to service_role;

-- Defense in depth: an already-issued JWT must stop authorizing score writes
-- as soon as the retained application profile is disabled. The Edge layer
-- performs the same check for a clear 401; this trigger also protects direct
-- calls to the authenticated RPC.
create or replace function app.enforce_active_score_actor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not exists (
    select 1 from public.profiles
    where id = auth.uid() and status = 'active'
  ) then
    raise exception 'active profile required' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger individual_hole_scores_active_actor
  before insert or update on public.individual_hole_scores
  for each row execute function app.enforce_active_score_actor();
create trigger team_hole_scores_active_actor
  before insert or update on public.team_hole_scores
  for each row execute function app.enforce_active_score_actor();
create trigger score_mutations_active_actor
  before insert or update on public.score_mutations
  for each row execute function app.enforce_active_score_actor();
create trigger score_conflicts_active_actor
  before insert or update on public.score_conflicts
  for each row execute function app.enforce_active_score_actor();

-- Serialize expensive projection builds per event. Score facts commit first;
-- concurrent callers mark the lease pending and return queued_projection while
-- one background repair publishes the newest complete revision. This prevents
-- a burst of score writes from multiplying identical snapshot reads.
create table app.projection_publish_leases (
  event_id uuid primary key references public.events (id) on delete cascade,
  lease_token uuid not null,
  waiter_token uuid,
  lease_until timestamptz not null,
  claimed_revision bigint not null,
  pending boolean not null default false
);

revoke all on app.projection_publish_leases from public, anon, authenticated;

create or replace function public.claim_projection_publish(
  p_event_id uuid,
  p_revision bigint,
  p_lease_token uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease app.projection_publish_leases%rowtype;
begin
  if coalesce((select auth.role()), '') <> 'service_role'
     and session_user <> 'postgres' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_event_id::text));
  select * into v_lease
  from app.projection_publish_leases
  where event_id = p_event_id
  for update;

  if not found then
    insert into app.projection_publish_leases (
      event_id, lease_token, waiter_token, lease_until, claimed_revision, pending
    ) values (
      p_event_id, p_lease_token, null, now() + interval '15 seconds', p_revision, false
    );
    return 'claimed';
  end if;

  if v_lease.lease_until <= now() then
    update app.projection_publish_leases
    set lease_token = p_lease_token,
        waiter_token = null,
        lease_until = now() + interval '15 seconds',
        claimed_revision = greatest(claimed_revision, p_revision),
        pending = false
    where event_id = p_event_id;
    return 'claimed';
  end if;

  if v_lease.waiter_token = p_lease_token then
    update app.projection_publish_leases
    set claimed_revision = greatest(claimed_revision, p_revision),
        pending = true
    where event_id = p_event_id;
    return 'wait';
  end if;

  update app.projection_publish_leases
  set claimed_revision = greatest(claimed_revision, p_revision),
      pending = true,
      waiter_token = case
        when not v_lease.pending then p_lease_token
        else waiter_token
      end
  where event_id = p_event_id;
  if v_lease.pending then
    return 'pending';
  end if;
  return 'wait';
end;
$$;

revoke all on function public.claim_projection_publish(uuid, bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_projection_publish(uuid, bigint, uuid)
  to service_role;

-- Extend the lease immediately before the database publish transaction. An
-- expired owner cannot publish after a fallback has claimed a newer token.
create or replace function public.renew_projection_publish_lease(
  p_event_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.role()), '') <> 'service_role'
     and session_user <> 'postgres' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_event_id::text));
  update app.projection_publish_leases
  set lease_until = now() + interval '60 seconds'
  where event_id = p_event_id and lease_token = p_lease_token;
  return found;
end;
$$;

revoke all on function public.renew_projection_publish_lease(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.renew_projection_publish_lease(uuid, uuid)
  to service_role;

-- A delayed crash fallback exits without a redundant rebuild when every
-- competition already has a projection at the event's current raw revision.
create or replace function public.event_projections_current(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.events where id = p_event_id)
    and not exists (
      select 1
      from public.competitions c
      join public.events e on e.id = c.event_id
      where c.event_id = p_event_id
        and coalesce((
          select max(cp.event_revision)
          from public.competition_projections cp
          where cp.competition_id = c.id
        ), -1) < e.scoring_revision
    );
$$;

revoke all on function public.event_projections_current(uuid)
  from public, anon, authenticated;
grant execute on function public.event_projections_current(uuid) to service_role;

create or replace function public.release_projection_publish(
  p_event_id uuid,
  p_revision bigint,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pending boolean := false;
begin
  if coalesce((select auth.role()), '') <> 'service_role'
     and session_user <> 'postgres' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_event_id::text));
  select pending into v_pending
  from app.projection_publish_leases
  where event_id = p_event_id and lease_token = p_lease_token
  for update;

  if not found then
    return false;
  end if;

  update app.projection_publish_leases
  set lease_until = now() + case
        when coalesce(v_pending, false) then interval '500 milliseconds'
        else interval '0 seconds'
      end,
      claimed_revision = greatest(claimed_revision, p_revision),
      pending = false
  where event_id = p_event_id and lease_token = p_lease_token;
  return coalesce(v_pending, false);
end;
$$;

revoke all on function public.release_projection_publish(uuid, bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.release_projection_publish(uuid, bigint, uuid)
  to service_role;
