/**
 * Countback tie resolution (spec §8.15).
 *
 * The spec's own worked sequence is last 9, last 6, last 3, hole 18, then
 * tied — these tests walk each rung of that ladder and, just as importantly,
 * assert the two things the spec forbids: silently randomizing, and letting a
 * missing card decide a tie.
 */

import { describe, expect, it } from 'vitest'
import {
  applyCountback,
  resolveCountback,
  segmentIndexes,
} from '../src/formats/countback.ts'

const SEQUENCE = ['last_9', 'last_6', 'last_3', 'hole_18']

/** 18 hole values, overriding the given published-order indexes (0-based). */
function card(base: number, overrides: Record<number, number | null> = {}) {
  const values: Array<number | null> = Array.from({ length: 18 }, () => base)
  for (const [index, value] of Object.entries(overrides)) {
    values[Number(index)] = value
  }
  return values
}

describe('segmentIndexes', () => {
  it('last_N selects the final N holes of the published order', () => {
    expect(segmentIndexes('last_3', 18)).toEqual([15, 16, 17])
    expect(segmentIndexes('last_9', 18)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
  })

  it('hole_N is the Nth hole of the published order, not a course hole number', () => {
    expect(segmentIndexes('hole_18', 18)).toEqual([17])
    expect(segmentIndexes('hole_1', 18)).toEqual([0])
    // A 9-hole competition has no 18th published hole.
    expect(segmentIndexes('hole_18', 9)).toBeNull()
  })

  it('rejects segments that overrun the competition', () => {
    expect(segmentIndexes('last_19', 18)).toBeNull()
    expect(segmentIndexes('last_0', 18)).toBeNull()
    expect(segmentIndexes('back_9', 18)).toBeNull()
  })
})

describe('resolveCountback (§8.15)', () => {
  it('separates on last 9 when the back nine differs', () => {
    // Equal 18-hole totals; B is one stroke better across the last nine.
    const result = resolveCountback({
      entities: [
        { entityId: 'A', holeValues: card(4, { 0: 3, 17: 5 }) },
        { entityId: 'B', holeValues: card(4, { 0: 5, 17: 3 }) },
      ],
      sequence: SEQUENCE,
      direction: 'asc',
    })

    const order = result.placements.sort((a, b) => a.order - b.order)
    expect(order[0]!.entityId).toBe('B')
    expect(order[0]!.resolvedBy).toBe('last_9')
    expect(result.unresolved).toBe(false)
    expect(order.every((p) => !p.stillTied)).toBe(true)
  })

  it('falls through last 9 and last 6 to resolve on last 3', () => {
    // The windows nest: last_3 (15-17) ⊂ last_6 (12-17) ⊂ last_9 (9-17). So to
    // make only the innermost one decide, B's gain inside last_3 must be given
    // back in the 12-14 band — that levels last_6, and levels last_9 with it.
    const a = card(4)
    const b = card(4)
    b[16] = 4
    a[16] = 5 // B better by one inside last_3
    b[12] = 5
    a[12] = 4 // repaid inside last_6, so last_6 and last_9 both tie

    const result = resolveCountback({
      entities: [
        { entityId: 'A', holeValues: a },
        { entityId: 'B', holeValues: b },
      ],
      sequence: SEQUENCE,
      direction: 'asc',
    })

    const order = result.placements.sort((x, y) => x.order - y.order)
    expect(order[0]!.entityId).toBe('B')
    expect(order[0]!.resolvedBy).toBe('last_3')
  })

  it('resolves on the final published hole when every window is level', () => {
    const a = card(4)
    const b = card(4)
    // Differ only on the last hole, compensating inside each wider window so
    // last_9, last_6 and last_3 all tie and only hole_18 can decide.
    a[17] = 5
    b[17] = 3
    a[16] = 3
    b[16] = 5

    const result = resolveCountback({
      entities: [
        { entityId: 'A', holeValues: a },
        { entityId: 'B', holeValues: b },
      ],
      sequence: SEQUENCE,
      direction: 'asc',
    })

    const order = result.placements.sort((x, y) => x.order - y.order)
    expect(order[0]!.entityId).toBe('B')
    expect(order[0]!.resolvedBy).toBe('hole_18')
  })

  it('leaves identical cards tied rather than inventing an order', () => {
    const result = resolveCountback({
      entities: [
        { entityId: 'A', holeValues: card(4) },
        { entityId: 'B', holeValues: card(4) },
      ],
      sequence: SEQUENCE,
      direction: 'asc',
    })

    expect(result.unresolved).toBe(true)
    expect(result.placements.every((p) => p.stillTied)).toBe(true)
    expect(result.placements.every((p) => p.order === 0)).toBe(true)
    expect(result.placements.every((p) => p.resolvedBy === null)).toBe(true)
    expect(result.warnings.map((w) => w.code)).toContain('COUNTBACK_UNRESOLVED')
  })

  it('is order-independent: shuffling the input cannot change the outcome', () => {
    // Guards the failure this module exists to prevent — a stable sort quietly
    // acting as the tiebreak, which would make results depend on row order.
    const entities = [
      { entityId: 'A', holeValues: card(4) },
      { entityId: 'B', holeValues: card(4) },
      { entityId: 'C', holeValues: card(4) },
    ]
    const forward = resolveCountback({ entities, sequence: SEQUENCE, direction: 'asc' })
    const reversed = resolveCountback({
      entities: [...entities].reverse(),
      sequence: SEQUENCE,
      direction: 'asc',
    })

    expect(forward.unresolved).toBe(true)
    expect(reversed.unresolved).toBe(true)
    for (const placement of [...forward.placements, ...reversed.placements]) {
      expect(placement.order).toBe(0)
      expect(placement.stillTied).toBe(true)
    }
  })

  it('will not let a missing hole decide a segment', () => {
    // A has no score at the last hole. Counting it as zero would hand A the
    // tie on the strength of the card it did not finish.
    const result = resolveCountback({
      entities: [
        { entityId: 'A', holeValues: card(4, { 17: null }) },
        { entityId: 'B', holeValues: card(4) },
      ],
      sequence: ['last_3'],
      direction: 'asc',
    })

    expect(result.unresolved).toBe(true)
    expect(result.warnings.map((w) => w.code)).toContain('COUNTBACK_SEGMENT_INCOMPLETE')
  })

  it('takes the HIGHER total for points formats', () => {
    const result = resolveCountback({
      entities: [
        { entityId: 'A', holeValues: card(2, { 17: 4 }) },
        { entityId: 'B', holeValues: card(2, { 17: 1 }) },
      ],
      sequence: ['last_3'],
      direction: 'desc',
    })

    const order = result.placements.sort((a, b) => a.order - b.order)
    expect(order[0]!.entityId).toBe('A')
  })

  it('skips a segment the competition cannot support and reports it', () => {
    const nine = Array.from({ length: 9 }, () => 4)
    const result = resolveCountback({
      entities: [
        { entityId: 'A', holeValues: nine },
        { entityId: 'B', holeValues: nine },
      ],
      sequence: ['last_18', 'hole_18'],
      direction: 'asc',
    })

    expect(result.warnings.filter((w) => w.code === 'COUNTBACK_SEGMENT_INVALID')).toHaveLength(2)
    expect(result.unresolved).toBe(true)
  })

  it('rejects entities whose cards disagree on length', () => {
    expect(() =>
      resolveCountback({
        entities: [
          { entityId: 'A', holeValues: card(4) },
          { entityId: 'B', holeValues: Array.from({ length: 9 }, () => 4) },
        ],
        sequence: SEQUENCE,
        direction: 'asc',
      }),
    ).toThrow(RangeError)
  })
})

describe('applyCountback across a leaderboard', () => {
  const values = new Map<string, Array<number | null>>([
    ['A', card(4, { 17: 5 })],
    ['B', card(4, { 17: 3 })],
    ['C', card(3)],
    ['D', card(4)],
  ])

  it('renumbers a shared rank into consecutive positions', () => {
    const { rows } = applyCountback(
      [
        { entityId: 'C', rank: 1, isTied: false },
        { entityId: 'A', rank: 2, isTied: true },
        { entityId: 'B', rank: 2, isTied: true },
      ],
      values,
      { mode: 'countback', sequence: SEQUENCE },
      'asc',
    )

    expect(rows.map((r) => [r.entityId, r.rank, r.isTied])).toEqual([
      ['C', 1, false],
      // B's better finish takes second; A drops to a real third, not a
      // second shared rank.
      ['B', 2, false],
      ['A', 3, false],
    ])
  })

  it('leaves ranks untouched when the mode is not countback', () => {
    const input = [
      { entityId: 'A', rank: 1, isTied: true },
      { entityId: 'B', rank: 1, isTied: true },
    ]
    const { rows } = applyCountback(input, values, { mode: 'tied', sequence: SEQUENCE }, 'asc')
    expect(rows).toEqual(input)
  })

  it('does not resolve playoff mode from card data', () => {
    // A playoff happens on the course; deriving one from scorecards would
    // fabricate a result that never took place.
    const input = [
      { entityId: 'A', rank: 1, isTied: true },
      { entityId: 'B', rank: 1, isTied: true },
    ]
    const { rows } = applyCountback(input, values, { mode: 'playoff', sequence: SEQUENCE }, 'asc')
    expect(rows).toEqual(input)
  })

  it('keeps genuinely level entities sharing a rank', () => {
    const level = new Map<string, Array<number | null>>([
      ['A', card(4)],
      ['B', card(4)],
    ])
    const { rows, warnings } = applyCountback(
      [
        { entityId: 'A', rank: 1, isTied: true },
        { entityId: 'B', rank: 1, isTied: true },
      ],
      level,
      { mode: 'countback', sequence: SEQUENCE },
      'asc',
    )

    expect(rows.every((r) => r.rank === 1 && r.isTied)).toBe(true)
    expect(warnings.map((w) => w.code)).toContain('COUNTBACK_UNRESOLVED')
  })

  it('passes unranked rows through untouched', () => {
    const { rows } = applyCountback(
      [
        { entityId: 'A', rank: 1, isTied: false },
        { entityId: 'D', rank: null, isTied: false },
      ],
      values,
      { mode: 'countback', sequence: SEQUENCE },
      'asc',
    )

    expect(rows.find((r) => r.entityId === 'D')).toEqual({
      entityId: 'D',
      rank: null,
      isTied: false,
    })
  })
})
