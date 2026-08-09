import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { calculateStrokePlay } from '../src/formats/stroke-play.ts'
import type {
  StrokePlayEntry,
  StrokePlayInput,
  StrokePlayResult,
} from '../src/formats/stroke-play.ts'
import type {
  EntityStatus,
  HoleSnapshot,
  IndividualHoleScore,
} from '../src/types.ts'

/** 18 par-4 holes, strokeIndex === ordinal, ids h1..h18. */
const holes18: HoleSnapshot[] = Array.from({ length: 18 }, (_, i) => ({
  id: `h${i + 1}`,
  ordinal: i + 1,
  par: 4,
  strokeIndex: i + 1,
}))

/** Complete card from an 18-entry gross array (index i -> hole h(i+1)). */
function card(participantId: string, grosses: readonly number[]): IndividualHoleScore[] {
  return grosses.map((g, i) => ({
    participantId,
    holeId: `h${i + 1}`,
    grossStrokes: g,
    status: 'complete' as const,
    revision: 1,
  }))
}

/** k fives then fours: total 72 + k. */
function fivesAndFours(k: number): number[] {
  return Array.from({ length: 18 }, (_, i) => (i < k ? 5 : 4))
}

function entry(
  entryId: string,
  playingHandicap: number | null,
  scores: IndividualHoleScore[],
  entityStatus: EntityStatus = 'active',
): StrokePlayEntry {
  return { entryId, entityStatus, playingHandicap, scores }
}

function run(partial: Partial<StrokePlayInput> & Pick<StrokePlayInput, 'metric' | 'entries'>): StrokePlayResult {
  return calculateStrokePlay({ holes: holes18, phase: 'final', ...partial })
}

function row(result: StrokePlayResult, entryId: string) {
  const r = result.rows.find((x) => x.entryId === entryId)
  if (r === undefined) throw new Error(`missing row ${entryId}`)
  return r
}

function holeResult(result: StrokePlayResult, entryId: string, holeId: string) {
  const hr = result.holeResults.find((x) => x.entityId === entryId && x.holeId === holeId)
  if (hr === undefined) throw new Error(`missing hole result ${entryId}/${holeId}`)
  return hr
}

describe('scratch gross golden vector (spec §20.2)', () => {
  it('scratch player, all fours on 18 par-4 holes, totals 72 and ranks first', () => {
    const result = run({
      metric: 'gross',
      entries: [entry('a', 0, card('a', fivesAndFours(0)))],
    })
    const a = row(result, 'a')
    expect(a.grossTotal).toBe(72)
    expect(a.netTotal).toBe(72)
    expect(a.thru).toBe(18)
    expect(a.rank).toBe(1)
    expect(a.isTied).toBe(false)
    expect(a.status).toBe('complete')
    expect(a.provisional).toBe(false)
    expect(a.cappedHoleIds).toEqual([])
    expect(result.provisional).toBe(false)
    expect(result.warnings).toEqual([])
    expect(result.holeResults).toHaveLength(18)
    for (const hr of result.holeResults) {
      expect(hr.gross).toBe(4)
      expect(hr.strokesReceived).toBe(0)
      expect(hr.net).toBe(4)
      expect(hr.relativeToPar).toBe(0)
      expect(hr.status).toBe('complete')
      expect(hr.provisional).toBe(false)
    }
  })
})

