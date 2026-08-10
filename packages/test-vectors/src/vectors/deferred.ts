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

/**
 * Empty by design: every §20.2 bullet now runs somewhere.
 *
 * The Phase 1 database and protocol vectors (idempotency retry, two-device
 * conflict, stale projection, export hash repeat) run in tests/integration
 * against the real stack, and the multi-round dropped-round vector landed with
 * the best-r-of-n engine module as `multi-round-dropped-round-best-2-of-3`.
 *
 * Keep the machinery: a future §20.2 bullet that outruns the engine belongs
 * here as a visible skip rather than an untested gap.
 */
export const deferredVectors: DeferredVector[] = []
