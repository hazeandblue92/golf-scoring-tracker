/**
 * Multi-round aggregation (spec §8.14): sum of stroke totals, sum of points,
 * match points table, and best r of n rounds.
 *
 * The golden vector `deferred-multi-round-dropped-round` lives here: a dropped
 * round must be excluded from the total while remaining visible in the
 * contributions, because §8.14 forbids using deleted rows to rewrite history.
 */

import { describe, expect, it } from 'vitest'
import {
  aggregationDirection,
  calculateMultiRound,
  type MultiRoundEntity,
} from '../src/formats/multi-round.ts'

function rounds(...values: Array<number | null>) {
  return values.map((value, i) => ({
    roundId: `r${i + 1}`,
    value,
    status: (value === null ? 'not_started' : 'complete') as 'complete' | 'not_started',
  }))
}

function entity(entityId: string, ...values: Array<number | null>): MultiRoundEntity {
  return { entityId, rounds: rounds(...values) }
}

describe('aggregationDirection', () => {
  it('ranks strokes ascending and every points table descending', () => {
    expect(aggregationDirection({ kind: 'sum_strokes' })).toBe('asc')
    expect(aggregationDirection({ kind: 'sum_points' })).toBe('desc')
    expect(aggregationDirection({ kind: 'match_points' })).toBe('desc')
    expect(aggregationDirection({ kind: 'best_r_of_n', count: 2, basis: 'strokes' })).toBe('asc')
    expect(aggregationDirection({ kind: 'best_r_of_n', count: 2, basis: 'points' })).toBe('desc')
  })
})

describe('sum aggregations (§8.14)', () => {
  it('sums stroke totals and ranks the lowest first', () => {
    const result = calculateMultiRound({
      entities: [entity('A', 72, 75, 74), entity('B', 70, 80, 70)],
      aggregation: { kind: 'sum_strokes' },
      phase: 'final',
    })

    const a = result.rows.find((r) => r.entityId === 'A')
    const b = result.rows.find((r) => r.entityId === 'B')
    expect(a?.total).toBe(221)
    expect(b?.total).toBe(220)
    expect(b?.rank).toBe(1)
    expect(a?.rank).toBe(2)
    expect(a?.roundsCounted).toBe(3)
  })

  it('sums points and ranks the highest first', () => {
    const result = calculateMultiRound({
      entities: [entity('A', 34, 38), entity('B', 40, 30)],
      aggregation: { kind: 'sum_points' },
      phase: 'final',
    })

    expect(result.rows.find((r) => r.entityId === 'A')?.rank).toBe(1)
    expect(result.rows.find((r) => r.entityId === 'B')?.rank).toBe(2)
  })

  it('treats a match points table as highest-wins', () => {
    const result = calculateMultiRound({
      entities: [entity('A', 3, 1), entity('B', 2, 3)],
      aggregation: { kind: 'match_points' },
      phase: 'final',
    })

    expect(result.rows.find((r) => r.entityId === 'B')?.rank).toBe(1)
    expect(result.rows.find((r) => r.entityId === 'B')?.total).toBe(5)
  })
})

describe('best r of n — the deferred §20.2 vector', () => {
  it('drops the worst round from the total but keeps it visible', () => {
    // Best 2 of 3. A's 84 is dropped; the total is 72 + 75.
    const result = calculateMultiRound({
      entities: [entity('A', 72, 84, 75)],
      aggregation: { kind: 'best_r_of_n', count: 2, basis: 'strokes' },
      phase: 'final',
    })

    const row = result.rows[0]!
    expect(row.total).toBe(147)
    expect(row.roundsCounted).toBe(2)
    expect(row.roundsPlayed).toBe(3)

    // History is preserved: the dropped round is still present, flagged.
    const dropped = row.contributions.find((c) => c.value === 84)
    expect(dropped?.counted).toBe(false)
    expect(row.contributions).toHaveLength(3)
    expect(row.contributions.filter((c) => c.counted).map((c) => c.value).sort())
      .toEqual([72, 75])
  })

  it('drops the LOWEST round when higher points are better', () => {
    const result = calculateMultiRound({
      entities: [entity('A', 30, 40, 38)],
      aggregation: { kind: 'best_r_of_n', count: 2, basis: 'points' },
      phase: 'final',
    })

    const row = result.rows[0]!
    expect(row.total).toBe(78)
    expect(row.contributions.find((c) => c.value === 30)?.counted).toBe(false)
  })

  it('changes the winner versus a plain sum — the reason the format exists', () => {
    // Straight sum: A 231, B 232 → A wins. Best 2 of 3: A 147, B 145 → B wins.
    const entities = [entity('A', 72, 84, 75), entity('B', 70, 87, 75)]

    const summed = calculateMultiRound({
      entities,
      aggregation: { kind: 'sum_strokes' },
      phase: 'final',
    })
    expect(summed.rows.find((r) => r.entityId === 'A')?.rank).toBe(1)

    const best2 = calculateMultiRound({
      entities,
      aggregation: { kind: 'best_r_of_n', count: 2, basis: 'strokes' },
      phase: 'final',
    })
    expect(best2.rows.find((r) => r.entityId === 'B')?.rank).toBe(1)
    expect(best2.rows.find((r) => r.entityId === 'B')?.total).toBe(145)
  })

  it('refuses to rank an entity with too few rounds at final', () => {
    const result = calculateMultiRound({
      entities: [entity('A', 72, 75, 74), entity('B', 70, null, null)],
      aggregation: { kind: 'best_r_of_n', count: 2, basis: 'strokes' },
      phase: 'final',
    })

    const b = result.rows.find((r) => r.entityId === 'B')
    expect(b?.status).toBe('no_return')
    expect(b?.rank).toBeNull()
    expect(result.warnings.map((w) => w.code)).toContain('MULTI_ROUND_INSUFFICIENT_ROUNDS')
    // A is unaffected and still wins.
    expect(result.rows.find((r) => r.entityId === 'A')?.rank).toBe(1)
  })

  it('ranks a partial entry provisionally while the tournament is live', () => {
    const result = calculateMultiRound({
      entities: [entity('A', 72, null, null)],
      aggregation: { kind: 'best_r_of_n', count: 2, basis: 'strokes' },
      phase: 'live',
    })

    const row = result.rows[0]!
    expect(row.status).toBe('provisional')
    expect(row.provisional).toBe(true)
    expect(row.rank).toBe(1)
    expect(row.total).toBe(72)
    expect(result.provisional).toBe(true)
  })

  it('counts every round when r exceeds the rounds played', () => {
    const result = calculateMultiRound({
      entities: [entity('A', 72, 75)],
      aggregation: { kind: 'best_r_of_n', count: 4, basis: 'strokes' },
      phase: 'final',
    })

    expect(result.rows[0]!.total).toBe(147)
    expect(result.rows[0]!.roundsCounted).toBe(2)
    expect(result.rows[0]!.status).toBe('complete')
  })

  it('rejects a nonsensical count', () => {
    expect(() =>
      calculateMultiRound({
        entities: [entity('A', 72)],
        aggregation: { kind: 'best_r_of_n', count: 0, basis: 'strokes' },
        phase: 'final',
      }),
    ).toThrow(RangeError)
  })
})

