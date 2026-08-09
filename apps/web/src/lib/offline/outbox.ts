/**
 * Offline outbox (spec §10.2–§10.3): queue first, then attempt network.
 *
 * - The idempotency key is generated once at enqueue time and preserved
 *   across every retry (§10.3, §12.5).
 * - Network/5xx failures retry with jittered exponential backoff capped at
 *   60 seconds while the app is open.
 * - Validation, authorization, locked-event, and explicit conflict outcomes
 *   are terminal: they are NEVER auto-retried (§10.3).
 * - Correctness never depends on service-worker Background Sync: the
 *   scheduler retriggers on 'online', on visibility, on a 15-second interval
 *   while the page is open, and on manual calls (§10.3).
 *
 * The decision helpers (`decideFromResponse`, `backoffDelayMs`,
 * `unsyncedCount`) are pure so the §10.3 policy is unit-testable in Node.
 */

import {
  submitScoreRequestSchema,
  submitScoreResponseSchema,
  type ErrorCode,
  type ScoreTarget,
  type ScoreValue,
  type SubmitScoreRequest,
} from '@gtt/contracts';

import { functionUrl, getSupabaseClient, getSupabaseEnv } from '../supabase.ts';
import { db, type OutboxRow, type OutboxState } from './db.ts';

// ── Retry policy (spec §10.3 decision table) ────────────────────────────────

/**
 * Rejection codes that MAY be retried automatically: transient service
 * conditions, not validation/authorization/locked-event outcomes.
 */
export const RETRYABLE_ERROR_CODES: readonly ErrorCode[] = [
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'PROJECTION_STALE',
];

/**
 * Rejection codes that are terminal (§10.3: do not automatically retry
 * validation, authorization, or locked-event errors). BASE_REVISION_STALE
 * normally surfaces as status 'conflict'; if it arrives as a rejection it is
 * equally terminal.
 */
export const TERMINAL_ERROR_CODES: readonly ErrorCode[] = [
  'AUTH_REQUIRED',
  'MFA_REQUIRED',
  'NOT_ASSIGNED',
  'EVENT_LOCKED',
  'SCORE_INVALID',
  'SNAPSHOT_INVALID',
  'BASE_REVISION_STALE',
];

export type OutboxDecision =
  | { kind: 'synced'; serverRevision: number }
  | { kind: 'conflict' }
  | { kind: 'rejected'; errorCode: ErrorCode | null }
  | { kind: 'retry' };

/**
 * Pure §10.3 decision table: map an HTTP status plus parsed submit-score
 * response body to the next outbox state.
 *
 * - HTTP 5xx or an unintelligible body -> retry (transient infrastructure).
 * - committed / duplicate / queued_projection -> synced (§12.3; a duplicate
 *   is the original receipt replayed, which is success).
 * - conflict -> terminal 'conflict'; a human resolves it (§10.4).
 * - rejected -> retry only for transient service codes; terminal otherwise.
 */
export function decideFromResponse(
  httpStatus: number,
  body: unknown,
): OutboxDecision {
  if (httpStatus >= 500) {
    return { kind: 'retry' };
  }
  const parsed = submitScoreResponseSchema.safeParse(body);
  if (!parsed.success) {
    // Non-5xx but not a contract-shaped response (proxy error page, empty
    // body): treat as transient, same as a network failure.
    return { kind: 'retry' };
  }
  const response = parsed.data;
  switch (response.status) {
    case 'committed':
    case 'duplicate':
    case 'queued_projection':
      return { kind: 'synced', serverRevision: response.scoreRevision };
    case 'conflict':
      return { kind: 'conflict' };
    case 'rejected':
      if (
        response.errorCode !== null &&
        RETRYABLE_ERROR_CODES.includes(response.errorCode)
      ) {
        return { kind: 'retry' };
      }
      return { kind: 'rejected', errorCode: response.errorCode };
  }
}

/** Backoff cap while the app is open (spec §10.3). */
export const BACKOFF_CAP_MS = 60_000;

/** Jitter factor upper bound: delay is base * (1 + random() * 0.3). */
export const BACKOFF_JITTER_MAX = 0.3;

/**
 * Jittered exponential backoff delay for the given attempt count (the value
 * AFTER incrementing): min(60s, 2^attempts seconds * (1 + random()*0.3)).
 * `random` is injectable for deterministic tests.
 */
export function backoffDelayMs(
  attempts: number,
  random: () => number = Math.random,
): number {
  const baseMs = 2 ** attempts * 1000;
  const jittered = baseMs * (1 + random() * BACKOFF_JITTER_MAX);
  return Math.min(BACKOFF_CAP_MS, jittered);
}