describe('gross vs net rank divergence (spec §8.2)', () => {
  // A: gross 80, PH 2 -> net 78. B: gross 82, PH 8 -> net 74.
  const entries = () => [
    entry('a', 2, card('a', fivesAndFours(8))),
    entry('b', 8, card('b', fivesAndFours(10))),
  ]

  it('gross metric ranks A first', () => {
    const result = run({ metric: 'gross', entries: entries() })
    expect(row(result, 'a').rank).toBe(1)
    expect(row(result, 'b').rank).toBe(2)
    expect(row(result, 'a').grossTotal).toBe(80)
    expect(row(result, 'b').grossTotal).toBe(82)
    // Net totals still populated for display under the gross metric.
    expect(row(result, 'a').netTotal).toBe(78)
    expect(row(result, 'b').netTotal).toBe(74)
  })

  it('net metric ranks B first using the frozen playing handicap', () => {
    const result = run({ metric: 'net', entries: entries() })
    expect(row(result, 'b').rank).toBe(1)
    expect(row(result, 'a').rank).toBe(2)
    expect(row(result, 'b').netTotal).toBe(74)
    expect(row(result, 'a').netTotal).toBe(78)
    // Gross totals still populated for display under the net metric.
    expect(row(result, 'a').grossTotal).toBe(80)
    expect(row(result, 'b').grossTotal).toBe(82)
  })
})

describe('plus handicap net (spec §7.3, §9.5, §21.1)', () => {
  it('plus-2 gives strokes at indexes 18 and 17; net total exceeds gross', () => {
    const result = run({
      metric: 'net',
      entries: [entry('plus', -2, card('plus', fivesAndFours(0)))],
    })
    const r = row(result, 'plus')
    expect(r.grossTotal).toBe(72)
    expect(r.netTotal).toBe(74)
    expect(r.rank).toBe(1)
    expect(holeResult(result, 'plus', 'h17').strokesReceived).toBe(-1)
    expect(holeResult(result, 'plus', 'h18').strokesReceived).toBe(-1)
    expect(holeResult(result, 'plus', 'h17').net).toBe(5)
    expect(holeResult(result, 'plus', 'h16').strokesReceived).toBe(0)
    expect(holeResult(result, 'plus', 'h16').net).toBe(4)
  })
})

describe('maximum score cap policies (spec §8.2)', () => {
  it('fixed caps the metric total, preserves entered gross, badges only capped holes', () => {
    const grosses = fivesAndFours(0)
    grosses[0] = 10 // h1: above the cap of 8
    grosses[1] = 8 // h2: exactly at the cap -> no badge
    const result = run({
      metric: 'gross',
      maximumScore: { policy: 'fixed', value: 8 },
      entries: [entry('a', 0, card('a', grosses))],
    })
    const a = row(result, 'a')
    // 16 fours + 8 + 8 = 80 (entered 82)
    expect(a.grossTotal).toBe(80)
    expect(a.cappedHoleIds).toEqual(['h1'])
    // Entered gross preserved in hole results; never silently capped.
    expect(holeResult(result, 'a', 'h1').gross).toBe(10)
    expect(holeResult(result, 'a', 'h2').gross).toBe(8)
  })

  it('par_plus_n caps at par + n', () => {
    const grosses = fivesAndFours(0)
    grosses[0] = 7 // cap is par 4 + 2 = 6
    const result = run({
      metric: 'gross',
      maximumScore: { policy: 'par_plus_n', value: 2 },
      entries: [entry('a', 0, card('a', grosses))],
    })
    const a = row(result, 'a')
    expect(a.grossTotal).toBe(74) // 17*4 + 6
    expect(a.cappedHoleIds).toEqual(['h1'])
    expect(holeResult(result, 'a', 'h1').gross).toBe(7)
  })

  it('net_double_bogey caps at par + 2 + strokes received on that hole', () => {
    const grosses = fivesAndFours(0)
    grosses[0] = 9 // PH 18 -> 1 stroke per hole -> cap 4 + 2 + 1 = 7
    const result = run({
      metric: 'net',
      maximumScore: { policy: 'net_double_bogey' },
      entries: [entry('a', 18, card('a', grosses))],
    })
    const a = row(result, 'a')
    // Capped gross 17*4 + 7 = 75; net total 75 - 18 = 57.
    expect(a.netTotal).toBe(57)
    // Non-metric gross total remains the raw entered total for display.
    expect(a.grossTotal).toBe(77)
    expect(a.cappedHoleIds).toEqual(['h1'])
    expect(holeResult(result, 'a', 'h1').gross).toBe(9)
    expect(holeResult(result, 'a', 'h1').net).toBe(8)
  })

  it('cap applies to the competition metric total only', () => {
    const grosses = fivesAndFours(0)
    grosses[0] = 10
    const result = run({
      metric: 'gross',
      maximumScore: { policy: 'fixed', value: 8 },
      entries: [entry('a', 0, card('a', grosses))],
    })
    const a = row(result, 'a')
    expect(a.grossTotal).toBe(76) // capped competition metric
    expect(a.netTotal).toBe(78) // display net stays uncapped
  })

  it('rejects a fixed policy without a value', () => {
    expect(() =>
      run({
        metric: 'gross',
        maximumScore: { policy: 'fixed' },
        entries: [entry('a', 0, card('a', fivesAndFours(0)))],
      }),
    ).toThrow(RangeError)
  })
})

