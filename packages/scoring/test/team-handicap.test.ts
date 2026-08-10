import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  SCRAMBLE_WEIGHT_PRESETS,
  calculateTeamBallTotals,
  foursomesTeamHandicap,
  greensomesTeamHandicap,
  scrambleTeamHandicap,
} from '../src/formats/team-handicap.ts'
import type {
  TeamBallInput,
  TeamBallResult,
  TeamBallTeam,
} from '../src/formats/team-handicap.ts'
import { compare, fromTenths, percent, rational } from '../src/rational.ts'
import type { Rational } from '../src/rational.ts'
import type {
  EntityStatus,
  HoleSnapshot,
  RoundingProfile,
  TeamHoleScore,
} from '../src/types.ts'

const usga: RoundingProfile = { kind: 'usga_whs_2024' }

const customDown: RoundingProfile = {
  kind: 'committee_custom',
  intermediatePrecision: 1,
  tieDirection: 'down',
  stepOrder: 'allowance_then_round',
}

/** 9 par-4 holes, strokeIndex === ordinal, ids h1..h9. */
const holes9: HoleSnapshot[] = Array.from({ length: 9 }, (_, i) => ({
  id: `h${i + 1}`,
  ordinal: i + 1,
  par: 4,
  strokeIndex: i + 1,
}))

/** Complete team card from a 9-entry gross array (index i -> hole h(i+1)). */
function card(teamId: string, grosses: readonly number[]): TeamHoleScore[] {
  return grosses.map((g, i) => ({
    teamId,
    holeId: `h${i + 1}`,
    grossStrokes: g,
    status: 'complete' as const,
    revision: 1,
  }))
}

function team(
  teamId: string,
  teamPlayingHandicap: number | null,
  scores: TeamHoleScore[],
  entityStatus: EntityStatus = 'active',
): TeamBallTeam {
  return { teamId, entityStatus, teamPlayingHandicap, scores }
}

function run(
  partial: Partial<TeamBallInput> & Pick<TeamBallInput, 'metric' | 'teams'>,
): TeamBallResult {
  return calculateTeamBallTotals({ holes: holes9, phase: 'final', ...partial })
}

function row(result: TeamBallResult, teamId: string) {
  const r = result.rows.find((x) => x.teamId === teamId)
  if (r === undefined) throw new Error(`missing row ${teamId}`)
  return r
}

function holeResult(result: TeamBallResult, teamId: string, holeId: string) {
  const hr = result.holeResults.find(
    (x) => x.entityId === teamId && x.holeId === holeId,
  )
  if (hr === undefined) throw new Error(`missing hole result ${teamId}/${holeId}`)
  return hr
}

describe('scramble weight presets (spec §8.8, [S17])', () => {
  it('publishes the USGA Appendix C defaults low to high', () => {
    expect(SCRAMBLE_WEIGHT_PRESETS[2]).toEqual([percent(35), percent(15)])
    expect(SCRAMBLE_WEIGHT_PRESETS[3]).toEqual([percent(30), percent(20), percent(10)])
    expect(SCRAMBLE_WEIGHT_PRESETS[4]).toEqual([
      percent(25),
      percent(20),
      percent(15),
      percent(10),
    ])
  })
})

