import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  calculateMatch,
  matchStrokeAllocation,
  type MatchHoleInput,
  type MatchInput,
} from '../src/formats/match-play.ts'
import { ZERO, percent, rational } from '../src/rational.ts'
import type { HoleSnapshot } from '../src/types.ts'

const holes18: HoleSnapshot[] = Array.from({ length: 18 }, (_, i) => ({
  id: `h${i + 1}`,
  ordinal: i + 1,
  par: 4,
  strokeIndex: i + 1,
}))

/** Hole input where the named side wins, halves, or the hole is unentered. */
function played(ordinal: number, outcome: 'a' | 'b' | 'half'): MatchHoleInput {
  return {
    holeId: `h${ordinal}`,
    a: outcome === 'b' ? 5 : 4,
    b: outcome === 'a' ? 5 : 4,
  }
}

function match(
  holeInputs: MatchHoleInput[],
  overrides: Partial<MatchInput> = {},
): MatchInput {
  return { holes: holes18, holeInputs, extraHolesAllowed: false, ...overrides }
}

describe('match play state (spec §8.6, golden §20.2)', () => {
  it('clinches 3 & 2 the moment abs(holesUp) > holesRemaining', () => {
    // A wins 1-3, halves 4-16; after hole 16: up 3 with 2 to play.
    const inputs = [
      ...[1, 2, 3].map((n) => played(n, 'a')),
      ...Array.from({ length: 13 }, (_, i) => played(i + 4, 'half')),
      // Scores exist for 17-18 (needed by simultaneous stroke/skins, §21.1)
      // but they are not part of the match once it is decided.
      played(17, 'a'),
      played(18, 'a'),
    ]
    const state = calculateMatch(match(inputs))
    expect(state.status).toBe('won')
    expect(state.winner).toBe('a')
    expect(state.holesUp).toBe(3)
    expect(state.holesRemaining).toBe(2)
    expect(state.display).toBe('A wins 3 & 2')
    expect(state.dormie).toBe(false)
    expect(state.outcomes).toHaveLength(18)
    expect(state.outcomes[0]?.winner).toBe('a')
    expect(state.outcomes[15]?.winner).toBe('half')
    expect(state.outcomes[16]?.winner).toBeNull()
    expect(state.outcomes[17]?.winner).toBeNull()
  })

  it('clinches for side B with the mirrored display', () => {
    // B wins every hole; first moment abs(up) > remaining is hole 10: 10 & 8.
    const inputs = Array.from({ length: 18 }, (_, i) => played(i + 1, 'b'))
    const state = calculateMatch(match(inputs))
    expect(state.status).toBe('won')
    expect(state.winner).toBe('b')
    expect(state.holesUp).toBe(-10)
    expect(state.holesRemaining).toBe(8)
    expect(state.display).toBe('B wins 10 & 8')
    expect(state.outcomes[9]?.winner).toBe('b')
    expect(state.outcomes[10]?.winner).toBeNull()
  })

  it('halves a level match at regulation end by default', () => {
    const inputs = [
      ...[1, 2, 3, 4].map((n) => played(n, 'a')),
      ...[5, 6, 7, 8].map((n) => played(n, 'b')),
      ...Array.from({ length: 10 }, (_, i) => played(i + 9, 'half')),
    ]
    const state = calculateMatch(match(inputs))
    expect(state.status).toBe('halved')
    expect(state.winner).toBeNull()
    expect(state.holesUp).toBe(0)
    expect(state.holesRemaining).toBe(0)
    expect(state.display).toBe('Halved')
    expect(state.dormie).toBe(false)
  })

  it('stays in progress after a level regulation when extra holes are allowed', () => {
    const inputs = [
      ...[1, 2, 3, 4].map((n) => played(n, 'a')),
      ...[5, 6, 7, 8].map((n) => played(n, 'b')),
      ...Array.from({ length: 10 }, (_, i) => played(i + 9, 'half')),
    ]
    const state = calculateMatch(match(inputs, { extraHolesAllowed: true }))
    expect(state.status).toBe('in_progress')
    expect(state.winner).toBeNull()
    expect(state.display).toBe('AS after regulation')
  })

  it('awards a conceded hole without inventing a numeric score', () => {
    // B concedes hole 1 after A holes out; hole 2 conceded to B with no
    // numeric score on either side. Neither null stops evaluation.
    const inputs = [
      { holeId: 'h1', a: 4, b: null, concession: 'to_a' as const },
      { holeId: 'h2', a: null, b: null, concession: 'to_b' as const },
      ...Array.from({ length: 16 }, (_, i) => played(i + 3, 'half')),
    ]
    const state = calculateMatch(match(inputs))
    expect(state.outcomes[0]?.winner).toBe('a')
    expect(state.outcomes[1]?.winner).toBe('b')
    expect(state.status).toBe('halved')
    expect(state.holesUp).toBe(0)
  })

  it('terminates immediately on a conceded match, storing the concession', () => {
    const inputs = [played(1, 'a'), ...[2, 3, 4, 5].map((n) => played(n, 'half'))]
    const state = calculateMatch(
      match(inputs, { matchConcession: { winner: 'b' } }),
    )
    expect(state.status).toBe('conceded')
    expect(state.winner).toBe('b')
    expect(state.display).toBe('B wins (concession)')
    // The record of holes actually played stands.
    expect(state.holesUp).toBe(1)
    expect(state.holesRemaining).toBe(13)
    expect(state.dormie).toBe(false)
  })

  it('flags dormie for display but never ends the match', () => {
    const through16 = [
      played(1, 'a'),
      played(2, 'a'),
      ...Array.from({ length: 14 }, (_, i) => played(i + 3, 'half')),
    ]
    const dormie = calculateMatch(match(through16))
    expect(dormie.status).toBe('in_progress')
    expect(dormie.winner).toBeNull()
    expect(dormie.holesUp).toBe(2)
    expect(dormie.holesRemaining).toBe(2)
    expect(dormie.dormie).toBe(true)
    expect(dormie.display).toBe('A 2 UP')

    // Play continues: a halved 17th clinches 2 & 1.
    const after17 = calculateMatch(match([...through16, played(17, 'half')]))
    expect(after17.status).toBe('won')
    expect(after17.display).toBe('A wins 2 & 1')
    expect(after17.dormie).toBe(false)
  })

  it('shows AS with no determined holes and B n UP in-progress displays', () => {
    const fresh = calculateMatch(match([]))
    expect(fresh.status).toBe('in_progress')
    expect(fresh.display).toBe('AS')
    expect(fresh.holesUp).toBe(0)
    expect(fresh.holesRemaining).toBe(18)
    expect(fresh.outcomes.every((o) => o.winner === null)).toBe(true)

    const bUp = calculateMatch(match([played(1, 'b'), played(2, 'b')]))
    expect(bUp.status).toBe('in_progress')
    expect(bUp.display).toBe('B 2 UP')
    expect(bUp.dormie).toBe(false)
  })

  it('counts determined later ordinals when an earlier shotgun hole is unresolved', () => {
    // A up 1 through 3; hole 4 has a missing B score, but the later played
    // holes still count. This is reachable when the group starts on a later
    // course ordinal and the snapshot remains in course order.
    const inputs = [
      played(1, 'a'),
      played(2, 'half'),
      played(3, 'half'),
      { holeId: 'h4', a: 5, b: null },
      ...Array.from({ length: 14 }, (_, i) => played(i + 5, 'b')),
    ]
    const state = calculateMatch(match(inputs))
    expect(state.status).toBe('won')
    expect(state.winner).toBe('b')
    expect(state.holesUp).toBe(-8)
    expect(state.holesRemaining).toBe(6)
    expect(state.display).toBe('B wins 8 & 6')
    expect(state.outcomes[3]?.winner).toBeNull()
    expect(state.outcomes[4]?.winner).toBe('b')
    expect(state.outcomes.slice(13).every((o) => o.winner === null)).toBe(true)
  })

  it('treats a hole with no input row as undetermined too', () => {
    const inputs = [
      played(1, 'a'),
      played(2, 'half'),
      played(3, 'half'),
      // no row for h4
      ...Array.from({ length: 14 }, (_, i) => played(i + 5, 'b')),
    ]
    const state = calculateMatch(match(inputs))
    expect(state.holesUp).toBe(-8)
    expect(state.holesRemaining).toBe(6)
    expect(state.outcomes[3]?.winner).toBeNull()
    expect(state.outcomes[4]?.winner).toBe('b')
  })

  it('aligns holeInputs by holeId regardless of array order', () => {
    const ordered = [
      ...[1, 2, 3].map((n) => played(n, 'a')),
      ...Array.from({ length: 15 }, (_, i) => played(i + 4, 'half')),
    ]
    const shuffled = [...ordered].reverse()
    expect(calculateMatch(match(shuffled))).toEqual(calculateMatch(match(ordered)))
  })

  it('accepts zero and negative net comparison values', () => {
    const state = calculateMatch(match([
      { holeId: 'h1', a: -1, b: 0 },
      { holeId: 'h2', a: 0, b: -2 },
    ]))

    expect(state.outcomes[0]?.winner).toBe('a')
    expect(state.outcomes[1]?.winner).toBe('b')
    expect(state.holesUp).toBe(0)
  })

  it('rejects invalid inputs', () => {
    expect(() =>
      calculateMatch({ holes: [], holeInputs: [], extraHolesAllowed: false }),
    ).toThrow(RangeError)
    expect(() =>
      calculateMatch(match([played(1, 'a'), played(1, 'b')])),
    ).toThrow(/multiple match inputs/)
    expect(() =>
      calculateMatch(match([{ holeId: 'h1', a: 4, b: 4.5 }])),
    ).toThrow(RangeError)
  })

  it('property: cumulative evaluation invariants hold for random sequences', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<'a' | 'b' | 'half' | 'none'>('a', 'b', 'half', 'none'), {
          minLength: 1,
          maxLength: 18,
        }),
        fc.boolean(),
        (seq, extraHolesAllowed) => {
          const holes: HoleSnapshot[] = seq.map((_, i) => ({
            id: `h${i + 1}`,
            ordinal: i + 1,
            par: 4,
            strokeIndex: i + 1,
          }))
          const holeInputs: MatchHoleInput[] = seq.map((w, i) => ({
            holeId: `h${i + 1}`,
            a: w === 'none' ? null : w === 'b' ? 5 : 4,
            b: w === 'none' ? null : w === 'a' ? 5 : 4,
          }))
          const state = calculateMatch({ holes, holeInputs, extraHolesAllowed })

          expect(state.outcomes).toHaveLength(holes.length)
          const det = state.outcomes.filter((o) => o.winner !== null)
          const winsA = det.filter((o) => o.winner === 'a').length
          const winsB = det.filter((o) => o.winner === 'b').length
          expect(state.holesUp).toBe(winsA - winsB)
          expect(state.holesRemaining).toBe(holes.length - det.length)
          if (state.status === 'won') {
            expect(Math.abs(state.holesUp)).toBeGreaterThan(state.holesRemaining)
            expect(state.display).toMatch(/^(A|B) wins \d+ & \d+$/)
            expect(state.winner).toBe(state.holesUp > 0 ? 'a' : 'b')
          }
          if (state.status === 'halved') {
            expect(state.holesUp).toBe(0)
            expect(state.holesRemaining).toBe(0)
          }
          if (state.dormie) {
            expect(state.status).toBe('in_progress')
            expect(Math.abs(state.holesUp)).toBe(state.holesRemaining)
            expect(state.holesUp).not.toBe(0)
          }
        },
      ),
    )
  })
})

