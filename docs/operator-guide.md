# Operator Guide

## Before the season

On a brand-new deployment, follow the
[initial owner bootstrap](runbooks/initial-owner-bootstrap.md) once, complete
password/privacy activation, and enroll the owner in MFA before creating any
other accounts.

Complete one clean restore drill, enroll every director in MFA, print the paper
fallback pack, and record the supported-device checks. Add the four backup
secrets listed in `docs/runbooks/backup-and-restore.md`; the private age key
stays on two owner-controlled devices. Train a second operator to sign in,
export an event, rebuild projections, and follow an incident runbook.

## Before every event

Open **Operations** and refresh the checks. Health and all event projections
must be current. Database use should remain below 60%; review egress, Realtime,
and Edge Function usage in the Supabase dashboard because those values do not
have a reliable app-facing metrics API. Manually run the encrypted backup
workflow within 24 hours. Complete `docs/season-launch-checklist.md`.

## During scoring

Raw hole scores and frozen event snapshots are authoritative. If the board
lags, continue scoring and use **Operations → Projection repair**; rebuilding
changes only derived results. If Realtime fails, clients fall back to polling.
If the service is unavailable, keep devices open, retain queued scores, and
use paper cards. Never clear browser data during an incident.

At 90% database usage, stop creating nonessential data and prepare exports. At
95%, new event publication is intentionally blocked; scoring and exports remain
available. No operator should add a payment method to bypass the free profile.

## After the event

Resolve conflicts, verify attestations, finalize competitions, and download the
portable event export. Confirm the final result hash and retain the signed paper
cards according to league policy. Record incidents by correlation code only;
do not place names, scores, tokens, or free text in error reports.

For recovery or compromise, use the matching file in `docs/runbooks/` and name
one incident lead before taking action.
