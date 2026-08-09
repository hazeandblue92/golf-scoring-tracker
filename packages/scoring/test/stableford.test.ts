import { describe, expect, it } from 'vitest'
import { calculateStableford } from '../src/formats/stableford.ts'
import type {
  StablefordEntry,
  StablefordInput,
  StablefordResult,
} from '../src/formats/stableford.ts'
import type {
  HoleScoreStatus,
  HoleSnapshot,
  IndividualHoleScore,
  StablefordRules,
} from '../src/types.ts'

// ── fixtures ────────────────────────────────────────────────────────────────

/** Spec §8.5 standard default table by net relation to par. */
const STANDARD: StablefordRules = {
  pointsByRelation: { [-3]: 5, [-2]: 4, [-1]: 3, 0: 2, 1: 1, 2: 0 },
  floorPoints: 0,
}

const PARS_9 = [4, 4, 3, 5, 4, 3, 4, 5, 4]

function holes9(): HoleSnapshot[] {
  return PARS_9.map((par, i) => ({
    id: `h${i + 1}`,
    ordinal: i + 1,
    par,
    strokeIndex: i + 1,
  }))
}

function holesN(n: number, par = 4): HoleSnapshot[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `h${i + 1}`,
    ordinal: i + 1,
    par,
    strokeIndex: i + 1,
  }))
}

function complete(holeId: string, grossStrokes: number): IndividualHoleScore {
  return { participantId: 'p', holeId, grossStrokes, status: 'complete', revision: 1 }
}

function terminal(holeId: string, status: HoleScoreStatus): IndividualHoleScore {
  return { participantId: 'p', holeId, status, revision: 1 }
}

function entry(
  entryId: string,
  playingHandicap: number | null,
  scores: IndividualHoleScore[],
  entityStatus: StablefordEntry['entityStatus'] = 'active',
): StablefordEntry {
  return { entryId, entityStatus, playingHandicap, scores }
}

function row(result: StablefordResult, entryId: string) {
  const found = result.rows.find((r) => r.entryId === entryId)
  if (found === undefined) throw new Error(`no row for ${entryId}`)
  return found
}

function holePoints(result: StablefordResult, entryId: string, holeId: string) {
  const found = result.holePoints.find(
    (hp) => hp.entryId === entryId && hp.holeId === holeId,
  )
  if (found === undefined) throw new Error(`no hole points for ${entryId}/${holeId}`)
  return found
}

// ── standard table golden (§20.2: standard Stableford including pickup) ─────

describe('standard net Stableford with pickup (spec §8.5, golden §20.2)', () => {
  // PH 9 over 9 holes: one stroke on every hole.
  const grossA = [5, 4, 3, 8, null, 2, 7, 3, 4] // null = pickup on h5
  const scoresA = grossA.map((g, i) =>
    g === null ? terminal(`h${i + 1}`, 'picked_up') : complete(`h${i + 1}`, g),
  )
  const input: StablefordInput = {
    holes: holes9(),
    metric: 'net',
    rules: STANDARD,
    entries: [
      entry('A', 9, scoresA),
      entry('B', 0, PARS_9.map((par, i) => complete(`h${i + 1}`, par))),
    ],
    phase: 'final',
  }
  const result = calculateStableford(input)

  it('awards the default table by net relation to par', () => {
    // net relations: 0,-1,-1,+2,PU,-2,+2,-3,-1 -> 2,3,3,0,0,4,0,5,3 = 20
    const perHole = holes9().map((h) => holePoints(result, 'A', h.id).points)
    expect(perHole).toEqual([2, 3, 3, 0, 0, 4, 0, 5, 3])
    expect(row(result, 'A').points).toBe(20)
    expect(row(result, 'B').points).toBe(18) // nine net pars at 2 points
  })

  it('a pickup receives the configured floor of 0 with no relation', () => {
    const pu = holePoints(result, 'A', 'h5')
    expect(pu.points).toBe(0)
    expect(pu.relation).toBeNull()
    expect(pu.provisional).toBe(false)
  })

  it('reports exact relations including the clamped double-bogey side', () => {
    expect(holePoints(result, 'A', 'h4').relation).toBe(2)
    expect(holePoints(result, 'A', 'h8').relation).toBe(-3) // net albatross -> 5
    expect(holePoints(result, 'A', 'h8').points).toBe(5)
  })

  it('ranks highest points first, complete and non-provisional', () => {
    expect(result.provisional).toBe(false)
    expect(result.warnings).toEqual([])
    expect(row(result, 'A')).toMatchObject({
      rank: 1,
      isTied: false,
      thru: 9,
      provisional: false,
      status: 'complete',
    })
    expect(row(result, 'B')).toMatchObject({ rank: 2, isTied: false, thru: 9 })
    expect(result.rows[0]?.entryId).toBe('A')
  })
})

