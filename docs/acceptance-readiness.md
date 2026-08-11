# Acceptance and Handoff Readiness

This is the release-truth record for specification §§23, 24, and 26. It is
deliberately conservative: **Demonstrated** means a direct automated check
exists and must be green on the release commit; **Partial** means useful
automation exists but does not prove the whole criterion; **Manual/deployment**
means local code cannot close the gate. A configured feature is never counted
as a manual or production pass.

## §23 acceptance matrix

| Criterion | Status | Evidence and remaining gate |
| --- | --- | --- |
| AC-001 | Partial | RLS tests prove the temporary-password flag blocks mutation until activation; MFA integration/browser tests prove an AAL1 organizer is rejected and an enrolled, challenged TOTP session can use privileged workflows. Add a complete first-sign-in/password-change browser journey; recovery access for real directors remains a §26 launch drill. |
| AC-002 | Demonstrated | `tests/integration/test/phase1-workflow.test.ts` and `tests/e2e/phase1.spec.ts` create and publish through supported application paths. |
| AC-003 | Demonstrated | `tests/integration/test/phase1-workflow.test.ts` changes catalog course, tee, hole, roster, and handicap sources, proves frozen rows/projections do not move, and verifies published handicap/rule edits are denied. |
| AC-004 | Manual/deployment | No test currently counts the interactions from player sign-in to the active scorecard. Add a player-journey assertion and verify it on a physical phone. |
| AC-005 | Demonstrated | `tests/integration/test/rls-security.test.ts` covers assigned, self, unassigned, unauthenticated, locked-event, and direct-table paths with real JWTs and service-side ground truth. |
| AC-006 | Partial | IndexedDB/outbox code, idempotency integration tests, and browser offline reopening exist. A browser test must still queue while offline, refresh, reconnect, and prove the original idempotency key syncs once; screen-lock survival remains a device drill. |
| AC-007 | Partial | `docs/reports/phase4-capacity.md` records a passing local 120-client profile. Re-run the full profile against the production free project and retain the report. |
| AC-008 | Demonstrated | `tests/integration/test/live-pipeline.test.ts`, Phase 2 workflow tests, and browser tests exercise simultaneous projections from shared raw scores. |
| AC-009 | Demonstrated | Phase 1 workflow coverage proves missing-score blocking/override; `tests/integration/test/conflict.test.ts` proves open conflicts block finalization without an override. |
| AC-010 | Demonstrated | `tests/integration/test/export-hash.test.ts` reconstructs and re-hashes an exported frozen snapshot. A clean-stack restore is separately tracked by AC-COST-005. |
| AC-FMT-001 | Demonstrated | The full unit/property/golden suite and every format-specific integration suite pass together on this release candidate, including multi-round, match, shamble, flight, skins, and substitution projections. |
| AC-FMT-002 | Demonstrated | `packages/scoring/test/best-ball.test.ts` explicitly proves per-player net calculation occurs before selection. |
| AC-FMT-003 | Demonstrated | Stroke-allocation and match tests cover signed plus handicaps and give-back strokes. |
| AC-FMT-004 | Demonstrated | `packages/scoring/test/match-play.test.ts` covers regulation, dormie/clinch, concession, and extra-hole states. |
| AC-FMT-005 | Demonstrated | `packages/scoring/test/skins.test.ts` covers every frozen carry/final-carry policy and unit conservation. |
| AC-FMT-006 | Demonstrated | Stroke, team, Stableford, match, and skins tests preserve terminal states without coercing them to zero. |
| AC-REL-001 | Demonstrated | `tests/integration/test/idempotency.test.ts` proves sequential and concurrent duplicate retries produce one mutation and the original receipt. |
| AC-REL-002 | Demonstrated | `tests/integration/test/conflict.test.ts` proves stale writes create durable, explicit conflicts without overwriting the score. |
| AC-REL-003 | Partial | Raw facts and projections are separated; live-pipeline, stale-publication, repair, and lease tests cover normal recovery. Add a deterministic forced projection-failure test that proves the committed raw row survives and repair converges. |
| AC-REL-004 | Partial | Leaderboards poll every ten seconds in addition to Realtime. Add an outage test that disables the subscription, observes polling convergence, and proves no write is duplicated. |
| AC-SEC-001 | Partial | `tests/integration/test/rls-security.test.ts` covers event/role boundaries and direct table attacks. Add an isolated second-league fixture to prove cross-league denial explicitly. |
| AC-SEC-002 | Partial | `npm run test:security` detects Supabase privileged keys/JWTs, credentialed DB URLs, Cloudflare tokens, VAPID/private keys, and literal privileged environment values across browser bundles, tracked files, and likely log/export/environment artifacts without printing matches. It does not scan Git history or files outside the checkout; run provider history scanning and separately inspect production logs and generated exports. |
| AC-SEC-003 | Demonstrated | `npm run test:security` compares source and built headers/CSP, rejects unsafe or local production origins, and scans every built JavaScript bundle. Verify the same headers on the deployed URL. |
| AC-SEC-004 | Demonstrated | Integration tests prove a retained, unexpired JWT loses mutation access immediately after profile disablement; account administration retains the profile/audit identity. Complete one production session-revocation drill. |
| AC-COST-001 | Manual/deployment | Owner must record that Supabase, Cloudflare Pages, and public-repository Actions are on Free plans, use the generated `pages.dev` host, and have no payment method attached. |
| AC-COST-002 | Manual/deployment | The repository has no required email/SMS or paid API flow. Owner must confirm production vendor configuration introduces none. |
| AC-COST-003 | Partial | Operations exposes measured database thresholds, manual vendor quota checks, and stop-first guidance. Vendor dashboards remain a required operator review. |
| AC-COST-004 | Demonstrated | `npm run test:licenses` fails on any shipped dependency outside the reviewed allow-list. |
| AC-COST-005 | Partial | Portable export, integrity hashing, restore ordering, and restore tooling exist. Complete and record a clean local/self-hosted restore including migrations, RLS, projection rebuild, and final-hash comparison. |
| AC-A11Y-001 | Partial | Playwright/axe and reflow automation cover core surfaces. Complete every Due row in `docs/accessibility-audit.md` and `docs/supported-device-matrix.md`. |
| AC-A11Y-002 | Partial | Sync states use text/status semantics and automated accessibility checks. VoiceOver/TalkBack announcement cadence and field-error perception remain manual gates. |
| AC-PERF-001 | Partial | CI enforces the bundle budget; the local supported-load profile passed. Production load, interaction responsiveness, and physical-device field evidence remain due. |

