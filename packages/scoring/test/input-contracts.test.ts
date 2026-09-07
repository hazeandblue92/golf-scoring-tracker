/**
 * Input-contract guards across the engine (spec §7.3, §20.3).
 *
 * Every format here refuses malformed input rather than scoring it. That is an
 * engine invariant, not defensive noise: a duplicate hole score, a stroke index
 * outside the layout, or a round value that cannot survive numeric(14, 6) would
 * each produce a total that looks authoritative and is wrong. The engine's
 * contract is that raw facts either compute exactly or raise — never round,
 * coerce, or silently pick one of two conflicting facts.
 *
 * These are the branches the format suites do not reach, because those suites
 * feed the engine well-formed cards. §20.3 requires the format state machines
 * at full branch coverage, and a guard is part of the state machine.
 */

import { describe, expect, it } from 'vitest'

import { calculateStrokePlay } from '../src/formats/stroke-play.ts'
import { calculateParBogey } from '../src/formats/par-bogey.ts'
import { applyCountback, resolveCountback } from '../src/formats/countback.ts'
import { calculateMultiRound } from '../src/formats/multi-round.ts'
import {
  calculateTeamBallTotals,
  scrambleTeamHandicap,
} from '../src/formats/team-handicap.ts'
import { strokesReceivedOnHole } from '../src/handicap/allocation.ts'
import { rational } from '../src/rational.ts'
import type { HoleSnapshot, IndividualHoleScore, TeamHoleScore } from '../src/types.ts'

/** 18 par-4 holes, strokeIndex === ordinal, ids h1..h18. */
const holes18: HoleSnapshot[] = Array.from({ length: 18 }, (_, i) => ({
  id: `h${i + 1}`,
  ordinal: i + 1,
  par: 4,
  strokeIndex: i + 1,
}))

function card(participantId: string, gross: number): IndividualHoleScore[] {
  return holes18.map((hole) => ({
    participantId,
    holeId: hole.id,
    grossStrokes: gross,
    status: 'complete' as const,
    revision: 1,
  }))
}

describe('stroke play refuses input it cannot score exactly (§8.2)', () => {
  it('rejects a par_plus_n maximum-score policy without a usable value', () => {
    for (const value of [undefined, 1.5, -1]) {
      expect(() =>
        calculateStrokePlay({
          holes: holes18,
          metric: 'gross',
          phase: 'final',
          entries: [
            { entryId: 'a', entityStatus: 'active', playingHandicap: 0, scores: card('a', 4) },
          ],
          maximumScore: value === undefined ? { policy: 'par_plus_n' } : { policy: 'par_plus_n', value },
        }),
      ).toThrow(RangeError)
    }
  })

  it('rejects two entries sharing an entryId', () => {
    const entry = {
      entryId: 'a',
      entityStatus: 'active' as const,
      playingHandicap: 0,
      scores: card('a', 4),
    }
    expect(() =>
      calculateStrokePlay({
        holes: holes18,
        metric: 'gross',
        phase: 'final',
        entries: [entry, { ...entry, scores: card('a', 5) }],
      }),
    ).toThrow(/duplicate entryId 'a'/)
  })

  it('rejects two scores for one hole rather than choosing between them', () => {
    const scores = card('a', 4)
    scores.push({
      participantId: 'a',
      holeId: 'h1',
      grossStrokes: 9,
      status: 'complete',
      revision: 1,
    })
    expect(() =>
      calculateStrokePlay({
        holes: holes18,
        metric: 'gross',
        phase: 'final',
        entries: [{ entryId: 'a', entityStatus: 'active', playingHandicap: 0, scores }],
      }),
    ).toThrow(/multiple scores for hole 'h1'/)
  })

  it('ignores a score for a hole outside this competition, and does not count it', () => {
    // A round-scoped competition (§8, holeScope) legitimately receives a card
    // carrying holes it does not score. Those must not reach the total.
    const scores = card('a', 4)
    scores.push({
      participantId: 'a',
      holeId: 'h19-not-in-scope',
      grossStrokes: 9,
      status: 'complete',
      revision: 1,
    })
    const result = calculateStrokePlay({
      holes: holes18,
      metric: 'gross',
      phase: 'final',
      entries: [{ entryId: 'a', entityStatus: 'active', playingHandicap: 0, scores }],
    })
    expect(result.rows[0]?.grossTotal).toBe(72)
    expect(result.rows[0]?.thru).toBe(18)
  })
})

