# Golf Tournament Tracker

Zero-cost, offline-first, mobile-first web app for golf league and tournament
live scoring. Players enter gross hole scores on their phones on the course;
the system applies frozen event rules and handicaps and updates live
scorecards, leaderboards, matches, Stableford points, and skins.

The implementation authority is the technical specification
(`golf-scoring-tracker-technical-specification.docx`, v1.0). Product truth is
recorded in [PRODUCT.md](PRODUCT.md).

## Quick start

```bash
npm ci                 # install from lockfile
npm run backend:start  # local Supabase (requires Supabase CLI + container runtime)
npm run backend:seed   # reset DB, apply migrations + seed
npm run web:start      # Vite dev server for apps/web
npm test               # unit + property + golden vector suites
npm run build          # production build, all workspaces
```

## Repository layout (spec §13.4)

```
apps/web/                 React PWA
packages/contracts/       Zod schemas and generated types
packages/scoring/         Pure scoring/handicap engine
packages/test-vectors/    Golden scenarios
supabase/migrations/      Ordered SQL migrations
supabase/functions/       Edge Functions and shared server code
supabase/seed.sql         Deterministic development fixtures
tests/e2e/                Playwright suites
tests/security/           RLS/RPC tests
docs/                     ADRs, runbooks, data dictionary
.github/workflows/        CI, deploy, backup, dependency review
public/                   Manifest, icons, static policy pages
```

## Architecture in one paragraph

Raw score facts and immutable published event snapshots are the source of
truth; leaderboards, match state, and skins are replaceable projections. The
pure TypeScript engine in `packages/scoring` is imported by both the web app
(offline previews) and Supabase Edge Functions (authoritative projections), and
both must pass the same golden-vector suite. Score writes are idempotent,
revision-checked, and queued in an offline outbox (Dexie/IndexedDB) before any
network attempt. Everything runs on vendor free tiers with no payment method
attached — when a free quota is reached, the system degrades or stops rather
than incurring a charge.

## License

MIT — see [LICENSE](LICENSE).
