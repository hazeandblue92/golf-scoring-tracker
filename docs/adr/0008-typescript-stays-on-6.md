# ADR 0008: TypeScript stays pinned to 6.0.x

## Status

Accepted (2026-09-07)

## Context

Dependabot has proposed TypeScript 7.0.2 since 2026-08-13. The specification
anticipated exactly this and answered it in the source register:

> [S11] TypeScript 7.0 announcement. TypeScript 7 is current but lacks a stable
> programmatic API in 7.0; compatibility package guidance supports a temporary
> 6.0 pin.

The pin is not inertia about a major version. This repository consumes
TypeScript through more than `tsc`:

- `typescript-eslint` parses every `.ts`/`.tsx` file through the TypeScript
  compiler API, and `npm run lint` runs with `--max-warnings=0`.
- `vite` and `@vitejs/plugin-react` transform the app, and `vitest` runs three
  workspaces against the same sources.
- The Edge Functions are checked by Deno, not by `tsc`, so a compiler change
  can silently split what the browser and the server consider the same shared
  engine — the one thing §7.1 requires stay identical.

A programmatic API that is explicitly not yet stable is the hinge those tools
turn on. Taking 7.0 now means adopting whatever each of them ships to work
around that instability, on a codebase whose release gate is that the scoring
engine compiles the same way in two runtimes.

Nothing in the project needs a 7.0 feature. The strict options the code relies
on — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` — are all present
in 6.0.2 and enforced today.

## Decision

`typescript` stays pinned to the exact version `6.0.2` in the root and in
`apps/web`. Dependabot pull request #7 is declined, not deferred.

Every other dependency is kept current. The 2026-09-07 sweep took the GitHub
Actions majors (checkout 7, setup-node 7, upload-artifact 7, download-artifact
8, setup-cli 3, dependency-review 5), the Supabase CLI to 2.117, supabase-js to
2.116, react-router to 8.3.1, and every in-range minor and patch, each verified
against the full gate battery. TypeScript is the single deliberate exception.

## Consequences

- The pin is exact, not a caret range, so a transitive bump cannot move it.
- Deno's own TypeScript version is not controlled by this pin. That is the
  standing risk in this decision, and `npm run typecheck:functions` in CI is
  what catches it: the Edge Functions are compiled on every pull request
  against the same shared engine sources the browser uses.
- Revisit when TypeScript ships a stable programmatic API and
  `typescript-eslint` declares support for it. At that point the upgrade is a
  single pin change plus a full gate run, because nothing in the codebase has
  been written around 6.0-specific behaviour.
- Until then, close each new TypeScript major pull request with a link to this
  ADR rather than leaving it open. An open pull request nobody intends to merge
  is indistinguishable from one nobody has looked at.
