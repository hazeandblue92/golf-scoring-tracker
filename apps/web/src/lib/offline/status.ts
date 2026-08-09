/**
 * Live-status semantics ladder (spec §10.6), as a pure function so the
 * policy is unit-testable without a browser.
 *
 * - device_saved: queued locally.
 * - server_saved: raw score committed (no projection revision known yet).
 * - leaderboard_updating: committed event revision exceeds published
 *   projection revision.
 * - live: projection revision equals event revision.
 * - stale: device has not confirmed server/projection revisions within 30
 *   seconds while online.
 * - offline: network unavailable; local data may be cached.
 */

import type { OutboxCounts } from './outbox.ts';

export type LiveStatus =
  | 'device_saved'
  | 'server_saved'
  | 'leaderboard_updating'
  | 'live'
  | 'stale'
  | 'offline';

/** §10.6: stale after 30 seconds online without revision confirmation. */
export const STALE_AFTER_MS = 30_000;

/**
 * The last server acknowledgment this device observed: the revisions from
 * the most recent submit-score response or revision-feed message, and when
 * it was received (epoch milliseconds).
 */
export interface ServerAck {
  eventRevision: number;
  /** Null when the server has not reported a projection revision yet. */
  projectionRevision: number | null;
  /** When this device received the acknowledgment (epoch ms). */
  ackAt: number;
}

export interface LiveStatusInput {
  /** Epoch milliseconds "now"; injectable for tests. */
  now: number;
  /** Network availability (navigator.onLine at the call site). */
  online: boolean;
}

/**
 * Resolve the §10.6 ladder. Precedence: offline first (nothing can be
 * confirmed), then locally-queued work, then confirmation freshness, then
 * the event-vs-projection revision comparison.
 */
export function liveStatus(
  outboxCounts: OutboxCounts,
  lastServerAck: ServerAck | null,
  input: LiveStatusInput,
): LiveStatus {
  if (!input.online) {
    return 'offline';
  }
  if (outboxCounts.queued + outboxCounts.sending > 0) {
    return 'device_saved';
  }
  if (
    lastServerAck === null ||
    input.now - lastServerAck.ackAt > STALE_AFTER_MS
  ) {
    return 'stale';
  }
  if (lastServerAck.projectionRevision === null) {
    return 'server_saved';
  }
  if (lastServerAck.eventRevision > lastServerAck.projectionRevision) {
    return 'leaderboard_updating';
  }
  return 'live';
}
