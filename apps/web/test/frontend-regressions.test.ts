import { describe, expect, it } from 'vitest';

import { accountSwitchDecision } from '../src/lib/auth.ts';
import {
  consistentMatchSummary,
  initialMatchResultState,
  matchProjectionLag,
  matchStandingResult,
  resultStateAfterStatusChange,
  resultStateAfterWinnerChange,
  standingsByMatch,
  type MatchProjectionRow,
} from '../src/lib/match-view.ts';
import {
  localBestBall,
  localStrokePlay,
  overlayScores,
  type LocalDraftScore,
  type LocalHole,
  type LocalScore,
} from '../src/lib/offline/local-projections.ts';
import { decideFromResponse, mutationFactKey, nextBaseRevision } from '../src/lib/offline/outbox.ts';
import {
  OFFLINE_MARKER_MAX_AGE_MS,
  offlineMarkerIsActive,
  refreshOfflineMarkerOnPageExit,
} from '../src/lib/useOnlineStatus.ts';

describe('multi-round match standings', () => {
  const rows: MatchProjectionRow[] = [
    aggregateRow('alpha', '4', [
      matchDetail('match-one', 'bravo', 'won', 3, 2, 'won'),
      matchDetail('match-two', 'charlie', 'in_progress', -2, 7, 'in_progress'),
    ]),
    aggregateRow('bravo', '2', [
      matchDetail('match-one', 'alpha', 'won', -3, 2, 'lost'),
    ]),
    aggregateRow('charlie', '2', [
      matchDetail('match-two', 'alpha', 'in_progress', 2, 7, 'in_progress'),
    ]),
  ];
  const names = new Map([
    ['alpha', 'Alpha'],
    ['bravo', 'Bravo'],
    ['charlie', 'Charlie'],
  ]);

  it('uses nested per-round detail instead of an entity aggregate', () => {
    const standings = standingsByMatch(rows);
    const first = standings.get('match-one');
    const second = standings.get('match-two');

    expect(first).toMatchObject({
      display: null,
      thru: null,
      leaderEntityId: 'alpha',
      holesUp: 3,
      holesRemaining: 2,
    });
    expect(second).toMatchObject({
      display: null,
      thru: null,
      leaderEntityId: 'charlie',
      holesUp: 2,
      holesRemaining: 7,
    });
    expect(matchStandingResult(first!, names)).toBe('Alpha won 3 & 2');
    expect(matchStandingResult(second!, names)).toBe('Charlie 2 up');
  });

  it('is deterministic when projection row order changes', () => {
    expect([...standingsByMatch(rows).entries()]).toEqual(
      [...standingsByMatch([...rows].reverse()).entries()],
    );
  });
});

describe('Committee match result state', () => {
  it('does not render Halved over an authoritative winner', () => {
    expect(consistentMatchSummary('Halved', 'alpha')).toBeNull();
    expect(consistentMatchSummary('3 & 2', 'alpha')).toBe('3 & 2');
    expect(consistentMatchSummary('Halved', null)).toBe('Halved');
  });

  it('never keeps Halved after a winner is selected', () => {
    const initial = initialMatchResultState({
      status: 'scheduled',
      winnerEntityId: null,
      resultSummary: null,
      sideAEntityId: 'alpha',
      sideBEntityId: 'bravo',
    });
    expect(initial.resultSummary).toBe('Halved');

    const withWinner = resultStateAfterWinnerChange(initial, 'alpha');
    expect(withWinner).toMatchObject({
      winnerEntityId: 'alpha',
      resultSummary: '',
    });
    expect(resultStateAfterWinnerChange(withWinner, '')).toMatchObject({
      winnerEntityId: '',
      resultSummary: 'Halved',
    });
  });

  it('resets status-specific summaries when moving back to completed', () => {
    const conceded = resultStateAfterStatusChange({
      status: 'complete',
      winnerEntityId: 'alpha',
      resultSummary: '3 & 2',
    }, 'conceded', false, 'alpha');
    expect(conceded.resultSummary).toBe('Conceded');
    expect(resultStateAfterStatusChange(
      conceded,
      'complete',
      false,
      'alpha',
    ).resultSummary).toBe('');
  });
});

