import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { calculateBestBall } from '../src/formats/best-ball.ts'
import type {
  BestBallInput,
  BestBallResult,
  BestBallRow,
  BestBallTeamHole,
} from '../src/formats/best-ball.ts'
import { strokesReceivedOnHole } from '../src/handicap/allocation.ts'
import type {
  HoleScoreStatus,
  HoleSnapshot,
  IndividualHoleScore,
} from '../src/types.ts'

// ── Helpers ─────────────────────────────────────────────────────────────────

const mkHoles = (n: number, par = 4): HoleSnapshot[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `h${i + 1}`,
    ordinal: i + 1,
    par,
    strokeIndex: i + 1,
  }))

const complete = (
  participantId: string,
  holeId: string,
  grossStrokes: number,
  revision = 1,
): IndividualHoleScore => ({
  participantId,
  holeId,
  grossStrokes,
  status: 'complete',
  revision,
})

const terminal = (
  participantId: string,
  holeId: string,
  status: HoleScoreStatus,
): IndividualHoleScore => ({ participantId, holeId, status, revision: 1 })

function teamHole(
  result: BestBallResult,
  teamId: string,
  holeId: string,
): BestBallTeamHole {
  const th = result.teamHoles.find(
    (t) => t.teamId === teamId && t.holeId === holeId,
  )
  if (th === undefined) throw new Error(`missing team hole ${teamId}/${holeId}`)
  return th
}

function row(result: BestBallResult, teamId: string): BestBallRow {
  const r = result.rows.find((x) => x.teamId === teamId)
  if (r === undefined) throw new Error(`missing row ${teamId}`)
  return r
}

// Golden card (spec §20.2): 3 holes, A plays scratch, B plays off 4, so B
// receives 2 strokes on SI 1 and 1 stroke on SI 2 and SI 3.
const goldenHoles = mkHoles(3)
const goldenTeams = (): BestBallInput['teams'] => [
  {
    teamId: 'T1',
    entityStatus: 'active',
    members: [
      {
        participantId: 'A',
        playingHandicap: 0,
        scores: [
          complete('A', 'h1', 4),
          complete('A', 'h2', 5),
          complete('A', 'h3', 3),
        ],
      },
      {
        participantId: 'B',
        playingHandicap: 4,
        scores: [
          complete('B', 'h1', 5),
          complete('B', 'h2', 5),
          complete('B', 'h3', 6),
        ],
      },
    ],
  },
]