describe('scramble team handicap goldens (spec §8.8, §20.2)', () => {
  it('two players: 35% low + 15% high on CHs 5.2 and 18.6 (given unsorted)', () => {
    // 0.35 x 5.2 + 0.15 x 18.6 = 1.82 + 2.79 = 4.61 exactly.
    const result = scrambleTeamHandicap(
      [fromTenths(186), fromTenths(52)],
      SCRAMBLE_WEIGHT_PRESETS[2],
      usga,
    )
    expect(result.teamPlayingHandicapUnrounded).toEqual(rational(461, 100))
    expect(result.teamPlayingHandicap).toBe(5)
    expect(result.explanation).toContain('ch=5.200000 x w=0.3500')
    expect(result.explanation).toContain('ch=18.600000 x w=0.1500')
    expect(result.explanation).toContain('unrounded=4.610000')
    expect(result.explanation).toContain('team_playing_handicap=5 (usga_whs_2024)')
  })

  it('three players: 30/20/10 on CHs 4.0, 10.5, 22.3 (given unsorted)', () => {
    // 0.30 x 4.0 + 0.20 x 10.5 + 0.10 x 22.3 = 1.2 + 2.1 + 2.23 = 5.53 exactly.
    const result = scrambleTeamHandicap(
      [fromTenths(105), fromTenths(223), fromTenths(40)],
      SCRAMBLE_WEIGHT_PRESETS[3],
      usga,
    )
    expect(result.teamPlayingHandicapUnrounded).toEqual(rational(553, 100))
    expect(result.teamPlayingHandicap).toBe(6)
  })

  it('four players: 25/20/15/10 with a plus handicap taking the low slot', () => {
    // Sorted by value: -2.0, 6.4, 11.0, 20.8.
    // 0.25 x -2.0 + 0.20 x 6.4 + 0.15 x 11.0 + 0.10 x 20.8
    //   = -0.5 + 1.28 + 1.65 + 2.08 = 4.51 exactly.
    const result = scrambleTeamHandicap(
      [fromTenths(64), fromTenths(208), fromTenths(-20), fromTenths(110)],
      SCRAMBLE_WEIGHT_PRESETS[4],
      usga,
    )
    expect(result.teamPlayingHandicapUnrounded).toEqual(rational(451, 100))
    expect(result.teamPlayingHandicap).toBe(5)
    expect(result.explanation).toContain('ch=-2.000000 x w=0.2500')
  })

  it("'low' means lowest VALUE: plus 3.0 sorts below 1.0 and takes 35%", () => {
    // Value sort: [-3.0, 1.0] -> 0.35 x -3.0 + 0.15 x 1.0 = -0.90.
    // (A magnitude sort would wrongly yield 0.35 x 1.0 + 0.15 x -3.0 = -0.10.)
    const result = scrambleTeamHandicap(
      [fromTenths(10), fromTenths(-30)],
      SCRAMBLE_WEIGHT_PRESETS[2],
      usga,
    )
    expect(result.teamPlayingHandicapUnrounded).toEqual(rational(-9, 10))
    // floor(-0.9 + 0.5) = -1: the .5-toward-positive-infinity profile.
    expect(result.teamPlayingHandicap).toBe(-1)
  })

  it('applies exactly one rounding at the end: .5 tie under both profiles', () => {
    // Both CHs 9.0 -> 0.35 x 9 + 0.15 x 9 = 4.5 exactly.
    const chs = () => [fromTenths(90), fromTenths(90)]
    const up = scrambleTeamHandicap(chs(), SCRAMBLE_WEIGHT_PRESETS[2], usga)
    expect(up.teamPlayingHandicapUnrounded).toEqual(rational(9, 2))
    expect(up.teamPlayingHandicap).toBe(5)

    const down = scrambleTeamHandicap(chs(), SCRAMBLE_WEIGHT_PRESETS[2], customDown)
    expect(down.teamPlayingHandicapUnrounded).toEqual(rational(9, 2))
    expect(down.teamPlayingHandicap).toBe(4)
    expect(down.explanation).toContain('(committee_custom)')
  })

  it('does not mutate the caller-provided course handicap array', () => {
    const chs = [fromTenths(186), fromTenths(52)]
    scrambleTeamHandicap(chs, SCRAMBLE_WEIGHT_PRESETS[2], usga)
    expect(chs).toEqual([fromTenths(186), fromTenths(52)])
  })

  it('throws RangeError on unsupported team sizes, mismatched counts, and invalid weights', () => {
    expect(() =>
      scrambleTeamHandicap(
        [fromTenths(52), fromTenths(105), fromTenths(186)],
        SCRAMBLE_WEIGHT_PRESETS[2],
        usga,
      ),
    ).toThrow(RangeError)
    expect(() =>
      scrambleTeamHandicap([fromTenths(52)], SCRAMBLE_WEIGHT_PRESETS[2], usga),
    ).toThrow(RangeError)
    expect(() => scrambleTeamHandicap([], [], usga)).toThrow(RangeError)
    expect(() => scrambleTeamHandicap(
      [fromTenths(10), fromTenths(20)],
      [rational(-1, 10), rational(1, 10)],
      usga,
    )).toThrow(/between 0 and 1/)
    expect(() => scrambleTeamHandicap(
      [fromTenths(10), fromTenths(20)],
      [rational(11, 10), rational(1, 10)],
      usga,
    )).toThrow(/between 0 and 1/)
  })

  it('is invariant under permutation of the input course handicaps', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -100, max: 400 }), { minLength: 2, maxLength: 4 }),
        (tenths) => {
          const weights = SCRAMBLE_WEIGHT_PRESETS[tenths.length as 2 | 3 | 4]
          const forward = scrambleTeamHandicap(tenths.map(fromTenths), weights, usga)
          const reversed = scrambleTeamHandicap(
            [...tenths].reverse().map(fromTenths),
            weights,
            usga,
          )
          expect(
            compare(
              forward.teamPlayingHandicapUnrounded,
              reversed.teamPlayingHandicapUnrounded,
            ),
          ).toBe(0)
          expect(reversed.teamPlayingHandicap).toBe(forward.teamPlayingHandicap)
        },
      ),
    )
  })
})