describe('match projection lag', () => {
  it('does not report an intentional sealed projection gap', () => {
    expect(matchProjectionLag(12, 8, 'finalized')).toBe(0);
    expect(matchProjectionLag(12, 8, 'scoring_open')).toBe(4);
    expect(matchProjectionLag(8, 12, 'scoring_open')).toBe(0);
  });
});

describe('offline reload marker', () => {
  it('expires stale and legacy markers while respecting a live offline signal', () => {
    const now = 100_000;
    expect(offlineMarkerIsActive(String(now - 100), true, now)).toBe(true);
    expect(offlineMarkerIsActive(
      String(now - OFFLINE_MARKER_MAX_AGE_MS),
      true,
      now,
    )).toBe(false);
    expect(offlineMarkerIsActive('1', true, now)).toBe(false);
    expect(offlineMarkerIsActive(null, false, now)).toBe(true);
  });

  it('refreshes the marker on page exit only when the document is offline', () => {
    const writes: Array<[string, string]> = [];
    const storage = {
      setItem(key: string, value: string) {
        writes.push([key, value]);
      },
    };

    refreshOfflineMarkerOnPageExit(false, storage, 100_000);
    refreshOfflineMarkerOnPageExit(true, storage, 200_000);

    expect(writes).toEqual([['gtt.networkOffline', '100000']]);
  });
});

describe('local data account ownership', () => {
  it('blocks only an unconfirmed switch with retained unsynced scores', () => {
    expect(accountSwitchDecision('old', 'new', 2, false)).toBe('block');
    expect(accountSwitchDecision('old', 'new', 2, true)).toBe('clear');
    expect(accountSwitchDecision('old', 'new', 0, false)).toBe('clear');
    expect(accountSwitchDecision('same', 'same', 2, false)).toBe('reuse');
    expect(accountSwitchDecision(null, 'new', 0, false)).toBe('adopt');
  });
});

/**
 * Regression: submitScoreResponseSchema was a single strictObject requiring
 * non-null revisions and forbidding extra fields, so neither the conflict body
 * (extra `conflictId`, nullable revisions) nor the rejection envelope (no
 * revision fields, optional `detail`) parsed. Both fell through to the
 * "unintelligible body" branch and were requeued forever, which is precisely
 * the opposite of the §10.3 terminal policy.
 *
 * The bodies below are what supabase/functions/submit-score/index.ts and the
 * shared `rejected()` helper actually emit.
 */
describe('submit-score outcome classification', () => {
  const correlationId = 'req_01H';

  it('treats every success status as synced and carries the score revision', () => {
    for (const status of ['committed', 'duplicate', 'queued_projection']) {
      expect(
        decideFromResponse(200, {
          status,
          scoreRevision: 7,
          eventRevision: 21,
          projectionRevision: status === 'queued_projection' ? null : 21,
          errorCode: null,
          correlationId,
        }),
      ).toEqual({ kind: 'synced', serverRevision: 7 });
    }
  });

  it('makes a conflict terminal and retains the id needed to reconcile it', () => {
    // The id is what lets reconcileResolvedConflicts close this row once an
    // organizer decides; without it the conflict is stranded on the device.
    expect(
      decideFromResponse(409, {
        status: 'conflict',
        scoreRevision: 4,
        eventRevision: 17,
        projectionRevision: null,
        conflictId: '11111111-1111-4111-8111-111111111111',
        errorCode: 'BASE_REVISION_STALE',
        correlationId,
      }),
    ).toEqual({ kind: 'conflict', conflictId: '11111111-1111-4111-8111-111111111111' });

    // The server may report a conflict without a row id; still terminal.
    expect(
      decideFromResponse(409, {
        status: 'conflict',
        scoreRevision: null,
        eventRevision: null,
        projectionRevision: null,
        conflictId: null,
        errorCode: 'BASE_REVISION_STALE',
        correlationId,
      }),
    ).toEqual({ kind: 'conflict', conflictId: null });
  });

  it('makes authorization, validation, and lock rejections terminal', () => {
    for (const [httpStatus, errorCode] of [
      [401, 'AUTH_REQUIRED'],
      [403, 'NOT_ASSIGNED'],
      [409, 'EVENT_LOCKED'],
      [400, 'SCORE_INVALID'],
      [400, 'SNAPSHOT_INVALID'],
      [400, 'MFA_REQUIRED'],
    ] as const) {
      expect(decideFromResponse(httpStatus, { status: 'rejected', errorCode, correlationId }))
        .toEqual({ kind: 'rejected', errorCode });
    }
    // `detail` is present on most real rejections and must not break parsing.
    expect(
      decideFromResponse(400, {
        status: 'rejected',
        errorCode: 'SCORE_INVALID',
        detail: 'not_started is not a submittable status',
        correlationId,
      }),
    ).toEqual({ kind: 'rejected', errorCode: 'SCORE_INVALID' });
  });

  it('retries only the documented transient outcomes', () => {
    for (const errorCode of ['RATE_LIMITED', 'SERVICE_UNAVAILABLE', 'PROJECTION_STALE']) {
      expect(decideFromResponse(400, { status: 'rejected', errorCode, correlationId }))
        .toEqual({ kind: 'retry' });
    }
    expect(decideFromResponse(500, null)).toEqual({ kind: 'retry' });
    expect(decideFromResponse(502, '<html>gateway</html>')).toEqual({ kind: 'retry' });
    expect(decideFromResponse(200, null)).toEqual({ kind: 'retry' });
  });

  it('keeps an unrecognized rejection terminal rather than retrying forever', () => {
    expect(
      decideFromResponse(400, {
        status: 'rejected',
        errorCode: 'SOME_FUTURE_CODE',
        correlationId,
      }),
    ).toEqual({ kind: 'rejected', errorCode: 'SOME_FUTURE_CODE' });
  });
});