describe('stroke allocation rejects impossible allocation inputs (§9)', () => {
  it('refuses a fractional playing handicap', () => {
    expect(() => strokesReceivedOnHole(10.5, 18, 1)).toThrow(
      /playing handicap must be a signed integer/,
    )
  })

  it('refuses a stroke index outside the layout', () => {
    expect(() => strokesReceivedOnHole(10, 18, 19)).toThrow(/out of range for 18 holes/)
    expect(() => strokesReceivedOnHole(10, 18, 0)).toThrow(/out of range for 18 holes/)
    expect(() => strokesReceivedOnHole(10, 0, 1)).toThrow(/out of range for 0 holes/)
  })
})

describe('Par/Bogey terminal and revision handling (§8.12, §21.1)', () => {
  it('leaves a withdrawn entrant unscored at finalization instead of losing every hole', () => {
    const result = calculateParBogey({
      holes: holes18,
      metric: 'gross',
      phase: 'final',
      entries: [
        { entryId: 'wd', entityStatus: 'withdrawn', playingHandicap: 0, scores: [] },
        { entryId: 'ok', entityStatus: 'active', playingHandicap: 0, scores: card('ok', 4) },
      ],
    })
    const withdrawn = result.rows.find((r) => r.entryId === 'wd')
    expect(withdrawn?.status).toBe('withdrawn')
    expect(withdrawn?.rank).toBeNull()
    // Not −18: an unplayed card is a withdrawal, not eighteen lost holes.
    expect(withdrawn?.result).toBe(0)
    for (const hr of result.holeResults.filter((h) => h.entryId === 'wd')) {
      expect(hr.outcome).toBeNull()
    }
  })

  it('uses the highest revision for a hole, whichever order the facts arrive in', () => {
    const scores = card('a', 4)
    // Superseding correction first, superseded original second.
    scores.unshift({
      participantId: 'a',
      holeId: 'h1',
      grossStrokes: 7,
      status: 'complete',
      revision: 2,
    })
    const result = calculateParBogey({
      holes: holes18,
      metric: 'gross',
      phase: 'final',
      entries: [{ entryId: 'a', entityStatus: 'active', playingHandicap: 0, scores }],
    })
    // 17 halved holes at par plus one hole three over: 0 × 17 + (−1).
    expect(result.rows[0]?.result).toBe(-1)
    const first = result.holeResults.find((h) => h.holeId === 'h1')
    expect(first?.outcome).toBe(-1)
  })
})

describe('countback declines to invent a separation (§8.15)', () => {
  it('is a no-op for fewer than two entities', () => {
    const single = resolveCountback({
      entities: [{ entityId: 'a', holeValues: [4, 4, 4] }],
      sequence: ['last_3'],
      direction: 'asc',
    })
    expect(single.placements).toHaveLength(1)
    expect(single.placements[0]).toMatchObject({ entityId: 'a', order: 0, stillTied: false })
    expect(resolveCountback({ entities: [], sequence: ['last_3'], direction: 'asc' }).placements).toEqual([])
  })

  it('passes an already-separated rank through untouched', () => {
    const ranked = [
      { entityId: 'a', rank: 1, isTied: false },
      { entityId: 'b', rank: 2, isTied: false },
    ]
    const { rows, warnings } = applyCountback(
      ranked,
      new Map([
        ['a', [4, 4, 4]],
        ['b', [5, 5, 5]],
      ]),
      { mode: 'countback', sequence: ['hole_3'] },
      'asc',
    )
    expect(rows.map((r) => r.rank)).toEqual([1, 2])
    expect(warnings).toEqual([])
  })

  it('leaves a tied group tied when a member has no published hole values', () => {
    const ranked = [
      { entityId: 'a', rank: 1, isTied: true },
      { entityId: 'b', rank: 1, isTied: true },
    ]
    const { rows } = applyCountback(
      ranked,
      // 'b' is absent: a substitution or projection lag, never a reason to
      // rank 'a' ahead on evidence that does not exist.
      new Map([['a', [4, 4, 4]]]),
      { mode: 'countback', sequence: ['hole_3'] },
      'asc',
    )
    expect(rows.map((r) => r.rank)).toEqual([1, 1])
    expect(rows.every((r) => r.isTied)).toBe(true)
  })
})

