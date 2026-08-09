import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { calculateSkins } from '../src/formats/skins.ts'
import type {
  SkinsEntry,
  SkinsEntryHole,
  SkinsInput,
  SkinsHoleOutcome,
  SkinsResult,
} from '../src/formats/skins.ts'
import type { HoleSnapshot, SkinsRules } from '../src/types.ts'

// ── fixtures ────────────────────────────────────────────────────────────────

function holes(n: number): HoleSnapshot[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `h${i + 1}`,
    ordinal: i + 1,
    par: 4,
    strokeIndex: i + 1,
  }))
}

/**
 * Per-hole cell aligned with holes h1..hn:
 *  number  -> complete metric score
 *  null    -> required score still missing (blocks the hole)
 *  'X'     -> terminal (pickup/no-score under the frozen rule; cannot win)
 *  object  -> explicit SkinsEntryHole fields (e.g. terminal with a score)
 */
type Cell = number | null | 'X' | { score: number | null; terminal: boolean }

function cellToHole(holeId: string, cell: Cell): SkinsEntryHole {
  if (cell === 'X') return { holeId, score: null, terminal: true }
  if (cell === null) return { holeId, score: null, terminal: false }
  if (typeof cell === 'number') return { holeId, score: cell, terminal: false }
  return { holeId, score: cell.score, terminal: cell.terminal }
}

function entry(entityId: string, cells: Cell[], eligible = true): SkinsEntry {
  return {
    entityId,
    eligible,
    holeScores: cells.map((cell, i) => cellToHole(`h${i + 1}`, cell)),
  }
}

function baseRules(overrides: Partial<SkinsRules> = {}): SkinsRules {
  return {
    population: 'field',
    carryMode: 'carry_forward',
    unitsPerHole: 1,
    finalCarry: 'expire',
    fractionalUnits: false,
    ...overrides,
  }
}

function run(
  entries: SkinsEntry[],
  overrides: Partial<SkinsRules> = {},
  phase: 'live' | 'final' = 'final',
  holeCount?: number,
): SkinsResult {
  const n = holeCount ?? maxCells(entries)
  const input: SkinsInput = {
    holes: holes(n),
    entries,
    rules: baseRules(overrides),
    phase,
  }
  return calculateSkins(input)
}

function maxCells(entries: SkinsEntry[]): number {
  return Math.max(...entries.map((e) => e.holeScores.length))
}

function outcome(result: SkinsResult, holeId: string): SkinsHoleOutcome {
  const found = result.holeOutcomes.find((o) => o.holeId === holeId)
  if (found === undefined) throw new Error(`no outcome for ${holeId}`)
  return found
}

function units(result: SkinsResult, entityId: string): number {
  const found = result.totals.find((t) => t.entityId === entityId)
  if (found === undefined) throw new Error(`no total for ${entityId}`)
  return found.units
}

function warningCodes(result: SkinsResult): string[] {
  return result.warnings.map((w) => w.code)
}

// ── §20.2 goldens ───────────────────────────────────────────────────────────

describe('golden: unique low wins a hole (spec §8.7, §20.2)', () => {
  it('awards the whole pool to the sole lowest score', () => {
    const result = run([entry('A', [3]), entry('B', [4]), entry('C', [5])])
    expect(outcome(result, 'h1')).toEqual({
      holeId: 'h1',
      status: 'won',
      winnerId: 'A',
      unitsAwarded: 1,
      poolCarriedIn: 0,
    })
    expect(units(result, 'A')).toBe(1)
    expect(units(result, 'B')).toBe(0)
    expect(units(result, 'C')).toBe(0)
    expect(result.unawardedUnits).toBe(0)
    expect(result.provisional).toBe(false)
    expect(result.warnings).toEqual([])
  })
})

describe('golden: tie carries the pool (spec §8.7, §20.2)', () => {
  it('carries a tied pool into the next hole under carry_forward', () => {
    const result = run([entry('A', [4, 3]), entry('B', [4, 4])])
    expect(outcome(result, 'h1')).toEqual({
      holeId: 'h1',
      status: 'carried',
      winnerId: null,
      unitsAwarded: 0,
      poolCarriedIn: 0,
    })
    expect(outcome(result, 'h2')).toEqual({
      holeId: 'h2',
      status: 'won',
      winnerId: 'A',
      unitsAwarded: 2,
      poolCarriedIn: 1,
    })
    expect(units(result, 'A')).toBe(2)
    expect(units(result, 'B')).toBe(0)
    expect(result.unawardedUnits).toBe(0)
  })
})