describe('foursomes team handicap golden (spec §8.9, §20.2)', () => {
  it('50% of combined unrounded CHs: 8.3 + 12.9 -> 10.6 -> 11', () => {
    const result = foursomesTeamHandicap(fromTenths(83), fromTenths(129), usga)
    expect(result.teamPlayingHandicapUnrounded).toEqual(rational(53, 5))
    expect(result.teamPlayingHandicap).toBe(11)
    expect(result.explanation).toContain('ch_a=8.300000')
    expect(result.explanation).toContain('ch_b=12.900000')
    expect(result.explanation).toContain('allowance=0.5000')
    expect(result.explanation).toContain('team_playing_handicap=11 (usga_whs_2024)')
  })

  it('.5 tie rounds toward positive infinity: 9.0 + 12.0 -> 10.5 -> 11', () => {
    const result = foursomesTeamHandicap(fromTenths(90), fromTenths(120), usga)
    expect(result.teamPlayingHandicapUnrounded).toEqual(rational(21, 2))
    expect(result.teamPlayingHandicap).toBe(11)
  })

  it('plus pair stays signed: -3.0 + 1.0 -> -1.0 -> -1', () => {
    const result = foursomesTeamHandicap(fromTenths(-30), fromTenths(10), usga)
    expect(result.teamPlayingHandicapUnrounded).toEqual(rational(-1))
    expect(result.teamPlayingHandicap).toBe(-1)
  })
})

describe('greensomes/Chapman team handicap goldens (spec §8.10, §20.2)', () => {
  it('60% of lower + 40% of higher: 5.3 and 12.7 -> 8.26 -> 8', () => {
    const result = greensomesTeamHandicap(fromTenths(53), fromTenths(127), usga)
    expect(result.teamPlayingHandicapUnrounded).toEqual(rational(413, 50))
    expect(result.teamPlayingHandicap).toBe(8)
    expect(result.explanation).toContain('lower=5.300000 x 0.6000')
    expect(result.explanation).toContain('higher=12.700000 x 0.4000')
    expect(result.explanation).toContain('team_playing_handicap=8 (usga_whs_2024)')
  })

  it('plus handicap is the LOWER value regardless of argument order', () => {
    // lower = -1.6, higher = 7.4: 0.6 x -1.6 + 0.4 x 7.4 = -0.96 + 2.96 = 2.
    const forward = greensomesTeamHandicap(fromTenths(-16), fromTenths(74), usga)
    const swapped = greensomesTeamHandicap(fromTenths(74), fromTenths(-16), usga)
    for (const result of [forward, swapped]) {
      expect(result.teamPlayingHandicapUnrounded).toEqual(rational(2))
      expect(result.teamPlayingHandicap).toBe(2)
      expect(result.explanation).toContain('lower=-1.600000 x 0.6000')
      expect(result.explanation).toContain('higher=7.400000 x 0.4000')
    }
  })
})

