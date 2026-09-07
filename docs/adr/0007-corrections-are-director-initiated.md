# ADR 0007: Corrections are director-initiated; there is no player request queue

## Status

Accepted (2026-09-07) — pending owner confirmation at §25 sign-off.

## Context

Spec §3.5 opens the correction flow with a disjunction:

> A player requests a correction **or** an event director opens the score audit
> view.

Everything after that sentence — prior revisions, actor, sync time, derived
impact, the required reason, the same idempotent pipeline, the explicit reopen
when finalized — is director-side, and all of it is built. `AdminEventAudit`
shows the revision history, migration 25 carries the audited correction
workflow, and `tests/integration/test/conflict.test.ts` proves an unresolved
conflict blocks finalization.

What does not exist is the first half of the disjunction: a durable
player-submitted request, and the "correction requests" panel §5.2 lists among
the scoring control room's contents.

Building it means a new table, RLS for who may file and who may see, a
submission surface on the scorecard, a queue in the control room, states
(open / accepted / declined / superseded), and a finalization blocker decision
— does an open request block sealing a competition, the way an open conflict
does? If it does not, the queue is advisory and a director can seal over it. If
it does, a player can stall finalization by filing a request, which §4.4's
"the Committee decides" posture does not want.

The league is fewer than thirty players in groups of four, scoring together on
the course, with a director present. A player who disputes a hole says so, out
loud, to the marker or the director — who then opens the audit view, which is
exactly the path the spec's "or" offers.

## Decision

Corrections are **director-initiated only** for launch. §3.5 is satisfied
through its second branch.

The control room does not show a correction-request queue, because there are no
correction requests. It shows what does gate finalization: missing scores, open
conflicts, attestation state, projection lag, and unfinished matches.

## Consequences

- No new table, RLS policy, or state machine, and no ambiguity about whether a
  player can block a director from sealing a result. Finalization blockers stay
  exactly the ones §3.6 enumerates.
- The audit trail is unchanged and complete: every correction still records
  actor, prior value, revision, and a required reason, whoever asked for it out
  loud.
- The verbal request is not recorded anywhere. That is the accepted cost — the
  correction it produces is fully audited, but the fact that a player asked is
  not. The director's reason field is where that context belongs, and the
  operator guide should say so.
- `docs/operator-guide.md` and the incident runbook describe the correction
  path as director-initiated; neither promises a request inbox.
- Reversal is additive: a `correction_requests` table, an RLS policy scoped to
  the requester and the event's organizers, a scorecard action, and a control
  room panel. The decision that would need making first is the finalization
  question above, and it is a product decision, not an implementation detail.
- Revisit if the league grows beyond one director's line of sight, or if events
  are ever scored by groups the director is not physically with.