describe('golden: multi-hole carry then win (spec §8.7, §20.2)', () => {
  it('accumulates the pool across ties and pays it all to the next winner', () => {
    const result = run([
      entry('A', [4, 3, 5, 3]),
      entry('B', [4, 3, 5, 4]),
      entry('C', [5, 3, 5, 6]),
    ])
    expect(result.holeOutcomes.map((o) => o.status)).toEqual([
      'carried',
      'carried',
      'carried',
      'won',
    ])
    expect(result.holeOutcomes.map((o) => o.poolCarriedIn)).toEqual([0, 1, 2, 3])
    expect(outcome(result, 'h4')).toMatchObject({
      winnerId: 'A',
      unitsAwarded: 4,
    })
    expect(units(result, 'A')).toBe(4)
    expect(result.unawardedUnits).toBe(0)
  })
})

describe('golden: final unresolved carry under expire (spec §8.7, §20.2)', () => {
  it('keeps the carried pool visible as unawarded units', () => {
    const result = run([entry('A', [3, 4]), entry('B', [3, 4])])
    expect(result.holeOutcomes.map((o) => o.status)).toEqual([
      'carried',
      'carried',
    ])
    expect(units(result, 'A')).toBe(0)
    expect(units(result, 'B')).toBe(0)
    expect(result.unawardedUnits).toBe(2)
    expect(result.provisional).toBe(false)
    expect(result.warnings).toEqual([])
  })
})

// ── carry modes ─────────────────────────────────────────────────────────────

describe('no_carry mode (spec §8.7)', () => {
  it('expires each tied pool instead of carrying it', () => {
    const result = run(
      [entry('A', [4, 3, 4]), entry('B', [4, 4, 4])],
      { carryMode: 'no_carry' },
    )
    expect(result.holeOutcomes.map((o) => o.status)).toEqual([
      'expired',
      'won',
      'expired',
    ])
    // The pool never accumulates: the h2 win is worth exactly one unit.
    expect(outcome(result, 'h2')).toMatchObject({
      winnerId: 'A',
      unitsAwarded: 1,
      poolCarriedIn: 0,
    })
    expect(units(result, 'A')).toBe(1)
    expect(result.unawardedUnits).toBe(2)
  })
})

describe('split_tied mode (spec §8.7)', () => {
  it('splits an evenly divisible pool when fractionalUnits is enabled', () => {
    const result = run(
      [entry('A', [4]), entry('B', [4]), entry('C', [5])],
      { carryMode: 'split_tied', fractionalUnits: true, unitsPerHole: 2 },
    )
    expect(outcome(result, 'h1')).toEqual({
      holeId: 'h1',
      status: 'split',
      winnerId: null,
      unitsAwarded: 1,
      poolCarriedIn: 0,
    })
    expect(units(result, 'A')).toBe(1)
    expect(units(result, 'B')).toBe(1)
    expect(units(result, 'C')).toBe(0)
    expect(result.unawardedUnits).toBe(0)
    expect(result.warnings).toEqual([])
  })

  it('expires with SKINS_SPLIT_UNAVAILABLE when the pool does not divide', () => {
    const result = run(
      [entry('A', [4]), entry('B', [4])],
      { carryMode: 'split_tied', fractionalUnits: true, unitsPerHole: 1 },
    )
    expect(outcome(result, 'h1').status).toBe('expired')
    expect(result.unawardedUnits).toBe(1)
    expect(warningCodes(result)).toEqual(['SKINS_SPLIT_UNAVAILABLE'])
  })

  it('expires with SKINS_SPLIT_UNAVAILABLE when fractionalUnits is off', () => {
    const result = run(
      [entry('A', [4]), entry('B', [4])],
      { carryMode: 'split_tied', fractionalUnits: false, unitsPerHole: 2 },
    )
    expect(outcome(result, 'h1').status).toBe('expired')
    expect(result.unawardedUnits).toBe(2)
    expect(warningCodes(result)).toEqual(['SKINS_SPLIT_UNAVAILABLE'])
  })
})

// ── final carry policies ────────────────────────────────────────────────────

