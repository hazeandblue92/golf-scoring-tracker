# Data Dictionary

PostgreSQL schema for the Golf Tournament Tracker, as created by the ordered
migrations in `supabase/migrations/` (spec section 11). Conventions
(section 11.1): uuid primary keys via `gen_random_uuid()`, `timestamptz`
stored in UTC, `created_at`/`updated_at` on mutable business tables, soft
lifecycle statuses instead of destructive deletes, restrictive foreign keys
with `ON DELETE CASCADE` only for ephemeral children of a draft event.

RLS posture legend (spec section 14.3): every table has RLS enabled and is
deny-by-default. "EF-only writes" means the table has no client
insert/update/delete policies and is mutated exclusively by Edge Functions
using the service role.

## Identity and access (section 11.2, migration 2)

| Table | Purpose | Key columns | RLS posture |
| --- | --- | --- | --- |
| `profiles` | App profile per Supabase auth user; the internal `.invalid` auth email is never exposed | `id` (PK, FK `auth.users`), `username` (citext, unique, format-checked), `display_name`, `status`, `must_change_password`, `privacy_accepted_at` | Read: own row; league admins for their members. EF-only writes (`account-admin`, `complete-activation`) |
| `leagues` | League root; one active row per deployment (enforced by partial unique index) | `id`, `name`, `slug` (unique), `timezone`, `locale`, `privacy_notice_version`, `settings_json`, `status` | Read: members and admins. Update: owner/league_admin. No client insert/delete |
| `league_memberships` | Connects a profile to league access | `league_id` + `profile_id` (unique pair), `member_status`, `joined_at`, `ended_at` | Read: own rows; league admins. EF-only writes |
| `role_assignments` | Additive scoped roles (section 2.2); CHECK forces event ids on event-scoped roles only | `league_id`, `event_id` (nullable), `profile_id`, `role`, `granted_by/at`, `revoked_at`; partial unique on active grants | Read: own rows; league admins; event directors for their events. EF-only writes |
| `scoring_permissions` | Scorer assignment per event round; XOR CHECK: exactly one of participant/team target | `event_id`, `round_id`, `scorer_profile_id`, `participant_id` XOR `team_id`, `permission_type`, `grant_origin` (`self` \| `explicit_field` \| `group_auto` \| `legacy`), `valid_from/to` | Read: own assignments; directors. Insert/update: directors. No delete (expiry via `valid_to`) |

`scoring_permissions.grant_origin` records WHY a grant exists (migration 37).
Self grants, organizer-selected field markers, and tee-group derived markers
were previously indistinguishable, so reloading an event draft promoted the
automatic grants into deliberate field-wide ones and widened access on each
edit. The event builder reloads only `explicit_field`. Rows created before the
column exists are `legacy`: unknown intent, never silently promoted.

## League catalog (section 11.3, migration 3)

| Table | Purpose | Key columns | RLS posture |
| --- | --- | --- | --- |
| `seasons` | Season windows per league | `league_id` + `name` (unique), `starts_on`, `ends_on`, `status` | Read: members. Write: owner/league_admin |
| `participants` | League roster incl. guests without accounts | `league_id`, `profile_id` (nullable), `display_name`, `sort_name`, `external_ref`, `status`, `organizer_notes` | Read: members, but `organizer_notes` is excluded via column-level grants; organizers read notes through `public.participant_organizer_notes()`. Write: owner/league_admin |
| `participant_handicaps` | Signed handicap values (plus handicaps negative); non-overlapping validity via unique (participant, effective_from) plus gist exclusion on the daterange | `participant_id`, `value numeric(5,1)`, `source`, `effective_from/to`, `verified_at/by`, `source_reference` | Read: owner/league_admin/event_director. Write: owner/league_admin (imports via `import-csv` EF) |
| `teams` | Current league teams (events use snapshots, not these rows) | `league_id`, `season_id` (nullable), `name`, `status` | Read: members. Write: owner/league_admin |
| `team_members` | Team membership over time | `team_id`, `participant_id`, `valid_from/to` (unique triple) | Read: members. Write: owner/league_admin |

## Courses (section 11.4, migration 4)

| Table | Purpose | Key columns | RLS posture |
| --- | --- | --- | --- |
| `courses` | Course master data | `league_id`, `name`, `location_text`, `timezone`, `status` | Read: members. Write: owner/league_admin |
| `course_layouts` | Versioned hole layouts (9 or 18) | `course_id`, `name`, `hole_count`, `version`, `effective_from`, `retired_at` | Read: members. Write: owner/league_admin |
| `tee_sets` | Rated tees; slope CHECK 55..155 (WHS) | `course_layout_id`, `name`, `rating_category`, `course_rating numeric(5,1)`, `slope_rating`, `par`, `version`, `status` | Read: members. Write: owner/league_admin |
| `tee_holes` | Per-hole par/yardage/stroke index; PK (tee_set, ordinal); unique (tee_set, stroke_index) | `tee_set_id`, `hole_ordinal`, `par`, `yardage`, `stroke_index` | Read: members. Write: owner/league_admin |

## Event setup (section 11.5, migration 5)

