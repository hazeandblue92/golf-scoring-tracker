/**
 * Deferred §20.2 golden vectors — documented SKIP entries.
 *
 * These required vectors cannot be expressed against the pure scoring engine
 * (spec §7.1: no network/database/global state): they exercise the database
 * write path, projection protocol, or export pipeline. Each entry names the
 * behavior, why it is deferred, and the implementation phase (spec §22) whose
 * test layer (spec §20.1) adds it. Phase 1 database/protocol vectors now live
 * in tests/integration; only genuinely unimplemented behavior remains here.
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