// ── Counts (§10.3: show exact unsynced count) ───────────────────────────────

export interface OutboxCounts {
  queued: number;
  sending: number;
  synced: number;
  conflict: number;
  rejected: number;
}

export const EMPTY_OUTBOX_COUNTS: OutboxCounts = {
  queued: 0,
  sending: 0,
  synced: 0,
  conflict: 0,
  rejected: 0,
};

/**
 * Exact number of rows that have not reached the server as an accepted
 * mutation. Conflict and rejected rows still count: they carry local data
 * the server has not accepted, so sign-out must warn about them (§10.3,
 * §14.2).
 */
export function unsyncedCount(counts: OutboxCounts): number {
  return counts.queued + counts.sending + counts.conflict + counts.rejected;
}

/** Count outbox rows by state, optionally scoped to one event. */
export async function outboxCounts(eventId?: string): Promise<OutboxCounts> {
  const rows =
    eventId === undefined
      ? await db.outbox.toArray()
      : await db.outbox.where('eventId').equals(eventId).toArray();
  const counts: OutboxCounts = { ...EMPTY_OUTBOX_COUNTS };
  for (const row of rows) {
    counts[row.state] += 1;
  }
  return counts;
}

// ── Enqueue (§10.3: queue first, then attempt network) ──────────────────────

export interface ScoreMutationDraft {
  eventId: string;
  roundId: string;
  target: ScoreTarget;
  /** Last known server revision for this score row; 0 when never synced. */
  baseRevision: number;
  value: ScoreValue;
  /** RFC 3339; defaults to now. */
  clientRecordedAt?: string;
}

function clientRelease(): string {
  const release = import.meta.env.VITE_RELEASE_VERSION;
  return release === undefined || release === '' ? '0.0.0' : release;
}

/**
 * Write the local draft and the outbox row in ONE Dexie transaction so a
 * killed tab can never hold a draft without its queued mutation (§10.3
 * "queue first"; §17.6 "outbox persisted before request").
 *
 * Returns the idempotency key of the queued mutation. The key is minted
 * here, once, and reused verbatim on every retry.
 */
export async function enqueueScoreMutation(
  draft: ScoreMutationDraft,
): Promise<string> {
  const idempotencyKey = crypto.randomUUID();
  const now = Date.now();
  const request: SubmitScoreRequest = {
    idempotencyKey,
    eventId: draft.eventId,
    roundId: draft.roundId,
    target: draft.target,
    baseRevision: draft.baseRevision,
    value: draft.value,
    clientRecordedAt: draft.clientRecordedAt ?? new Date(now).toISOString(),
    clientRelease: clientRelease(),
  };
  const entityId =
    draft.target.kind === 'individual'
      ? draft.target.entryId
      : draft.target.teamId;

  await db.transaction('rw', db.scoreDrafts, db.outbox, async () => {
    await db.scoreDrafts.put({
      eventId: draft.eventId,
      entityId,
      holeId: draft.target.holeId,
      value: draft.value.grossStrokes ?? null,
      status: draft.value.status,
      baseRevision: draft.baseRevision,
      updatedAt: now,
    });
    await db.outbox.put({
      idempotencyKey,
      eventId: draft.eventId,
      mutation: request,
      state: 'queued',
      attempts: 0,
      nextAttemptAt: now,
    });
  });
  return idempotencyKey;
}

// ── Sync (§10.3) ────────────────────────────────────────────────────────────

/** Receipts are retained for at least seven days (§10.2). */
export const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface SyncSummary {
  attempted: number;
  synced: number;
  conflict: number;
  rejected: number;
  requeued: number;
}

const EMPTY_SUMMARY: SyncSummary = {
  attempted: 0,
  synced: 0,
  conflict: 0,
  rejected: 0,
  requeued: 0,
};

