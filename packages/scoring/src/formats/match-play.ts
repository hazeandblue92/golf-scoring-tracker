/**
 * Match play (spec §8.6).
 *
 * Two sides ('a' and 'b') compare the configured gross/net score hole by
 * hole in the competition's published play order. Lower wins the hole; equal
 * halves. Cumulative holes_up = wins_a - wins_b.
 *
 *   - In progress: 'AS', 'A 1 UP', 'B 2 UP'.
 *   - Won the moment abs(holes_up) > holes_remaining: 'A wins X & Y' with
 *     X = abs(holes_up) and Y = holes_remaining at the clinch.
 *   - Regulation end at zero difference: 'halved' by default; when extra
 *     holes are allowed the match stays 'in_progress' ('AS after regulation').
 *   - A conceded hole is awarded to the receiving side WITHOUT inventing a
 *     numeric stroke score (spec §8.6).
 *   - A conceded match stores the concession and terminal status; it
 *     terminates the match immediately.
 *   - Dormie (lead equals holes remaining) is display-only and never ends
 *     the match (spec §8.6).
 *
 * Missing data propagates, never coerces (spec §7.3): a hole with either
 * side's score null and no concession is undetermined. Other determined holes
 * still count, because shotgun/back-nine starts may record later course
 * ordinals before earlier ones; a missing ordinal is not proof that play
 * stopped. Holes after an early clinch carry winner null: they are not part of
 * the match, although simultaneous stroke/skins competitions may still require
 * them (spec §21.1).
 *
 * Handicap match play (spec §8.6, §9.4-9.5): strokes are normalized from the
 * LOWEST unrounded Course Handicap — correct for negative internal plus
 * handicaps because the comparison is signed. Each side's exact rational
 * difference from the low CH takes the match allowance (USGA four-ball
 * default 90%), rounds once at the final step under the selected profile,
 * and the side left with a positive relative Playing Handicap receives
 * strokes by stroke index; the low side receives a zero map. Extra holes
 * reuse the same per-hole allocation: an extra hole is a replay of a
 * regulation hole, and the maps are keyed by hole id (a repeat of the
 * regulation stroke-index allocation, spec §9.5 repeat policy).
 */

import type { HoleSnapshot, RoundingProfile } from '../types.ts'
import { type Rational, compare, sub } from '../rational.ts'
import { playingHandicap } from '../handicap/course-handicap.ts'
import { allocateStrokes } from '../handicap/allocation.ts'

// ── Match state calculation ─────────────────────────────────────────────────

export interface MatchHoleInput {
  holeId: string
  /** Side A's comparison score (gross or net per rules); null = not entered. */
  a: number | null
  /** Side B's comparison score; null = not entered. */
  b: number | null
  /** Hole conceded to the named side; awarded without a numeric score. */
  concession?: 'to_a' | 'to_b'
}

export interface MatchInput {
  /** Regulation holes in the competition's published play order. */
  holes: HoleSnapshot[]
  /** Aligned with `holes` by holeId; array order is irrelevant. */
  holeInputs: MatchHoleInput[]
  /** A concession of the whole match; terminates it immediately. */
  matchConcession?: { winner: 'a' | 'b' }
  /** Continue past a level regulation finish instead of halving. */
  extraHolesAllowed: boolean
}

export interface MatchHoleOutcome {
  holeId: string
  /** null = undetermined, or not part of the match after a clinch. */
  winner: 'a' | 'b' | 'half' | null
}

export interface MatchState {
  status: 'in_progress' | 'won' | 'halved' | 'conceded'
  winner: 'a' | 'b' | null
  /** Cumulative wins_a - wins_b over determined holes. */
  holesUp: number
  /** Holes not yet determined (frozen at the clinch for a won match). */
  holesRemaining: number
  display: string
  /** Display-only: leader's lead equals holes remaining. Never ends a match. */
  dormie: boolean
  /** One outcome per regulation hole, in play order. */
  outcomes: MatchHoleOutcome[]
}

const SIDE_LABEL = { a: 'A', b: 'B' } as const

function validateSideScore(holeId: string, side: 'a' | 'b', value: number | null): void {
  if (value === null) return
  // This is the configured comparison score, not necessarily raw gross. A
  // legitimate net value can be zero or negative when a side receives several
  // relative match strokes on a low gross score.
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `hole '${holeId}' side ${SIDE_LABEL[side]}: comparison must be an integer or null, got ${value}`,
    )
  }
}

/** Outcome of a single hole; null when undetermined. */
function holeWinner(input: MatchHoleInput | undefined): 'a' | 'b' | 'half' | null {
  if (input === undefined) return null
  // A concession decides the hole without any numeric score being invented;
  // an actual holed-out score may coexist (e.g. A holes out, B concedes).
  if (input.concession === 'to_a') return 'a'
  if (input.concession === 'to_b') return 'b'
  if (input.a === null || input.b === null) return null
  if (input.a < input.b) return 'a'
  if (input.b < input.a) return 'b'
  return 'half'
}

