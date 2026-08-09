-- Migration 8: projection and operational tables (spec section 11.8).
-- Projections are derived, canonically hashed artifacts written only by the
-- projection publisher (Edge Functions with the service role). Clients read
-- them under RLS; they never read raw scores as spectators (section 14.3).

-- ---------------------------------------------------------------------------
-- competition_projections: one header per competition/revision.
-- ---------------------------------------------------------------------------
create table public.competition_projections (
  competition_id uuid not null references public.competitions (id) on delete cascade,
  event_revision bigint not null,
  engine_version text not null,
  projection_hash text not null,
  status text not null default 'live' check (status in ('live', 'final', 'stale', 'error')),
  calculated_at timestamptz not null default now(),
  warnings jsonb not null default '[]'::jsonb,
  summary_json jsonb not null default '{}'::jsonb,
  primary key (competition_id, event_revision)
);

comment on table public.competition_projections is
  'Derived leaderboard header per competition and event scoring revision. summary_json is canonical JSON (sorted keys, integers only) hashed into projection_hash.';

-- ---------------------------------------------------------------------------
-- leaderboard_rows: PK (competition_id, event_revision, entity_id).
-- ---------------------------------------------------------------------------
create table public.leaderboard_rows (
  competition_id uuid not null,
  event_revision bigint not null,
  entity_id uuid not null references public.competition_entities (id) on delete cascade,
  rank integer,
  is_tied boolean not null default false,
  thru smallint,
  result_primary numeric(14, 6),
  result_secondary numeric(14, 6),
  display_primary text,
  status text not null default 'provisional',
  detail_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (competition_id, event_revision, entity_id),
  constraint leaderboard_rows_projection_fk
    foreign key (competition_id, event_revision)
    references public.competition_projections (competition_id, event_revision)
    on delete cascade
);

comment on column public.leaderboard_rows.rank is
  'NULL for entities that are never competitively ranked (withdrawn/disqualified stay visible without rank, section 7.3). Ties share rank with is_tied = true.';

-- ---------------------------------------------------------------------------
-- hole_results: per competition/entity/hole derived metrics.
-- ---------------------------------------------------------------------------
create table public.hole_results (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null,
  event_revision bigint not null,
  entity_id uuid not null references public.competition_entities (id) on delete cascade,
  event_hole_id uuid not null references public.event_holes (id) on delete cascade,
  gross smallint,
  strokes_received smallint,
  net smallint,
  relative_to_par smallint,
  status public.score_status,
  provisional boolean not null default false,
  contributor_entry_ids uuid[],
  match_result text,
  skin_units integer,
  skin_carried_units integer,
  skin_winner boolean,
  detail_json jsonb,
  created_at timestamptz not null default now(),
  constraint hole_results_unique unique (competition_id, event_revision, entity_id, event_hole_id),
  constraint hole_results_projection_fk
    foreign key (competition_id, event_revision)
    references public.competition_projections (competition_id, event_revision)
    on delete cascade
);

-- ---------------------------------------------------------------------------
-- event_revision_feed: compact realtime table (section 10.5). Clients
-- subscribe here, not to raw tables. Retain latest plus short history only
-- (pruned by the projection publisher).
-- ---------------------------------------------------------------------------
create table public.event_revision_feed (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  score_revision bigint not null,
  projection_revision bigint not null,
  changed_competition_ids uuid[] not null default '{}',
  published_at timestamptz not null default now()
);

-- Register the feed with Supabase Realtime when the publication exists
-- (it does on Supabase; guarded so plain PostgreSQL still applies cleanly).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'event_revision_feed'
     ) then
    alter publication supabase_realtime add table public.event_revision_feed;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- audit_events: append-only audit trail (section 11.8). Writers (Edge
-- Functions) must never store raw passwords, tokens, or unnecessary IPs.
-- ---------------------------------------------------------------------------
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid references public.profiles (id) on delete restrict,
  action text not null,
  scope_league_id uuid references public.leagues (id) on delete restrict,
  scope_event_id uuid references public.events (id) on delete restrict,
  target_type text not null,
  target_id uuid,
  reason text,
  before_json jsonb,
  after_json jsonb,
  correlation_id uuid,
  created_at timestamptz not null default now()
);

revoke update, delete on public.audit_events from anon, authenticated;

create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function app.prevent_change();

-- ---------------------------------------------------------------------------
-- push_subscriptions: Web Push endpoints. The endpoint and keys are sensitive
-- and are never exposed to other clients (own-only RLS in migration 9).
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete restrict,
  device_label text,
  endpoint text not null,
  p256dh_key text not null,
  auth_key text not null,
  permission_status text not null default 'granted'
    check (permission_status in ('granted', 'denied', 'revoked')),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint push_subscriptions_unique unique (profile_id, endpoint)
);

-- ---------------------------------------------------------------------------
-- app_error_events: sanitized error aggregates (section 11.8). No score
-- payloads, names, tokens, or free-text user content. 30-day retention is
-- enforced by a scheduled cleanup job in a later phase.
-- ---------------------------------------------------------------------------
create table public.app_error_events (
  id uuid primary key default gen_random_uuid(),
  error_code text not null,
  release text,
  route_family text,
  correlation_id uuid,
  severity text not null default 'error'
    check (severity in ('debug', 'info', 'warning', 'error', 'critical')),
  occurrence_count integer not null default 1 check (occurrence_count >= 1),
  window_started_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- backup_runs: metadata about external encrypted backups (section 11.8).
-- The backup artifact itself is never stored in the database.
-- ---------------------------------------------------------------------------
create table public.backup_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  completed_at timestamptz,
  workflow_run_url text,
  artifact_checksum text,
  artifact_size_bytes bigint check (artifact_size_bytes is null or artifact_size_bytes >= 0),
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  last_tested_restore_on date,
  created_at timestamptz not null default now()
);