async function markSynced(row: OutboxRow, serverRevision: number): Promise<void> {
  const committedAt = Date.now();
  await db.transaction(
    'rw',
    db.outbox,
    db.receipts,
    db.scoreDrafts,
    async () => {
      await db.outbox.update(row.idempotencyKey, {
        state: 'synced' satisfies OutboxState,
      });
      await db.receipts.put({
        idempotencyKey: row.idempotencyKey,
        serverRevision,
        committedAt,
      });
      // Retain receipts for at least seven days; prune only older ones (§10.2).
      await db.receipts
        .where('committedAt')
        .below(committedAt - RECEIPT_RETENTION_MS)
        .delete();
      // Advance the draft's base revision so the NEXT edit of this hole uses
      // the authoritative server revision (§10.4).
      const parsed = submitScoreRequestSchema.safeParse(row.mutation);
      if (parsed.success) {
        const { target, eventId } = parsed.data;
        const entityId =
          target.kind === 'individual' ? target.entryId : target.teamId;
        await db.scoreDrafts.update([eventId, entityId, target.holeId], {
          baseRevision: serverRevision,
        });
      }
    },
  );
}

async function sendRow(row: OutboxRow, accessToken: string): Promise<OutboxDecision> {
  const { publishableKey } = getSupabaseEnv();
  try {
    const response = await fetch(functionUrl('submit-score'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        apikey: publishableKey,
      },
      body: JSON.stringify(row.mutation),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return decideFromResponse(response.status, body);
  } catch {
    // Network failure (offline, DNS, aborted): retry with backoff (§10.3).
    return { kind: 'retry' };
  }
}

async function runSync(): Promise<SyncSummary> {
  const supabase = getSupabaseClient();
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (accessToken === undefined) {
    // Token expired offline: retain the outbox untouched; sync resumes after
    // refresh/sign-in (§17.7 "do not discard").
    return { ...EMPTY_SUMMARY };
  }

  // Rows stuck in 'sending' are leftovers of a killed tab: this module is the
  // only sender and runs single-flight, so at sync start they are stale.
  await db.outbox
    .where('state')
    .equals('sending')
    .modify({ state: 'queued' satisfies OutboxState });

  const now = Date.now();
  const due = (
    await db.outbox
      .where('state')
      .equals('queued')
      .and((row) => row.nextAttemptAt <= now)
      .sortBy('nextAttemptAt')
  );

  const summary: SyncSummary = { ...EMPTY_SUMMARY };
  for (const row of due) {
    summary.attempted += 1;
    await db.outbox.update(row.idempotencyKey, {
      state: 'sending' satisfies OutboxState,
    });
    const decision = await sendRow(row, accessToken);
    switch (decision.kind) {
      case 'synced':
        await markSynced(row, decision.serverRevision);
        summary.synced += 1;
        break;
      case 'conflict':
        // Terminal until a human resolves it (§10.3, §10.4). NO auto-retry.
        await db.outbox.update(row.idempotencyKey, {
          state: 'conflict' satisfies OutboxState,
        });
        summary.conflict += 1;
        break;
      case 'rejected':
        // Terminal validation/authorization/locked outcome (§10.3).
        await db.outbox.update(row.idempotencyKey, {
          state: 'rejected' satisfies OutboxState,
        });
        summary.rejected += 1;
        break;
      case 'retry': {
        const attempts = row.attempts + 1;
        await db.outbox.update(row.idempotencyKey, {
          state: 'queued' satisfies OutboxState,
          attempts,
          nextAttemptAt: Date.now() + backoffDelayMs(attempts),
        });
        summary.requeued += 1;
        break;
      }
    }
  }
  return summary;
}

let syncInFlight: Promise<SyncSummary> | null = null;

/**
 * Drain due queued rows in order, single-flight: concurrent callers share
 * the in-progress drain instead of double-sending.
 */
export function syncOutbox(): Promise<SyncSummary> {
  if (syncInFlight === null) {
    syncInFlight = runSync().finally(() => {
      syncInFlight = null;
    });
  }
  return syncInFlight;
}

// ── Scheduler (§10.3) ───────────────────────────────────────────────────────

/** Foreground retry interval while the page is open (§10.3, §17.6). */
export const SYNC_INTERVAL_MS = 15_000;

/**
 * Start the foreground sync triggers: browser 'online', tab becoming
 * visible, and a 15-second interval while the page is open, plus one
 * immediate kick. Returns a stop function. Background Sync is deliberately
 * NOT part of correctness (§10.3).
 */
export function startOutboxScheduler(): () => void {
  const trigger = (): void => {
    void syncOutbox().catch(() => {
      // Scheduler triggers must never throw into the event loop; failures
      // remain queued and the next trigger retries.
    });
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      trigger();
    }
  };
  window.addEventListener('online', trigger);
  document.addEventListener('visibilitychange', onVisibilityChange);
  const intervalId = window.setInterval(trigger, SYNC_INTERVAL_MS);
  trigger();
  return () => {
    window.removeEventListener('online', trigger);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.clearInterval(intervalId);
  };
}
