# Phase 4 Capacity Report

## Enforced budgets

- Initial JavaScript: **206.39 KiB gzip** measured on 2026-08-10; limit 250 KiB,
  excluding lazy route chunks. `npm run test:bundle-budget` enforces the limit.
- Database: 500 MiB free-profile ceiling; warnings at 60%, 75%, and 90%.
  Publication stops at 95%, while scoring and exports remain available.
- Synthetic profile: 120 Realtime clients, 30 score writes/second for 30
  seconds, and 120 leaderboard refreshes.

## Reproducible load procedure

Create a disposable open-scoring event with at least 900 distinct score cells.
Copy `docs/runbooks/capacity-test-config.example.json`, expand `scoreCells` to
at least 900 valid cells, then run:

```bash
LOAD_ALLOW_SYNTHETIC=true \
LOAD_CONFIG=/absolute/path/to/load.json \
LOAD_TEST_ACCESS_TOKEN=... \
SUPABASE_URL=... \
SUPABASE_PUBLISHABLE_KEY=... \
npm run load:capacity
```

For local Supabase, `npm run load:prepare-local` creates disposable test data
plus ignored, mode-600 config/token files. Then use `.capacity-config.local`
and `.capacity-token.local`; reset the local database after the exercise.

The harness writes latency, HTTP status, delivered Realtime revisions, and
connection counts to `phase4-capacity-report.json`. It fails unless score-write
p95 is at most 2 seconds and final projection visibility p95 is at most 3
seconds, in addition to requiring every operation and projection to succeed.
Never use a real event. The full remote profile remains a required prelaunch
exercise because local or shared-vendor results depend on the target project.

## Local result — 2026-08-10

The clean local Supabase/Colima profile passed after projection publication was
serialized and debounced per event. A 15-second owner-token lease prevents
duplicate work; renewal fences expired publishers before database publication.
One elected waiter retries after lease expiry if the publisher crashes, while
the normal pending-release path repairs after 650 ms and exits if already
current:

| Check | Result |
| --- | --- |
| Realtime subscriptions | 120/120; 212 ms setup; 120/120 received revision 900; conservative visibility p95 627 ms |
| Score writes | 900/900; p50 155 ms, p95 690 ms; 1 idempotent retry |
| Leaderboard refreshes | 120/120; p50 321 ms, p95 384 ms; 34 read retries |
| Projection repair | All 3 competitions converged to event revision 900 |

Retries use the same score idempotency key and are included in latency. The
raw score commits remain authoritative; only derived projection work is
coalesced. The overlapping-write integration test proves convergence within 3
seconds; clean migration and capacity runs exercise the lease path, while a
forced process-crash drill remains deployed-profile evidence. Re-run this
profile against the deployment before season launch.
