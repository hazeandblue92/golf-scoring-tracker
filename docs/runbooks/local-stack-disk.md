# Runbook: Local stack disk exhaustion

Development-environment runbook. This covers the developer machine, not a
deployed environment — but a corrupted local Docker store costs hours and has
already happened twice on this project, so it is written down.

## Symptoms

- `colima status` reports `colima is not running` with no deliberate stop.
- `~/.colima/_lima/colima/ha.stderr.log` ends with
  `[VZ] - vm state change: VirtualMachineStateError` followed by
  `Invalid virtual machine state. The virtual machine is no longer live.`
- Edge Function 503s, `supabase db reset` failing partway, or Postgres refusing
  writes.
- `df -h /System/Volumes/Data` at 95–100% capacity.

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

3. **Rebuild the VM with a bounded disk.** `colima delete` removes the VM but
   deliberately **keeps** the datadisk so Docker data survives a VM rebuild.
   After the delete, `limactl disk list` reports no disks while the file is
   still on disk — orphaned, and safe to remove.

   ```bash
   colima delete --force
   rm -rf ~/.colima/_lima/_disks/colima
   colima start --cpu 4 --memory 6 --disk 40 --vm-type vz --mount-type virtiofs
   ```

   40 GiB comfortably fits the ~9 GiB of Supabase images plus the database and
   leaves the cap well below the host's free space.

4. **Rebuild the stack.** Everything local is reproducible from migrations and
   `supabase/seed.sql`; nothing of value lives only in the local database.

   ```bash
   npm run backend:start
   npm run backend:seed
   npm run test:integration
   ```

   A hosted project's first owner is re-created through
   [initial-owner-bootstrap.md](initial-owner-bootstrap.md), never by hand.

## Prevention

`npm run backend:start` and `npm run backend:seed` run
`scripts/check-disk-space.mjs` first. It fails below 10 GiB free and warns
below 20 GiB. Check it any time with:

```bash
npm run check:disk
```

To bypass deliberately, call `supabase` directly rather than through the npm
script.
