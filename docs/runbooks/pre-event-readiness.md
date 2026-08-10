# Runbook: Pre-event readiness (24–48 hours before)

Spec Appendix C.1. Run every item; do not skip because the last event was fine.
Use the signable checklist in `docs/season-launch-checklist.md` as the event
record and the Operations screen as the live evidence source.

1. Confirm the Supabase project is **active** (free projects pause after ~1 week
   of low activity) and the billing plan is still Free with **no payment method
   attached**.
2. Confirm the latest Cloudflare Pages deployment is healthy and GitHub Actions
   workflows are green.
3. Open Operations; confirm the health check is current, verify projections for
   the designated test event are current, and run **Rebuild projections** for
   that test event. Do not create synthetic scores in a real event.
4. Confirm a backup completed within the last 24 hours and the last restore
   drill is within policy (quarterly).
5. Review quota headroom: database size, egress, realtime connections, Edge
   Function invocations. Warnings begin at 60%.
6. Freeze and publish the event; review the generated Terms of Competition
   summary with the Committee.
7. Have **every group** open the event on their scoring device while online so
   it is cached for offline use.
8. Export/print the group list, rules summary, and blank scorecards as the
   paper fallback.
9. Confirm directors' MFA and recovery access; name the incident lead for the
   event day.
