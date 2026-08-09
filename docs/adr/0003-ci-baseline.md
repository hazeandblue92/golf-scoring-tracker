# ADR 0003: CI baseline

## Status

Accepted (2026-08-09)

## Context

Spec §16.3 defines the full pull-request CI pipeline on a public GitHub
repository using free standard runners. Several steps require a local
Supabase stack (containers, migrations, seed) that does not exist yet in
this phase of the project.

## Decision

CI starts with a minimal `checks` job: clean install from the lockfile
(`npm ci`), type check, unit and property tests via vitest, and the
production web build (`--if-present`). A `licenses` job runs a dependency
tree integrity check (`npm ls --all`); the §13.2 license scan gate is
completed manually until a tooling decision lands in a follow-up ADR.
Dependency provenance review runs via `actions/dependency-review-action@v4`
on pull requests. Dependabot keeps npm and github-actions dependencies
current weekly with grouped minor/patch updates.

## Deferred §16.3 steps

Each step below is deferred until local Supabase support exists, and is
staged as a commented "Phase 1" placeholder in `.github/workflows/ci.yml`:

- Start local Supabase; reset and apply migrations/seed — Phase 1 (backend setup)
- Database constraints, functions, and RLS test suites — Phase 1 (backend setup)
- Edge Function integration tests — Phase 1 (Edge Functions land)
- Playwright smoke in Chromium (scheduled full suite adds Firefox/WebKit) — Phase 1 (web app shell)
- axe automated accessibility checks — Phase 1 (web app shell)
- Format/lint and coverage thresholds — added once tooling is standardized
- Bundle-budget check — added with the production web build pipeline

## Consequences

The pipeline grows by uncommenting/adding steps rather than restructuring;
job names and ordering already match the target §16.3 pipeline.