describe('team-ball gross totals (spec §8.8-§8.10)', () => {
  it('ranks complete team cards ascending on gross; net stays null sans handicap', () => {
    const result = run({
      metric: 'gross',
      teams: [
        team('b', null, card('b', [5, 5, 4, 4, 4, 4, 4, 4, 4])),
        team('a', null, card('a', [4, 4, 4, 4, 4, 4, 4, 4, 4])),
      ],
    })
    const a = row(result, 'a')
    const b = row(result, 'b')
    expect(a.grossTotal).toBe(36)
    expect(b.grossTotal).toBe(38)
    expect(a.netTotal).toBeNull()
    expect(b.netTotal).toBeNull()
    expect(a.rank).toBe(1)
    expect(b.rank).toBe(2)
    expect(a.thru).toBe(9)
    expect(a.status).toBe('complete')
    expect(result.warnings).toEqual([])
    expect(result.provisional).toBe(false)
    expect(result.holeResults).toHaveLength(18)
    const hr = holeResult(result, 'b', 'h1')
    expect(hr.gross).toBe(5)
    expect(hr.strokesReceived).toBe(0)
    expect(hr.net).toBeNull()
    expect(hr.relativeToPar).toBe(1)
  })

  it('shares rank on equal gross totals (ties stand)', () => {
    const result = run({
      metric: 'gross',
      teams: [
        team('a', null, card('a', [4, 4, 4, 4, 4, 4, 4, 4, 4])),
        team('b', null, card('b', [4, 4, 4, 4, 4, 4, 4, 4, 4])),
        team('c', null, card('c', [5, 5, 4, 4, 4, 4, 4, 4, 4])),
      ],
    })
    expect(row(result, 'a').rank).toBe(1)
    expect(row(result, 'a').isTied).toBe(true)
    expect(row(result, 'b').rank).toBe(1)
    expect(row(result, 'b').isTied).toBe(true)
    expect(row(result, 'c').rank).toBe(3)
    expect(row(result, 'c').isTied).toBe(false)
  })

  it('throws on duplicate teamId or duplicate hole score', () => {
    expect(() =>
      run({
        metric: 'gross',
        teams: [
          team('a', null, card('a', [4, 4, 4, 4, 4, 4, 4, 4, 4])),
          team('a', null, card('a', [5, 5, 5, 5, 5, 5, 5, 5, 5])),
        ],
      }),
    ).toThrow(RangeError)
    expect(() =>
      run({
        metric: 'gross',
        teams: [
          team('a', null, [
            ...card('a', [4, 4, 4, 4, 4, 4, 4, 4, 4]),
            { teamId: 'a', holeId: 'h1', grossStrokes: 5, status: 'complete', revision: 2 },
          ]),
        ],
      }),
    ).toThrow(RangeError)
  })
})

describe('team-ball net totals with stroke allocation (spec §8.8, §9.5)', () => {
  it('allocates the frozen team Playing Handicap by stroke index before ranking', () => {
    // A: PH 5, gross 45 -> strokes on SI 1..5 -> net 40.
    // B: PH 2, gross 43 -> strokes on SI 1..2 -> net 41.
    // Net order (A, B) inverts the gross order (B, A).
    const result = run({
      metric: 'net',
      teams: [
        team('a', 5, card('a', [5, 5, 5, 5, 5, 5, 5, 5, 5])),
        team('b', 2, card('b', [4, 4, 5, 5, 5, 5, 5, 5, 5])),
      ],
    })
    const a = row(result, 'a')
    const b = row(result, 'b')
    expect(a.grossTotal).toBe(45)
    expect(a.netTotal).toBe(40)
    expect(b.grossTotal).toBe(43)
    expect(b.netTotal).toBe(41)
    expect(a.rank).toBe(1)
    expect(b.rank).toBe(2)

    const a1 = holeResult(result, 'a', 'h1')
    expect(a1.strokesReceived).toBe(1)
    expect(a1.net).toBe(4)
    expect(a1.relativeToPar).toBe(0)
    const a6 = holeResult(result, 'a', 'h6')
    expect(a6.strokesReceived).toBe(0)
    expect(a6.net).toBe(5)
    const b1 = holeResult(result, 'b', 'h1')
    expect(b1.strokesReceived).toBe(1)
    expect(b1.net).toBe(3)
    const b3 = holeResult(result, 'b', 'h3')
    expect(b3.strokesReceived).toBe(0)
    expect(b3.net).toBe(5)
  })

  it('net metric with a null team handicap warns NET_NO_HANDICAP and never ranks', () => {
    const result = run({
      metric: 'net',
      teams: [
        team('a', 3, card('a', [5, 5, 5, 5, 5, 5, 5, 5, 5])),
        team('c', null, card('c', [4, 4, 4, 4, 4, 4, 4, 4, 4])),
      ],
    })
    const c = row(result, 'c')
    expect(c.grossTotal).toBe(36)
    expect(c.netTotal).toBeNull()
    expect(c.rank).toBeNull()
    expect(c.status).toBe('complete')
    expect(row(result, 'a').rank).toBe(1)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.code).toBe('NET_NO_HANDICAP')
    expect(result.warnings[0]?.context).toEqual({ teamId: 'c' })
  })
})