describe('finalCarry award_last_unique_winner (spec §8.7)', () => {
  it('appends the final carried pool to the most recent unique winner', () => {
    const result = run(
      [entry('A', [3, 4, 4]), entry('B', [4, 4, 4])],
      { finalCarry: 'award_last_unique_winner' },
    )
    expect(result.holeOutcomes.map((o) => o.status)).toEqual([
      'won',
      'carried',
      'carried',
    ])
    // 1 unit won on h1 plus the 2-unit final carry.
    expect(units(result, 'A')).toBe(3)
    expect(units(result, 'B')).toBe(0)
    expect(result.unawardedUnits).toBe(0)
    // Hole outcomes are not rewritten by the final award.
    expect(outcome(result, 'h1').unitsAwarded).toBe(1)
    expect(result.warnings).toEqual([])
  })

  it('expires with a warning when no hole had a unique winner', () => {
    const result = run(
      [entry('A', [4, 4]), entry('B', [4, 4])],
      { finalCarry: 'award_last_unique_winner' },
    )
    expect(units(result, 'A')).toBe(0)
    expect(units(result, 'B')).toBe(0)
    expect(result.unawardedUnits).toBe(2)
    expect(warningCodes(result)).toEqual(['SKINS_NO_UNIQUE_WINNER'])
  })
})

describe('finalCarry split_final_tied (spec §8.7)', () => {
  it('splits the final pool among the last hole\'s tied lows when whole units result', () => {
    const result = run(
      [entry('A', [4, 4]), entry('B', [4, 4]), entry('C', [5, 5])],
      { finalCarry: 'split_final_tied' },
    )
    expect(units(result, 'A')).toBe(1)
    expect(units(result, 'B')).toBe(1)
    expect(units(result, 'C')).toBe(0)
    expect(result.unawardedUnits).toBe(0)
    expect(result.warnings).toEqual([])
  })

  it('expires with SKINS_SPLIT_UNAVAILABLE when whole units are impossible', () => {
    const result = run(
      [entry('A', [4, 4, 4]), entry('B', [4, 4, 4])],
      { finalCarry: 'split_final_tied' },
    )
    // 3 carried units cannot divide into whole units between 2 tied lows.
    expect(units(result, 'A')).toBe(0)
    expect(units(result, 'B')).toBe(0)
    expect(result.unawardedUnits).toBe(3)
    expect(warningCodes(result)).toEqual(['SKINS_SPLIT_UNAVAILABLE'])
  })

  it('expires with a warning when the final hole had no winnable score', () => {
    const result = run(
      [entry('A', [4, 'X']), entry('B', [4, 'X'])],
      { finalCarry: 'split_final_tied' },
    )
    expect(result.holeOutcomes.map((o) => o.status)).toEqual([
      'carried',
      'carried',
    ])
    expect(result.unawardedUnits).toBe(2)
    expect(warningCodes(result)).toEqual(['SKINS_SPLIT_UNAVAILABLE'])
  })
})

describe('finalCarry sudden_death (spec §8.7)', () => {
  it('leaves the pool unawarded pending manual Committee resolution', () => {
    const result = run(
      [entry('A', [4, 4]), entry('B', [4, 4])],
      { finalCarry: 'sudden_death' },
    )
    expect(result.unawardedUnits).toBe(2)
    expect(warningCodes(result)).toEqual(['SKINS_SUDDEN_DEATH_PENDING'])
    expect(result.provisional).toBe(false)
  })
})

// ── provisional propagation (spec §21.1) ────────────────────────────────────

describe('provisional propagation when a required score is missing', () => {
  it('marks the incomplete hole and every later hole provisional', () => {
    const result = run(
      [entry('A', [4, null, 3]), entry('B', [4, 4, 5])],
      {},
      'live',
    )
    expect(result.holeOutcomes).toEqual([
      { holeId: 'h1', status: 'carried', winnerId: null, unitsAwarded: 0, poolCarriedIn: 0 },
      { holeId: 'h2', status: 'provisional', winnerId: null, unitsAwarded: 0, poolCarriedIn: 1 },
      { holeId: 'h3', status: 'provisional', winnerId: null, unitsAwarded: 0, poolCarriedIn: 0 },
    ])
    expect(units(result, 'A')).toBe(0)
    expect(units(result, 'B')).toBe(0)
    // finalCarry never runs on an unknowable pool: nothing expires either.
    expect(result.unawardedUnits).toBe(0)
    expect(result.provisional).toBe(true)
    expect(result.warnings).toEqual([])
  })

  it('treats a hole with no recorded fact for an eligible entity as missing', () => {
    // A has facts only for h1; h2 has no row at all.
    const result = run(
      [entry('A', [4]), entry('B', [4, 3])],
      {},
      'live',
      2,
    )
    expect(outcome(result, 'h2').status).toBe('provisional')
    expect(result.provisional).toBe(true)
  })

  it('warns SKINS_FINAL_INCOMPLETE when finalized with missing scores', () => {
    const result = run([entry('A', [null]), entry('B', [4])], {}, 'final')
    expect(result.provisional).toBe(true)
    expect(warningCodes(result)).toEqual(['SKINS_FINAL_INCOMPLETE'])
  })
})

