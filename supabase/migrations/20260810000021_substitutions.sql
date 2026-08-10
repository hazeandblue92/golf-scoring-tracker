-- Migration 21: mid-event substitutions (spec §8.14, §11.3).
--
-- "Support withdrawals, no-shows, disqualifications, and substitutions without
-- deleting history." / "Substitute mid-event: new entry with effective round;
-- historical round remains attributed." / "Cuts, playoffs, and substitutions
-- are explicit entries; deleted rows are never used to rewrite history."
--
-- The model that satisfies all three: a substitution NEVER edits the outgoing
-- entry's participant. It creates a NEW event_entries row for the incoming
-- player, marks the round it takes effect from, and points back at the entry
-- it replaces. The outgoing row keeps its own rounds and its own scores, so a
-- scorecard from round one still names the player who actually played it.

alter table public.event_entries
  add column if not exists effective_from_round_id uuid
    references public.rounds (id) on delete restrict,
  add column if not exists replaces_entry_id uuid
    references public.event_entries (id) on delete restrict,
  add column if not exists substitution_reason text;

comment on column public.event_entries.effective_from_round_id is
  'First round this entry is eligible to score. NULL means the entry has been in the field since the event opened.';
comment on column public.event_entries.replaces_entry_id is
  'The entry this one substitutes for. The replaced entry is never deleted or reassigned; its earlier rounds stay attributed to the player who played them (section 8.14).';
comment on column public.event_entries.substitution_reason is
  'Committee note recorded with the substitution; surfaced in audit, never in public results.';

-- A substitution must name the round it starts at, or the chain has no point
-- at which attribution changes hands.
alter table public.event_entries
  drop constraint if exists event_entries_substitution_complete;
alter table public.event_entries
  add constraint event_entries_substitution_complete
  check (replaces_entry_id is null or effective_from_round_id is not null);

-- An entry cannot substitute for itself.
alter table public.event_entries
  drop constraint if exists event_entries_substitution_not_self;
alter table public.event_entries
  add constraint event_entries_substitution_not_self
  check (replaces_entry_id is null or replaces_entry_id <> id);

-- One live substitute per replaced entry: a second substitution for the same
-- outgoing entry would leave two players holding the same slot in one round.
create unique index if not exists event_entries_one_substitute_per_entry
  on public.event_entries (replaces_entry_id)
  where replaces_entry_id is not null;

create index if not exists event_entries_effective_round_idx
  on public.event_entries (event_id, effective_from_round_id)
  where effective_from_round_id is not null;

-- Table-level privileges from migration 13 already cover new columns.