// ── Modified Stableford: custom map with negative values ────────────────────

describe('Modified Stableford custom map with negative values (spec §8.5)', () => {
  const MODIFIED: StablefordRules = {
    pointsByRelation: { [-3]: 8, [-2]: 5, [-1]: 2, 0: 0, 1: -1, 2: -3 },
    floorPoints: -3,
  }

  it('applies any integer map including negative points', () => {
    // gross metric relations: -2, -1, 0, +1, +2, +4(clamp->2), 0, 0, 0
    const grossA = [2, 3, 3, 6, 6, 7, 4, 5, 4]
    const result = calculateStableford({
      holes: holes9(),
      metric: 'gross',
      rules: MODIFIED,
      entries: [
        entry('A', null, grossA.map((g, i) => complete(`h${i + 1}`, g))),
        entry('B', null, PARS_9.map((par, i) => complete(`h${i + 1}`, par + 1))),
      ],
      phase: 'final',
    })
    expect(row(result, 'A').points).toBe(5 + 2 + 0 - 1 - 3 - 3 + 0 + 0 + 0) // 0
    expect(row(result, 'B').points).toBe(-9) // nine bogeys at -1
    expect(row(result, 'A').rank).toBe(1) // 0 beats -9 (highest wins)
    expect(row(result, 'B').rank).toBe(2)
  })

  it('a pickup receives the configured negative floor', () => {
    const result = calculateStableford({
      holes: holesN(1),
      metric: 'gross',
      rules: MODIFIED,
      entries: [entry('A', null, [terminal('h1', 'picked_up')])],
      phase: 'final',
    })
    expect(row(result, 'A').points).toBe(-3)
  })
})

// ── gross vs net relation divergence ────────────────────────────────────────

describe('gross vs net metric (spec §8.5)', () => {
  const holes = holesN(2)
  const entries = () => [entry('A', 1, [complete('h1', 5), complete('h2', 4)])]

  it('net allocates strokes before the relation; gross compares gross', () => {
    const gross = calculateStableford({
      holes,
      metric: 'gross',
      rules: STANDARD,
      entries: entries(),
      phase: 'final',
    })
    const net = calculateStableford({
      holes,
      metric: 'net',
      rules: STANDARD,
      entries: entries(),
      phase: 'final',
    })
    // h1 (stroke index 1 receives the single stroke): gross bogey vs net par
    expect(holePoints(gross, 'A', 'h1')).toMatchObject({ relation: 1, points: 1 })
    expect(holePoints(net, 'A', 'h1')).toMatchObject({ relation: 0, points: 2 })
    expect(row(gross, 'A').points).toBe(3)
    expect(row(net, 'A').points).toBe(4)
  })
})

// ── clamp behavior at and beyond the map bounds ─────────────────────────────

describe('relation clamping to map key bounds (spec §8.5)', () => {
  it('clamps beyond-bounds relations to the edge keys', () => {
    // Relations: -4 (below min -3 -> 5) and +5 (above max 2 -> 0).
    const holes: HoleSnapshot[] = [
      { id: 'h1', ordinal: 1, par: 5, strokeIndex: 1 },
      { id: 'h2', ordinal: 2, par: 4, strokeIndex: 2 },
    ]
    const result = calculateStableford({
      holes,
      metric: 'gross',
      rules: STANDARD,
      entries: [entry('A', null, [complete('h1', 1), complete('h2', 9)])],
      phase: 'final',
    })
    expect(holePoints(result, 'A', 'h1')).toMatchObject({ relation: -4, points: 5 })
    expect(holePoints(result, 'A', 'h2')).toMatchObject({ relation: 5, points: 0 })
  })

  it('a clamped key absent from a sparse map falls back to floorPoints', () => {
    const sparse: StablefordRules = {
      pointsByRelation: { [-1]: 3, 1: 1 },
      floorPoints: 7,
    }
    const result = calculateStableford({
      holes: holesN(3),
      metric: 'gross',
      rules: sparse,
      entries: [
        entry('A', null, [
          complete('h1', 4), // relation 0: inside bounds but absent -> floor 7
          complete('h2', 1), // relation -3: clamps to -1 -> 3
          complete('h3', 8), // relation +4: clamps to +1 -> 1
        ]),
      ],
      phase: 'final',
    })
    expect(holePoints(result, 'A', 'h1').points).toBe(7)
    expect(holePoints(result, 'A', 'h2').points).toBe(3)
    expect(holePoints(result, 'A', 'h3').points).toBe(1)
    expect(row(result, 'A').points).toBe(11)
  })

  it('an empty map warns and floors every relation', () => {
    const result = calculateStableford({
      holes: holesN(1),
      metric: 'gross',
      rules: { pointsByRelation: {}, floorPoints: 0 },
      entries: [entry('A', null, [complete('h1', 3)])],
      phase: 'final',
    })
    expect(result.warnings.map((w) => w.code)).toContain('STABLEFORD_POINTS_MAP_EMPTY')
    expect(row(result, 'A').points).toBe(0)
  })
})