describe('golden: two-person gross and net best ball, selected partner differs after strokes (spec §20.2, §8.3)', () => {
  it('gross best ball selects A on every hole (ties break by participantId)', () => {
    const teams = goldenTeams()
    const input: BestBallInput = {
      holes: goldenHoles,
      metric: 'gross',
      bestK: 1,
      teams,
      phase: 'final',
    }
    // Purity: the engine must not mutate its snapshot inputs.
    Object.freeze(input.holes)
    for (const t of teams) {
      Object.freeze(t.members)
      for (const m of t.members) Object.freeze(m.scores)
    }
    const result = calculateBestBall(input)

    expect(teamHole(result, 'T1', 'h1')).toEqual({
      teamId: 'T1',
      holeId: 'h1',
      teamScore: 4,
      contributorIds: ['A'],
      provisional: false,
      status: 'complete',
    })
    // h2 is a gross tie 5/5: deterministic contributor by participantId.
    expect(teamHole(result, 'T1', 'h2').teamScore).toBe(5)
    expect(teamHole(result, 'T1', 'h2').contributorIds).toEqual(['A'])
    expect(teamHole(result, 'T1', 'h3').contributorIds).toEqual(['A'])

    const r = row(result, 'T1')
    expect(r.total).toBe(12)
    expect(r.thru).toBe(3)
    expect(r.rank).toBe(1)
    expect(r.isTied).toBe(false)
    expect(r.status).toBe('complete')
    expect(r.provisional).toBe(false)
    expect(result.provisional).toBe(false)
    expect(result.warnings).toEqual([])
  })

  it('net best ball applies strokes before selecting: B becomes the contributor on h1 and h2', () => {
    const input: BestBallInput = {
      holes: goldenHoles,
      metric: 'net',
      bestK: 1,
      teams: goldenTeams(),
      phase: 'final',
    }
    const result = calculateBestBall(input)

    // h1: A net 4, B net 5-2=3 -> B; h2: A net 5, B net 5-1=4 -> B;
    // h3: A net 3, B net 6-1=5 -> A.
    expect(teamHole(result, 'T1', 'h1').teamScore).toBe(3)
    expect(teamHole(result, 'T1', 'h1').contributorIds).toEqual(['B'])
    expect(teamHole(result, 'T1', 'h2').teamScore).toBe(4)
    expect(teamHole(result, 'T1', 'h2').contributorIds).toEqual(['B'])
    expect(teamHole(result, 'T1', 'h3').teamScore).toBe(3)
    expect(teamHole(result, 'T1', 'h3').contributorIds).toEqual(['A'])
    expect(row(result, 'T1').total).toBe(10)
  })

  it('proves net-before-select against a wrong gross-first implementation', () => {
    // Wrong implementation: select the lowest GROSS ball (ties by id), then
    // subtract that player's strokes — exactly what spec §8.3 forbids.
    const strokes = new Map<string, Map<string, number>>([
      ['A', new Map([['h1', 0], ['h2', 0], ['h3', 0]])],
      ['B', new Map([['h1', 2], ['h2', 1], ['h3', 1]])],
    ])
    const gross = new Map<string, Map<string, number>>([
      ['A', new Map([['h1', 4], ['h2', 5], ['h3', 3]])],
      ['B', new Map([['h1', 5], ['h2', 5], ['h3', 6]])],
    ])
    const wrongGrossFirstHole = (holeId: string): number => {
      const candidates = ['A', 'B']
        .map((id) => ({ id, g: gross.get(id)?.get(holeId) ?? 0 }))
        .sort((a, b) => (a.g !== b.g ? a.g - b.g : a.id < b.id ? -1 : 1))
      const best = candidates[0]
      if (best === undefined) throw new Error('empty')
      return best.g - (strokes.get(best.id)?.get(holeId) ?? 0)
    }
    const wrongTotal =
      wrongGrossFirstHole('h1') + wrongGrossFirstHole('h2') + wrongGrossFirstHole('h3')

    const result = calculateBestBall({
      holes: goldenHoles,
      metric: 'net',
      bestK: 1,
      teams: goldenTeams(),
      phase: 'final',
    })

    // The wrong implementation picks A gross 4 on h1 and returns net 4;
    // the correct engine picks B (net 3) because strokes apply BEFORE
    // selection.
    expect(wrongGrossFirstHole('h1')).toBe(4)
    expect(teamHole(result, 'T1', 'h1').teamScore).toBe(3)
    expect(wrongTotal).toBe(12)
    expect(row(result, 'T1').total).toBe(10)
    expect(row(result, 'T1').total).not.toBe(wrongTotal)
  })
})

describe('golden: best two of four with equal contributor scores (spec §20.2, §8.3-8.4)', () => {
  it('sums the two lowest and picks contributors deterministically by (score, participantId)', () => {
    const holes = mkHoles(1)
    const result = calculateBestBall({
      holes,
      metric: 'gross',
      bestK: 2,
      teams: [
        {
          teamId: 'T1',
          entityStatus: 'active',
          members: [
            { participantId: 'p1', playingHandicap: null, scores: [complete('p1', 'h1', 5)] },
            { participantId: 'p2', playingHandicap: null, scores: [complete('p2', 'h1', 4)] },
            { participantId: 'p3', playingHandicap: null, scores: [complete('p3', 'h1', 4)] },
            { participantId: 'p4', playingHandicap: null, scores: [complete('p4', 'h1', 4)] },
          ],
        },
      ],
      phase: 'final',
    })
    const th = teamHole(result, 'T1', 'h1')
    expect(th.teamScore).toBe(8)
    // p2/p3/p4 all shot 4: the two counting members are chosen by id order.
    expect(th.contributorIds).toEqual(['p2', 'p3'])
    expect(th.status).toBe('complete')
    expect(row(result, 'T1').total).toBe(8)
  })
})

