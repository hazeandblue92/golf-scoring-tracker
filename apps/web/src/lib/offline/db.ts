import { Dexie } from 'dexie';
import type { Table } from 'dexie';

/**
 * Local data stores over IndexedDB via Dexie, exactly per spec §10.2.
 *
 * The service worker never caches authenticated API responses; normalized
 * permitted snapshots live here instead (spec §10.1). League data is
 * cleared on sign-out, account disable detection, or explicit device reset.
 *
 * Timestamps are Unix epoch milliseconds so range queries and backoff
 * comparisons are plain numeric comparisons on IndexedDB keys.
 */

/** eventSnapshots: [eventId+snapshotRevision], payload, cachedAt, userId. */
export interface EventSnapshotRow {
  eventId: string;
  snapshotRevision: number;
  /** Normalized permitted snapshot payload (spec §6.2 publish snapshot). */
  payload: unknown;
  cachedAt: number;
  /** The signed-in user who authorized offline availability (spec §10.1). */
  userId: string;
}

/**
 * Hole score status accompanying a draft value (spec §10.2 "value/status").
 * Mirrors HoleScoreStatus in @gtt/scoring types; duplicated locally so the
 * offline store does not depend on the engine package surface.
 */
export type ScoreDraftStatus =
  | 'not_started'
  | 'complete'
  | 'picked_up'
  | 'conceded'
  | 'not_played'
  | 'no_score'
  | 'withdrawn'
  | 'disqualified';

/** scoreDrafts: [eventId+entityId+holeId], value/status, baseRevision, updatedAt. */
export interface ScoreDraftRow {
  eventId: string;
  /** Participant or team id, per the competition's population. */
  entityId: string;
  holeId: string;
  /** Gross strokes; null when the status alone carries the meaning. */
  value: number | null;
  status: ScoreDraftStatus;
  /** Server revision this draft was based on (conflict detection, §10.4). */
  baseRevision: number;
  updatedAt: number;
}

/** Outbox states per spec §10.2. */
export type OutboxState =
  | 'queued'
  | 'sending'
  | 'synced'
  | 'conflict'
  | 'rejected';

/** outbox: idempotencyKey PK, eventId, mutation, state, attempts, nextAttemptAt. */
export interface OutboxRow {
  /** Client-generated idempotency key; preserved across retries (§10.3). */
  idempotencyKey: string;
  eventId: string;
  /** Serialized mutation payload (typed via @gtt/contracts when wired). */
  mutation: unknown;
  state: OutboxState;
  attempts: number;
  /** When the next retry attempt is due (jittered exponential backoff). */
  nextAttemptAt: number;
}

/** receipts: idempotencyKey PK, serverRevision, committedAt. Retained >= 7 days (§10.2). */
export interface ReceiptRow {
  idempotencyKey: string;
  serverRevision: number;
  committedAt: number;
}

/** preferences: [userId+key], value. */
export interface PreferenceRow {
  userId: string;
  key: string;
  value: unknown;
}

export class GttDatabase extends Dexie {
  // `declare` (not `!:` field syntax) so ES2022 class fields do not shadow
  // the table properties Dexie assigns in the constructor.
  declare eventSnapshots: Table<EventSnapshotRow, [string, number]>;
  declare scoreDrafts: Table<ScoreDraftRow, [string, string, string]>;
  declare outbox: Table<OutboxRow, string>;
  declare receipts: Table<ReceiptRow, string>;
  declare preferences: Table<PreferenceRow, [string, string]>;

  constructor() {
    super('gtt-offline');
    this.version(1).stores({
      // First entry is the primary key; the rest are secondary indexes.
      eventSnapshots: '[eventId+snapshotRevision], eventId, userId, cachedAt',
      scoreDrafts: '[eventId+entityId+holeId], eventId, updatedAt',
      outbox: 'idempotencyKey, eventId, state, nextAttemptAt',
      receipts: 'idempotencyKey, committedAt',
      preferences: '[userId+key], userId',
    });
  }
}

/** Shared database instance. Dexie opens the connection lazily on first use. */
export const db = new GttDatabase();
