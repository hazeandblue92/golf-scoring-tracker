# Runbook: Backups and restore drills

Spec §17.4–17.5. Supabase Free has no managed downloadable backups; the project
owns its logical backups.

## Backup (automated, GitHub Actions)

- Runs at least weekly and within 24 hours before every event.
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

## Restore drill (quarterly and pre-season)

1. Decrypt the newest backup locally.
2. Start a clean local Supabase instance.
3. Apply repository migrations to the recorded schema version.
4. Restore data.
5. Run integrity queries, RLS tests, projection rebuilds, and a representative
   score/leaderboard comparison against known results.
6. Record duration, issues, checksum, and `tested_restore_at`.

## Recovery objectives (internal targets, not SLAs)

- RPO: ≤ 7 days ordinarily; ≤ 24 hours around events.
- RTO: best effort within 4 hours by a prepared operator.
