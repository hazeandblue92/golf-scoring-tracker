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

## Running the roster

**Players** holds the roster, handicap history, and sign-in accounts.

Add players one at a time, or import a spreadsheet. An import is always a dry
run first: paste or choose the file, press **Check the file**, and read the
report — which rows are new, which update someone already on the roster, and
every problem by row and column. Nothing is written until you press Import.
Only `display_name` is required; `username`, `handicap_index`,
`handicap_source`, `effective_from`, and `status` are optional, and **Use the
template** fills in a correct example. Players are matched by display name, so
two people with the same name must be sorted out before importing. **Export
roster as CSV** produces a file the importer reads back.

Saving a handicap never overwrites the old one. It closes that value's period
and opens a new one from the effective date you give, so an event published
last month keeps the handicap it froze. Changing a value on the same day you
set it corrects it instead, because there was no period in between. A player
who stops playing goes **inactive** — never delete anyone, because every past
score, attestation, and result is attributed to them.

An import never creates sign-in accounts: temporary passwords are handed over
one at a time, in person. Create an account from the player's **Manage** panel,
and use the same panel to disable sign-in, restore it, or reset a password.
Each of those ends every session that person has open, and each needs your
authenticator. Disabling an account removes access and nothing else — their
history stays exactly as it is.

Seasons move planned → active → completed → archived from **Seasons**. A new
event can start from a previous one: the picker on the event builder's first
step copies its field, teams, flights, tee, and format, and leaves the name and
date for you. The event you copy from is not touched.

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
