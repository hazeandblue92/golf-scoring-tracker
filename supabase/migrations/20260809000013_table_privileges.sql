-- Migration 13: SQL-level table privileges (spec §14.3, §12.1).
--
-- This deployment uses the always-revoked Data API model: no role receives
-- automatic privileges on newly created tables. Row Level Security is the
-- authorization boundary, but PostgreSQL checks SQL privileges FIRST — a
-- table with perfect policies and no GRANT is simply inaccessible. Migrations
-- 1-12 created the tables, enabled RLS, and wrote the policies; this
-- migration grants the privileges those policies then filter.
--
-- Principles:
--   * `authenticated` receives SELECT only. Every mutation goes through a
--     SECURITY DEFINER function (apply_score_mutation) or an Edge Function
--     with service credentials (§12.1), so no browser role needs INSERT,
--     UPDATE, or DELETE anywhere.
--   * `anon` receives SELECT only on the tables a public spectator view
--     needs; RLS then restricts rows to public events and published
--     projections (§14.3). Raw scores, mutations, audit, and operations
--     tables are never granted to anon.
--   * `service_role` receives the DML its Edge Functions require. It is
--     never present in the browser bundle (§2.3).
--   * Append-only tables keep their migration-7/8 UPDATE/DELETE revocations
--     and triggers; nothing here re-grants them.

-- ---------------------------------------------------------------------------
-- authenticated: read access across the league catalog, event snapshots,
-- competitions, raw scoring, and projections. RLS narrows every row set.
-- `participants` is deliberately excluded: migration 9 revokes table-level
-- SELECT and grants an explicit column list so organizer-only notes stay
-- invisible.
-- ---------------------------------------------------------------------------
grant select on
  public.profiles,
  public.leagues,
  public.league_memberships,
  public.role_assignments,
  public.scoring_permissions,
  public.seasons,
  public.participant_handicaps,
  public.teams,
  public.team_members,
  public.courses,
  public.course_layouts,
  public.tee_sets,
  public.tee_holes,
  public.events,
  public.rounds,
  public.event_tee_snapshots,
  public.event_holes,
  public.event_entries,
  public.event_teams,
  public.event_team_members,
  public.flights,
  public.groups,
  public.group_members,
  public.competitions,
  public.competition_rounds,
  public.competition_entities,
  public.matches,
  public.individual_hole_scores,
  public.team_hole_scores,
  public.score_mutations,
  public.score_conflicts,
  public.scorecard_attestations,
  public.competition_projections,
  public.leaderboard_rows,
  public.hole_results,
  public.event_revision_feed,
  public.audit_events,
  public.push_subscriptions
to authenticated;

-- ---------------------------------------------------------------------------
-- anon: published spectator surface only (§14.3 "Spectator" column).
-- Raw scores are never readable directly; spectators see projections.
-- ---------------------------------------------------------------------------
grant select on
  public.events,
  public.rounds,
  public.event_holes,
  public.competitions,
  public.competition_entities,
  public.competition_projections,
  public.leaderboard_rows,
  public.hole_results,
  public.event_revision_feed
to anon;

-- ---------------------------------------------------------------------------
-- service_role: the privileged server surface. Edge Functions publish
-- projections, import CSV, provision accounts, finalize competitions, and
-- repair state. Migration 12 already granted profiles/leagues/memberships/
-- role_assignments/audit_events; the rest follows here.
-- ---------------------------------------------------------------------------
-- Restated here (also granted in migration 12) so that this single, final
-- migration is the complete privilege authority: the Data API revokes
-- privileges from these roles between migration steps, so grants must land
-- last to survive a `db reset`.
grant select, insert, update on public.profiles to service_role;
grant select, update on public.leagues to service_role;
grant select, insert, update on public.league_memberships to service_role;
grant select, insert, update on public.role_assignments to service_role;
grant select, insert on public.audit_events to service_role;

grant select, insert, update, delete on
  public.scoring_permissions,
  public.seasons,
  public.participants,
  public.participant_handicaps,
  public.teams,
  public.team_members,
  public.courses,
  public.course_layouts,
  public.tee_sets,
  public.tee_holes,
  public.events,
  public.rounds,
  public.event_tee_snapshots,
  public.event_holes,
  public.event_entries,
  public.event_teams,
  public.event_team_members,
  public.flights,
  public.groups,
  public.group_members,
  public.competitions,
  public.competition_rounds,
  public.competition_entities,
  public.matches,
  public.individual_hole_scores,
  public.team_hole_scores,
  public.score_conflicts,
  public.scorecard_attestations,
  public.competition_projections,
  public.leaderboard_rows,
  public.hole_results,
  public.event_revision_feed,
  public.push_subscriptions,
  public.app_error_events,
  public.backup_runs
to service_role;

-- Append-only ledger: insert and read only. The migration-7 trigger rejects
-- updates and deletes from every role including this one.
grant select, insert on public.score_mutations to service_role;

-- Sequences are not used (uuid primary keys), so no sequence grants are
-- required. Function privileges are granted at each function's definition.
