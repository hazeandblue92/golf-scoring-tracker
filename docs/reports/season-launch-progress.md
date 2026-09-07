# Season launch implementation record

Started 2026-09-07 from `d14d697`, on `codex/season-launch`, against the owner's
Route to Season Launch plan. This record tracks implementation, not acceptance
sign-off: a green gate here is evidence that code works, never that a drill was
performed. `artifacts/two-man-throwdown-demo/` is owner workspace content and is
deliberately not committed.

## Backend and operations

- Supabase project `dhdctelabkzfbxoppjck` was `INACTIVE` on 2026-09-07 and has
  been restored by the owner. `/functions/v1/health` answers 200 `{"status":
  "ok"}` (the unauthenticated summary), and `https://golfsc2man.pages.dev`
  serves the expected CSP, HSTS, and no-store shell.
- `service-health.yml` polls that endpoint every other day. A free project
  pauses after roughly a week of inactivity, which is exactly what took the
  deployment down between 2026-08-27 and 2026-09-07; `health` reads the database
  and the auth admin API, so the check doubles as the keep-alive.
- Backup and maintenance now assemble their connection string through
  `scripts/lib/operations-config.mjs`: host/user/password parts or a whole URL,
  `sslmode=require` forced, the assembled URL masked, and a fail-fast validation
  step that names the missing variable instead of falling through to a runner
  socket. Plaintext dump and tarball are removed with `if: always()`.

**Still owner-only:** generate the age keypair, store the private identity on
two owner-controlled devices, set `AGE_BACKUP_RECIPIENT`, `SUPABASE_URL`, and
`SUPABASE_SERVICE_ROLE_KEY`, then run the backup and maintenance workflows and
retain the evidence. No backup has ever succeeded, so the §26 restore drill
cannot start until this is done.

## Schema

- Migration 38 restates the browser Data API privileges explicitly rather than
  inheriting the Supabase CLI's stack defaults, which changed in 2.116 and
  flipped six privilege assertions from 42501 to 23514. The grant lists are
  unchanged from migration 13.
- Migration 39 adds `record_participant_handicap`, which closes a superseded
  handicap interval and opens the next one in a single statement. The old
  insert-only path succeeded exactly once per player and then collided with the
  gist exclusion for ever after.
- `health` reports `schemaVersion` 39.

**Still owner-only:** dry-run and apply migrations 38 and 39 to the hosted
project, then redeploy Edge Functions and the web app and confirm the
authenticated health body reports schema 39 and matching release stamps.

## Release gates

Every automated gate is green on this branch, verified 2026-09-07:

| Gate | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run typecheck:functions` | pass |
| `npm run lint` | pass (`--max-warnings=0`) |
| `npm run test:coverage` | pass — 95.99% branches (gate 95), 98.92% lines, 100% functions |
| `npm run build` | pass |
| `npm run test:bundle-budget` | pass |
| `npm run test:security` | pass — 15 scanner self-tests, 36 bundles, 323 files |
| `npm run test:licenses` | pass |
| `npm run test:operations` | pass |
| `npm run db:types -- --check` | pass |
| `npm run test:integration` | pass — 38 files, 216 tests, 3 skipped |
| `npm run test:e2e` | pass — 44 journeys across Chromium, Firefox, WebKit, Pixel 7 |
| `npm ci` from the lockfile | pass — the whole battery re-run on a clean install |
| `npm audit` | 0 vulnerabilities |

Coverage now runs in CI and the report is retained as an artifact; it had never
run before, which is why the gate sat red and unnoticed. Generated database
types are committed and CI fails when they drift from the migrations.

The Dependabot backlog is cleared. Migration 38 unblocked the CLI upgrade that
had stalled it since 2026-08-13, and everything mergeable was taken and
verified rather than merged on a green checkmark: the GitHub Actions majors
(checkout 7, setup-node 7, upload-artifact 7, download-artifact 8, setup-cli 3,
dependency-review 5), react-router 8.3.1, supabase-js 2.116, Supabase CLI
2.117, zod 4.5.4 with the Edge `deno.json` pin moved to match, and every
in-range minor and patch. `cloudflare/wrangler-action` stays on v3 — it is the
deployment path and there is no way to test a major there short of a real
deploy. TypeScript stays on 6.0.2 per ADR 0008 and the specification's own
source register. Initial JavaScript is 216.15 KiB gzip against the 250 KiB
budget.

The upgrade surfaced a real defect, now fixed: the outbox's score send had no
timeout, so a request that hung rather than failing left the row in `sending`
for the life of the document — durable and reported unsynced, but never
retried until the app was reloaded. It is bounded at twenty seconds and
requeues like any other network failure (§10.3).

## Specification gaps closed

- **CSV import and export (§4.2, §4.3, §21.2).** A shared parser in
  `packages/contracts/src/csv.ts` handles BOM, LF/CRLF/CR, duplicated headers,
  ragged rows, unknown enums, and formula strings, reporting by row and column
  rather than aborting. Preview and apply run the same server-side validation
  over the same text. Course hole tables read through the same reviewer, so a
  spreadsheet export and a typed four-column paste behave identically.
- **Account lifecycle UI (FR-AUTH-002).** Disable, reactivate, and reset are
  wired to the roster; the Edge Function actions had existed and been tested
  since Phase 1 with nothing calling them. This is also the interface
  AC-SEC-004's production revocation drill needs.
- **Roster and season maintenance (§4.2).** Edit a participant, revise a
  handicap with effective date and source, set roster status, and move a season
  through planned → active → completed → archived. A rename no longer resets a
  season's status.
- **Event templates (§3.2, §4.2).** A new event can copy a previous event's
  field, teams, flights, tee, and format. The source event is never modified.
- **ADR 0006** rules Web Push out of launch scope; **ADR 0007** records that
  corrections are director-initiated. Both are marked pending owner
  confirmation at the §25 sign-off.

## Remaining before launch

Everything below needs the owner, a vendor account, or a physical device. None
of it can be closed by code.

1. Migrations 38–39 applied to the hosted project; Edge Functions and web app
   redeployed; authenticated health confirmed.
2. Backup secrets set, age identity stored on two devices, backup and
   maintenance workflows run green and retained.
3. Clean-stack portable restore drill and an encrypted-backup restore drill
   from a second device, compared by result hash rather than checksum.
4. Production capacity run at the 120-client profile against the deployed
   project, report retained.
5. The seven Due rows in `docs/accessibility-audit.md`, and the physical iPhone
   and Android rows in `docs/supported-device-matrix.md`.
6. MFA enrolment and recovery drill; a live session-revocation check against a
   disabled account, now that the interface for it exists.
7. Free-plan and no-payment-method evidence; trademark check on "Golf
   Tournament Tracker"; signed owner acceptance of the §25 defaults and of ADRs
   0006 and 0007.
8. Real-phone dress rehearsal of the two-man throwdown with gross, net, and net
   skins, including a stretch in airplane mode and one audited correction; then
   the final export and result hash.