describe('live provisional vs final no_return (spec §7.3, §8.1)', () => {
  const seventeenHoles = () => card('a', fivesAndFours(0)).slice(0, 17)

  it('live: pending holes rank provisionally on current totals', () => {
    const result = run({
      phase: 'live',
      metric: 'gross',
      entries: [
        entry('a', 0, seventeenHoles()),
        entry('b', 0, card('b', fivesAndFours(8))),
      ],
    })
    const a = row(result, 'a')
    expect(a.status).toBe('provisional')
    expect(a.provisional).toBe(true)
    expect(a.thru).toBe(17)
    expect(a.grossTotal).toBe(68)
    expect(a.rank).toBe(1) // provisional lead on current totals
    expect(row(result, 'b').status).toBe('complete')
    expect(row(result, 'b').provisional).toBe(false)
    expect(row(result, 'b').rank).toBe(2)
    expect(result.provisional).toBe(true)
    expect(holeResult(result, 'a', 'h18').status).toBe('not_started')
    expect(holeResult(result, 'a', 'h18').provisional).toBe(true)
    expect(holeResult(result, 'a', 'h18').gross).toBeNull()
  })

  it('final: a pending hole becomes no_return, visible but unranked', () => {
    const result = run({
      phase: 'final',
      metric: 'gross',
      entries: [
        entry('a', 0, seventeenHoles()),
        entry('b', 0, card('b', fivesAndFours(8))),
      ],
    })
    const a = row(result, 'a')
    expect(a.status).toBe('no_return')
    expect(a.rank).toBeNull()
    expect(a.provisional).toBe(false)
    expect(a.grossTotal).toBe(68) // partial total remains visible
    expect(row(result, 'b').rank).toBe(1)
    expect(result.provisional).toBe(false)
  })

  it('final: a terminal non-complete gap (pickup) becomes no_return', () => {
    const scores = seventeenHoles()
    scores.push({ participantId: 'a', holeId: 'h18', status: 'picked_up', revision: 1 })
    const result = run({
      phase: 'final',
      metric: 'gross',
      entries: [entry('a', 0, scores), entry('b', 0, card('b', fivesAndFours(8)))],
    })
    expect(row(result, 'a').status).toBe('no_return')
    expect(row(result, 'a').rank).toBeNull()
    expect(row(result, 'b').rank).toBe(1)
  })

  it('live: a pickup gap still ranks provisionally pending committee action', () => {
    const scores = seventeenHoles()
    scores.push({ participantId: 'a', holeId: 'h18', status: 'picked_up', revision: 1 })
    const result = run({
      phase: 'live',
      metric: 'gross',
      entries: [entry('a', 0, scores)],
    })
    expect(row(result, 'a').status).toBe('provisional')
    expect(row(result, 'a').provisional).toBe(true)
    expect(row(result, 'a').rank).toBe(1)
  })
})

