# Repository Guidelines

## Project Structure & Module Organization

This npm-workspaces monorepo separates UI and domain code. `apps/web/` contains the PWA. `packages/scoring/` is the pure scoring engine, `packages/contracts/` owns API contracts, and `packages/test-vectors/` stores golden scenarios. Supabase SQL and Edge Functions live under `supabase/`. Unit tests sit in each package's `test/`; stack-dependent suites are in `tests/integration/`, and project decisions are under `docs/`.

`golf-scoring-tracker-technical-specification.docx` is binding; `PRODUCT.md` records product truth. Keep scoring deterministic and free of browser, database, clock, locale, network, or global-state dependencies. Raw facts and frozen snapshots are authoritative; results are rebuildable projections. Do not bypass offline or RLS safeguards.

## Build, Test, and Development Commands

- `npm ci`: install the locked dependency graph (Node 24 or newer).
- `npm run backend:start`: start local Supabase.
- `npm run backend:seed`: reset, migrate, and seed the local database.
- `npm run web:start`: run the Vite development server.
- `npm run typecheck`: check shared packages with strict TypeScript.
- `npm test`: run unit, property, and golden-vector tests.
- `npm run test:integration`: run serial integration and security tests.
- `npm run test:e2e`: run desktop and mobile browser journeys with accessibility checks.
- `npm run build`: type-check and create the production web bundle.
- `npm run lint`: enforce the repository ESLint rules without warnings.
- `npm run restore:export -- <file>`: restore a portable JSON export into a fresh project.

## Coding Style & Naming Conventions

Use TypeScript ESM, two-space indentation, single quotes, and trailing commas in multiline constructs. Use `PascalCase` for React components and types, `camelCase` for functions/variables, and kebab-case domain files such as `stroke-play.ts`. Preserve explicit `.ts` import extensions where used. Strict compiler rules include `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

## Testing Guidelines

Name tests `*.test.ts` and group behavior with Vitest `describe`/`it`. Add formula tests in `packages/scoring/test/`, contract tests in `packages/contracts/test/`, and reusable golden cases in `packages/test-vectors/`. Coverage targets for scoring code are 95% branches and 85% lines; critical formulas and state machines should aim for complete branch coverage. Add integration coverage for migrations, RLS, idempotency, revisions, or Edge Function changes.

## Commits & Pull Requests

Recent commits use short, imperative summaries, optionally scoped by phase (for example, `Phase 1: score write pipeline`). Keep commits cohesive. Pull requests should explain intent and risk, list verification commands, link issues or spec sections, and include UI screenshots. Call out migrations, RLS changes, configuration impacts, and follow-ups; never commit `.env` files or service-role credentials.
