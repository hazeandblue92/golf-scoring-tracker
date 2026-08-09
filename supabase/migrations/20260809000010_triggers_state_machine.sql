-- Migration 10: updated_at maintenance and database-enforced state machines.
-- Appendix B: "Event and competition transitions are database-enforced; the
-- UI is not the authority." Triggers fire for every role, including the
-- service role used by Edge Functions.

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function app.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'leagues', 'league_memberships', 'scoring_permissions',
    'seasons', 'participants', 'participant_handicaps', 'teams',
    'courses', 'course_layouts', 'tee_sets', 'tee_holes',
    'events', 'rounds', 'flights', 'event_entries', 'event_teams', 'groups',
    'competitions', 'competition_entities', 'matches',
    'individual_hole_scores', 'team_hole_scores', 'score_conflicts',
    'push_subscriptions'
  ] loop
    execute format(
      'create trigger set_updated_at before update on public.%I for each row execute function app.set_updated_at()',
      t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Event state transitions (Appendix B):
--   draft -> published
--   published -> draft            only before any accepted score; audited unpublish
--   published -> scoring_open
--   scoring_open -> scoring_closed
--   scoring_closed -> scoring_open   director reopen + reason
--   scoring_closed -> finalized      all blockers resolved/overridden
--   finalized -> scoring_closed      director/admin + MFA + reason; invalidates final hash
--   finalized -> archived
--   archived -> finalized            owner/admin restore, read-only by default
-- MFA, reason capture, blocker checks, and final-hash invalidation are
-- enforced by the publish-event / finalize-competition Edge Functions
-- (section 12.2); this trigger enforces the transition graph itself and the
-- no-accepted-score condition for unpublish, for every caller.
-- ---------------------------------------------------------------------------
create or replace function app.enforce_event_transition()
returns trigger
language plpgsql
as $$
declare
  allowed boolean;
begin
  if new.status = old.status then
    return new;
  end if;

  allowed := case
    when old.status = 'draft' and new.status = 'published' then true
    when old.status = 'published' and new.status = 'draft' then true
    when old.status = 'published' and new.status = 'scoring_open' then true
    when old.status = 'scoring_open' and new.status = 'scoring_closed' then true
    when old.status = 'scoring_closed' and new.status = 'scoring_open' then true
    when old.status = 'scoring_closed' and new.status = 'finalized' then true
    when old.status = 'finalized' and new.status = 'scoring_closed' then true
    when old.status = 'finalized' and new.status = 'archived' then true
    when old.status = 'archived' and new.status = 'finalized' then true
    else false
  end;

  if not allowed then
    raise exception 'invalid event status transition: % -> %', old.status, new.status
      using errcode = '23514';
  end if;

  -- Unpublish is allowed only before any accepted score exists.
  if old.status = 'published' and new.status = 'draft' then
    if exists (
         select 1 from public.individual_hole_scores s
         where s.event_id = new.id and s.score_status <> 'not_started'
       )
       or exists (
         select 1 from public.team_hole_scores s
         where s.event_id = new.id and s.score_status <> 'not_started'
       ) then
      raise exception 'event % cannot return to draft: accepted scores exist', new.id
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create trigger events_status_transition
  before update on public.events
  for each row execute function app.enforce_event_transition();

-- ---------------------------------------------------------------------------
-- scoring_revision guard: the event scoring revision advances only inside the
-- score mutation function, monotonically.
--
-- PLACEHOLDER: app.apply_score_mutation(...) ships with the Edge Function
-- phase. It will run:
--     set local app.allow_scoring_revision_change = 'on';
-- inside its transaction before updating events.scoring_revision, so the
-- setting can never leak past the transaction. Until then, every direct
-- change to scoring_revision is rejected.
-- ---------------------------------------------------------------------------
create or replace function app.enforce_scoring_revision_guard()
returns trigger
language plpgsql
as $$
begin
  if new.scoring_revision is distinct from old.scoring_revision then
    if coalesce(current_setting('app.allow_scoring_revision_change', true), '') <> 'on' then
      raise exception 'events.scoring_revision may only be advanced by app.apply_score_mutation()'
        using errcode = '23514';
    end if;
    if new.scoring_revision < old.scoring_revision then
      raise exception 'events.scoring_revision must increase monotonically (% -> %)',
        old.scoring_revision, new.scoring_revision
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger events_scoring_revision_guard
  before update on public.events
  for each row execute function app.enforce_scoring_revision_guard();

-- ---------------------------------------------------------------------------
-- Hard DELETE of an event is a draft-only teardown; every later lifecycle
-- stage uses soft status (section 11.1). Cascading FKs on setup children can
-- therefore only ever fire for draft events.
-- ---------------------------------------------------------------------------
create or replace function app.prevent_nondraft_event_delete()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'draft' then
    raise exception 'event % is % and cannot be deleted; archive it instead', old.id, old.status
      using errcode = '23514';
  end if;
  return old;
end;
$$;

create trigger events_delete_guard
  before delete on public.events
  for each row execute function app.prevent_nondraft_event_delete();

-- ---------------------------------------------------------------------------
-- Competition state transitions: same graph as events (Appendix B). A
-- competition may be reopened independently while the raw scores of another
-- competition remain open; raw-score acceptance is an event-level concern, so
-- no score check is applied here. Final-hash management (set on finalize,
-- cleared on reopen) is the finalize-competition Edge Function's job; the
-- competitions_finalized_fields CHECK keeps the pair consistent.
-- ---------------------------------------------------------------------------
create or replace function app.enforce_competition_transition()
returns trigger
language plpgsql
as $$
declare
  allowed boolean;
begin
  if new.status = old.status then
    return new;
  end if;

  allowed := case
    when old.status = 'draft' and new.status = 'published' then true
    when old.status = 'published' and new.status = 'draft' then true
    when old.status = 'published' and new.status = 'scoring_open' then true
    when old.status = 'scoring_open' and new.status = 'scoring_closed' then true
    when old.status = 'scoring_closed' and new.status = 'scoring_open' then true
    when old.status = 'scoring_closed' and new.status = 'finalized' then true
    when old.status = 'finalized' and new.status = 'scoring_closed' then true
    when old.status = 'finalized' and new.status = 'archived' then true
    when old.status = 'archived' and new.status = 'finalized' then true
    else false
  end;

  if not allowed then
    raise exception 'invalid competition status transition: % -> %', old.status, new.status
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger competitions_status_transition
  before update on public.competitions
  for each row execute function app.enforce_competition_transition();