describe('multi-round aggregation guards its round contract (§8.14)', () => {
  const oneRound = [{ entityId: 'a', rounds: [{ roundId: 'r1', value: 70, status: 'complete' as const }] }]

  it('refuses an empty authoritative round list', () => {
    expect(() =>
      calculateMultiRound({
        entities: oneRound,
        aggregation: { kind: 'sum_strokes' },
        phase: 'final',
        expectedRoundIds: [],
      }),
    ).toThrow(/at least one round/)
  })

  it('refuses empty or duplicated authoritative round IDs', () => {
    expect(() =>
      calculateMultiRound({
        entities: oneRound,
        aggregation: { kind: 'sum_strokes' },
        phase: 'final',
        expectedRoundIds: [''],
      }),
    ).toThrow(/empty round ID/)
    expect(() =>
      calculateMultiRound({
        entities: oneRound,
        aggregation: { kind: 'sum_strokes' },
        phase: 'final',
        expectedRoundIds: ['r1', 'r1'],
      }),
    ).toThrow(/duplicate round 'r1'/)
  })

  it('refuses more observed rounds than the competition declares', () => {
    expect(() =>
      calculateMultiRound({
        entities: [
          {
            entityId: 'a',
            rounds: [
              { roundId: 'r1', value: 70, status: 'complete' },
              { roundId: 'r2', value: 71, status: 'complete' },
            ],
          },
        ],
        aggregation: { kind: 'sum_strokes' },
        phase: 'final',
        expectedRoundCount: 1,
      }),
    ).toThrow(/exceeding expectedRoundCount/)
  })

  it('refuses a non-finite round value', () => {
    expect(() =>
      calculateMultiRound({
        entities: [
          { entityId: 'a', rounds: [{ roundId: 'r1', value: Number.POSITIVE_INFINITY, status: 'complete' }] },
        ],
        aggregation: { kind: 'sum_strokes' },
        phase: 'final',
      }),
    ).toThrow(/must be finite or null/)
  })

  it('refuses an empty roundId on an entity result', () => {
    expect(() =>
      calculateMultiRound({
        entities: [{ entityId: 'a', rounds: [{ roundId: '', value: 70, status: 'complete' }] }],
        aggregation: { kind: 'sum_strokes' },
        phase: 'final',
      }),
    ).toThrow(/empty roundId/)
  })

  it('reports no total — not zero — for an entity with no usable round value', () => {
    const result = calculateMultiRound({
      entities: [{ entityId: 'a', rounds: [{ roundId: 'r1', value: null, status: 'not_started' }] }],
      aggregation: { kind: 'sum_strokes' },
      phase: 'live',
    })
    expect(result.rows[0]?.total).toBeNull()
    expect(result.rows[0]?.roundsCounted).toBe(0)
  })
})

describe('team formats guard team-level input (§8.4, §8.8)', () => {
  it('refuses two team balls on one hole', () => {
    const scores: TeamHoleScore[] = holes18.map((hole) => ({
      teamId: 't1',
      holeId: hole.id,
      grossStrokes: 4,
      status: 'complete' as const,
      revision: 1,
    }))
    scores.push({ teamId: 't1', holeId: 'h1', grossStrokes: 6, status: 'complete', revision: 1 })
    expect(() =>
      calculateTeamBallTotals({
        holes: holes18,
        metric: 'gross',
        phase: 'final',
        teams: [{ teamId: 't1', entityStatus: 'active', teamPlayingHandicap: 0, scores }],
      }),
    ).toThrow(/multiple scores for hole 'h1'/)
  })

  it('ignores a team ball recorded for a hole outside the competition', () => {
    const scores: TeamHoleScore[] = holes18.map((hole) => ({
      teamId: 't1',
      holeId: hole.id,
      grossStrokes: 4,
      status: 'complete' as const,
      revision: 1,
    }))
    scores.push({ teamId: 't1', holeId: 'out-of-scope', grossStrokes: 9, status: 'complete', revision: 1 })
    const result = calculateTeamBallTotals({
      holes: holes18,
      metric: 'gross',
      phase: 'final',
      teams: [{ teamId: 't1', entityStatus: 'active', teamPlayingHandicap: 0, scores }],
    })
    expect(result.rows[0]?.grossTotal).toBe(72)
  })

  it('refuses a scramble weight set that does not match the team size', () => {
    expect(() =>
      scrambleTeamHandicap([rational(10), rational(20)], [rational(35, 100)], {
        kind: 'usga_whs_2024',
      }),
    ).toThrow(/does not match/)
  })
})
