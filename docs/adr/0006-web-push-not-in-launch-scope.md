# ADR 0006: Web Push is not in launch scope

## Status

Accepted (2026-09-07) — pending owner confirmation at §25 sign-off.

## Context

Spec §15.1 splits notifications three ways: in-app realtime notices are
**required**, Web Push is **optional Phase 2**, and email/SMS are excluded from
the zero-cost baseline entirely. §25 restates the same default — "In-app
required; Web Push optional; no email/SMS" — with the impact line "Push setup
can be deferred".

The database has carried a `push_subscriptions` table since migration 8, with
endpoint and key material marked sensitive. Nothing else exists: no VAPID key,
no subscription flow, no send path, no preference storage, no 404/410 pruning.
That is the whole of §15.3.

Building it means committing to several things the launch does not otherwise
need:

- A VAPID private key becomes a production secret to guard, rotate, and keep
  out of bundles, logs, and exports. `npm run test:security` would gain a
  fourth privileged credential class to scan for, and the credential-compromise
  runbook a fourth rotation path.
- Every notification is an Edge Function invocation against a 500,000/month
  free quota that also carries every score write and projection rebuild. §24.2
  already names push as the **first** thing to disable under Edge pressure.
- On iOS the subscription only exists for a Home Screen web app, and only after
  a user gesture, so the feature would be absent for precisely the players most
  likely to be told "install the app" on the first tee.
- §15.2 requires per-category preferences and forbids lock-screen score detail,
  which is real UI on a surface (Settings) that currently has none.

Against that: the league is fewer than thirty adults who play together in
groups of four. Every message push would carry — event published, scoring open,
correction requested, card ready to attest, results final — reaches them faster
from the person standing next to them, and the app already shows all of it
in-app in real time.

## Decision

Web Push is **not implemented for launch**. In-app realtime notices are the
only notification channel, as §15.1 requires.

`push_subscriptions` stays in the schema. It is empty, it is covered by RLS and
migration 38's grant list like every other table, and dropping it would be a
migration whose only effect is to make a later reversal harder.

## Consequences

- No VAPID key exists in any environment, so there is nothing to rotate, scan
  for, or leak. The security gate's credential classes stay as they are.
- §24.2's "disable nonessential push first" circuit breaker is trivially
  satisfied: there is no push to disable, so Edge quota pressure reaches
  scoring endpoints only after the optional surfaces §24.2 lists ahead of them.
- The season launch checklist's "optional push … must be disabled before core
  scoring is degraded" line is satisfied by absence, and needs no evidence.
- Delivery guarantees are unaffected. §15.2 already forbids push as the only
  channel for a critical rule change, so nothing that matters depended on it.
- Reversal is additive: a VAPID keypair, a subscribe flow, an authenticated
  send function with a pinned Deno-compatible implementation, preference rows,
  and 404/410 pruning. No schema migration is required to start, and no
  scoring, projection, or offline path changes.
- If the league grows past the point where word of mouth reaches everyone, or
  spectators are ever given public leaderboards, this ADR should be revisited —
  those are the conditions that would give push its first real user.
