import { describe, expect, it } from 'vitest'
import { calculateParBogey } from '../src/formats/par-bogey.ts'
import type { ParBogeyResult } from '../src/formats/par-bogey.ts'
import type { StablefordEntry } from '../src/formats/stableford.ts'
import type {
  HoleScoreStatus,
  HoleSnapshot,
  IndividualHoleScore,
} from '../src/types.ts'

// ── fixtures ────────────────────────────────────────────────────────────────

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

function row(result: ParBogeyResult, entryId: string) {
  const found = result.rows.find((r) => r.entryId === entryId)
  if (found === undefined) throw new Error(`no row for ${entryId}`)
  return found
}

// ── cumulative result with no-score holes (spec §8.12) ──────────────────────

describe('par/bogey cumulative result (spec §8.12)', () => {
  it('scores +1 better, 0 equal, -1 worse, and -1 for no-score/pickup', () => {
    const scoresA = [
      complete('h1', 3), // birdie: +1
      complete('h2', 4), // par: 0
      complete('h3', 4), // bogey: -1
      terminal('h4', 'no_score'), // -1, never 0
      terminal('h5', 'picked_up'), // -1, never 0
      complete('h6', 3), // par: 0
      complete('h7', 4), // 0
      complete('h8', 5), // 0
      complete('h9', 4), // 0
    ]
    const scoresB = PARS_9.map((par, i) =>
      complete(`h${i + 1}`, i === 0 ? par - 1 : par),
    ) // one birdie, eight pars: +1
    const result = calculateParBogey({
      holes: holes9(),
      metric: 'gross',
      entries: [entry('A', null, scoresA), entry('B', null, scoresB)],
      phase: 'final',
    })
    expect(row(result, 'A').result).toBe(1 + 0 - 1 - 1 - 1 + 0 + 0 + 0 + 0) // -2
    expect(row(result, 'B').result).toBe(1)
    expect(result.provisional).toBe(false)
    expect(result.warnings).toEqual([])
  })

  it('ranks highest cumulative result first', () => {
    const result = calculateParBogey({
      holes: holesN(3),
      metric: 'gross',
      entries: [
        entry('A', null, [complete('h1', 5), complete('h2', 5), complete('h3', 4)]), // -2
        entry('B', null, [complete('h1', 3), complete('h2', 4), complete('h3', 4)]), // +1
        entry('C', null, [complete('h1', 4), complete('h2', 4), complete('h3', 5)]), // -1
      ],
      phase: 'final',
    })
    expect(result.rows.map((r) => r.entryId)).toEqual(['B', 'C', 'A'])
    expect(row(result, 'B')).toMatchObject({ rank: 1, result: 1, status: 'complete' })
    expect(row(result, 'C')).toMatchObject({ rank: 2, result: -1 })
    expect(row(result, 'A')).toMatchObject({ rank: 3, result: -2 })
  })

  it('tied results share a rank', () => {
    const scores = () => [complete('h1', 4), complete('h2', 4)]
    const result = calculateParBogey({
      holes: holesN(2),
      metric: 'gross',
      entries: [entry('A', null, scores()), entry('B', null, scores())],
      phase: 'final',
    })
    expect(row(result, 'A')).toMatchObject({ rank: 1, isTied: true, result: 0 })
    expect(row(result, 'B')).toMatchObject({ rank: 1, isTied: true, result: 0 })
  })
})

// ── net metric (spec §8.12: compare gross or net with the target) ───────────

describe('par/bogey net metric', () => {
  it('net allocates strokes before comparing with par', () => {
    const holes = holesN(2)
    const scores = () => [entry('A', 1, [complete('h1', 5), complete('h2', 4)])]
    const gross = calculateParBogey({
      holes,
      metric: 'gross',
      entries: scores(),
      phase: 'final',
    })
    const net = calculateParBogey({
      holes,
      metric: 'net',
      entries: scores(),
      phase: 'final',
    })
    // h1 (stroke index 1 receives the single stroke): gross bogey loses,
    // net par halves.
    expect(row(gross, 'A').result).toBe(-1 + 0)
    expect(row(net, 'A').result).toBe(0 + 0)
  })

  it('net without a Playing Handicap warns and stays unranked', () => {
    const result = calculateParBogey({
      holes: holesN(1),
      metric: 'net',
      entries: [entry('A', null, [complete('h1', 4)])],
      phase: 'live',
    })
    expect(result.warnings.map((w) => w.code)).toContain('PAR_BOGEY_NET_HANDICAP_MISSING')
    expect(row(result, 'A').rank).toBeNull()
    expect(result.provisional).toBe(true)
  })
})

// ── live provisional behavior ───────────────────────────────────────────────

describe('live vs final pending holes (spec §7.3, §8.12)', () => {
  const partial = () => [
    entry('A', 0, [
      complete('h1', 3), // +1
      complete('h2', 4), // 0
      complete('h3', 4), // -1
      complete('h4', 5), // 0
    ]),
  ]

  it('live: pending holes contribute nothing and the row is provisional', () => {
    const result = calculateParBogey({
      holes: holes9(),
      metric: 'gross',
      entries: partial(),
      phase: 'live',
    })
    expect(result.provisional).toBe(true)
    expect(row(result, 'A')).toMatchObject({
      result: 0, // +1 +0 -1 +0, five holes still pending
      thru: 4,
      rank: 1, // live boards rank provisional totals
      provisional: true,
      status: 'provisional',
    })
  })

  it('final: each unreturned hole resolves to a loss of -1', () => {
    const result = calculateParBogey({
      holes: holes9(),
      metric: 'gross',
      entries: partial(),
      phase: 'final',
    })
    expect(result.provisional).toBe(false)
    expect(row(result, 'A')).toMatchObject({
      result: 0 - 5, // four played holes net 0, five unreturned at -1
      thru: 4,
      provisional: false,
      status: 'complete',
    })
  })

  it('a withdrawn entity stays visible, unranked, and never pins the board', () => {
    const result = calculateParBogey({
      holes: holes9(),
      metric: 'gross',
      entries: [
        entry('A', null, PARS_9.map((par, i) => complete(`h${i + 1}`, par))),
        entry('W', null, [complete('h1', 3)], 'withdrawn'),
      ],
      phase: 'live',
    })
    expect(result.provisional).toBe(false)
    expect(row(result, 'A')).toMatchObject({ rank: 1, result: 0 })
    expect(row(result, 'W')).toMatchObject({
      rank: null,
      status: 'withdrawn',
      result: 1, // played holes remain visible
      thru: 1,
    })
  })
})