/**
 * Regression: a second edit of the same hole claimed `serverScores`' revision
 * only. `markSynced` advances the DRAFT when a mutation commits, so a
 * background sync landing between two edits left the snapshot behind and the
 * next edit opened a conflict against the device's own prior write.
 */
describe('offline edit revision chaining', () => {
  const UUID_EVENT = '11111111-1111-4111-8111-111111111111';
  const UUID_ENTRY = '22222222-2222-4222-8222-222222222222';
  const UUID_HOLE = '33333333-3333-4333-8333-333333333333';

  it('takes the newer of the server snapshot and the synced draft', () => {
    // Background sync committed revision 5; the snapshot still says 4.
    expect(nextBaseRevision(4, 5)).toBe(5);
    // Snapshot refreshed first: it wins.
    expect(nextBaseRevision(7, 5)).toBe(7);
    // Never-synced hole on both sides.
    expect(nextBaseRevision(undefined, undefined)).toBe(0);
    expect(nextBaseRevision(undefined, 3)).toBe(3);
    expect(nextBaseRevision(3, undefined)).toBe(3);
  });

  it('identifies the fact a queued mutation targets, for coalescing', () => {
    const individual = {
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
      eventId: UUID_EVENT,
      roundId: '55555555-5555-4555-8555-555555555555',
      target: { kind: 'individual', entryId: UUID_ENTRY, holeId: UUID_HOLE },
      baseRevision: 2,
      value: { status: 'complete', grossStrokes: 5, notes: null },
      clientRecordedAt: '2026-08-26T12:00:00.000Z',
      clientRelease: '0.0.0',
    };
    const key = mutationFactKey(individual);
    expect(key).toBe(`${UUID_EVENT}:${UUID_ENTRY}:${UUID_HOLE}`);

    // A corrected value for the same hole coalesces onto the same fact.
    expect(mutationFactKey({
      ...individual,
      idempotencyKey: '66666666-6666-4666-8666-666666666666',
      value: { status: 'complete', grossStrokes: 4, notes: null },
    })).toBe(key);

    // A different hole must NOT coalesce.
    expect(mutationFactKey({
      ...individual,
      target: { ...individual.target, holeId: '77777777-7777-4777-8777-777777777777' },
    })).not.toBe(key);

    // Unparseable payloads never coalesce onto anything.
    expect(mutationFactKey({ nonsense: true })).toBeNull();
    expect(mutationFactKey(null)).toBeNull();
  });
});

/**
 * Device-local provisional projections. The browser and the Edge Functions
 * share `@gtt/scoring`, so a local total must be the SAME number the server
 * would produce from the same facts — not merely close.
 */
