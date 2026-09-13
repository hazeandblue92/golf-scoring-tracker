# Repository Guidelines

## Project Structure & Module Organization

This npm-workspaces monorepo separates UI and domain code. `apps/web/` contains the PWA. `packages/scoring/` is the pure scoring engine, `packages/contracts/` owns API contracts, and `packages/test-vectors/` stores golden scenarios. Supabase SQL and Edge Functions live under `supabase/`. Unit tests sit in each package's `test/`; stack-dependent suites are in `tests/integration/`, and project decisions are under `docs/`.

`golf-scoring-tracker-technical-specification.docx` is binding; `PRODUCT.md` records product truth. `DESIGN.md` carries the hard UI gates: WCAG 2.2 AA contrast, at least 44×44 CSS px on-course targets, keyboard operation, 200% zoom at 320 px width, reduced-motion support, explicit local/server/provisional states, and no remote fonts or assets. `SECURITY.md` carries the hard security gates: RLS on every API-exposed table, authorization repeated at Edge Function boundaries, service-role secrets never bundled, committed, or logged, finalized-record immutability with audited director reopening, and private vulnerability reporting. Keep scoring deterministic and free of browser, database, clock, locale, network, or global-state dependencies. Raw facts and frozen snapshots are authoritative; results are rebuildable projections. Do not bypass offline or RLS safeguards.

## Build, Test, and Development Commands

- `npm ci`: install the locked dependency graph (Node 24 or newer).
- `npm run check:disk`: run the local-stack free-space preflight.
- `npm run backend:start`: run the disk-space preflight, then start local Supabase.
- `npm run backend:seed`: run the disk-space preflight, then reset, migrate, and seed the local database.
- `npm run web:start`: run the Vite development server.
- `npm run build`: type-check the web app and create the production web bundle.
- `npm run typecheck`: check scoring, contracts, and test-vectors with strict TypeScript; excludes the web app and Edge Functions.
- `npm run typecheck:functions`: run Deno typechecking on Edge Function entry points.
- `npm run lint`: enforce the configured ESLint correctness rules without warnings.
- `npm test`: run unit, property, and golden-vector tests across all four workspace projects, including apps/web.
- `npm run test:watch`: run the four workspace test projects in Vitest watch mode.
- `npm run test:coverage`: run the same four projects with V8 coverage; enforce 100% branches per scoring source file, plus 95% branches and 85% lines overall for scoring.
- `npm run test:integration`: run serial integration and security tests.
- `npm run test:bootstrap:fresh`: verify first-owner bootstrap against a running, freshly reset, unseeded local database.
- `npm run test:bootstrap:existing`: verify first-owner attachment to an existing league immediately after backend seeding.
- `npm run test:restore:fresh`: verify atomic portable restore against a running, freshly reset, unseeded local database.
- `npm run test:e2e`: run desktop and mobile browser journeys with accessibility checks.
- `npm run test:bundle-budget`: enforce the 250 KiB limit on gzipped JavaScript referenced by the built index.html; requires an existing production build and does not build automatically.
- `npm run test:security`: run secret-scan and bootstrap-helper tests, verify source and built CSP/headers, and scan bundles, source, and artifacts; requires an existing production build.
- `npm run test:licenses`: enforce the reviewed dependency license allow-list.
- `npm run test:operations`: test backup and maintenance connection configuration.
- `npm run verify:deployment -- https://<host>`: verify a deployed origin's security headers, CSP, caching, and SPA fallback.
- `npm run load:prepare-local`: create a disposable 50-player capacity fixture and local load configuration/token files.
- `npm run load:capacity`: run the capacity workload against a disposable event; requires the load configuration, credentials, and LOAD_ALLOW_SYNTHETIC=true environment setting.
- `npm run bootstrap:owner`: bootstrap the first owner with the arguments and environment described in docs/runbooks/initial-owner-bootstrap.md.
- `npm run bootstrap:owner -- --help`: print bootstrap usage only; does not bootstrap an owner.
- `npm run restore:backup -- <file> --reset-local`: verify and decrypt an age backup, reset the local database, and restore its data; requires AGE_IDENTITY_FILE and the checksum file.
- `npm run restore:export -- <file>`: restore a portable JSON export into a fresh project.
- `npm run db:types`: regenerate packages/contracts/src/database.types.ts from the live schema.
- `npm run db:types -- --check`: compare generated database types with the committed file without rewriting it.

