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

As of 2026-08-10, a separate `integration` job starts local Supabase, resets
and seeds the database, and runs the serial database, Edge Function, and RLS
suite. It then runs the Phase 1 Playwright journey in Chromium; the journey
includes axe checks on the public entry surfaces. The job always stops the
ephemeral stack without retaining a backup.

## Remaining §16.3 steps

Local Supabase, database/RLS, Edge Function, Chromium Playwright, axe, and
static source-lint gates are implemented. The remaining hardening work is:

- scheduled Firefox/WebKit coverage
- per-file scoring coverage ratchets
- automated dependency-license classification
- a measured route-level bundle budget

## Consequences

The pipeline grows by uncommenting/adding steps rather than restructuring;
job names and ordering already match the target §16.3 pipeline.
