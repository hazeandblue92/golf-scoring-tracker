-- Migration 14: freeze the team playing handicap on the event roster.
--
-- event_entries already freezes each individual's computed handicap at publish
-- (course_handicap_unrounded, playing_handicap, allowance, handicap_profile)
-- so a recomputation months later reproduces the same result. Team formats
-- (§8.9-8.12: scramble, foursomes, greensomes, chapman) derive a TEAM playing
-- handicap from member course handicaps, and that derived value needs the same
-- freeze for the same reason — otherwise a later roster or index edit silently
-- changes a finalized team result.
--
-- The scoring snapshot and projection orchestrator already read
-- event_teams.playing_handicap; migration 5 created the roster table without
-- it, so every projection publish failed its snapshot read and every score
-- degraded to 'queued_projection'. This adds the missing column.

alter table public.event_teams
  add column if not exists course_handicap_unrounded numeric(12, 6),
  add column if not exists playing_handicap smallint,
  add column if not exists allowance numeric(5, 4)
    check (allowance is null or (allowance > 0 and allowance <= 2));

comment on column public.event_teams.playing_handicap is
  'Committee-confirmed team playing handicap, frozen at publish. Derived from member course handicaps by the engine team-handicap functions (section 8.9-8.12); stored so finalized results recompute identically.';
comment on column public.event_teams.course_handicap_unrounded is
  'Unrounded basis for playing_handicap, retained for audit and deterministic recomputation (section 5.4).';

-- Table-level privileges granted in migration 13 already cover new columns, so
-- no re-grant is required here. The privilege matrix stays the last migration.
