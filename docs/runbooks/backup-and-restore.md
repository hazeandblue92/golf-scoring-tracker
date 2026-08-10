# Runbook: Backups and restore drills

Spec §17.4–17.5. Supabase Free has no managed downloadable backups; the project
owns its logical backups.

## Backup (automated, GitHub Actions)

- `.github/workflows/encrypted-backup.yml` runs every Sunday and on manual
  dispatch. An operator must dispatch it within 24 hours before every event.
- Dumps required schemas + data + migration/version manifest with Supabase
  CLI/PostgreSQL tools.
- Compresses, then encrypts with `age` to the owner-controlled recipient key.
  The private decryption key is **never** stored in CI.
- Uploads only the encrypted artifact, checksum, and manifest; retains 30 days
  under the GitHub Free artifact allowance.
- Fails the workflow if unencrypted output remains or the artifact exceeds the
  configured ceiling.
- Records a `backup_runs` row (status only, no secrets).
- Monthly: the owner downloads an encrypted backup to two owner-controlled
  local locations.

Configure only these GitHub Actions secrets: `SUPABASE_DB_URL`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and the public
`AGE_BACKUP_RECIPIENT`. Keep the private age identity off GitHub, Supabase,
Cloudflare, and the repository.

## Restore drill (quarterly and pre-season)

1. Download `backup.tar.gz.age` and its checksum from the newest successful
   workflow run.
2. Install the `age`, PostgreSQL client, and Supabase CLI tools; start local
   Supabase, then set `AGE_IDENTITY_FILE` to the owner-held key.
3. Run `npm run restore:backup -- backup.tar.gz.age --reset-local`. The command
   refuses non-local database hosts and verifies the checksum and migration
   manifest before resetting anything. Its report remains
   `restored_pending_verification`; a successful data import is not a passed
   drill.
4. Run `npm run test:integration`, rebuild projections from the Operations
   screen, and compare a representative leaderboard with the event export.
5. Store the generated `phase4-restore-report.json` together with the test,
   rebuild, and comparison evidence. Only after all three checks pass, set the
   service credentials locally and run
   `node scripts/record-backup-run.mjs restore-tested BACKUP_RUN_ID` to update
   the matching `backup_runs.last_tested_restore_on` value.

Do not treat checksum/integrity success alone as a completed drill. The RLS
suite and representative projection comparison are required sign-off steps.

## Recovery objectives (internal targets, not SLAs)

- RPO: ≤ 7 days ordinarily; ≤ 24 hours around events.
- RTO: best effort within 4 hours by a prepared operator.