Direct workspace commands, run from the repository root:

- `npm run dev --workspace apps/web`: run Vite for the web app.
- `npm run build --workspace apps/web`: type-check the web app and build it with Vite.
- `npm run preview --workspace apps/web`: preview an existing production web build.
- `npm run typecheck --workspace packages/scoring`: type-check the scoring package.
- `npm run test --workspace packages/scoring`: run the scoring package's Vitest tests.
- `npm run typecheck --workspace packages/contracts`: type-check the contracts package.
- `npm run test --workspace packages/contracts`: run the contracts package's Vitest tests.
- `npm run typecheck --workspace packages/test-vectors`: type-check the golden-vector package.
- `npm run test --workspace packages/test-vectors`: run the golden-vector package's Vitest tests.

## Coding Style & Naming Conventions

Use TypeScript ESM, two-space indentation, single quotes, and trailing commas in multiline constructs. Use `PascalCase` for React components and types, `camelCase` for functions/variables, and kebab-case domain files such as `stroke-play.ts`. Preserve explicit `.ts` import extensions where used. Strict compiler rules include `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

## Testing Guidelines

Name tests `*.test.ts` and group behavior with Vitest `describe`/`it`. Add formula tests in `packages/scoring/test/`, contract tests in `packages/contracts/test/`, and reusable golden cases in `packages/test-vectors/`. Coverage for scoring is enforced at 100% branches per source file, plus 95% branches and 85% lines overall. Add integration coverage for migrations, RLS, idempotency, revisions, or Edge Function changes.

## Verification

After every set of edits, run the applicable gates below. Do not report a task complete without pasting a passing run of every required command.

- Shared packages: `npm run typecheck`
- Web app: `npm run build` (this is what typechecks apps/web)
- Edge Functions: `npm run typecheck:functions`
- Always: `npm run lint && npm test`
- Scoring changes: `npm run test:coverage`
- Web app changes: `npm run build` first, then `npm run test:bundle-budget`
- Migrations/Edge Functions: `npm run test:integration`
- Contract changes: `npm run db:types -- --check`
- Security headers, CSP, or security-check script changes: `npm run build` first, then `npm run test:security`

`npm run test:integration` and `npm run db:types -- --check` require a running local backend with current migrations applied. Starting Supabase does not by itself resolve schema drift.

If either fails for environment reasons — backend not running, migrations behind, missing credentials — report it as an environment blocker, distinct from a code failure, and stop. Do not reset, seed, or migrate the database to clear the blocker, and do not count the attempt toward the 3-attempt limit or spend further attempts on it.

On failure: fix and re-run, up to 3 attempts. If still failing, STOP. Leave the working tree exactly as it is. Report the failing command, its output, what you tried, and which files you modified. Never continue past a failing gate. Never revert or delete files you did not create in the current task, and never run a destructive git command without asking first.

## Lessons

Read `docs/lessons.md` at the start of any non-trivial task. Append recurring failures and surprising repository behavior there with a date.

## Commits & Pull Requests

Recent commits use short, imperative summaries, optionally scoped by phase (for example, `Phase 1: score write pipeline`). Keep commits cohesive. Pull requests should explain intent and risk, list verification commands, link issues or spec sections, and include UI screenshots. Call out migrations, RLS changes, configuration impacts, and follow-ups; never commit `.env` files or service-role credentials.
