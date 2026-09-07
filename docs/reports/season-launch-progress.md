# Season launch implementation record

Started 2026-09-07 from `d14d697`, on `codex/season-launch`, against the owner's
Route to Season Launch plan. This record tracks implementation, not acceptance
sign-off. Existing `artifacts/two-man-throwdown-demo/` is owner workspace content.

## Current evidence

- Supabase Management API: original project `dhdctelabkzfbxoppjck` exists with
  status `INACTIVE` on 2026-09-07. Dashboard restoration awaits signed-in access.
- Existing GitHub configuration includes database host/user variables and a
  password secret. Backup recipient and service-role secrets are absent.
- Baseline coverage reproduced: 89.08% branches, 95.1% lines; 95% branch gate fails.
- Local Docker/Supabase stack is available.

## Work in progress

- Weekly hosted health workflow and pre-event instructions added.
- Shared fail-fast operations connection configuration added to backup and
  maintenance, with credential-encoding and missing-configuration tests passing.
- Plaintext backup cleanup runs on failure as well as success.
- Deployment history corrected in acceptance readiness.
- Coverage provider pinned to the matching Vitest release.

## Remaining implementation and verification

1. Restore backend, inspect plan/no-payment evidence, dry-run/apply migrations,
   redeploy and verify authenticated health and organizer workflow.
2. Owner creates/stores age private identity on two devices; configure public
   recipient and backend service key, run and verify backup and maintenance.
3. Complete scoring coverage and CI retention; explicit Data API privilege
   migration and integration tests; dependency backlog; generated database types
   with regeneration gate; run every automated release gate.
4. CSV preview/transactional apply/export and templates; account lifecycle UI;
   participant/handicap/season maintenance; event copying; optional-feature ADRs.
5. Restore/capacity/security drills and owner physical-device, accessibility,
   vendor-plan, trademark and acceptance evidence.
6. Real-phone field rehearsal, resulting fixes, release gates/deployment and
   finalized event export with reproducible result hash.

Owner decisions requested: defer optional Web Push and use director-initiated
corrections for launch. No decision or manual evidence is assumed from silence.
