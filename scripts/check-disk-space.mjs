/**
 * Preflight disk-space guard for local backend work.
 *
 * The local Supabase stack runs inside a Colima VM whose Docker data lives on
 * a sparse disk image. That image grows as images and volumes are written and
 * never shrinks again: `docker system df` can report 0 B reclaimable while the
 * host file holds tens of gigabytes, because the two measure different things.
 * A host volume that is nearly full therefore does not merely slow the stack
 * down — Postgres and the VM itself can fail mid-write.
 *
 * This is not hypothetical. On 2026-08-26 the VM died with a VZ
 * `VirtualMachineStateError` ("the virtual machine is no longer live") while
 * the host had under 1 GiB free, taking the whole stack down mid-session.
 *
 * `supabase start` pulls roughly 9 GiB of images on a cold cache, so the floor
 * below is what a fresh stack needs plus room for the database, WAL, and build
 * artifacts. To bypass this deliberately, call `supabase` directly instead of
 * going through the npm script.
 *
 * See docs/runbooks/local-stack-disk.md.
 */

import { statfs } from 'node:fs/promises';

const MINIMUM_GIB = 10;
const COMFORTABLE_GIB = 20;

const stats = await statfs(process.cwd());
const freeBytes = stats.bavail * stats.bsize;
const totalBytes = stats.blocks * stats.bsize;
const freeGiB = freeBytes / 1024 ** 3;
const totalGiB = totalBytes / 1024 ** 3;
const usedPercent = ((totalBytes - freeBytes) / totalBytes) * 100;

console.log(JSON.stringify({
  freeGiB: Number(freeGiB.toFixed(2)),
  totalGiB: Number(totalGiB.toFixed(2)),
  usedPercent: Number(usedPercent.toFixed(1)),
  minimumGiB: MINIMUM_GIB,
  comfortableGiB: COMFORTABLE_GIB,
}, null, 2));

if (freeGiB < MINIMUM_GIB) {
  throw new Error(
    `Only ${freeGiB.toFixed(2)} GiB free; the local stack needs at least ${MINIMUM_GIB} GiB. `
    + 'A nearly full host volume can kill the Colima VM mid-write and corrupt the Docker '
    + 'store. Free space before starting the backend — see docs/runbooks/local-stack-disk.md.',
  );
}

if (freeGiB < COMFORTABLE_GIB) {
  console.warn(
    `Warning: ${freeGiB.toFixed(2)} GiB free is under the ${COMFORTABLE_GIB} GiB comfort level `
    + 'for a full `supabase db reset` plus an integration run.',
  );
}
