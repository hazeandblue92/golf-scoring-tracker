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
  OFFLINE_MARKER_MAX_AGE_MS,
  offlineMarkerIsActive,
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
