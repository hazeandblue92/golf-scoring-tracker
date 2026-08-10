/**
 * Multi-round aggregation golden vectors (spec §8.14, §20.2).
 *
 * `multi-round-dropped-round-best-2-of-3` is the §20.2 bullet that shipped as
 * a documented SKIP until the best-r-of-n engine module existed. It is written
 * so the dropped round changes the WINNER, not merely a total: a vector where
 * dropping made no difference would pass against an engine that ignored the
 * drop policy entirely.
 */

import type { MultiRoundVector } from './types.ts'

const complete = (roundId: string, value: number) => ({
  roundId,
  value,
  status: 'complete' as const,
})

export const multiRoundVectors: MultiRoundVector[] = [
  {
    id: 'multi-round-dropped-round-best-2-of-3',
    kind: 'multi_round',
    section: '§8.14 · §20.2 · AC-FMT-001',
    description:
      'Best 2 of 3 drops each entrant\'s worst round and reverses the straight-sum order',
    input: {
      // Straight sums: A 231, B 232 — A would lead. Dropping the worst round
      // leaves A 147 and B 145, so B wins. Same cards, opposite result.
      entities: [
        {
          entityId: 'A',
          rounds: [complete('r1', 72), complete('r2', 84), complete('r3', 75)],
        },
        {
          entityId: 'B',
          rounds: [complete('r1', 70), complete('r2', 87), complete('r3', 75)],
        },
      ],
      aggregation: { kind: 'best_r_of_n', count: 2, basis: 'strokes' },
      phase: 'final',
    },
    expected: {
      rows: [
        {
          entityId: 'A',
          total: 147,
          roundsPlayed: 3,
          roundsCounted: 2,
          rank: 2,
          isTied: false,
          status: 'complete',
        },
        {
          entityId: 'B',
          total: 145,
          roundsPlayed: 3,
          roundsCounted: 2,
          rank: 1,
          isTied: false,
          status: 'complete',
        },
      ],
    },
  },
  {
    id: 'multi-round-sum-stroke-totals',
    kind: 'multi_round',
    section: '§8.14 · AC-FMT-001',
    description: 'Sum of stroke totals across three rounds ranks the lowest aggregate first',
    input: {
      entities: [
        {
          entityId: 'A',
          rounds: [complete('r1', 72), complete('r2', 75), complete('r3', 74)],
        },
        {
          entityId: 'B',
          rounds: [complete('r1', 70), complete('r2', 80), complete('r3', 70)],
        },
      ],
      aggregation: { kind: 'sum_strokes' },
      phase: 'final',
    },
    expected: {
      rows: [
        { entityId: 'A', total: 221, rank: 2, roundsCounted: 3 },
        { entityId: 'B', total: 220, rank: 1, roundsCounted: 3 },
      ],
    },
  },
  {
    id: 'multi-round-match-points-table',
    kind: 'multi_round',
    section: '§8.14 · AC-FMT-001',
    description: 'A match points table ranks the highest accumulated points first',
    input: {
      entities: [
        { entityId: 'A', rounds: [complete('r1', 3), complete('r2', 1)] },
        { entityId: 'B', rounds: [complete('r1', 2), complete('r2', 3)] },
      ],
      aggregation: { kind: 'match_points' },
      phase: 'final',
    },
    expected: {
      rows: [
        { entityId: 'A', total: 4, rank: 2 },
        { entityId: 'B', total: 5, rank: 1 },
      ],
    },
  },
  {
    id: 'multi-round-insufficient-rounds-no-return',
    kind: 'multi_round',
    section: '§8.14 · §4.5',
    description:
      'An entrant without enough scoreable rounds is a no-return at final rather than ranked on a short total',
    input: {
      entities: [
        {
          entityId: 'A',
          rounds: [complete('r1', 72), complete('r2', 75), complete('r3', 74)],
        },
        {
          entityId: 'B',
          rounds: [
            complete('r1', 70),
            { roundId: 'r2', value: null, status: 'not_started' as const },
            { roundId: 'r3', value: null, status: 'not_started' as const },
          ],
        },
      ],
      aggregation: { kind: 'best_r_of_n', count: 2, basis: 'strokes' },
      phase: 'final',
    },
    expected: {
      rows: [
        { entityId: 'A', rank: 1, status: 'complete' },
        // B's single 70 is the lowest card in the field and must NOT win.
        { entityId: 'B', rank: null, status: 'no_return' },
      ],
      warningCodes: ['MULTI_ROUND_INSUFFICIENT_ROUNDS'],
    },
  },
]