describe('round weights (competition_rounds.weight)', () => {
  it('applies weight to the aggregated total', () => {
    const result = calculateMultiRound({
      entities: [
        {
          entityId: 'A',
          rounds: [
            { roundId: 'r1', value: 70, weight: 1, status: 'complete' },
            { roundId: 'r2', value: 70, weight: 2, status: 'complete' },
          ],
        },
      ],
      aggregation: { kind: 'sum_strokes' },
      phase: 'final',
    })

    expect(result.rows[0]!.total).toBe(210)
  })

  it('selects best-r on the weighted value, since that is what will count', () => {
    // Raw scores say r1 (70) is the best round, but its double weight makes it
    // contribute 140 — worse than r2's 75. Keeping r1 would understate nothing
    // and overstate the total.
    const result = calculateMultiRound({
      entities: [
        {
          entityId: 'A',
          rounds: [
            { roundId: 'r1', value: 70, weight: 2, status: 'complete' },
            { roundId: 'r2', value: 75, weight: 1, status: 'complete' },
          ],
        },
      ],
      aggregation: { kind: 'best_r_of_n', count: 1, basis: 'strokes' },
      phase: 'final',
    })

    expect(result.rows[0]!.total).toBe(75)
    expect(result.rows[0]!.contributions.find((c) => c.roundId === 'r2')?.counted).toBe(true)
  })

  it('rejects a negative weight', () => {
    expect(() =>
      calculateMultiRound({
        entities: [
          { entityId: 'A', rounds: [{ roundId: 'r1', value: 70, weight: -1, status: 'complete' }] },
        ],
        aggregation: { kind: 'sum_strokes' },
        phase: 'final',
      }),
    ).toThrow(RangeError)
  })
})

describe('entity status and input integrity', () => {
  it('never ranks a withdrawn entity even with a complete card', () => {
    const result = calculateMultiRound({
      entities: [
        { ...entity('A', 72, 70), entityStatus: 'withdrawn' },
        entity('B', 90, 90),
      ],
      aggregation: { kind: 'sum_strokes' },
      phase: 'final',
    })

    const a = result.rows.find((r) => r.entityId === 'A')
    expect(a?.status).toBe('withdrawn')
    expect(a?.rank).toBeNull()
    expect(result.rows.find((r) => r.entityId === 'B')?.rank).toBe(1)
  })

  it('shares a rank when totals are genuinely level', () => {
    const result = calculateMultiRound({
      entities: [entity('A', 72, 74), entity('B', 74, 72)],
      aggregation: { kind: 'sum_strokes' },
      phase: 'final',
    })

    expect(result.rows.every((r) => r.rank === 1 && r.isTied)).toBe(true)
  })

  it('rejects duplicate entities and duplicate rounds', () => {
    expect(() =>
      calculateMultiRound({
        entities: [entity('A', 72), entity('A', 73)],
        aggregation: { kind: 'sum_strokes' },
        phase: 'final',
      }),
    ).toThrow(RangeError)

    expect(() =>
      calculateMultiRound({
        entities: [
          {
            entityId: 'A',
            rounds: [
              { roundId: 'r1', value: 72, status: 'complete' },
              { roundId: 'r1', value: 73, status: 'complete' },
            ],
          },
        ],
        aggregation: { kind: 'sum_strokes' },
        phase: 'final',
      }),
    ).toThrow(RangeError)
  })
})
