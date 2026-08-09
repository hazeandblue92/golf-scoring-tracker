-- Migration 5: event setup tables (spec section 11.5).
-- FK policy (section 11.1): restrictive by default; ON DELETE CASCADE is used
-- only for ephemeral child data of a draft event. A trigger in migration 10
-- blocks deleting any event that has left draft, so cascades can only ever
-- fire during draft teardown.

create table public.events (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete restrict,
  season_id uuid not null references public.seasons (id) on delete restrict,
  name text not null,
  slug extensions.citext not null,
  timezone text not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  status public.event_status not null default 'draft',
  visibility public.event_visibility not null default 'league',
  -- Incremented only by the score mutation function (placeholder in
  -- migration 10); guarded by trigger.
  scoring_revision bigint not null default 0,
  published_snapshot_version integer,
  created_by uuid references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint events_league_slug_unique unique (league_id, slug),
  constraint events_time_order check (ends_at is null or ends_at > starts_at)
);

comment on column public.events.timezone is
  'IANA timezone of the event venue; all timestamptz values are stored UTC (section 11.1).';

-- Deferred FKs from migration 2. Event-scoped role grants and scorer
-- assignments are ephemeral children of a draft event, hence CASCADE.
alter table public.role_assignments
  add constraint role_assignments_event_fk
  foreign key (event_id) references public.events (id) on delete cascade;

alter table public.scoring_permissions
  add constraint scoring_permissions_event_fk
  foreign key (event_id) references public.events (id) on delete cascade;

-- ---------------------------------------------------------------------------
-- rounds
-- ---------------------------------------------------------------------------
create table public.rounds (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  round_number smallint not null check (round_number >= 1),
  name text,
  starts_at timestamptz,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'in_progress', 'complete', 'cancelled')),
  hole_count smallint not null check (hole_count in (9, 18)),
  snapshot_version integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rounds_event_number_unique unique (event_id, round_number),
  -- Enables composite FKs that keep child rows event-consistent.
  constraint rounds_id_event_unique unique (id, event_id)
);

alter table public.scoring_permissions
  add constraint scoring_permissions_round_fk
  foreign key (round_id) references public.rounds (id) on delete cascade;

-- ---------------------------------------------------------------------------
-- event_tee_snapshots: frozen copy of tee data at publish time.
-- Written ONLY by the publish-event Edge Function (service role); no client
-- write policies exist (migration 9). Immutable once the event is published.
-- ---------------------------------------------------------------------------
create table public.event_tee_snapshots (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete cascade,
  source_tee_set_id uuid not null references public.tee_sets (id) on delete restrict,
  course_name text not null,
  layout_name text not null,
  tee_name text not null,
  rating_category text,
  course_rating numeric(5, 1) not null,
  slope_rating smallint not null check (slope_rating between 55 and 155),
  par smallint not null check (par > 0),
  hole_count smallint not null check (hole_count in (9, 18)),
  snapshot_version integer not null default 1,
  snapshot_hash text not null,
  created_at timestamptz not null default now(),
  constraint event_tee_snapshots_unique unique (round_id, source_tee_set_id, snapshot_version)
);

-- ---------------------------------------------------------------------------
-- event_holes: frozen per-hole data. Unique ordinal AND unique stroke index
-- per snapshot (duplicate stroke indexes are a publish blocker, section 3.2).
-- ---------------------------------------------------------------------------
create table public.event_holes (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete cascade,
  event_tee_snapshot_id uuid not null references public.event_tee_snapshots (id) on delete cascade,
  hole_ordinal smallint not null check (hole_ordinal between 1 and 18),
  label text,
  par smallint not null check (par between 3 and 6),
  yardage smallint check (yardage is null or yardage > 0),
  stroke_index smallint not null check (stroke_index between 1 and 18),
  created_at timestamptz not null default now(),
  constraint event_holes_snapshot_ordinal_unique unique (event_tee_snapshot_id, hole_ordinal),
  constraint event_holes_snapshot_stroke_index_unique unique (event_tee_snapshot_id, stroke_index),
  constraint event_holes_id_round_unique unique (id, round_id)
);

-- ---------------------------------------------------------------------------
-- flights
-- ---------------------------------------------------------------------------
create table public.flights (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  eligibility_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint flights_event_name_unique unique (event_id, name)
);

-- ---------------------------------------------------------------------------
-- event_entries: participant enrollment with frozen handicap fields
-- (section 4.4: source, value, unrounded course handicap, playing handicap,
-- allowance, profile, tee snapshot reference, hash).
-- ---------------------------------------------------------------------------
create table public.event_entries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete restrict,
  flight_id uuid references public.flights (id) on delete set null,
  status public.entity_status not null default 'active',
  seed integer,
  handicap_source public.handicap_source not null default 'none',
  handicap_value numeric(5, 1),
  course_handicap_unrounded numeric(12, 6),
  playing_handicap smallint,
  allowance numeric(5, 4) check (allowance is null or (allowance > 0 and allowance <= 2)),
  handicap_profile text
    check (handicap_profile is null or handicap_profile in ('usga_whs_2024', 'committee_custom', 'none')),
  -- SET NULL (not RESTRICT) so draft-event cascade teardown cannot deadlock
  -- on ordering; the frozen reference is re-established at publish.
  tee_snapshot_id uuid references public.event_tee_snapshots (id) on delete set null,
  snapshot_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_entries_event_participant_unique unique (event_id, participant_id),
  constraint event_entries_id_event_unique unique (id, event_id)
);

comment on column public.event_entries.course_handicap_unrounded is
  'Unrounded Course Handicap retained at numeric(12,6) intermediate precision until the final Playing Handicap step (section 11.1, USGA Rule 6).';

-- ---------------------------------------------------------------------------
-- event_teams and event_team_members: frozen team roster for the event.
-- Membership must cover the competition''s required rounds (validated at
-- publish preflight).
-- ---------------------------------------------------------------------------
create table public.event_teams (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  source_team_id uuid references public.teams (id) on delete restrict,
  name text not null,
  flight_id uuid references public.flights (id) on delete set null,
  status public.entity_status not null default 'active',
  seed integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_teams_event_name_unique unique (event_id, name),
  constraint event_teams_id_event_unique unique (id, event_id)
);

create table public.event_team_members (
  id uuid primary key default gen_random_uuid(),
  event_team_id uuid not null references public.event_teams (id) on delete cascade,
  event_entry_id uuid not null references public.event_entries (id) on delete cascade,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  constraint event_team_members_unique unique (event_team_id, event_entry_id)
);

-- ---------------------------------------------------------------------------
-- groups and group_members: tee groups per round with marker and ordered
-- participant/team membership (exactly one target kind per member row).
-- ---------------------------------------------------------------------------
create table public.groups (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete cascade,
  label text not null,
  start_hole_ordinal smallint check (start_hole_ordinal between 1 and 18),
  starts_at timestamptz,
  marker_profile_id uuid references public.profiles (id) on delete restrict,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint groups_round_label_unique unique (round_id, label)
);

create table public.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  event_entry_id uuid references public.event_entries (id) on delete cascade,
  event_team_id uuid references public.event_teams (id) on delete cascade,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint group_members_one_target check (num_nonnulls(event_entry_id, event_team_id) = 1)
);

create unique index group_members_entry_unique
  on public.group_members (group_id, event_entry_id) where event_entry_id is not null;
create unique index group_members_team_unique
  on public.group_members (group_id, event_team_id) where event_team_id is not null;