## §24 zero-cost release gates

Before launch, the owner must attach evidence to `docs/season-launch-checklist.md`
for the Free-plan/no-payment-method checks, generated `pages.dev` hostname,
vendor quotas, production capacity run, and the 60/75/90/95 percent circuit
breakers. Optional push, spectator live updates, and historical subscriptions
must be disabled before core scoring is degraded. A quota increase, custom
domain, paid messaging, telemetry, commercial data feed, or billing attachment
requires an explicit product decision and specification update.

## §26 handoff checklist

### Present in the repository

- MIT license, lockfile, quick start, architecture decisions, migrations,
  deterministic synthetic seed data, data dictionary/RLS posture, shared
  scoring engine, contracts, golden vectors, Edge Functions, PWA/offline
  implementation, CI, encrypted backup/restore tooling, security headers,
  credential-rotation and operator runbooks.
- Accessibility record, supported-device matrix, local capacity report, season
  checklist, portable export and deterministic result-hash coverage.

### Must be generated or signed for the release commit

- Clean `npm ci`, type checks, unit/property/golden, integration, browser/axe,
  build, lint, bundle, security, and license runs, plus a retained coverage
  report meeting the scoring thresholds.
- Generated database types checked against the release schema and a reviewed
  RLS policy map if the data dictionary no longer matches the migrations.
- Clean-stack portable restore report and production encrypted-backup restore
  drill, including RLS and result comparison—not checksum alone.
- Production capacity report, deployed CSP/header check, physical device and
  assistive-technology records, organizer training, and MFA/recovery drill.
- Signed owner acceptance of the §25 defaults/unresolved decisions and all
  remaining manual/deployment rows above.

Implementation is not complete, and season launch remains blocked, while any
item in the second list is missing or any automated gate is red.
