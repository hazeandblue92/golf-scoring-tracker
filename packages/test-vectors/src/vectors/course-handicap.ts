/**
 * Golden vectors — Course/Playing Handicap formula and .5 rounding
 * (spec §20.2 bullets 4-5; §9.3-9.4; §7.5).
 */

import { percent, rational } from '@gtt/scoring'
import type {
  CourseHandicapVector,
  PlayingHandicapRoundingVector,
} from './types.ts'

export const courseHandicapVectors: CourseHandicapVector[] = [
  {
    id: 'ch-unrounded-before-85-allowance',
    kind: 'course_handicap',
    section: '§20.2 · §9.3-9.4 · §7.5',
    description:
      'Course Handicap formula preserves the exact unrounded value before the 85% allowance',
    // HI 10.4, Slope 130, CR 71.3, par 72 (usga_whs_2024):
    //   CH_unrounded = 10.4 x (130/113) + (71.3 - 72)
    //                = (104/10)(130/113) - 7/10
    //                = 1352/113 - 7/10
    //                = (13520 - 791)/1130
    //                = 12729/1130            (~ 11.264602, irreducible)
    //   PH_unrounded = CH x 85% = (12729 x 85)/(1130 x 100)
    //                = 1081965/113000 = 216393/22600   (~ 9.574912)
    //   PH = floor(9.574912 + 0.5) = floor(10.074912) = 10
    input: {
      course: {
        handicapIndexTenths: 104,
        slopeRating: 130,
        courseRatingTenths: 713,
        par: 72,
      },
      allowance: percent(85),
      rounding: { kind: 'usga_whs_2024' },
    },
    expected: {
      courseHandicapUnrounded: { num: 12729, den: 1130 },
      playingHandicapUnrounded: { num: 216393, den: 22600 },
      playingHandicap: 10,
    },
  },
  {
    id: 'ch-usga-round-then-85-allowance',
    kind: 'course_handicap',
    section: '§20.2 · §9.3-9.4 · ADR-0005',
    description:
      'USGA order on the SAME input as ch-unrounded-before-85-allowance: rounding the Course Handicap before the 85% allowance yields 9, not 10',
    // Identical input to the vector above; only the frozen rounding profile
    // differs. This pair is the executable record of ADR-0005 — the league
    // freezes the USGA order, and the two orders genuinely disagree by a
    // stroke, so neither profile may silently stand in for the other.
    //
    //   CH_unrounded = 12729/1130          (~ 11.264602, as above)
    //   step 1: round to whole, ties up    -> 11
    //   step 2: 11 x 85% = 11 x 17/20      = 187/20  (= 9.35)
    //   step 3: round to whole, ties up    -> 9
    input: {
      course: {
        handicapIndexTenths: 104,
        slopeRating: 130,
        courseRatingTenths: 713,
        par: 72,
      },
      allowance: percent(85),
      rounding: {
        kind: 'committee_custom',
        intermediatePrecision: 0,
        tieDirection: 'up',
        stepOrder: 'round_then_allowance',
      },
    },
    expected: {
      courseHandicapUnrounded: { num: 12729, den: 1130 },
      playingHandicapUnrounded: { num: 187, den: 20 },
      playingHandicap: 9,
    },
  },
]

export const roundingVectors: PlayingHandicapRoundingVector[] = [
  {
    id: 'round-half-positive-2p5-to-3',
    kind: 'playing_handicap_rounding',
    section: '§20.2 · §7.5',
    description:
      '.5 rounding for a positive value: 2.5 rounds up toward positive infinity to 3',
    // 5/2 x 100% = 2.5 -> floor(2.5 + 0.5) = floor(3.0) = 3
    input: {
      courseHandicap: rational(5, 2),
      allowance: percent(100),
      rounding: { kind: 'usga_whs_2024' },
    },
    expected: { playingHandicap: 3 },
  },
  {
    id: 'round-half-plus-minus2p5-to-minus2',
    kind: 'playing_handicap_rounding',
    section: '§20.2 · §7.5 · §7.3',
    description:
      '.5 rounding for a plus (internally negative) value: -2.5 rounds toward positive infinity, i.e. toward zero, to -2',
    // -5/2 x 100% = -2.5 -> floor(-2.5 + 0.5) = floor(-2.0) = -2
    // (displayed as +2 by the presentation layer; internal sign stays negative)
    input: {
      courseHandicap: rational(-5, 2),
      allowance: percent(100),
      rounding: { kind: 'usga_whs_2024' },
    },
    expected: { playingHandicap: -2 },
  },
  {
    id: 'round-usga-order-plus-minus2p5-to-minus2',
    kind: 'playing_handicap_rounding',
    section: '§20.2 · §7.5 · §7.3 · ADR-0005',
    description:
      'USGA order applies its tie direction at BOTH steps: a plus (internally negative) -2.5 rounds toward positive infinity at the intermediate step too',
    // step 1: -5/2 = -2.5 is an exact tie -> ties 'up' (toward +inf) -> -2
    // step 2: -2 x 100% = -2 -> already whole -> -2
    // The intermediate step must not round away from zero for plus players;
    // that would give a plus golfer a stroke back they are not owed.
    input: {
      courseHandicap: rational(-5, 2),
      allowance: percent(100),
      rounding: {
        kind: 'committee_custom',
        intermediatePrecision: 0,
        tieDirection: 'up',
        stepOrder: 'round_then_allowance',
      },
    },
    expected: { playingHandicap: -2 },
  },
]
