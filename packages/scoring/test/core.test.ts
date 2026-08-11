import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  fromTenths,
  percent,
  rational,
  roundHalfUpTowardPositiveInfinity,
  toNumber,
} from '../src/rational.ts'
import {
  courseHandicapUnrounded,
  playingHandicap,
} from '../src/handicap/course-handicap.ts'
import {
  allocateStrokes,
  strokesReceivedOnHole,
} from '../src/handicap/allocation.ts'
import { canonicalJson, canonicalNumericResult, sha256Hex } from '../src/canonical.ts'
import { assignRanks, computeHole, computeTotals } from '../src/common.ts'
import type { HoleSnapshot } from '../src/types.ts'

const holes18: HoleSnapshot[] = Array.from({ length: 18 }, (_, i) => ({
  id: `h${i + 1}`,
  ordinal: i + 1,
  par: 4,
  strokeIndex: i + 1,
}))

describe('rounding profile usga_whs_2024 (spec §7.5)', () => {
  it('rounds .5 upward toward positive infinity', () => {
    expect(roundHalfUpTowardPositiveInfinity(rational(5, 2))).toBe(3) // 2.5 -> 3
    expect(roundHalfUpTowardPositiveInfinity(rational(3, 2))).toBe(2) // 1.5 -> 2
  })
  it('moves a negative plus-handicap tie toward zero', () => {
    expect(roundHalfUpTowardPositiveInfinity(rational(-5, 2))).toBe(-2) // -2.5 -> -2
    expect(roundHalfUpTowardPositiveInfinity(rational(-3, 2))).toBe(-1) // -1.5 -> -1
  })
  it('rounds ordinary values to nearest', () => {
    expect(roundHalfUpTowardPositiveInfinity(rational(24, 10))).toBe(2)
    expect(roundHalfUpTowardPositiveInfinity(rational(26, 10))).toBe(3)
    expect(roundHalfUpTowardPositiveInfinity(rational(-24, 10))).toBe(-2)
    expect(roundHalfUpTowardPositiveInfinity(rational(-26, 10))).toBe(-3)
  })
})

describe('course/playing handicap (spec §9.3-9.4, golden §20.2)', () => {
  it('preserves the unrounded Course Handicap before an 85% allowance', () => {
    // HI 10.4, slope 130, CR 71.3, par 72
    const ch = courseHandicapUnrounded({
      handicapIndexTenths: 104,
      slopeRating: 130,
      courseRatingTenths: 713,
      par: 72,
    })
    // 10.4 * 130/113 - 0.7 = (104*130 - 7*113) / 1130 = 12729/1130
    expect(ch).toEqual(rational(12729, 1130))
    const ph = playingHandicap(ch, percent(85), { kind: 'usga_whs_2024' })
    // 12729/1130 * 85/100 = 1081965/113000 ~= 9.575 -> 10
    expect(toNumber(ph.playingHandicapUnrounded)).toBeCloseTo(9.5749, 3)
    expect(ph.playingHandicap).toBe(10)
  })

  it('handles a plus handicap end to end (signed internal convention)', () => {
    // +2.0 index (internally -20 tenths), slope 113, CR = par
    const ch = courseHandicapUnrounded({
      handicapIndexTenths: -20,
      slopeRating: 113,
      courseRatingTenths: 720,
      par: 72,
    })
    expect(ch).toEqual(rational(-2))
    const ph = playingHandicap(ch, percent(100), { kind: 'usga_whs_2024' })
    expect(ph.playingHandicap).toBe(-2)
    // 90% allowance moves the plus handicap toward zero: -1.8 -> -2? No:
    // round(-1.8) = floor(-1.3) = -2. Tie case: -1.5 rounds to -1.
    const ph90 = playingHandicap(ch, percent(90), { kind: 'usga_whs_2024' })
    expect(toNumber(ph90.playingHandicapUnrounded)).toBeCloseTo(-1.8, 10)
    expect(ph90.playingHandicap).toBe(-2)
  })
})