// ── terminal holes (spec §8.7 frozen-rule exclusion) ────────────────────────

describe('terminal pickup cannot win but does not block completeness', () => {
  it('resolves the hole and awards to the low among non-terminal entities', () => {
    const result = run([entry('A', ['X']), entry('B', [5]), entry('C', [6])])
    expect(outcome(result, 'h1')).toMatchObject({
      status: 'won',
      winnerId: 'B',
      unitsAwarded: 1,
    })
    expect(result.provisional).toBe(false)
  })

  it('never awards to a terminal hole even if a lower score was recorded', () => {
    const result = run([
      entry('A', [{ score: 3, terminal: true }]),
      entry('B', [5]),
    ])
    expect(outcome(result, 'h1')).toMatchObject({ status: 'won', winnerId: 'B' })
  })

  it('carries the pool when every entity is terminal on a hole', () => {
    const result = run([entry('A', ['X', 4]), entry('B', ['X', 5])])
    expect(outcome(result, 'h1').status).toBe('carried')
    expect(outcome(result, 'h2')).toMatchObject({
      status: 'won',
      winnerId: 'A',
      unitsAwarded: 2,
    })
  })
})

// ── eligibility and ordering ────────────────────────────────────────────────

describe('eligibility and hole order (spec §8.7)', () => {
  it('excludes ineligible entries entirely, even with the lowest scores', () => {
    const result = run([
      entry('A', [4, 4]),
      entry('B', [5, 5]),
      entry('C', [1, null], false),
    ])
    expect(outcome(result, 'h1')).toMatchObject({ status: 'won', winnerId: 'A' })
    // C's missing h2 score does not block completeness either.
    expect(outcome(result, 'h2')).toMatchObject({ status: 'won', winnerId: 'A' })
    expect(result.provisional).toBe(false)
    expect(result.totals.map((t) => t.entityId)).toEqual(['A', 'B'])
  })

  it('processes holes in published ordinal order regardless of array order', () => {
    const shuffled: HoleSnapshot[] = [
      { id: 'h2', ordinal: 2, par: 4, strokeIndex: 2 },
      { id: 'h1', ordinal: 1, par: 4, strokeIndex: 1 },
    ]
    const result = calculateSkins({
      holes: shuffled,
      entries: [entry('A', [4, 3]), entry('B', [4, 4])],
      rules: baseRules(),
      phase: 'final',
    })
    expect(result.holeOutcomes.map((o) => o.holeId)).toEqual(['h1', 'h2'])
    // h1 ties and carries into h2, which A wins for 2 units.
    expect(outcome(result, 'h2')).toMatchObject({
      winnerId: 'A',
      unitsAwarded: 2,
      poolCarriedIn: 1,
    })
  })
})

// ── input validation ────────────────────────────────────────────────────────

describe('input validation', () => {
  it('rejects a non-positive or fractional unitsPerHole', () => {
    expect(() => run([entry('A', [4])], { unitsPerHole: 0 })).toThrow(RangeError)
    expect(() => run([entry('A', [4])], { unitsPerHole: 1.5 })).toThrow(RangeError)
  })

  it('rejects non-integer scores', () => {
    expect(() => run([entry('A', [4.5])])).toThrow(RangeError)
  })

  it('rejects duplicate hole ids', () => {
    const dup: HoleSnapshot[] = [
      { id: 'h1', ordinal: 1, par: 4, strokeIndex: 1 },
      { id: 'h1', ordinal: 2, par: 4, strokeIndex: 2 },
    ]
    expect(() =>
      calculateSkins({
        holes: dup,
        entries: [entry('A', [4])],
        rules: baseRules(),
        phase: 'final',
      }),
    ).toThrow(RangeError)
  })

  it('rejects duplicate eligible entity ids', () => {
    expect(() => run([entry('A', [4]), entry('A', [5])])).toThrow(RangeError)
  })
})