export function calculateMatch(input: MatchInput): MatchState {
  const { holes, holeInputs, matchConcession, extraHolesAllowed } = input
  if (holes.length === 0) {
    throw new RangeError('a match requires at least one hole')
  }
  const holeIds = new Set(holes.map((h) => h.id))
  if (holeIds.size !== holes.length) {
    throw new RangeError('duplicate hole ids in match hole list')
  }

  const inputByHole = new Map<string, MatchHoleInput>()
  for (const hi of holeInputs) {
    if (!holeIds.has(hi.holeId)) continue
    if (inputByHole.has(hi.holeId)) {
      throw new RangeError(`multiple match inputs for hole '${hi.holeId}'`)
    }
    validateSideScore(hi.holeId, 'a', hi.a)
    validateSideScore(hi.holeId, 'b', hi.b)
    inputByHole.set(hi.holeId, hi)
  }

  const outcomes: MatchHoleOutcome[] = []
  let winsA = 0
  let winsB = 0
  let determined = 0
  let clinched = false

  for (const hole of holes) {
    if (clinched) {
      outcomes.push({ holeId: hole.id, winner: null })
      continue
    }
    const winner = holeWinner(inputByHole.get(hole.id))
    outcomes.push({ holeId: hole.id, winner })
    if (winner === null) {
      continue
    }
    determined += 1
    if (winner === 'a') winsA += 1
    else if (winner === 'b') winsB += 1
    if (Math.abs(winsA - winsB) > holes.length - determined) {
      clinched = true
    }
  }

  const holesUp = winsA - winsB
  // Frozen at the clinch for a won match because evaluation stops there.
  const holesRemaining = holes.length - determined

  const base = { holesUp, holesRemaining, outcomes }

  if (matchConcession !== undefined) {
    // A conceded match terminates immediately with the stored concession.
    const winner = matchConcession.winner
    return {
      ...base,
      status: 'conceded',
      winner,
      display: `${SIDE_LABEL[winner]} wins (concession)`,
      dormie: false,
    }
  }

  if (clinched) {
    const winner = holesUp > 0 ? 'a' : 'b'
    return {
      ...base,
      status: 'won',
      winner,
      display: `${SIDE_LABEL[winner]} wins ${Math.abs(holesUp)} & ${holesRemaining}`,
      dormie: false,
    }
  }

  if (determined === holes.length) {
    // Regulation complete without a clinch: difference is necessarily zero
    // (any nonzero difference at the last hole satisfies abs(up) > 0).
    if (extraHolesAllowed) {
      return {
        ...base,
        status: 'in_progress',
        winner: null,
        display: 'AS after regulation',
        dormie: false,
      }
    }
    return { ...base, status: 'halved', winner: null, display: 'Halved', dormie: false }
  }

  const display =
    holesUp === 0
      ? 'AS'
      : holesUp > 0
        ? `A ${holesUp} UP`
        : `B ${-holesUp} UP`
  return {
    ...base,
    status: 'in_progress',
    winner: null,
    display,
    dormie: holesUp !== 0 && Math.abs(holesUp) === holesRemaining,
  }
}

// ── Handicap match stroke allocation ────────────────────────────────────────

export interface MatchAllocationInput {
  /** Exact unrounded Course Handicap of side A (plus handicaps negative). */
  courseHandicapA: Rational
  /** Exact unrounded Course Handicap of side B (plus handicaps negative). */
  courseHandicapB: Rational
  /** Match allowance applied to the differences, e.g. percent(90). */
  allowance: Rational
  rounding: RoundingProfile
  holes: HoleSnapshot[]
}

/**
 * Normalize from the lowest unrounded Course Handicap (spec §8.6): each
 * side's difference from min(CH_A, CH_B) is an exact Rational (zero for the
 * low side, and correct when the low side is a negative plus handicap), the
 * allowance multiplies the difference, and the one rounding step happens at
 * the end under the given profile (usga_whs_2024:
 * roundHalfUpTowardPositiveInfinity). The side with the positive rounded
 * relative handicap receives strokes by stroke index; the other side's map
 * is all zeros. Extra holes replay regulation holes and therefore reuse
 * these same per-hole allocations.
 */
export function matchStrokeAllocation(input: MatchAllocationInput): {
  strokesA: Map<string, number>
  strokesB: Map<string, number>
} {
  const { courseHandicapA, courseHandicapB, allowance, rounding, holes } = input
  const lowest =
    compare(courseHandicapA, courseHandicapB) <= 0 ? courseHandicapA : courseHandicapB
  const differenceA = sub(courseHandicapA, lowest)
  const differenceB = sub(courseHandicapB, lowest)
  // playingHandicap applies the allowance to the exact difference and rounds
  // once at the final step under the profile (spec §9.4); at most one of the
  // differences is nonzero, so at most one side receives strokes and
  // allocateStrokes(0, holes) is the other side's zero map.
  const relativeA = playingHandicap(differenceA, allowance, rounding).playingHandicap
  const relativeB = playingHandicap(differenceB, allowance, rounding).playingHandicap
  return {
    strokesA: allocateStrokes(relativeA, holes),
    strokesB: allocateStrokes(relativeB, holes),
  }
}
