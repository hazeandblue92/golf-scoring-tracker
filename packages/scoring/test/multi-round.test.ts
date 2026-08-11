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

  it('does not rank a late entrant on a short 2-of-3 sum', () => {
    const result = calculateMultiRound({
      entities: [
        entity('FULL', 72, 72, 72),
        {
          entityId: 'LATE',
          rounds: [
            { roundId: 'r2', value: 80, status: 'complete' },
            { roundId: 'r3', value: 80, status: 'complete' },
          ],
        },
      ],
      aggregation: { kind: 'sum_strokes' },
      phase: 'final',
    })

    const late = result.rows.find((r) => r.entityId === 'LATE')
    expect(late?.total).toBe(160)
    expect(late?.status).toBe('no_return')
    expect(late?.rank).toBeNull()
    expect(result.rows.find((r) => r.entityId === 'FULL')?.rank).toBe(1)
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

  it('does not rank an omitted one-round entry in a best-2 competition', () => {
    const result = calculateMultiRound({
      entities: [
        entity('FULL', 72, 73, 74),
        {
          entityId: 'ONE',
          rounds: [{ roundId: 'r1', value: 60, status: 'complete' }],
        },
      ],
      aggregation: { kind: 'best_r_of_n', count: 2, basis: 'strokes' },
      phase: 'final',
    })

    const one = result.rows.find((r) => r.entityId === 'ONE')
    expect(one?.total).toBe(60)
    expect(one?.status).toBe('no_return')
    expect(one?.rank).toBeNull()
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'MULTI_ROUND_INSUFFICIENT_ROUNDS',
        context: expect.objectContaining({ entityId: 'ONE', available: 1, required: 2 }),
      }),
    )
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

  it('does not rank when r exceeds the actual usable rounds', () => {
    const result = calculateMultiRound({
      entities: [entity('A', 72, 75)],
      aggregation: { kind: 'best_r_of_n', count: 4, basis: 'strokes' },
      phase: 'final',
    })

    expect(result.rows[0]!.total).toBe(147)
    expect(result.rows[0]!.roundsCounted).toBe(2)
    expect(result.rows[0]!.status).toBe('no_return')
    expect(result.rows[0]!.rank).toBeNull()
    expect(result.warnings.map((w) => w.code)).toContain('MULTI_ROUND_INSUFFICIENT_ROUNDS')
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

  it('rejects zero, non-finite, and over-precision weights', () => {
    for (const weight of [0, Number.NaN, Number.POSITIVE_INFINITY, 1.23456]) {
      expect(() =>
        calculateMultiRound({
          entities: [
            {
              entityId: 'A',
              rounds: [{ roundId: 'r1', value: 70, weight, status: 'complete' }],
            },
          ],
          aggregation: { kind: 'sum_strokes' },
          phase: 'final',
        }),
      ).toThrow(RangeError)
    }
  })

  it('uses exact scaled totals so mathematically equal weights stay tied', () => {
    // Both cards are exactly (60 + 63) * .3333 = (61 + 62) * .3333
    // = 40.9959. Direct floating addition gives different IEEE-754 totals.
    const result = calculateMultiRound({
      entities: [
        {
          entityId: 'A',
          rounds: [
            { roundId: 'r1', value: 60, weight: 0.3333, status: 'complete' },
            { roundId: 'r2', value: 63, weight: 0.3333, status: 'complete' },
          ],
        },
        {
          entityId: 'B',
          rounds: [
            { roundId: 'r1', value: 61, weight: 0.3333, status: 'complete' },
            { roundId: 'r2', value: 62, weight: 0.3333, status: 'complete' },
          ],
        },
      ],
      aggregation: { kind: 'sum_strokes' },
      phase: 'final',
    })

    expect(result.rows.map((r) => r.total)).toEqual([40.9959, 40.9959])
    expect(result.rows.every((r) => r.rank === 1 && r.isTied)).toBe(true)
  })

  it('preserves exact six-decimal values and fractional weighted totals', () => {
    const result = calculateMultiRound({
      entities: [
        {
          entityId: 'A',
          rounds: [
            { roundId: 'r1', value: 1.234566, weight: 0.5, status: 'complete' },
            { roundId: 'r2', value: 3, weight: 0.3333, status: 'complete' },
          ],
        },
      ],
      aggregation: { kind: 'sum_points' },
      phase: 'final',
    })

    expect(result.rows[0]!.contributions.map((round) => round.weightedValue))
      .toEqual([0.617283, 0.9999])
    expect(result.rows[0]!.total).toBe(1.617183)
  })

  it('rejects round values that cannot fit numeric(14, 6) losslessly', () => {
    for (const value of [0.1234567, 100_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(() =>
        calculateMultiRound({
          entities: [
            { entityId: 'A', rounds: [{ roundId: 'r1', value, status: 'complete' }] },
          ],
          aggregation: { kind: 'sum_points' },
          phase: 'final',
        }),
      ).toThrow(RangeError)
    }
  })

  it('rejects lossy or out-of-range weighted products', () => {
    for (const round of [
      { roundId: 'r1', value: 0.000001, weight: 0.3333, status: 'complete' as const },
      { roundId: 'r1', value: 99_999_999.999999, weight: 2, status: 'complete' as const },
    ]) {
      expect(() =>
        calculateMultiRound({
          entities: [{ entityId: 'A', rounds: [round] }],
          aggregation: { kind: 'sum_points' },
          phase: 'final',
        }),
      ).toThrow(RangeError)
    }
  })

  it('rejects totals that overflow numeric(14, 6)', () => {
    expect(() =>
      calculateMultiRound({
        entities: [entity('A', 60_000_000, 60_000_000)],
        aggregation: { kind: 'sum_points' },
        phase: 'final',
      }),
    ).toThrow(/weighted total is outside/)
  })

  it('rejects a weight outside the database numeric(8, 4) bound', () => {
    expect(() =>
      calculateMultiRound({
        entities: [
          {
            entityId: 'A',
            rounds: [
              { roundId: 'r1', value: 1, weight: 10_000, status: 'complete' },
            ],
          },
        ],
        aggregation: { kind: 'sum_points' },
        phase: 'final',
      }),
    ).toThrow(/numeric\(8, 4\)/)
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

  it('uses authoritative round IDs and validates their integrity', () => {
    const result = calculateMultiRound({
      entities: [
        {
          entityId: 'LATE',
          rounds: [
            { roundId: 'r2', value: 80, status: 'complete' },
            { roundId: 'r3', value: 80, status: 'complete' },
          ],
        },
      ],
      aggregation: { kind: 'sum_strokes' },
      phase: 'final',
      expectedRoundIds: ['r1', 'r2', 'r3'],
      expectedRoundCount: 3,
    })

    expect(result.rows[0]).toEqual(
      expect.objectContaining({ total: 160, rank: null, status: 'no_return' }),
    )

    expect(() =>
      calculateMultiRound({
        entities: [entity('A', 72)],
        aggregation: { kind: 'sum_strokes' },
        phase: 'final',
        expectedRoundIds: ['r1', 'r1'],
      }),
    ).toThrow(/duplicate round/)

    expect(() =>
      calculateMultiRound({
        entities: [entity('A', 72)],
        aggregation: { kind: 'sum_strokes' },
        phase: 'final',
        expectedRoundIds: ['r1'],
        expectedRoundCount: 2,
      }),
    ).toThrow(/does not match/)

    expect(() =>
      calculateMultiRound({
        entities: [entity('A', 72, 73)],
        aggregation: { kind: 'sum_strokes' },
        phase: 'final',
        expectedRoundIds: ['r1'],
      }),
    ).toThrow(/unexpected round 'r2'/)
  })

  it('does not mutate frozen input while selecting dropped rounds', () => {
    const input = Object.freeze({
      entities: Object.freeze([
        Object.freeze({
          entityId: 'A',
          rounds: Object.freeze([
            Object.freeze({ roundId: 'r1', value: 72, status: 'complete' as const }),
            Object.freeze({ roundId: 'r2', value: 84, status: 'complete' as const }),
            Object.freeze({ roundId: 'r3', value: 75, status: 'complete' as const }),
          ]),
        }),
      ]),
      aggregation: Object.freeze({
        kind: 'best_r_of_n' as const,
        count: 2,
        basis: 'strokes' as const,
      }),
      phase: 'final' as const,
      expectedRoundIds: Object.freeze(['r1', 'r2', 'r3']),
    })

    expect(() => calculateMultiRound(input)).not.toThrow()
    expect(input.entities[0]!.rounds.every((round) => !('counted' in round))).toBe(true)
  })
})
