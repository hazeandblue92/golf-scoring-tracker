-- Migration 1: extensions and enum types
-- Golf Tournament Tracker initial schema (spec section 11.1, Appendix A/B).
-- Target: PostgreSQL 15+ on Supabase. The supabase CLI runs each migration in
-- a single transaction; no explicit BEGIN/COMMIT here.

-- Extensions are installed into the dedicated "extensions" schema per Supabase
-- convention. The Supabase database search_path includes "extensions".
create extension if not exists citext with schema extensions;
create extension if not exists pgcrypto with schema extensions;
-- btree_gist supports the exclusion constraint that prevents overlapping
-- participant handicap validity intervals (migration 3).
create extension if not exists btree_gist with schema extensions;

-- Dedicated schema for security-definer helper functions and trigger
-- functions. It is NOT exposed through PostgREST; clients cannot call these
-- as RPCs, but RLS policies can.
create schema if not exists app;
grant usage on schema app to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------

create type public.account_status as enum ('active', 'disabled');

create type public.member_status as enum ('active', 'inactive', 'removed');

create type public.season_status as enum ('planned', 'active', 'completed', 'archived');

-- Appendix B event lifecycle. Transitions are database-enforced (migration 10).
create type public.event_status as enum (
  'draft',
  'published',
  'scoring_open',
  'scoring_closed',
  'finalized',
  'archived'
);

create type public.event_visibility as enum ('league', 'public', 'organizers');

-- Section 2.2 role hierarchy. Roles are additive, scoped memberships.
create type public.app_role as enum (
  'owner',
  'league_admin',
  'event_director',
  'marker',
  'player',
  'spectator'
);

-- Section 4.4 handicap provenance.
create type public.handicap_source as enum (
  'manual_verified',
  'authorized_import',
  'league_value',
  'scratch_fallback',
  'none'
);

-- Section 4.5 hole score statuses.
create type public.score_status as enum (
  'not_started',
  'complete',
  'picked_up',
  'conceded',
  'not_played',
  'no_score',
  'withdrawn',
  'disqualified'
);

-- Competitive entity lifecycle (engine EntityStatus, section 7).
create type public.entity_status as enum ('active', 'withdrawn', 'no_return', 'disqualified');

-- Section 12.3 submit-score outcome statuses.
create type public.mutation_result as enum (
  'committed',
  'duplicate',
  'conflict',
  'rejected',
  'queued_projection'
);

create type public.conflict_status as enum ('open', 'resolved');

-- Section 11.7 scorecard_attestations.
create type public.attestation_type as enum ('player', 'marker', 'director_override');
