/**
 * Course and Playing Handicap calculation (spec §9.3-9.4, usga_whs_2024).
 *
 * course_handicap_unrounded = handicap_index * (slope_rating / 113)
 *                             + (course_rating - par)
 * playing_handicap_unrounded = course_handicap_unrounded * allowance
 * playing_handicap = round_profile(playing_handicap_unrounded)
 *
 * Full precision is retained until the one named rounding step. Plus
 * handicaps are negative internally; an allowance reduction moves a plus
 * handicap toward zero automatically because the multiplication is signed.
 */

import {
  type Rational,
  add,
  fromTenths,
  mul,
  rational,
  roundHalfUpTowardPositiveInfinity,
  roundToDecimals,
  sub,
  toNumber,
} from '../rational.ts'
import type { RoundingProfile } from '../types.ts'

export interface CourseHandicapInput {
  /** Signed handicap index in tenths; plus handicaps negative (+2.0 -> -20). */
  handicapIndexTenths: number
  /** Published Slope Rating (55..155 for WHS profile). */
  slopeRating: number
  /** Published Course Rating in tenths, e.g. 71.3 -> 713. */
  courseRatingTenths: number
  /** Par for the rated holes. */
  par: number
}

export function courseHandicapUnrounded(input: CourseHandicapInput): Rational {
  const index = fromTenths(input.handicapIndexTenths)
  const slopeFactor = rational(input.slopeRating, 113)
  const ratingMinusPar = sub(
    fromTenths(input.courseRatingTenths),
    rational(input.par),
  )
  return add(mul(index, slopeFactor), ratingMinusPar)
}

export interface PlayingHandicapResult {
  playingHandicapUnrounded: Rational
  /** Final signed integer strokes received (negative = strokes given). */
  playingHandicap: number
  /** Human-auditable calculation explanation (spec §9.4). */
  explanation: string
}

export function playingHandicap(
  courseHandicap: Rational,
  allowance: Rational,
  rounding: RoundingProfile,
): PlayingHandicapResult {
  let working = courseHandicap
  if (rounding.kind === 'committee_custom' && rounding.stepOrder === 'round_then_allowance') {
    working = roundToDecimals(
      working,
      rounding.intermediatePrecision,
      rounding.tieDirection,
    )
  }
  const unrounded = mul(working, allowance)
  let final: number
  if (rounding.kind === 'usga_whs_2024') {
    final = roundHalfUpTowardPositiveInfinity(unrounded)
  } else {
    const r = roundToDecimals(unrounded, 0, rounding.tieDirection)
    final = r.num / r.den
  }
  return {
    playingHandicapUnrounded: unrounded,
    playingHandicap: final,
    explanation:
      `course_handicap=${toNumber(courseHandicap).toFixed(6)} x ` +
      `allowance=${toNumber(allowance).toFixed(4)} -> ` +
      `unrounded=${toNumber(unrounded).toFixed(6)} -> ` +
      `playing_handicap=${final} (${rounding.kind})`,
  }
}