// ── live provisional behavior ───────────────────────────────────────────────

describe('live vs final pending holes (spec §7.3, §8.5)', () => {
  const partial = () => [
    entry('A', 0, [complete('h1', 4), complete('h2', 4), complete('h3', 3)]),
  ]

  it('live: pending holes score null points and stay provisional', () => {
    const result = calculateStableford({
      holes: holes9(),
      metric: 'net',
      rules: STANDARD,
      entries: partial(),
      phase: 'live',
    })
    expect(result.provisional).toBe(true)
    expect(row(result, 'A')).toMatchObject({
      points: 6,
      thru: 3,
      rank: 1, // live boards rank provisional totals
      provisional: true,
      status: 'provisional',
    })
    expect(holePoints(result, 'A', 'h4')).toMatchObject({
      relation: null,
      points: null,
      provisional: true,
    })
  })

  it('final: an unreturned hole resolves to the floor, not provisional', () => {
    const result = calculateStableford({
      holes: holes9(),
      metric: 'net',
      rules: STANDARD,
      entries: partial(),
      phase: 'final',
    })
    expect(result.provisional).toBe(false)
    expect(row(result, 'A')).toMatchObject({
      points: 6,
      thru: 3,
      provisional: false,
      status: 'complete',
    })
    expect(holePoints(result, 'A', 'h4')).toMatchObject({
      relation: null,
      points: 0,
      provisional: false,
    })
  })
})

// ── entity status and net handicap edge cases ───────────────────────────────

describe('entity status and warnings (spec §7.3, §20.2)', () => {
  it('a withdrawn entity stays visible, unranked, and never pins the board', () => {
    const result = calculateStableford({
      holes: holes9(),
      metric: 'net',
      rules: STANDARD,
      entries: [
        entry('A', 0, PARS_9.map((par, i) => complete(`h${i + 1}`, par))),
        entry('W', 0, [complete('h1', 4), complete('h2', 5)], 'withdrawn'),
      ],
      phase: 'live',
    })
    expect(result.provisional).toBe(false) // W's unplayed holes do not pend
    expect(row(result, 'A').rank).toBe(1)
    expect(row(result, 'W')).toMatchObject({
      rank: null,
      isTied: false,
      status: 'withdrawn',
      points: 2 + 1, // net par + net bogey still visible
      thru: 2,
    })
  })

  it('net metric without a Playing Handicap warns and never coerces to zero strokes', () => {
    const result = calculateStableford({
      holes: holesN(1),
      metric: 'net',
      rules: STANDARD,
      entries: [entry('A', null, [complete('h1', 4)])],
      phase: 'live',
    })
    expect(result.warnings.map((w) => w.code)).toContain('STABLEFORD_NET_HANDICAP_MISSING')
    expect(row(result, 'A').rank).toBeNull()
    expect(holePoints(result, 'A', 'h1').points).toBeNull()
    expect(result.provisional).toBe(true)
  })

  it('tied point totals share a rank', () => {
    const scores = () => PARS_9.map((par, i) => complete(`h${i + 1}`, par))
    const result = calculateStableford({
      holes: holes9(),
      metric: 'gross',
      rules: STANDARD,
      entries: [entry('A', null, scores()), entry('B', null, scores())],
      phase: 'final',
    })
    expect(row(result, 'A')).toMatchObject({ rank: 1, isTied: true })
    expect(row(result, 'B')).toMatchObject({ rank: 1, isTied: true })
  })
})
