# Runbook: Suspected credential or secret compromise

Spec Appendix C.4. Execute in order; never delete audit evidence.

1. Disable the affected application account immediately.
2. If a privileged key (service role, DB password, vendor token) may be
   exposed, close scoring.
3. Rotate in this order as applicable: Supabase service-role key and database
   password; GitHub and Cloudflare tokens; VAPID key pair.
4. Redeploy Edge Functions and CI with the new secrets.
5. Invalidate all user sessions.
6. Audit recent changes: score mutations, role assignments, account admin
   actions, exports.
7. Rebuild projections from raw facts.
8. Document the incident: timeline, scope, rotation evidence, follow-ups.