describe('withdrawn/disqualified visibility (spec §7.3, §20.2)', () => {
  it('disqualified entry stays visible with totals but is never ranked', () => {
    const result = run({
      metric: 'gross',
      entries: [
        entry('dq', 0, card('dq', fivesAndFours(0)), 'disqualified'),
        entry('b', 0, card('b', fivesAndFours(8))),
      ],
    })
    const dq = row(result, 'dq')
    expect(dq.status).toBe('disqualified')
    expect(dq.grossTotal).toBe(72)
    expect(dq.rank).toBeNull()
    expect(dq.isTied).toBe(false)
    expect(row(result, 'b').rank).toBe(1) // lower DQ total never outranks
  })

  it('withdrawn entry stays visible and unranked', () => {
    const result = run({
      metric: 'gross',
      entries: [
        entry('wd', 0, card('wd', fivesAndFours(0)).slice(0, 9), 'withdrawn'),
        entry('b', 0, card('b', fivesAndFours(8))),
      ],
    })
    expect(row(result, 'wd').status).toBe('withdrawn')
    expect(row(result, 'wd').grossTotal).toBe(36)
    expect(row(result, 'wd').thru).toBe(9)
    expect(row(result, 'wd').rank).toBeNull()
  })
})

describe('ties share rank (spec §8.15, §4.6)', () => {
  it('equal totals share rank; next rank skips', () => {
    const result = run({
      metric: 'gross',
      entries: [
        entry('a', 0, card('a', fivesAndFours(0))),
        entry('b', 0, card('b', fivesAndFours(0))),
        entry('c', 0, card('c', fivesAndFours(2))),
      ],
    })
    expect(row(result, 'a').rank).toBe(1)
    expect(row(result, 'a').isTied).toBe(true)
    expect(row(result, 'b').rank).toBe(1)
    expect(row(result, 'b').isTied).toBe(true)
    expect(row(result, 'c').rank).toBe(3)
    expect(row(result, 'c').isTied).toBe(false)
  })
})

describe('net eligibility (spec §8.2)', () => {
  it('null handicap under net metric warns NET_NO_HANDICAP and stays unranked', () => {
    const result = run({
      metric: 'net',
      entries: [
        entry('nohcp', null, card('nohcp', fivesAndFours(0))),
        entry('scratch', 0, card('scratch', fivesAndFours(8))),
      ],
    })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.code).toBe('NET_NO_HANDICAP')
    expect(result.warnings[0]?.context).toEqual({ entryId: 'nohcp' })
    const nohcp = row(result, 'nohcp')
    expect(nohcp.rank).toBeNull()
    expect(nohcp.grossTotal).toBe(72)
    expect(nohcp.netTotal).toBeNull() // never coerced to gross
    expect(holeResult(result, 'nohcp', 'h1').net).toBeNull()
    // Explicit scratch 0 IS eligible even with the worse gross.
    const scratch = row(result, 'scratch')
    expect(scratch.rank).toBe(1)
    expect(scratch.netTotal).toBe(80)
  })

  it('null handicap under gross metric ranks normally with no warning', () => {
    const result = run({
      metric: 'gross',
      entries: [entry('nohcp', null, card('nohcp', fivesAndFours(0)))],
    })
    expect(result.warnings).toEqual([])
    expect(row(result, 'nohcp').rank).toBe(1)
    expect(row(result, 'nohcp').netTotal).toBeNull()
  })
})

describe('property: net identity over complete cards (spec §8.1)', () => {
  it('net_total === gross_total - sum(strokes received) for complete cards', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -5, max: 40 }),
        fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 18, maxLength: 18 }),
        (playingHandicap, grosses) => {
          const result = run({
            metric: 'net',
            entries: [entry('p', playingHandicap, card('p', grosses))],
          })
          const r = row(result, 'p')
          const strokesSum = result.holeResults
            .filter((hr) => hr.entityId === 'p')
            .reduce((acc, hr) => acc + hr.strokesReceived, 0)
          expect(r.grossTotal).toBe(grosses.reduce((a, b) => a + b, 0))
          expect(r.netTotal).toBe((r.grossTotal ?? 0) - strokesSum)
          // Full-round allocation hands out exactly the playing handicap.
          expect(strokesSum).toBe(playingHandicap)
          expect(r.status).toBe('complete')
        },
      ),
    )
  })
})
