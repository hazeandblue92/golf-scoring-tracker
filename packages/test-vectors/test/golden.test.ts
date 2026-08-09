/**
 * Golden-vector runner (spec §20.1-20.2).
 *
 * Each vector is dispatched to the engine function named by its `kind`; the
 * hand-computed `expected` value is asserted as a SUBSET of the engine
 * output: arrays must match the actual length and are compared index-wise,
 * objects assert only the keys they name, and scalars must be strictly
 * equal. §20.2 bullets that need the database layer or a later-phase engine
 * module appear as explicit skipped tests from `deferredVectors`.
 */

import { describe, expect, it } from 'vitest'
import {
  allocateStrokes,
  calculateBestBall,
  calculateMatch,
  calculateParBogey,
  calculateSkins,
  calculateStableford,
  calculateStrokePlay,
  courseHandicapUnrounded,
  foursomesTeamHandicap,
  greensomesTeamHandicap,
  matchStrokeAllocation,
  playingHandicap,
  scrambleTeamHandicap,
} from '@gtt/scoring'
import type { EngineWarning, HoleSnapshot } from '@gtt/scoring'
import { COURSE_18, COURSE_18_PAR, COURSE_9, COURSE_9_PAR, allVectors } from '../src/index.ts'
import { deferredVectors } from '../src/vectors/deferred.ts'
import type { GoldenVector } from '../src/vectors/types.ts'

// ── Subset assertion ────────────────────────────────────────────────────────

function expectSubset(actual: unknown, expected: unknown, path = '$'): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      throw new Error(`${path}: expected an array, got ${typeof actual}`)
    }
    expect(actual.length, `${path}.length`).toBe(expected.length)
    for (let i = 0; i < expected.length; i += 1) {
      expectSubset(actual[i], expected[i], `${path}[${i}]`)
    }
    return
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') {
      throw new Error(`${path}: expected an object, got ${String(actual)}`)
    }
    for (const [key, value] of Object.entries(expected)) {
      expectSubset(
        (actual as Record<string, unknown>)[key],
        value,
        `${path}.${key}`,
      )
    }
    return
  }
  expect(actual, path).toBe(expected)
}

