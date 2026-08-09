-- Migration 7: raw scoring tables (spec section 11.7).
-- Raw hole scores are mutated ONLY by the submit-score / resolve-score-conflict
-- Edge Functions using the service role (section 12.1); clients have read-only
-- RLS access (migration 9). score_mutations is append-only.

-- Shared trigger function for append-only tables (also used in migration 8).
create or replace function app.prevent_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'table % is append-only; updates and deletes are forbidden', tg_table_name;
end;
$$;

-- ---------------------------------------------------------------------------
-- individual_hole_scores
-- Composite FKs keep round/entry/hole references consistent with event_id.
-- Section 4.5: a numeric value and a nonnumeric terminal status are mutually
-- exclusive; gross_strokes is required exactly when status = 'complete'.
-- Missing data stays NULL and propagates as provisional; it is never coerced
-- to zero (section 7.3).
-- ---------------------------------------------------------------------------
create table public.individual_hole_scores (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete restrict,
  round_id uuid not null,
  event_entry_id uuid not null,
  event_hole_id uuid not null,
  gross_strokes smallint check (gross_strokes is null or gross_strokes >= 1),
  score_status public.score_status not null default 'not_started',
  revision integer not null default 1 check (revision >= 1),
  entered_by uuid references public.profiles (id) on delete restrict,
  device_id_hash text,
  source text not null default 'app' check (source in ('app', 'import', 'director')),
  client_recorded_at timestamptz,
  server_recorded_at timestamptz not null default now(),
  submitted_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint individual_hole_scores_entry_hole_unique unique (event_entry_id, event_hole_id),
  constraint individual_hole_scores_value_xor_status check (
    (score_status = 'complete' and gross_strokes is not null)
    or (score_status <> 'complete' and gross_strokes is null)
  ),
  constraint individual_hole_scores_round_fk
    foreign key (round_id, event_id) references public.rounds (id, event_id) on delete restrict,
  constraint individual_hole_scores_entry_fk
    foreign key (event_entry_id, event_id) references public.event_entries (id, event_id) on delete restrict,
  constraint individual_hole_scores_hole_fk
    foreign key (event_hole_id, round_id) references public.event_holes (id, round_id) on delete restrict
);

comment on column public.individual_hole_scores.gross_strokes is
  'Official hole total inclusive of penalties. Default allowed range 1-25 is validated by the submit-score function; 0 is always invalid (section 4.5).';

-- ---------------------------------------------------------------------------
-- team_hole_scores: same pattern keyed by event_team_id, for scramble /
-- foursomes / single-team-ball formats.
-- ---------------------------------------------------------------------------
create table public.team_hole_scores (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete restrict,
  round_id uuid not null,
  event_team_id uuid not null,
  event_hole_id uuid not null,
  gross_strokes smallint check (gross_strokes is null or gross_strokes >= 1),
  score_status public.score_status not null default 'not_started',
  revision integer not null default 1 check (revision >= 1),
  entered_by uuid references public.profiles (id) on delete restrict,
  device_id_hash text,
  source text not null default 'app' check (source in ('app', 'import', 'director')),
  client_recorded_at timestamptz,
  server_recorded_at timestamptz not null default now(),
  submitted_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_hole_scores_team_hole_unique unique (event_team_id, event_hole_id),
  constraint team_hole_scores_value_xor_status check (
    (score_status = 'complete' and gross_strokes is not null)
    or (score_status <> 'complete' and gross_strokes is null)
  ),
  constraint team_hole_scores_round_fk
    foreign key (round_id, event_id) references public.rounds (id, event_id) on delete restrict,
  constraint team_hole_scores_team_fk
    foreign key (event_team_id, event_id) references public.event_teams (id, event_id) on delete restrict,
  constraint team_hole_scores_hole_fk
    foreign key (event_hole_id, round_id) references public.event_holes (id, round_id) on delete restrict
);

