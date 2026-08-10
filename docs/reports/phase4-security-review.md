# Phase 4 Security Review

Reviewed 2026-08-10 against the release profile.

## Controls implemented

- PostgreSQL RLS remains the authorization boundary; service-only maintenance
  functions reject browser roles, and integration tests cover operator denial.
- Disabling an account bans new Auth access and revokes sessions. Every Edge
  request also validates the retained profile is active, and database score
  triggers reject stale authenticated JWTs; the integration suite verifies
  immediate denial for AC-SEC-004.
- Client error intake accepts only three server-owned codes, enumerated route
  families, a correlation UUID, and severity. The server owns the release
  value, and a 5,000-accepted-report hourly circuit breaker bounds aggregation
  writes and data growth. Aggregates are removed after 30 days; messages,
  stacks, names, scores, and URLs are rejected. Host-level request throttling
  remains a deployment check because rejected public calls still reach Edge.
- Production deployment headers deny framing, sniffing, sensitive browser capabilities,
  unapproved script origins, and cross-origin opener access. CSP `connect-src`
  permits only the app itself and the Supabase host class over TLS; no loopback
  or plaintext origin appears in the shipped policy, and
  `scripts/check-security-headers.mjs` fails the release if one is reintroduced.
  Local development needs no such allowance: the deployment header file is
  host-delivered and the Vite dev server that Playwright drives never applies
  it, so the production policy stays tight without affecting local work.
- CI scans built JavaScript for service-role variables, database URLs, and JWT-
  shaped secrets. The 2026-08-10 local build passed across 32 bundles.
- All 535 installed package records use reviewed allow-listed licenses.
- Backups are encrypted to an owner-held age recipient; only encrypted data,
  checksum, and a nonsensitive manifest are retained for 30 days.

## Remaining release evidence

Production headers must be checked after deployment, and the quarterly clean
restore plus physical accessibility/device drills must be signed before season
launch. Secret rotation follows `docs/runbooks/credential-compromise.md`.