describe('partner pickup (spec §21.1, §8.3)', () => {
  it('ignores a picked-up partner when the remaining valid scores satisfy k', () => {
    const holes = mkHoles(2)
    const result = calculateBestBall({
      holes,
      metric: 'gross',
      bestK: 1,
      teams: [
        {
          teamId: 'T1',
          entityStatus: 'active',
          members: [
            {
              participantId: 'A',
              playingHandicap: null,
              scores: [complete('A', 'h1', 4), complete('A', 'h2', 5)],
            },
            {
              participantId: 'B',
              playingHandicap: null,
              scores: [
                terminal('B', 'h1', 'picked_up'),
                // Two revisions for h2: the engine must use the latest.
                complete('B', 'h2', 6, 1),
                complete('B', 'h2', 4, 2),
              ],
            },
          ],
        },
      ],
      phase: 'live',
    })
    // h1 completes through A alone even live: a pickup is terminal, not
    // pending, so it holds nothing open.
    expect(teamHole(result, 'T1', 'h1')).toEqual({
      teamId: 'T1',
      holeId: 'h1',
      teamScore: 4,
      contributorIds: ['A'],
      provisional: false,
      status: 'complete',
    })
    expect(teamHole(result, 'T1', 'h2').teamScore).toBe(4)
    expect(teamHole(result, 'T1', 'h2').contributorIds).toEqual(['B'])
    const r = row(result, 'T1')
    expect(r.total).toBe(8)
    expect(r.thru).toBe(2)
    expect(r.status).toBe('complete')
    expect(result.provisional).toBe(false)
  })
})

describe('fewer than k valid scores (spec §8.3, §6.1 incomplete policy)', () => {
  const holes = mkHoles(1)
  const bothPickedUp: BestBallInput['teams'] = [
    {
      teamId: 'T1',
      entityStatus: 'active',
      members: [
        { participantId: 'A', playingHandicap: null, scores: [terminal('A', 'h1', 'picked_up')] },
        { participantId: 'B', playingHandicap: null, scores: [terminal('B', 'h1', 'no_score')] },
      ],
    },
  ]

  it('live: hole and team are provisional, never coerced to a number', () => {
    const result = calculateBestBall({
      holes,
      metric: 'gross',
      bestK: 1,
      teams: bothPickedUp,
      phase: 'live',
    })
    expect(teamHole(result, 'T1', 'h1')).toEqual({
      teamId: 'T1',
      holeId: 'h1',
      teamScore: null,
      contributorIds: [],
      provisional: true,
      status: 'provisional',
    })
    const r = row(result, 'T1')
    expect(r.total).toBeNull()
    expect(r.thru).toBe(0)
    expect(r.rank).toBeNull()
    expect(r.status).toBe('provisional')
    expect(r.provisional).toBe(true)
    expect(result.provisional).toBe(true)
  })

  it('final: hole and team become no_return; team stays visible but unranked', () => {
    const result = calculateBestBall({
      holes,
      metric: 'gross',
      bestK: 1,
      teams: [
        ...bothPickedUp,
        {
          teamId: 'T2',
          entityStatus: 'active',
          members: [
            { participantId: 'C', playingHandicap: null, scores: [complete('C', 'h1', 4)] },
          ],
        },
      ],
      phase: 'final',
    })
    expect(teamHole(result, 'T1', 'h1').status).toBe('no_return')
    expect(teamHole(result, 'T1', 'h1').teamScore).toBeNull()
    expect(teamHole(result, 'T1', 'h1').provisional).toBe(false)
    const r1 = row(result, 'T1')
    expect(r1.status).toBe('no_return')
    expect(r1.total).toBeNull()
    expect(r1.rank).toBeNull()
    const r2 = row(result, 'T2')
    expect(r2.rank).toBe(1)
    expect(result.provisional).toBe(false)
  })

  it('live with k=2 and only one valid score: provisional while a member is still out', () => {
    const result = calculateBestBall({
      holes,
      metric: 'gross',
      bestK: 2,
      teams: [
        {
          teamId: 'T1',
          entityStatus: 'active',
          members: [
            { participantId: 'A', playingHandicap: null, scores: [complete('A', 'h1', 4)] },
            { participantId: 'B', playingHandicap: null, scores: [] },
          ],
        },
      ],
      phase: 'live',
    })
    const th = teamHole(result, 'T1', 'h1')
    expect(th.status).toBe('provisional')
    expect(th.teamScore).toBeNull()
    expect(result.provisional).toBe(true)
  })

  it('live with k satisfied but a partner still pending: tentative score, hole stays provisional', () => {
    const result = calculateBestBall({
      holes,
      metric: 'gross',
      bestK: 1,
      teams: [
        {
          teamId: 'T1',
          entityStatus: 'active',
          members: [
            { participantId: 'A', playingHandicap: null, scores: [complete('A', 'h1', 4)] },
            { participantId: 'B', playingHandicap: null, scores: [] },
          ],
        },
      ],
      phase: 'live',
    })
    const th = teamHole(result, 'T1', 'h1')
    // B could still hole out lower than 4: report the best-so-far but keep
    // the hole provisional (missing data propagates, spec §7.3).
    expect(th.teamScore).toBe(4)
    expect(th.contributorIds).toEqual(['A'])
    expect(th.status).toBe('provisional')
    const r = row(result, 'T1')
    expect(r.thru).toBe(0)
    expect(r.total).toBeNull()
    expect(r.provisional).toBe(true)
  })
})