function checkWarnings(
  warnings: readonly EngineWarning[],
  codes: string[] | undefined,
): void {
  if (codes !== undefined) {
    expect(warnings.map((w) => w.code)).toEqual(codes)
  }
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

function runVector(v: GoldenVector): void {
  switch (v.kind) {
    case 'stroke_play': {
      const result = calculateStrokePlay(v.input)
      const { warningCodes, ...subset } = v.expected
      expectSubset(result, subset)
      checkWarnings(result.warnings, warningCodes)
      return
    }
    case 'allocation': {
      const strokes = allocateStrokes(v.input.playingHandicap, v.input.holes)
      expect(Object.fromEntries(strokes)).toEqual(v.expected.strokesByHole)
      return
    }
    case 'course_handicap': {
      const ch = courseHandicapUnrounded(v.input.course)
      expect(ch).toEqual(v.expected.courseHandicapUnrounded)
      const ph = playingHandicap(ch, v.input.allowance, v.input.rounding)
      expect(ph.playingHandicapUnrounded).toEqual(
        v.expected.playingHandicapUnrounded,
      )
      expect(ph.playingHandicap).toBe(v.expected.playingHandicap)
      return
    }
    case 'playing_handicap_rounding': {
      const ph = playingHandicap(
        v.input.courseHandicap,
        v.input.allowance,
        v.input.rounding,
      )
      expect(ph.playingHandicap).toBe(v.expected.playingHandicap)
      return
    }
    case 'best_ball': {
      const result = calculateBestBall(v.input)
      expectSubset(result, v.expected)
      return
    }
    case 'stableford': {
      const result = calculateStableford(v.input)
      expectSubset(result, v.expected)
      return
    }
    case 'par_bogey': {
      const result = calculateParBogey(v.input)
      expectSubset(result, v.expected)
      return
    }
    case 'match': {
      const state = calculateMatch(v.input)
      expectSubset(state, v.expected)
      return
    }
    case 'match_allocation': {
      const { strokesA, strokesB } = matchStrokeAllocation(v.input)
      expect(Object.fromEntries(strokesA)).toEqual(v.expected.strokesA)
      expect(Object.fromEntries(strokesB)).toEqual(v.expected.strokesB)
      return
    }
    case 'skins': {
      const result = calculateSkins(v.input)
      const { warningCodes, ...subset } = v.expected
      expectSubset(result, subset)
      checkWarnings(result.warnings, warningCodes)
      return
    }
    case 'scramble_handicap': {
      const result = scrambleTeamHandicap(
        v.input.courseHandicaps,
        v.input.weights,
        v.input.rounding,
      )
      expect(result.teamPlayingHandicapUnrounded).toEqual(
        v.expected.teamPlayingHandicapUnrounded,
      )
      expect(result.teamPlayingHandicap).toBe(v.expected.teamPlayingHandicap)
      return
    }
    case 'foursomes_handicap':
    case 'greensomes_handicap': {
      const result =
        v.kind === 'foursomes_handicap'
          ? foursomesTeamHandicap(v.input.a, v.input.b, v.input.rounding)
          : greensomesTeamHandicap(v.input.a, v.input.b, v.input.rounding)
      expect(result.teamPlayingHandicapUnrounded).toEqual(
        v.expected.teamPlayingHandicapUnrounded,
      )
      expect(result.teamPlayingHandicap).toBe(v.expected.teamPlayingHandicap)
      return
    }
    default: {
      const exhaustive: never = v
      throw new Error(`unhandled vector kind: ${JSON.stringify(exhaustive)}`)
    }
  }
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe('course fixtures', () => {
  function assertCourse(holes: readonly HoleSnapshot[], par: number): void {
    let parSum = 0
    const indexes = new Set<number>()
    for (const hole of holes) {
      parSum += hole.par
      indexes.add(hole.strokeIndex)
    }
    expect(parSum).toBe(par)
    // stroke indexes are a permutation of 1..N (spec §4.3/§6.3)
    expect(indexes.size).toBe(holes.length)
    for (let i = 1; i <= holes.length; i += 1) {
      expect(indexes.has(i), `stroke index ${i} present`).toBe(true)
    }
  }

  it('18-hole layout: pars sum to 72, stroke indexes are a permutation of 1..18', () => {
    expect(COURSE_18).toHaveLength(18)
    assertCourse(COURSE_18, COURSE_18_PAR)
  })

  it('9-hole layout: pars sum to 36, stroke indexes are a permutation of 1..9', () => {
    expect(COURSE_9).toHaveLength(9)
    assertCourse(COURSE_9, COURSE_9_PAR)
  })
})

describe('golden vector integrity', () => {
  it('vector ids are unique', () => {
    const ids = allVectors.map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('deferred entries document section, reason, and phase', () => {
    expect(deferredVectors.length).toBeGreaterThan(0)
    for (const d of deferredVectors) {
      expect(d.section).toContain('§')
      expect(d.reason.length).toBeGreaterThan(0)
      expect(d.phase).toMatch(/Phase \d/)
    }
  })
})

describe('golden vectors (§20.2)', () => {
  for (const vector of allVectors) {
    it(`[${vector.kind}] ${vector.id} (${vector.section}) — ${vector.description}`, () => {
      runVector(vector)
    })
  }
})

describe('deferred §20.2 vectors (database layer / later phase)', () => {
  for (const d of deferredVectors) {
    // Documented SKIP: see src/vectors/deferred.ts for reason and phase.
    it.skip(`${d.id} (${d.section}) — ${d.title} [${d.phase}]`, () => {
      throw new Error(`deferred: ${d.reason}`)
    })
  }
})
