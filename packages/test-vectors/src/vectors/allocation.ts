/**
 * Golden vectors — stroke allocation by stroke index
 * (spec §20.2 bullets 2-3; §9.5).
 *
 * COURSE_18 stroke indexes by hole:
 *   h01:7 h02:13 h03:17 h04:1 h05:9 h06:15 h07:5 h08:3 h09:11
 *   h10:8 h11:18 h12:14 h13:2 h14:10 h15:6 h16:16 h17:4 h18:12
 */

import { COURSE_18 } from '../holes.ts'
import type { AllocationVector } from './types.ts'

export const allocationVectors: AllocationVector[] = [
  {
    id: 'alloc-ph20-two-strokes-si-1-2',
    kind: 'allocation',
    section: '§20.2 · §9.5',
    description:
      'Playing Handicap 20 over 18 holes: two strokes on stroke indexes 1-2, one stroke on 3-18',
    // H=20, N=18: base = floor(20/18) = 1, remainder = 20 mod 18 = 2
    // strokes(hole) = 1 + (strokeIndex <= 2 ? 1 : 0)
    //   -> 2 strokes where SI is 1 (h04) or 2 (h13); 1 stroke elsewhere
    // sum check: 16 x 1 + 2 x 2 = 20
    input: { playingHandicap: 20, holes: COURSE_18 },
    expected: {
      strokesByHole: {
        h01: 1, // SI 7
        h02: 1, // SI 13
        h03: 1, // SI 17
        h04: 2, // SI 1  -> base 1 + extra 1
        h05: 1, // SI 9
        h06: 1, // SI 15
        h07: 1, // SI 5
        h08: 1, // SI 3
        h09: 1, // SI 11
        h10: 1, // SI 8
        h11: 1, // SI 18
        h12: 1, // SI 14
        h13: 2, // SI 2  -> base 1 + extra 1
        h14: 1, // SI 10
        h15: 1, // SI 6
        h16: 1, // SI 16
        h17: 1, // SI 4
        h18: 1, // SI 12
      },
    },
  },
  {
    id: 'alloc-plus2-gives-si-18-17',
    kind: 'allocation',
    section: '§20.2 · §9.5 · §7.3',
    description:
      'Plus-2 (internally -2) over 18 holes gives one stroke back on stroke indexes 18 and 17',
    // H=-2, N=18: magnitude 2, base = floor(2/18) = 0, remainder = 2
    // extra_given = strokeIndex > 18 - 2 = 16 ? 1 : 0
    //   -> -1 where SI is 17 (h03) or 18 (h11); 0 elsewhere
    // sum check: 2 x -1 = -2
    input: { playingHandicap: -2, holes: COURSE_18 },
    expected: {
      strokesByHole: {
        h01: 0,
        h02: 0,
        h03: -1, // SI 17 > 16 -> gives a stroke
        h04: 0,
        h05: 0,
        h06: 0,
        h07: 0,
        h08: 0,
        h09: 0,
        h10: 0,
        h11: -1, // SI 18 > 16 -> gives a stroke
        h12: 0,
        h13: 0,
        h14: 0,
        h15: 0,
        h16: 0,
        h17: 0,
        h18: 0,
      },
    },
  },
]