describe('local provisional projections', () => {
  const holes: LocalHole[] = [
    { id: 'h1', hole_ordinal: 1, par: 4, stroke_index: 1 },
    { id: 'h2', hole_ordinal: 2, par: 3, stroke_index: 2 },
  ];
  const serverScores: LocalScore[] = [
    { event_entry_id: 'a', event_hole_id: 'h1', gross_strokes: 5, score_status: 'complete', revision: 3 },
    { event_entry_id: 'a', event_hole_id: 'h2', gross_strokes: 3, score_status: 'complete', revision: 3 },
    { event_entry_id: 'b', event_hole_id: 'h1', gross_strokes: 4, score_status: 'complete', revision: 3 },
    { event_entry_id: 'b', event_hole_id: 'h2', gross_strokes: 4, score_status: 'complete', revision: 3 },
  ];

  it('lets an unsent draft override the server fact it supersedes', () => {
    const drafts: LocalDraftScore[] = [
      { entityId: 'a', holeId: 'h1', value: 6, status: 'complete', baseRevision: 3 },
    ];
    const result = overlayScores('a', new Set(['h1', 'h2']), serverScores, drafts);
    expect(result).toHaveLength(2);
    expect(result.find((score) => score.holeId === 'h1')?.grossStrokes).toBe(6);
    expect(result.find((score) => score.holeId === 'h2')?.grossStrokes).toBe(3);
  });

  it('never lets the not_started UI state displace a real score', () => {
    const drafts: LocalDraftScore[] = [
      { entityId: 'a', holeId: 'h1', value: null, status: 'not_started', baseRevision: 3 },
    ];
    const result = overlayScores('a', new Set(['h1', 'h2']), serverScores, drafts);
    expect(result.find((score) => score.holeId === 'h1')?.grossStrokes).toBe(5);
  });

  it('ignores other entities and out-of-scope holes', () => {
    const result = overlayScores('a', new Set(['h1']), serverScores, [
      { entityId: 'b', holeId: 'h1', value: 9, status: 'complete', baseRevision: 3 },
      { entityId: 'a', holeId: 'h-other', value: 9, status: 'complete', baseRevision: 3 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.grossStrokes).toBe(5);
  });

  it('totals gross stroke play and reflects an unsent edit immediately', () => {
    const base = localStrokePlay({
      holes, entries: [{ id: 'a', playingHandicap: 0 }], scores: serverScores, drafts: [], metric: 'gross',
    });
    expect(base.rows[0]!.grossTotal).toBe(8);
    expect(base.rows[0]!.thru).toBe(2);

    const edited = localStrokePlay({
      holes,
      entries: [{ id: 'a', playingHandicap: 0 }],
      scores: serverScores,
      drafts: [{ entityId: 'a', holeId: 'h1', value: 6, status: 'complete', baseRevision: 3 }],
      metric: 'gross',
    });
    expect(edited.rows[0]!.grossTotal).toBe(9);
  });

  it('applies the frozen playing handicap for net', () => {
    // Playing handicap 1 allocates its single stroke to stroke index 1 (h1),
    // so gross 8 becomes net 7.
    const result = localStrokePlay({
      holes, entries: [{ id: 'a', playingHandicap: 1 }], scores: serverScores, drafts: [], metric: 'net',
    });
    expect(result.rows[0]!.netTotal).toBe(7);
  });

  it('takes the lower ball per hole for a two-person best ball', () => {
    const result = localBestBall({
      holes,
      entries: [{ id: 'a', playingHandicap: 0 }, { id: 'b', playingHandicap: 0 }],
      scores: serverScores,
      drafts: [],
      metric: 'gross',
      bestK: 1,
      teams: [{ id: 'team', entryIds: ['a', 'b'] }],
    });
    // h1: min(5, 4) = 4; h2: min(3, 4) = 3 => 7
    expect(result.rows[0]!.total).toBe(7);
  });
});

function aggregateRow(
  entityId: string,
  aggregateDisplay: string,
  details: unknown[],
): MatchProjectionRow {
  return {
    entity_id: entityId,
    thru: details.length,
    display_primary: aggregateDisplay,
    status: 'complete',
    detail_json: {
      rounds: details.map((detail, index) => ({
        roundId: `round-${index + 1}`,
        detail,
      })),
    },
  };
}

function matchDetail(
  matchId: string,
  opponentEntityId: string,
  matchStatus: string,
  holesUp: number,
  holesRemaining: number,
  outcome: string,
) {
  return {
    matchId,
    opponentEntityId,
    matchStatus,
    holesUp,
    holesRemaining,
    outcome,
  };
}