// ── unit conservation property ──────────────────────────────────────────────

type PropCell = number | null | 'X'

const cellArb: fc.Arbitrary<PropCell> = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 1, max: 6 }) as fc.Arbitrary<PropCell> },
  { weight: 1, arbitrary: fc.constant<PropCell>(null) },
  { weight: 1, arbitrary: fc.constant<PropCell>('X') },
)

const scenarioArb = fc.record({
  holeCount: fc.integer({ min: 1, max: 9 }),
  entityCount: fc.integer({ min: 1, max: 4 }),
  cells: fc.array(fc.array(cellArb, { minLength: 9, maxLength: 9 }), {
    minLength: 4,
    maxLength: 4,
  }),
  eligibleFlags: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
  carryMode: fc.constantFrom<SkinsRules['carryMode']>(
    'carry_forward',
    'no_carry',
    'split_tied',
  ),
  finalCarry: fc.constantFrom<SkinsRules['finalCarry']>(
    'expire',
    'award_last_unique_winner',
    'split_final_tied',
    'sudden_death',
  ),
  fractionalUnits: fc.boolean(),
  unitsPerHole: fc.integer({ min: 1, max: 3 }),
  phase: fc.constantFrom<'live' | 'final'>('live', 'final'),
})

function scenarioToInput(s: {
  holeCount: number
  entityCount: number
  cells: PropCell[][]
  eligibleFlags: boolean[]
  carryMode: SkinsRules['carryMode']
  finalCarry: SkinsRules['finalCarry']
  fractionalUnits: boolean
  unitsPerHole: number
  phase: 'live' | 'final'
}): SkinsInput {
  const entries: SkinsEntry[] = Array.from(
    { length: s.entityCount },
    (_, e) => {
      const row = s.cells[e]
      if (row === undefined) throw new Error('cells row missing')
      return entry(
        `E${e + 1}`,
        row.slice(0, s.holeCount),
        s.eligibleFlags[e] ?? true,
      )
    },
  )
  return {
    holes: holes(s.holeCount),
    entries,
    rules: {
      population: 'field',
      carryMode: s.carryMode,
      finalCarry: s.finalCarry,
      fractionalUnits: s.fractionalUnits,
      unitsPerHole: s.unitsPerHole,
    },
    phase: s.phase,
  }
}

describe('unit conservation property (spec §7.3, §8.7)', () => {
  it('totals + unawarded + still-carried pool == resolved holes * unitsPerHole', () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const input = scenarioToInput(s)
        const result = calculateSkins(input)

        const firstProvisional = result.holeOutcomes.findIndex(
          (o) => o.status === 'provisional',
        )
        const resolvedHoles =
          firstProvisional === -1 ? s.holeCount : firstProvisional
        const provisionalHead =
          firstProvisional === -1
            ? null
            : result.holeOutcomes[firstProvisional]
        const stillCarried = provisionalHead?.poolCarriedIn ?? 0

        const totalUnits = result.totals.reduce((sum, t) => sum + t.units, 0)
        expect(totalUnits + result.unawardedUnits + stillCarried).toBe(
          resolvedHoles * s.unitsPerHole,
        )

        // Integers only, never negative, never NaN (spec §7.3).
        for (const t of result.totals) {
          expect(Number.isInteger(t.units)).toBe(true)
          expect(t.units).toBeGreaterThanOrEqual(0)
        }
        expect(Number.isInteger(result.unawardedUnits)).toBe(true)
        expect(result.unawardedUnits).toBeGreaterThanOrEqual(0)
        for (const o of result.holeOutcomes) {
          expect(Number.isInteger(o.unitsAwarded)).toBe(true)
          expect(o.unitsAwarded).toBeGreaterThanOrEqual(0)
          expect(Number.isInteger(o.poolCarriedIn)).toBe(true)
          expect(o.poolCarriedIn).toBeGreaterThanOrEqual(0)
        }

        // Once provisional, every later hole is provisional too.
        if (firstProvisional !== -1) {
          for (const o of result.holeOutcomes.slice(firstProvisional)) {
            expect(o.status).toBe('provisional')
          }
          expect(result.provisional).toBe(true)
        }

        // Pure function: identical input reproduces identical output.
        expect(calculateSkins(input)).toEqual(result)
      }),
      { numRuns: 300 },
    )
  })
})