describe('stroke allocation (spec §9.5, golden §20.2)', () => {
  it('allocates Playing Handicap 20 over 18 holes: two on SI 1-2, one on 3-18', () => {
    const alloc = allocateStrokes(20, holes18)
    expect(alloc.get('h1')).toBe(2)
    expect(alloc.get('h2')).toBe(2)
    for (let i = 3; i <= 18; i++) expect(alloc.get(`h${i}`)).toBe(1)
    let sum = 0
    for (const v of alloc.values()) sum += v
    expect(sum).toBe(20)
  })

  it('plus-2 gives strokes at stroke indexes 18 and 17', () => {
    const alloc = allocateStrokes(-2, holes18)
    expect(alloc.get('h18')).toBe(-1)
    expect(alloc.get('h17')).toBe(-1)
    for (let i = 1; i <= 16; i++) expect(alloc.get(`h${i}`)).toBe(0)
  })

  it('property: allocation always sums to the playing handicap', () => {
    fc.assert(
      fc.property(fc.integer({ min: -54, max: 54 }), (h) => {
        const alloc = allocateStrokes(h, holes18)
        let sum = 0
        for (const v of alloc.values()) sum += v
        return sum === h
      }),
    )
  })

  it('property: per-hole strokes differ by at most 1 within a cycle direction', () => {
    fc.assert(
      fc.property(fc.integer({ min: -54, max: 54 }), (h) => {
        const values = [...allocateStrokes(h, holes18).values()]
        const min = Math.min(...values)
        const max = Math.max(...values)
        return max - min <= 1
      }),
    )
  })

  it('rejects non-permutation stroke indexes', () => {
    const bad = holes18.map((h) => ({ ...h, strokeIndex: 1 }))
    expect(() => allocateStrokes(5, bad)).toThrow(/permutation/)
  })
})

describe('common hole results and totals (spec §8.1)', () => {
  it('computes net with negative strokes received (plus handicap)', () => {
    const hole = holes18[0]!
    const c = computeHole(
      hole,
      { participantId: 'p1', holeId: hole.id, grossStrokes: 4, status: 'complete', revision: 1 },
      -1,
    )
    expect(c.net).toBe(5)
  })

  it('never coerces missing scores to zero; totals stay provisional', () => {
    const computations = holes18.map((h, i) =>
      computeHole(
        h,
        i < 17
          ? { participantId: 'p1', holeId: h.id, grossStrokes: 4, status: 'complete', revision: 1 }
          : undefined,
        0,
      ),
    )
    const totals = computeTotals(computations)
    expect(totals.grossTotal).toBe(68)
    expect(totals.completed).toBe(17)
    expect(totals.provisional).toBe(true)
  })

  it('rejects numeric value combined with a terminal status', () => {
    const hole = holes18[0]!
    expect(() =>
      computeHole(
        hole,
        { participantId: 'p1', holeId: hole.id, grossStrokes: 6, status: 'picked_up', revision: 1 },
        0,
      ),
    ).toThrow(/mutually exclusive/)
  })

  it('assigns shared tied ranks and places unranked entities last', () => {
    const ranks = assignRanks(
      [
        { id: 'a', total: 70 },
        { id: 'b', total: 68 },
        { id: 'c', total: 70 },
        { id: 'd', total: null },
      ],
      (e) => e.total,
      'asc',
    )
    expect(ranks.map((r) => [r.entry.id, r.rank, r.isTied])).toEqual([
      ['b', 1, false],
      ['a', 2, true],
      ['c', 2, true],
      ['d', null, false],
    ])
  })
})

describe('canonical JSON and result hash (spec §7.3)', () => {
  it('sha256 matches the FIPS 180-4 known vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('sorts keys and forbids non-integer numbers', () => {
    expect(canonicalJson({ b: 1, a: [2, 'x'] })).toBe('{"a":[2,"x"],"b":1}')
    expect(() => canonicalJson({ v: 0.5 })).toThrow(/safe integers/)
  })

  it('encodes computed decimal results as canonical strings', () => {
    expect(canonicalNumericResult(12)).toBe(12)
    expect(canonicalNumericResult(40.9959)).toBe('40.9959')
    expect(() => canonicalNumericResult(Number.POSITIVE_INFINITY)).toThrow(/finite/)
  })

  it('byte-equivalent output for equivalent inputs regardless of key order', () => {
    const one = canonicalJson({ x: 1, y: { b: 2, a: 3 } })
    const two = canonicalJson({ y: { a: 3, b: 2 }, x: 1 })
    expect(one).toBe(two)
  })

  it('exact-rational tenths survive round trips (0.1 + 0.2 class errors)', () => {
    const a = fromTenths(1) // 0.1
    const b = fromTenths(2) // 0.2
    // 0.1 + 0.2 === 3/10 exactly in rational space
    expect(rational(a.num * b.den + b.num * a.den, a.den * b.den)).toEqual(
      rational(3, 10),
    )
  })
})