| Table | Purpose | Key columns | RLS posture |
| --- | --- | --- | --- |
| `events` | Event root with lifecycle status and monotonic `scoring_revision` | `league_id`, `season_id`, `slug` (unique per league), `timezone`, `starts_at/ends_at`, `status`, `visibility`, `scoring_revision`, `published_snapshot_version` | Read: visibility-based incl. anon for public events. Insert: admins. Update: directors (transition trigger enforces Appendix B; revision guarded). Delete: draft only |
| `rounds` | Rounds of an event | `event_id` + `round_number` (unique), `hole_count`, `status`, `snapshot_version` | Read with event. Write: directors. Delete: draft only |
| `event_tee_snapshots` | Frozen tee data copied at publish, hashed | `round_id`, `source_tee_set_id`, copied rating fields, `snapshot_version`, `snapshot_hash` | Read with event. EF-only writes (`publish-event`); immutable |
| `event_holes` | Frozen per-hole data; unique ordinal and unique stroke index per snapshot | `round_id`, `event_tee_snapshot_id`, `hole_ordinal`, `par`, `yardage`, `stroke_index` | Read with event. EF-only writes (`publish-event`); immutable |
| `flights` | Flights/divisions. Written only through `set_event_flights(event_id, flights jsonb)`, which replaces the whole set and is draft-only because setup freezes at publish | `event_id` + `name` (unique), `sort_order`, `eligibility_json` | Read with event. Write: directors, via `set_event_flights` |
| `event_entries` | Enrollment with frozen handicap: source, `handicap_value numeric(5,1)`, `course_handicap_unrounded numeric(12,6)`, `playing_handicap`, `allowance numeric(5,4)`, profile, tee snapshot ref, hash. Substitutions (§8.14) add `effective_from_round_id`, `replaces_entry_id`, `substitution_reason`: a substitute is a NEW row, so the replaced entry keeps its own participant and scores | `event_id` + `participant_id` (unique), `flight_id`, `status` (entity_status), handicap freeze columns, one live substitute per replaced entry (partial unique index) | Read with event (players see their own frozen snapshot here). Write: directors |
| `event_teams` | Frozen team header for the event | `event_id` + `name` (unique), `source_team_id`, `status`, `seed` | Read with event. Write: directors |
| `event_team_members` | Frozen roster (entries, ordered) | `event_team_id` + `event_entry_id` (unique), `position` | Read with event. Write: directors |
| `groups` | Tee groups per round with marker and start info | `round_id` + `label` (unique), `start_hole_ordinal`, `starts_at`, `marker_profile_id` | Read with event. Write: directors |
| `group_members` | Ordered group membership; XOR entry/team target | `group_id`, `event_entry_id` XOR `event_team_id`, `sort_order` | Read with event. Write: directors |

## Competitions (section 11.6, migration 6)

| Table | Purpose | Key columns | RLS posture |
| --- | --- | --- | --- |
| `competitions` | Structured Terms of Competition; `rules_json` authoritative, `rules_text` generated | `event_id` + `name` (unique), `format`, `metric`, `status`, `rules_schema_version`, `rules_json`, `engine_version`, `visibility`, `finalized_at/by`, `final_result_hash` | Read: layered event+competition visibility incl. anon for public. Write: directors; sealed independently per competition by the MFA-gated `finalize-competition` EF and unsealed by the MFA-gated `reopen-competition` EF; transition trigger enforces the lifecycle |
| `competition_rounds` | Round scope with hole subset, weight, drop policy; PK (competition, round) | `competition_id`, `round_id`, `hole_scope int[]`, `weight`, `drop_policy` | Read with competition. Write: directors |
| `competition_entities` | Entrants; XOR CHECK exactly one of entry/team | `competition_id`, `event_entry_id` XOR `event_team_id`, `eligibility_status`, `flight_id`, `seed` | Read with competition. Write: directors |
| `matches` | Match-play pairings and results | `competition_id`, `round_id`, `side_a/b_entity_id`, `bracket_position`, `status`, `winner_entity_id`, `result_summary` | Read with competition. Write: directors |

## Raw scoring (section 11.7, migration 7)

| Table | Purpose | Key columns | RLS posture |
| --- | --- | --- | --- |
| `individual_hole_scores` | Raw per-entry hole facts; CHECK enforces section 4.5 (gross required iff status `complete`, `gross >= 1`, never 0); composite FKs keep event/round/entry/hole consistent | `event_id`, `round_id`, `event_entry_id` + `event_hole_id` (unique), `gross_strokes`, `score_status`, `revision`, `entered_by`, `device_id_hash`, `source`, timing columns | Read: directors full event; entry owner; assigned scorer. Spectators never (projections only). EF-only writes (`submit-score`) |
| `team_hole_scores` | Same pattern keyed by `event_team_id` for team-ball formats | as above with `event_team_id` | Read: directors; team members; assigned scorer. EF-only writes |
| `score_mutations` | Append-only mutation ledger; PK is the client idempotency key | `idempotency_key` (PK), target ids, `base_revision`, `prior_value`/`new_value` (canonical jsonb), `actor_profile_id`, `result`, `event_revision`, `created_at` | Read: own receipts; directors full event. EF-only inserts; UPDATE/DELETE revoked and trigger-blocked for all roles |
| `score_conflicts` | Conflict records (never last-write-wins) with explicit resolution metadata | target ids, `local_payload`, `server_payload`, actor/revision pairs, `status`, `resolution_choice/value/reason`, `resolved_by/at` | Read: directors and involved actors. EF-only writes (`resolve-score-conflict`) |
| `scorecard_attestations` | Player/marker/director sign-off at a score revision | `round_id`, `event_entry_id` XOR `event_team_id`, `profile_id`, `attestation_type`, `score_revision`, `attested_at` | Read: attester, card owner, directors. EF-only writes |