describe('net metric with a missing handicap (spec §8.3, §21.1)', () => {
  it('excludes the member with warning NET_NO_HANDICAP once; team scores through the rest', () => {
    const holes = mkHoles(2)
    const result = calculateBestBall({
      holes,
      metric: 'net',
      bestK: 1,
      teams: [
        {
          teamId: 'T1',
          entityStatus: 'active',
          members: [
            {
              participantId: 'A',
              playingHandicap: null,
              // Lowest raw scores on both holes — must never contribute.
              scores: [complete('A', 'h1', 2), complete('A', 'h2', 2)],
            },
            {
              participantId: 'B',
              playingHandicap: 0,
              scores: [complete('B', 'h1', 4), complete('B', 'h2', 5)],
            },
          ],
        },
      ],
      phase: 'final',
    })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.code).toBe('NET_NO_HANDICAP')
    expect(result.warnings[0]?.context).toEqual({ participantId: 'A', teamId: 'T1' })
    expect(teamHole(result, 'T1', 'h1').contributorIds).toEqual(['B'])
    expect(teamHole(result, 'T1', 'h2').contributorIds).toEqual(['B'])
    expect(row(result, 'T1').total).toBe(9)
    expect(row(result, 'T1').status).toBe('complete')
  })

  it('a handicap-less member with no scores never holds the team provisional', () => {
    const holes = mkHoles(1)
    const result = calculateBestBall({
      holes,
      metric: 'net',
      bestK: 1,
      teams: [
        {
          teamId: 'T1',
          entityStatus: 'active',
          members: [
            { participantId: 'A', playingHandicap: null, scores: [] },
            { participantId: 'B', playingHandicap: 3, scores: [complete('B', 'h1', 5)] },
          ],
        },
      ],
      phase: 'live',
    })
    // B receives 3 strokes on the single competition hole: net 2.
    expect(teamHole(result, 'T1', 'h1').teamScore).toBe(2)
    expect(teamHole(result, 'T1', 'h1').status).toBe('complete')
    expect(result.provisional).toBe(false)
  })
})

describe('ranking, ties, and non-active visibility (spec §4.6, §7.3)', () => {
  it('ties share rank; withdrawn/disqualified teams stay visible but unranked', () => {
    const holes = mkHoles(1)
    const mkTeam = (
      teamId: string,
      entityStatus: BestBallInput['teams'][number]['entityStatus'],
      pid: string,
      grossStrokes: number,
    ): BestBallInput['teams'][number] => ({
      teamId,
      entityStatus,
      members: [
        { participantId: pid, playingHandicap: null, scores: [complete(pid, 'h1', grossStrokes)] },
      ],
    })
    const result = calculateBestBall({
      holes,
      metric: 'gross',
      bestK: 1,
      teams: [
        mkTeam('T1', 'active', 'a', 4),
        mkTeam('T2', 'active', 'b', 4),
        mkTeam('T3', 'withdrawn', 'c', 3),
        mkTeam('T4', 'disqualified', 'd', 5),
        mkTeam('T5', 'active', 'e', 6),
      ],
      phase: 'final',
    })
    const r1 = row(result, 'T1')
    const r2 = row(result, 'T2')
    expect(r1.rank).toBe(1)
    expect(r1.isTied).toBe(true)
    expect(r2.rank).toBe(1)
    expect(r2.isTied).toBe(true)
    expect(row(result, 'T5').rank).toBe(3)

    // The withdrawn team would have won on raw score: it is visible with its
    // total but never competitively ranked.
    const r3 = row(result, 'T3')
    expect(r3.total).toBe(3)
    expect(r3.rank).toBeNull()
    expect(r3.status).toBe('withdrawn')
    const r4 = row(result, 'T4')
    expect(r4.rank).toBeNull()
    expect(r4.status).toBe('disqualified')
  })
})