describe('team-ball live provisional vs final no_return (spec §7.3, §21.1)', () => {
  const incompleteTeams = () => [
    team('a', null, card('a', [4, 4, 4, 4, 4, 4, 4, 4, 4])),
    // b: 8 completed holes for 32, h9 never started.
    team('b', null, card('b', [4, 4, 4, 4, 4, 4, 4, 4]).slice(0, 8)),
  ]

  it('live: incomplete team ranks provisionally on its current total', () => {
    const result = run({ metric: 'gross', phase: 'live', teams: incompleteTeams() })
    const b = row(result, 'b')
    expect(b.grossTotal).toBe(32)
    expect(b.thru).toBe(8)
    expect(b.status).toBe('provisional')
    expect(b.provisional).toBe(true)
    expect(b.rank).toBe(1)
    expect(row(result, 'a').rank).toBe(2)
    expect(row(result, 'a').status).toBe('complete')
    expect(result.provisional).toBe(true)
    expect(holeResult(result, 'b', 'h9').status).toBe('not_started')
    expect(holeResult(result, 'b', 'h9').provisional).toBe(true)
  })

  it('final: the same incomplete team resolves to no_return, visible but unranked', () => {
    const result = run({ metric: 'gross', phase: 'final', teams: incompleteTeams() })
    const b = row(result, 'b')
    expect(b.grossTotal).toBe(32)
    expect(b.status).toBe('no_return')
    expect(b.provisional).toBe(false)
    expect(b.rank).toBeNull()
    expect(row(result, 'a').rank).toBe(1)
    expect(result.provisional).toBe(false)
  })

  it('final: a terminal non-complete hole (picked up team ball) is also no_return', () => {
    const scores = card('b', [4, 4, 4, 4, 4, 4, 4, 4]).slice(0, 8)
    scores.push({ teamId: 'b', holeId: 'h9', status: 'picked_up', revision: 1 })
    const result = run({
      metric: 'gross',
      phase: 'final',
      teams: [team('a', null, card('a', [4, 4, 4, 4, 4, 4, 4, 4, 4])), team('b', null, scores)],
    })
    const b = row(result, 'b')
    expect(b.status).toBe('no_return')
    expect(b.rank).toBeNull()
    expect(b.grossTotal).toBe(32)
    expect(holeResult(result, 'b', 'h9').status).toBe('picked_up')
    expect(holeResult(result, 'b', 'h9').gross).toBeNull()
  })
})

describe('team-ball withdrawn/disqualified visibility (spec §7.3, §21.1)', () => {
  it('keeps DQ and withdrawn teams visible with totals but never ranked', () => {
    const result = run({
      metric: 'gross',
      teams: [
        team('dq', null, card('dq', [3, 3, 3, 3, 3, 3, 3, 3, 3]), 'disqualified'),
        team('wd', null, card('wd', [3, 4, 3, 4, 3, 4, 3, 4, 3]), 'withdrawn'),
        team('a', null, card('a', [5, 5, 5, 5, 5, 5, 5, 5, 5])),
      ],
    })
    const dq = row(result, 'dq')
    const wd = row(result, 'wd')
    expect(dq.status).toBe('disqualified')
    expect(dq.grossTotal).toBe(27)
    expect(dq.rank).toBeNull()
    expect(wd.status).toBe('withdrawn')
    expect(wd.grossTotal).toBe(31)
    expect(wd.rank).toBeNull()
    expect(row(result, 'a').rank).toBe(1)
    expect(result.rows).toHaveLength(3)
  })
})