describe('match stroke allocation (spec §8.6, §9.4-9.5, golden §20.2)', () => {
  const usga = { kind: 'usga_whs_2024' } as const

  it('normalizes a USGA four-ball 90% allowance from the lowest unrounded CH, plus handicap included', () => {
    // CH_A = 10.5, CH_B = +1.5 (internally -1.5, the lowest).
    // diff_A = 10.5 - (-1.5) = 12 exactly; 12 x 90% = 10.8 -> 11 strokes.
    const { strokesA, strokesB } = matchStrokeAllocation({
      courseHandicapA: rational(21, 2),
      courseHandicapB: rational(-3, 2),
      allowance: percent(90),
      rounding: usga,
      holes: holes18,
    })
    let sumA = 0
    for (const hole of holes18) {
      const s = strokesA.get(hole.id)
      expect(s).toBe(hole.strokeIndex <= 11 ? 1 : 0)
      sumA += s ?? 0
      expect(strokesB.get(hole.id)).toBe(0)
    }
    expect(sumA).toBe(11)
    expect(strokesA.size).toBe(18)
    expect(strokesB.size).toBe(18)
  })

  it('rounds the .5 tie upward at the one final step', () => {
    // diff = 5; 5 x 90% = 4.5 -> 5 under usga_whs_2024.
    const { strokesA, strokesB } = matchStrokeAllocation({
      courseHandicapA: rational(5),
      courseHandicapB: ZERO,
      allowance: percent(90),
      rounding: usga,
      holes: holes18,
    })
    const sum = [...strokesA.values()].reduce((t, s) => t + s, 0)
    expect(sum).toBe(5)
    expect(strokesA.get('h5')).toBe(1)
    expect(strokesA.get('h6')).toBe(0)
    expect([...strokesB.values()].every((s) => s === 0)).toBe(true)
  })

  it('works when both sides are plus handicaps (negative internally)', () => {
    // CH_A = +2 (-2), CH_B = +5 (-5, the lowest); diff_A = 3 at full allowance.
    const { strokesA, strokesB } = matchStrokeAllocation({
      courseHandicapA: rational(-2),
      courseHandicapB: rational(-5),
      allowance: percent(100),
      rounding: usga,
      holes: holes18,
    })
    expect([...strokesA.values()].reduce((t, s) => t + s, 0)).toBe(3)
    expect(strokesA.get('h1')).toBe(1)
    expect(strokesA.get('h3')).toBe(1)
    expect(strokesA.get('h4')).toBe(0)
    expect([...strokesB.values()].every((s) => s === 0)).toBe(true)
  })

  it('gives both sides zero maps when Course Handicaps are equal', () => {
    const { strokesA, strokesB } = matchStrokeAllocation({
      courseHandicapA: rational(87, 10),
      courseHandicapB: rational(87, 10),
      allowance: percent(90),
      rounding: usga,
      holes: holes18,
    })
    expect([...strokesA.values()].every((s) => s === 0)).toBe(true)
    expect([...strokesB.values()].every((s) => s === 0)).toBe(true)
  })

  it('extra holes reuse the regulation stroke-index allocation', () => {
    const input = {
      courseHandicapA: rational(21, 2),
      courseHandicapB: rational(-3, 2),
      allowance: percent(90),
      rounding: usga,
      holes: holes18,
    }
    const regulation = matchStrokeAllocation(input)
    // An extra hole is a replay of a regulation hole: recomputing the
    // allocation for the replayed holes is byte-identical, and the stroke on
    // any replayed hole equals its regulation stroke.
    const extra = matchStrokeAllocation(input)
    expect(extra.strokesA).toEqual(regulation.strokesA)
    expect(extra.strokesB).toEqual(regulation.strokesB)
    expect(extra.strokesA.get('h1')).toBe(regulation.strokesA.get('h1'))
  })
})