describe('input validation', () => {
  it('rejects a non-positive or fractional bestK', () => {
    const base = {
      holes: mkHoles(1),
      metric: 'gross' as const,
      teams: [] as BestBallInput['teams'],
      phase: 'final' as const,
    }
    expect(() => calculateBestBall({ ...base, bestK: 0 })).toThrow(RangeError)
    expect(() => calculateBestBall({ ...base, bestK: 1.5 })).toThrow(RangeError)
  })
})

// ── Property-based tests (spec §20.1) ───────────────────────────────────────

interface PropCard {
  n: number
  metric: 'gross' | 'net'
  members: Array<{ ph: number; grosses: number[] }>
  kSeed: number
}

const cardArb = fc.record({
  n: fc.integer({ min: 1, max: 9 }),
  metric: fc.constantFrom('gross' as const, 'net' as const),
  members: fc.array(
    fc.record({
      ph: fc.integer({ min: -5, max: 30 }),
      grosses: fc.array(fc.integer({ min: 1, max: 12 }), {
        minLength: 9,
        maxLength: 9,
      }),
    }),
    { minLength: 1, maxLength: 4 },
  ),
  kSeed: fc.integer({ min: 1, max: 4 }),
})

function buildInput(card: PropCard, bestK: number): BestBallInput {
  const holes = mkHoles(card.n)
  return {
    holes,
    metric: card.metric,
    bestK,
    teams: [
      {
        teamId: 'T1',
        entityStatus: 'active',
        members: card.members.map((m, j) => ({
          participantId: `p${j + 1}`,
          playingHandicap: card.metric === 'net' ? m.ph : null,
          scores: holes.map((h, i) => complete(`p${j + 1}`, h.id, m.grosses[i] ?? 1)),
        })),
      },
    ],
    phase: 'final',
  }
}

/** Member metric score computed independently of the engine's selection. */
function independentValue(
  card: PropCard,
  member: { ph: number; grosses: number[] },
  holeIndex: number,
  strokeIndex: number,
): number {
  const gross = member.grosses[holeIndex] ?? 1
  return card.metric === 'net'
    ? gross - strokesReceivedOnHole(member.ph, card.n, strokeIndex)
    : gross
}

describe('properties: best_k_of_m selection (spec §20.1)', () => {
  it('team hole score equals — and is never worse than — the independently computed sum of the k lowest member scores; results are idempotent', () => {
    fc.assert(
      fc.property(cardArb, (card) => {
        const k = ((card.kSeed - 1) % card.members.length) + 1
        const input = buildInput(card, k)
        const result = calculateBestBall(input)
        input.holes.forEach((h, i) => {
          const values = card.members
            .map((m) => independentValue(card, m, i, h.strokeIndex))
            .sort((a, b) => a - b)
          const independentSum = values.slice(0, k).reduce((s, v) => s + v, 0)
          const th = teamHole(result, 'T1', h.id)
          expect(th.status).toBe('complete')
          expect(th.teamScore).not.toBeNull()
          expect(th.teamScore ?? Infinity).toBeLessThanOrEqual(independentSum)
          expect(th.teamScore).toBe(independentSum)
          expect(th.contributorIds).toHaveLength(k)
        })
        // Pure function: same snapshot in, identical projection out.
        expect(calculateBestBall(input)).toEqual(result)
      }),
    )
  })

  it('k=1 complete cards: the best-ball total is never better than logic allows and never worse than any single member total', () => {
    fc.assert(
      fc.property(cardArb, (card) => {
        const input = buildInput(card, 1)
        const result = calculateBestBall(input)
        const r = row(result, 'T1')
        expect(r.status).toBe('complete')
        expect(r.provisional).toBe(false)
        expect(r.total).not.toBeNull()
        for (const m of card.members) {
          const memberTotal = input.holes.reduce(
            (sum, h, i) => sum + independentValue(card, m, i, h.strokeIndex),
            0,
          )
          expect(r.total ?? Infinity).toBeLessThanOrEqual(memberTotal)
        }
      }),
    )
  })
})
