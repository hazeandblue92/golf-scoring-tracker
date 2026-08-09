-- Migration 2: identity and access tables (spec section 11.2).
-- Conventions (section 11.1): uuid PKs via gen_random_uuid(), timestamptz in
-- UTC, created_at/updated_at on mutable business tables, restrictive FKs,
-- soft lifecycle status instead of destructive deletion.

-- ---------------------------------------------------------------------------
-- profiles: one app profile per Supabase auth user.
-- The internal auth email (<random-key>@users.invalid, section 14.1) lives
-- only in auth.users and is NEVER exposed through this table, any view, or
-- any API response.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete restrict,
  username extensions.citext not null unique,
  display_name text not null,
  status public.account_status not null default 'active',
  must_change_password boolean not null default true,
  privacy_accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Section 3.1: 3-32 lowercase chars after normalization; letters, digits,
  -- period, underscore, hyphen; case-insensitive via citext.
  constraint profiles_username_format check ((username)::text ~ '^[a-z0-9._-]{3,32}$')
);

comment on table public.profiles is
  'App profile per auth user. The internal auth email identifier is an implementation detail of auth.users and must never be exposed here.';
comment on column public.profiles.must_change_password is
  'True while an organizer-provisioned temporary password is in force; cleared only by the complete-activation Edge Function (section 14.1).';

-- ---------------------------------------------------------------------------
-- leagues: exactly one active row in the supported deployment (section 11.2).
-- ---------------------------------------------------------------------------
create table public.leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug extensions.citext not null unique,
  timezone text not null,
  locale text not null default 'en-US',
  privacy_notice_version integer not null default 1,
  settings_json jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enforce the single-active-league deployment shape.
create unique index leagues_single_active on public.leagues ((1)) where status = 'active';

-- ---------------------------------------------------------------------------
-- league_memberships: connects an auth profile to league participant access.
-- ---------------------------------------------------------------------------
create table public.league_memberships (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete restrict,
  profile_id uuid not null references public.profiles (id) on delete restrict,
  member_status public.member_status not null default 'active',
  joined_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint league_memberships_league_profile_unique unique (league_id, profile_id)
);

-- ---------------------------------------------------------------------------
-- role_assignments: additive scoped roles (section 2.2). Never inferred from
-- client-side flags or user metadata.
-- ---------------------------------------------------------------------------
create table public.role_assignments (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete restrict,
  -- FK to events is added in migration 5, where the events table is created.
  event_id uuid,
  profile_id uuid not null references public.profiles (id) on delete restrict,
  role public.app_role not null,
  granted_by uuid references public.profiles (id) on delete restrict,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  -- Event-scoped roles must carry an event id; league-scoped roles must not.
  constraint role_assignments_scope_check check (
    (role in ('event_director', 'marker') and event_id is not null)
    or (role in ('owner', 'league_admin', 'player', 'spectator') and event_id is null)
  )
);

-- One active grant per (league, profile, role, event-scope). Revoked rows are
-- retained for audit; revocation is a timestamp, not a DELETE.
create unique index role_assignments_active_unique
  on public.role_assignments (
    league_id,
    profile_id,
    role,
    coalesce(event_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- scoring_permissions: who may enter scores for whom, per event round.
-- Exactly one target kind (participant XOR team) must be non-null.
-- FKs to events/rounds are added in migration 5; FKs to participants/teams in
-- migration 3 (those tables are created later in the ordered series).
-- ---------------------------------------------------------------------------
create table public.scoring_permissions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  round_id uuid not null,
  scorer_profile_id uuid not null references public.profiles (id) on delete restrict,
  participant_id uuid,
  team_id uuid,
  permission_type text not null check (permission_type in ('marker', 'self')),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scoring_permissions_one_target check (num_nonnulls(participant_id, team_id) = 1),
  constraint scoring_permissions_validity check (valid_to is null or valid_to > valid_from)
);

comment on table public.scoring_permissions is
  'Scorer assignments per event round. Exactly one of participant_id/team_id is set. Expiry is via valid_to, not row deletion.';
