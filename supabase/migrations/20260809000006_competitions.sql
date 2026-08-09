-- Migration 6: competition tables (spec section 11.6).

-- ---------------------------------------------------------------------------
-- competitions: structured Terms of Competition. rules_json (validated
-- against rules_schema_version, Appendix A) is authoritative; rules_text is
-- generated for humans (section 6.1). Finalization writes engine_version,
-- finalized_at/by and final_result_hash via the finalize-competition Edge
-- Function only (section 12.2); reopening clears the hash (Appendix B).
-- ---------------------------------------------------------------------------
create table public.competitions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  name text not null,
  format text not null check (format in (
    'individual_stroke', 'best_k', 'stableford', 'match', 'skins', 'scramble',
    'foursomes', 'greensomes', 'chapman', 'shamble', 'par_bogey', 'aggregate')),
  metric text not null check (metric in ('gross', 'net', 'points')),
  status text not null default 'draft' check (status in (
    'draft', 'published', 'scoring_open', 'scoring_closed', 'finalized', 'archived')),
  rules_schema_version integer not null default 1,
  rules_json jsonb not null,
  rules_text text not null default '',
  engine_version text not null,
  visibility public.event_visibility not null default 'league',
  sort_order integer not null default 0,
  finalized_at timestamptz,
  finalized_by uuid references public.profiles (id) on delete restrict,
  final_result_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint competitions_event_name_unique unique (event_id, name),
  constraint competitions_finalized_fields check (
    status <> 'finalized'
    or (finalized_at is not null and final_result_hash is not null)
  )
);

-- ---------------------------------------------------------------------------
-- competition_rounds: which rounds a competition spans. hole_scope NULL means
-- all holes of the round; otherwise an ordinal array subset.
-- ---------------------------------------------------------------------------
create table public.competition_rounds (
  competition_id uuid not null references public.competitions (id) on delete cascade,
  round_id uuid not null references public.rounds (id) on delete cascade,
  hole_scope integer[],
  weight numeric(8, 4) not null default 1,
  drop_policy text,
  created_at timestamptz not null default now(),
  primary key (competition_id, round_id)
);

-- ---------------------------------------------------------------------------
-- competition_entities: entrants of a competition. Exactly one of
-- event_entry_id / event_team_id (XOR enforced).
-- ---------------------------------------------------------------------------
create table public.competition_entities (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions (id) on delete cascade,
  event_entry_id uuid references public.event_entries (id) on delete cascade,
  event_team_id uuid references public.event_teams (id) on delete cascade,
  eligibility_status text not null default 'eligible'
    check (eligibility_status in ('eligible', 'ineligible', 'pending')),
  flight_id uuid references public.flights (id) on delete set null,
  seed integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint competition_entities_one_target check (num_nonnulls(event_entry_id, event_team_id) = 1)
);

create unique index competition_entities_entry_unique
  on public.competition_entities (competition_id, event_entry_id) where event_entry_id is not null;
create unique index competition_entities_team_unique
  on public.competition_entities (competition_id, event_team_id) where event_team_id is not null;

-- ---------------------------------------------------------------------------
-- matches: match-play pairings. Side entity FKs cascade because matches are
-- ephemeral children of a draft competition; a NULL side is a bye.
-- ---------------------------------------------------------------------------
create table public.matches (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions (id) on delete cascade,
  round_id uuid not null references public.rounds (id) on delete cascade,
  side_a_entity_id uuid references public.competition_entities (id) on delete cascade,
  side_b_entity_id uuid references public.competition_entities (id) on delete cascade,
  bracket_position integer,
  status text not null default 'scheduled' check (status in (
    'scheduled', 'in_progress', 'complete', 'conceded', 'walkover', 'cancelled')),
  winner_entity_id uuid references public.competition_entities (id) on delete set null,
  result_summary text,
  concession_by uuid references public.profiles (id) on delete restrict,
  concession_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint matches_distinct_sides check (
    side_a_entity_id is null
    or side_b_entity_id is null
    or side_a_entity_id <> side_b_entity_id
  )
);

comment on column public.matches.result_summary is
  'Presentation form of the decided result, e.g. AS, 2 UP, 3&2 (section 4.6).';
