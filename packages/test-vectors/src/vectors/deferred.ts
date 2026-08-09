/**
 * Deferred §20.2 golden vectors — documented SKIP entries.
 *
 * These required vectors cannot be expressed against the pure scoring engine
 * (spec §7.1: no network/database/global state): they exercise the database
 * write path, projection protocol, or export pipeline. Each entry names the
 * behavior, why it is deferred, and the implementation phase (spec §22) whose
 * test layer (spec §20.1) adds it. The golden test suite lists each one as an
 * explicit skipped test so the gap stays visible until then.
 */

export interface DeferredVector {
  id: string
  section: string
  title: string
  /** Why the pure engine cannot express this vector today. */
  reason: string
  /** Implementation phase (spec §22) that adds the vector. */
  phase: string
}

export const deferredVectors: DeferredVector[] = [
  {
    id: 'deferred-idempotency-retry-x5',
    section: '§20.2 · §7.2 · AC-REL-001',
    title:
      'Same offline idempotency key retried five times produces one mutation',
    reason:
      'Requires the apply_score_mutation RPC, idempotency-key storage, and ' +
      'the submit-score Edge Function — the database write path, not the ' +
      'pure engine. Belongs to the Database/Integration test layers (§20.1).',
    phase:
      'Phase 1 (offline outbox, conflicts, audit; §22) — database test harness',
  },
  {
    id: 'deferred-two-device-conflict',
    section: '§20.2 · §7.2 · §10',
    title:
      'Two devices edit the same hole and create a conflict, not a silent overwrite',
    reason:
      'Requires base-revision score locking and conflict policy inside ' +
      'PostgreSQL (§7.2): concurrency over durable state cannot exist in a ' +
      'pure function. Database concurrency tests (§20.1) cover it.',
    phase: 'Phase 1 (conflict handling; §22) — database concurrency tests',
  },
  {
    id: 'deferred-stale-projection',
    section: '§20.2 · §7.2',
    title: 'Stale projection cannot overwrite a newer revision',
    reason:
      'Requires publish_projections revision guard semantics ' +
      '(publish-only-if-current, retry-from-latest). The engine computes ' +
      'projections but never stores them; the guard lives in the database.',
    phase:
      'Phase 1 (realtime leaderboard + projection publish; §22) — ' +
      'database/integration tests',
  },
  {
    id: 'deferred-export-snapshot-hash-repeat',
    section: '§20.2 · AC-010',
    title:
      'Final result hash repeats identically from an exported snapshot',
    reason:
      'resultHash/canonicalJson exist in the engine, but the vector must ' +
      'round-trip a real exported event snapshot through finalize + export + ' +
      'reimport, which needs the export pipeline and storage format.',
    phase:
      'Phase 1 (basic exports, finalization; §22) — recovery/export tests, ' +
      'hardened in Phase 4 restore drills',
  },
  {
    id: 'deferred-multi-round-dropped-round',
    section: '§20.2 · §8.14',
    title: 'Multi-round dropped-round (best r of n) aggregation',
    reason:
      'No multi-round aggregation module exists in packages/scoring yet; ' +
      'the engine currently scores single rounds. The vector lands with the ' +
      'best-r-of-n engine module so it can assert typed engine output.',
    phase: 'Phase 3 (multi-round aggregation, countback/playoffs; §22)',
  },
]
