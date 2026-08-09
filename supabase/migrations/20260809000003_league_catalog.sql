-- Migration 3: league catalog tables (spec section 11.3).

-- ---------------------------------------------------------------------------
-- seasons
-- ---------------------------------------------------------------------------
create table public.seasons (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete restrict,
  name text not null,
  starts_on date not null,
  ends_on date not null,
  status public.season_status not null default 'planned',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seasons_league_name_unique unique (league_id, name),
  constraint seasons_date_order check (ends_on >= starts_on)
);

-- ---------------------------------------------------------------------------
-- participants: league roster rows. profile_id is optional so a guest
-- participant can exist before account activation (section 11.3).
-- organizer_notes is organizer-only; column-level SELECT privileges are
-- restricted in migration 9 and the notes are surfaced to organizers through
-- public.participant_organizer_notes().
-- ---------------------------------------------------------------------------
create table public.participants (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete restrict,
  profile_id uuid references public.profiles (id) on delete restrict,
  display_name text not null,
  sort_name text not null,
  external_ref text,
  status text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  organizer_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.participants.organizer_notes is
  'Organizer-only free text. Hidden from player reads via column-level privileges (migration 9); never rendered as raw HTML.';

-- ---------------------------------------------------------------------------
-- participant_handicaps: signed internal convention (plus handicaps are
-- negative, section 7.3). Overlapping active intervals for one participant
-- are prevented by both a btree unique on (participant_id, effective_from)
-- and a gist exclusion constraint over the daterange.
-- ---------------------------------------------------------------------------
create table public.participant_handicaps (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.participants (id) on delete restrict,
  value numeric(5, 1) not null,
  source public.handicap_source not null,
  effective_from date not null,
  effective_to date,
  verified_at timestamptz,
  verified_by uuid references public.profiles (id) on delete restrict,
  source_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint participant_handicaps_interval check (effective_to is null or effective_to > effective_from),
  constraint participant_handicaps_from_unique unique (participant_id, effective_from),
  -- Half-open [from, to) ranges; a NULL effective_to is unbounded.
  constraint participant_handicaps_no_overlap exclude using gist (
    participant_id with =,
    daterange(effective_from, effective_to, '[)') with &&
  )
);

comment on column public.participant_handicaps.value is
  'Signed handicap index in tenths precision. Plus handicaps are stored negative internally (section 4.4/7.3).';

-- ---------------------------------------------------------------------------
-- teams and team_members: current league rosters. Event snapshots, not these
-- rows, control an event (section 11.3).
-- ---------------------------------------------------------------------------
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete restrict,
  season_id uuid references public.seasons (id) on delete restrict,
  name text not null,
  status text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete restrict,
  participant_id uuid not null references public.participants (id) on delete restrict,
  valid_from date not null default current_date,
  valid_to date,
  created_at timestamptz not null default now(),
  constraint team_members_unique unique (team_id, participant_id, valid_from),
  constraint team_members_interval check (valid_to is null or valid_to > valid_from)
);

-- ---------------------------------------------------------------------------
-- Deferred FKs from migration 2 (scoring_permissions targets).
-- ---------------------------------------------------------------------------
alter table public.scoring_permissions
  add constraint scoring_permissions_participant_fk
  foreign key (participant_id) references public.participants (id) on delete restrict;

alter table public.scoring_permissions
  add constraint scoring_permissions_team_fk
  foreign key (team_id) references public.teams (id) on delete restrict;
