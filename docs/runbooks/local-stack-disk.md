# Runbook: Local stack disk exhaustion

Development-environment runbook. This covers the developer machine, not a
deployed environment — but a corrupted local Docker store costs hours and has
already happened three times on this project, so it is written down.

## Symptoms

- `colima status` reports `colima is not running` with no deliberate stop.
- `~/.colima/_lima/colima/ha.stderr.log` ends with
  `[VZ] - vm state change: VirtualMachineStateError` followed by
  `Invalid virtual machine state. The virtual machine is no longer live.`
- Edge Function 503s, `supabase db reset` failing partway, or Postgres refusing
  writes.
- `df -h /System/Volumes/Data` at 95–100% capacity.
- `supabase_db_*` stuck in `Restarting`, with
  `FATAL: could not write lock file "postmaster.pid": No space left on device`
  in `docker logs`. This is the VM's own Docker disk, not the host: check
  `colima ssh -- df -h /var/lib/docker`.

There is usually **no** `ENOSPC` string in the Colima log. The VM dies without
naming the cause, so a full host volume must be ruled out by inspection rather
than by searching the log.

## Why it happens

Colima runs Docker inside a Linux VM backed by two host files:

| File | Role |
| --- | --- |
| `~/.colima/_lima/colima/disk` | VM boot/root disk |
| `~/.colima/_lima/_disks/colima/datadisk` | Persistent Docker data (`/var/lib/docker`) |

Both are **sparse**: the apparent size is the provisioned maximum, and the
allocated size grows as blocks are written. Deleting Docker images frees space
*inside* the VM filesystem but never returns blocks to the host. So
`docker system df` reporting `0 B` reclaimable is entirely compatible with the
host file holding 20 GiB — the two measure different things, and the gap only
widens over time.

The default provisioning is 100 GiB, which is a ratchet aimed at the host disk.

## Recovery

1. **Confirm the space problem before touching anything.**

   ```bash
   df -h /System/Volumes/Data
   du -shx ~/.colima
   ```

2. **Free host space first.** Do not restart the VM into a full disk; that is
   how the store gets corrupted. Check for large regenerable caches, and note
   that on macOS several large directories are unreadable without Full Disk
   Access — `du` silently skips them, so a `du` total well below the `df` used
   figure means the real consumer is in a protected path (iOS device backups
   under `~/Library/Application Support/MobileSync`, or a fully-cached iCloud
   Drive under `CloudDocs`/`FileProvider`). Check System Settings → General →
   Storage for those.

3. **Try `fstrim` first — it usually makes step 4 unnecessary.** Deleting
   images or resetting the database frees blocks *inside* the VM filesystem,
   but the host's sparse file keeps them until the guest issues a discard.
   One command hands them back, with the stack running and nothing destroyed:

   ```bash
   colima ssh -- sudo fstrim -av
   ```

   Measured on 2026-08-26 after a day of repeated `supabase db reset` runs:
   the datadisk fell from 18 GiB to 10 GiB allocated and the host went from
   9.7 GiB to 18 GiB free, in seconds, with no image re-pull. Re-run
   `npm run check:disk` and stop here if that cleared the shortfall.

4. **Rebuild the VM with a bounded disk**, only if trimming was not enough.
   `colima delete` removes the VM but
   deliberately **keeps** the datadisk so Docker data survives a VM rebuild.
   After the delete, `limactl disk list` reports no disks while the file is
   still on disk — orphaned, and safe to remove.

   ```bash
   colima delete --force
   rm -rf ~/.colima/_lima/_disks/colima
   colima start --cpu 4 --memory 6 --disk 30 --vm-type vz --mount-type virtiofs
   ```

   30 GiB fits the ~9 GiB of Supabase images, one CLI upgrade's worth of new
   image versions beside them, and the database, while keeping the cap well
   below the host's free space. `colima delete` also removes
   `~/.colima/default/colima.yaml`; keep a copy and restore it before
   `colima start` so the prevention settings below survive the rebuild.

5. **Rebuild the stack.** Everything local is reproducible from migrations and
   `supabase/seed.sql`; nothing of value lives only in the local database.

   ```bash
   npm run backend:start
   npm run backend:seed
   npm run test:integration
   ```

   A hosted project's first owner is re-created through
   [initial-owner-bootstrap.md](initial-owner-bootstrap.md), never by hand.

## The VM disk fills, not the host (2026-09-22)

The third incident filled the 40 GiB VM disk while the host still had 7 GiB
free. `docker system df -v` showed a 14 GB `supabase_db_*` volume, but the app
database was 95 MB: 12 GB was `_supabase._analytics.log_events_<token>`, the
local Logflare copy of every Postgres log line, 11.3 million rows from a week
of test runs. Find the table with:

```bash
docker exec supabase_db_Golf_Scoring_Tracker psql -U postgres -d _supabase \
  -c "select name, token from _analytics.sources"
```

Truncating it is safe; it holds local logs only. Local analytics is now
disabled in `supabase/config.toml`, so it no longer accumulates.

## Prevention

`npm run backend:start` and `npm run backend:seed` run
`scripts/check-disk-space.mjs` first. It fails below 10 GiB free and warns
below 20 GiB. Check it any time with:

```bash
npm run check:disk
```

The same check fails when the Colima VM's Docker disk is 90% full and warns at
75%.

`~/.colima/default/colima.yaml` on the developer machine carries three
settings that bound growth:

```yaml
disk: 30
docker:
  log-driver: json-file
  log-opts:
    max-size: "10m"
    max-file: "3"
provision:
  - mode: system
    script: |
      mkdir -p /etc/systemd/system/fstrim.timer.d
      printf '[Timer]\nOnCalendar=\nOnCalendar=daily\n' > /etc/systemd/system/fstrim.timer.d/daily.conf
      systemctl daemon-reload
      systemctl enable --now fstrim.timer
```

The cap protects the host; container log rotation stops `docker logs` files
from growing without bound; the daily trim returns freed blocks to the host
instead of weekly. After a Supabase CLI upgrade, remove the superseded image
versions with `docker image prune -a` while the stack is running.

To bypass deliberately, call `supabase` directly rather than through the npm
script.