-- ---------------------------------------------------------------------------
-- score_mutations: append-only mutation ledger (section 10.4, 11.7).
-- PK is the client-generated idempotency key; replaying a key returns the
-- original receipt instead of inserting a second row.
-- ---------------------------------------------------------------------------
create table public.score_mutations (
  idempotency_key uuid primary key,
  event_id uuid not null references public.events (id) on delete restrict,
  round_id uuid not null references public.rounds (id) on delete restrict,
  target_kind text not null check (target_kind in ('individual', 'team')),
  event_entry_id uuid references public.event_entries (id) on delete restrict,
  event_team_id uuid references public.event_teams (id) on delete restrict,
  event_hole_id uuid not null references public.event_holes (id) on delete restrict,
  base_revision integer not null,
  prior_value jsonb,
  new_value jsonb not null,
  actor_profile_id uuid not null references public.profiles (id) on delete restrict,
  device_id_hash text,
  result public.mutation_result not null,
  event_revision bigint,
  reason text,
  client_recorded_at timestamptz,
  created_at timestamptz not null default now(),
  constraint score_mutations_one_target check (num_nonnulls(event_entry_id, event_team_id) = 1),
  constraint score_mutations_target_kind check (
    (target_kind = 'individual' and event_entry_id is not null)
    or (target_kind = 'team' and event_team_id is not null)
  )
);

comment on table public.score_mutations is
  'Append-only. prior_value/new_value hold canonical JSON score payloads. Partitioning is unnecessary at supported scale (section 11.7).';

-- Append-only enforcement: privilege revocation for API roles plus a trigger
-- that also stops the service role and table owner.
revoke update, delete on public.score_mutations from anon, authenticated;

create trigger score_mutations_append_only
  before update or delete on public.score_mutations
  for each row execute function app.prevent_change();

-- ---------------------------------------------------------------------------
-- score_conflicts (section 10.4): created when a stale base revision cannot
-- be auto-reconciled. Never last-write-wins. Resolution only via the
-- resolve-score-conflict Edge Function.
-- ---------------------------------------------------------------------------
create table public.score_conflicts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete restrict,
  round_id uuid not null references public.rounds (id) on delete restrict,
  target_kind text not null check (target_kind in ('individual', 'team')),
  event_entry_id uuid references public.event_entries (id) on delete restrict,
  event_team_id uuid references public.event_teams (id) on delete restrict,
  event_hole_id uuid not null references public.event_holes (id) on delete restrict,
  local_payload jsonb not null,
  server_payload jsonb not null,
  local_actor_profile_id uuid references public.profiles (id) on delete restrict,
  server_actor_profile_id uuid references public.profiles (id) on delete restrict,
  base_revision integer,
  server_revision integer,
  status public.conflict_status not null default 'open',
  resolution_choice text check (resolution_choice in ('local', 'server', 'manual')),
  resolution_value jsonb,
  resolution_reason text,
  resolved_by uuid references public.profiles (id) on delete restrict,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint score_conflicts_one_target check (num_nonnulls(event_entry_id, event_team_id) = 1),
  constraint score_conflicts_resolution check (
    (status = 'open' and resolved_at is null)
    or (status = 'resolved'
        and resolved_at is not null
        and resolved_by is not null
        and resolution_choice is not null)
  )
);

-- ---------------------------------------------------------------------------
-- scorecard_attestations (section 4.5/11.7): player/marker/director sign-off
-- of a card at a given score revision.
-- ---------------------------------------------------------------------------
create table public.scorecard_attestations (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete restrict,
  event_entry_id uuid references public.event_entries (id) on delete restrict,
  event_team_id uuid references public.event_teams (id) on delete restrict,
  profile_id uuid not null references public.profiles (id) on delete restrict,
  attestation_type public.attestation_type not null,
  score_revision bigint not null,
  attested_at timestamptz not null default now(),
  reason text,
  created_at timestamptz not null default now(),
  constraint scorecard_attestations_one_target check (num_nonnulls(event_entry_id, event_team_id) = 1)
);