## Projections and operations (section 11.8, migration 8)

| Table | Purpose | Key columns | RLS posture |
| --- | --- | --- | --- |
| `competition_projections` | One derived header per competition/revision with canonical summary and hash | PK (`competition_id`, `event_revision`), `engine_version`, `projection_hash`, `status`, `warnings`, `summary_json` | Read: per competition visibility incl. anon spectators for public. EF-only writes (projection publisher) |
| `leaderboard_rows` | Ranked rows per projection; ties share rank, unranked entities have NULL rank | PK (`competition_id`, `event_revision`, `entity_id`), `rank`, `is_tied`, `thru`, `result_primary/secondary`, `detail_json` | Same as projections |
| `hole_results` | Per entity/hole derived metrics, contributors, match result, skins pool/winner | `competition_id`, `event_revision`, `entity_id`, `event_hole_id` (unique quad), gross/net/status columns, skins/match columns | Same as projections |
| `event_revision_feed` | Compact realtime feed: current score/projection revisions and changed competitions; short history only | `event_id`, `score_revision`, `projection_revision`, `changed_competition_ids`, `published_at` | Read with event. EF-only writes; registered in the `supabase_realtime` publication |
| `audit_events` | Append-only audit trail (no passwords/tokens/unnecessary IPs) | `actor_profile_id`, `action`, `scope_league_id`/`scope_event_id`, `target_type/id`, `reason`, `before_json`/`after_json`, `correlation_id` | Read: league admins in scope; directors in event scope. EF-only inserts; UPDATE/DELETE revoked and trigger-blocked |
| `push_subscriptions` | Web Push endpoints and keys (sensitive) | `profile_id` + `endpoint` (unique), keys, `permission_status`, success/failure/revocation times | Own rows only (select/insert/update). Directors see delivery metadata only via `send-web-push` EF |
| `app_error_events` | Sanitized aggregated client/server errors; 30-day retention | `error_code`, `release`, `route_family`, `correlation_id`, `severity`, `occurrence_count`, first/last seen | Read: owner/league_admin. EF-only writes |
| `backup_runs` | Backup workflow metadata (never the artifact) | `started_at`/`completed_at`, `workflow_run_url`, `artifact_checksum`, `artifact_size_bytes`, `status`, `last_tested_restore_on` | Read: owner/league_admin. Writes: CI/EF with service role |

## Helper functions (migrations 9, 33, and 34)

| Function | Purpose |
| --- | --- |
| `app.is_league_member(league)` | Active membership check for the signed-in user (SECURITY DEFINER STABLE) |
| `app.has_role(league, roles[])` | Active role check against `role_assignments` |
| `app.is_event_director(event)` | Event director for the event, or owner/league_admin of its league |
| `app.actor_has_league_role(actor, league, roles[])` / `app.actor_is_event_director(actor, event)` | Service-workflow authorization predicates; require an active profile whose temporary-password activation is complete |
| `app.can_read_event(event)` / `app.can_read_competition(competition)` | Visibility gates used by read policies (anon-safe for public events) |
| `app.is_entry_owner(entry)` / `app.is_team_member(event_team)` | Card ownership checks |
| `public.bootstrap_initial_owner(...)` | Service-role-only, one-time transaction that creates/attaches the initial profile, league membership, owner grant, and audit row; guarded by owner history and an advisory lock |
| `app.can_score_entry(event, round, entry)` / `app.can_score_team(event, round, team)` | Active scorer assignment checks incl. team-to-member expansion |
| `app.is_operator()` | Owner/league_admin anywhere; gates ops tables |
| `public.participant_organizer_notes(participant)` | RPC returning organizer notes to organizer roles, NULL otherwise |

## State machines and guards (migration 10)

- `app.enforce_event_transition()` implements the Appendix B graph exactly;
  unpublish (`published -> draft`) is rejected once any accepted score exists.
- `app.enforce_scoring_revision_guard()` blocks direct changes to
  `events.scoring_revision`; only the future `app.apply_score_mutation()`
  (Edge Function phase) may advance it, monotonically.
- `app.prevent_nondraft_event_delete()` restricts hard DELETE to draft events,
  making the setup-child cascades draft-only by construction.
- `app.enforce_competition_transition()` applies the same lifecycle graph to
  competitions, which may reopen independently of the event.
- `app.set_updated_at()` maintains `updated_at` on all mutable tables.
- `app.prevent_change()` makes `score_mutations` and `audit_events`
  append-only for every role, including the service role.
