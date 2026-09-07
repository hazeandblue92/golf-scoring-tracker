-- Migration 38: make browser Data API privileges independent of CLI defaults.
-- RLS remains the row boundary; every write still uses an authorized RPC/Edge
-- Function. Re-establish the reviewed read allow-list after removing ambient
-- table grants, including TRUNCATE/REFERENCES/TRIGGER (not controlled by RLS).

revoke all privileges on all tables in schema public from public, anon, authenticated;
revoke all privileges on all sequences in schema public from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated;

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


-- Column-only access keeps organizer notes behind participant_organizer_notes.
grant select (id, league_id, profile_id, display_name, sort_name, external_ref,
  status, created_at, updated_at) on public.participants to authenticated;
