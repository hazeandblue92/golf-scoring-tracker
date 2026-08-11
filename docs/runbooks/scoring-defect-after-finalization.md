# Runbook: Scoring defect discovered after finalization

Spec Appendix C.5. The frozen snapshot and raw facts make this recoverable;
follow the order exactly.

1. Preserve the existing export and final result hash — do not overwrite.
2. Reopen the affected competition from Scoring control, or call the
   `reopen-competition` Edge Function directly (director/admin + MFA +
   written reason). This clears that competition's final hash and unlocks
   only its own score inputs; every other sealed competition in the event
   stays locked. The action is audited as `competition.reopened`.
3. Fix the engine defect; bump the engine version; add or correct the golden
   vector that would have caught it.
4. Deploy the corrected, versioned engine.
5. Rebuild projections from the frozen inputs.
6. Produce and review the change report (before/after per affected entity).
7. Obtain Committee approval of the corrected results.
8. Refinalize — a new result hash is stored.
9. Publish a correction notice through the allowed notification channels.
