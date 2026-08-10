# Season and Event Launch Checklist

Record the event, date, operator, and evidence links with this checklist.

## Preseason sign-off

- [ ] A clean local restore drill passed migrations, integrity, RLS, projection rebuild, and result comparison.
- [ ] Owner and backup operator can decrypt the newest backup from separate owner-controlled devices.
- [ ] Directors use MFA and recovery access has been tested.
- [ ] Automated Chromium, Firefox, WebKit, Pixel 7, and axe checks are green.
- [ ] The full capacity profile passed against the deployed project, including ≤2 s score-write p95 and ≤3 s projection-visibility p95.
- [ ] Production CSP/security headers and host-level error-endpoint throttling were verified on the deployed URL.
- [ ] VoiceOver, TalkBack, keyboard-only, 200%/320 px, contrast, sunlight, and interrupted-connectivity checks are recorded.
- [ ] Paper scorecards, group list, rules summary, and incident contacts are ready.
- [ ] No payment method is attached to the free-tier vendors.

## 24–48 hours before each event

- [ ] Supabase is active; production deployment and required workflows are green.
- [ ] Operations health is OK and app, Edge, engine, and schema versions match the release.
- [ ] Database is below 60%; vendor dashboard quotas have enough headroom.
- [ ] All projections are current; the designated test event rebuild succeeds.
- [ ] An encrypted backup completed within 24 hours and is below the artifact ceiling.
- [ ] Terms of Competition and frozen rules were reviewed before publication.
- [ ] Every scoring device opened the event online and shows the current sync state.
- [ ] Incident lead and paper fallback location were announced.

## Event close

- [ ] Conflicts and attestations are resolved before finalization.
- [ ] Portable event export and final result hashes were retained.
- [ ] Incidents, quota changes, and follow-up owners were recorded without sensitive data.
