/**
 * Golden vectors — match play (spec §20.2 bullet 9; §8.6; §9.5).
 *
 * COURSE_18 pars: h01:4 h02:5 h03:3 h04:4 h05:4 h06:3 h07:5 h08:4 h09:4
 * h10:4 h11:3 h12:5 h13:4 h14:4 h15:5 h16:3 h17:4 h18:4.
 */

import { percent, rational } from '@gtt/scoring'
import { COURSE_18 } from '../holes.ts'
import type { MatchAllocationVector, MatchVector } from './types.ts'

export const matchVectors: MatchVector[] = [
  {
    id: 'match-clinch-3-and-2',
    kind: 'match',
    section: '§20.2 · §8.6 · AC-FMT-004',
    description:
      'A clinches 3 & 2 on hole 16; holes 17-18 are not part of the match even when a score was entered',
    // Hole winners (lower comparison score wins, equal halves):
    //   h01 A(4<5) h02 half(5=5) h03 B(3<4) h04 half h05 A(3<4) h06 half
    //   h07 half   h08 A(4<5)    h09 B(4<5) h10 half h11 A(2<3) h12 B(5<6)
    //   h13 half   h14 A(4<5)    h15 half   h16 A(3<4)
    // Running holes_up (wins_A - wins_B) / holes remaining after each hole:
    //   h01 +1/17  h02 +1/16  h03 0/15  h04 0/14  h05 +1/13  h06 +1/12
    //   h07 +1/11  h08 +2/10  h09 +1/9  h10 +1/8  h11 +2/7   h12 +1/6
    //   h13 +1/5   h14 +2/4   h15 +2/3  h16 +3/2 -> 3 > 2 CLINCH
    // Result: A wins 3 & 2 (X = |holes_up| = 3, Y = holes remaining = 2).
    input: {
      holes: COURSE_18,
      holeInputs: [
        { holeId: 'h01', a: 4, b: 5 }, // A
        { holeId: 'h02', a: 5, b: 5 }, // half
        { holeId: 'h03', a: 4, b: 3 }, // B
        { holeId: 'h04', a: 4, b: 4 }, // half
        { holeId: 'h05', a: 3, b: 4 }, // A
        { holeId: 'h06', a: 3, b: 3 }, // half
        { holeId: 'h07', a: 5, b: 5 }, // half
        { holeId: 'h08', a: 4, b: 5 }, // A
        { holeId: 'h09', a: 5, b: 4 }, // B
        { holeId: 'h10', a: 4, b: 4 }, // half
        { holeId: 'h11', a: 2, b: 3 }, // A
        { holeId: 'h12', a: 6, b: 5 }, // B
        { holeId: 'h13', a: 4, b: 4 }, // half
        { holeId: 'h14', a: 4, b: 5 }, // A
        { holeId: 'h15', a: 5, b: 5 }, // half
        { holeId: 'h16', a: 3, b: 4 }, // A -> clinch
        // played for a simultaneous stroke/skins competition (spec §21.1),
        // but no longer part of the match:
        { holeId: 'h17', a: 4, b: 4 },
      ],
      extraHolesAllowed: false,
    },
    expected: {
      status: 'won',
      winner: 'a',
      holesUp: 3, // wins_A 6 - wins_B 3
      holesRemaining: 2, // frozen at the hole-16 clinch
      display: 'A wins 3 & 2',
      dormie: false,
      outcomes: [
        { holeId: 'h01', winner: 'a' },
        { holeId: 'h02', winner: 'half' },
        { holeId: 'h03', winner: 'b' },
        { holeId: 'h04', winner: 'half' },
        { holeId: 'h05', winner: 'a' },
        { holeId: 'h06', winner: 'half' },
        { holeId: 'h07', winner: 'half' },
        { holeId: 'h08', winner: 'a' },
        { holeId: 'h09', winner: 'b' },
        { holeId: 'h10', winner: 'half' },
        { holeId: 'h11', winner: 'a' },
        { holeId: 'h12', winner: 'b' },
        { holeId: 'h13', winner: 'half' },
        { holeId: 'h14', winner: 'a' },
        { holeId: 'h15', winner: 'half' },
        { holeId: 'h16', winner: 'a' },
        { holeId: 'h17', winner: null }, // after the clinch: not in the match
        { holeId: 'h18', winner: null },
      ],
    },
  },
  {
    id: 'match-halved-at-regulation',
    kind: 'match',
    section: '§20.2 · §8.6',
    description:
      'All 18 determined, three wins each: halved (extra holes not allowed)',
    // Winners: A on h02,h07,h15; B on h05,h11,h18; halves elsewhere.
    // Running holes_up: never exceeds +1/-1 vs holes remaining, no clinch;
    // after h17 A is 1 up with 1 to play (dormie display only), B wins h18:
    // wins_A 3 - wins_B 3 = 0 at regulation end -> Halved.
    input: {
      holes: COURSE_18,
      holeInputs: [
        { holeId: 'h01', a: 4, b: 4 }, // half
        { holeId: 'h02', a: 4, b: 5 }, // A
        { holeId: 'h03', a: 3, b: 3 }, // half
        { holeId: 'h04', a: 4, b: 4 }, // half
        { holeId: 'h05', a: 5, b: 4 }, // B
        { holeId: 'h06', a: 3, b: 3 }, // half
        { holeId: 'h07', a: 4, b: 5 }, // A
        { holeId: 'h08', a: 4, b: 4 }, // half
        { holeId: 'h09', a: 4, b: 4 }, // half
        { holeId: 'h10', a: 4, b: 4 }, // half
        { holeId: 'h11', a: 4, b: 3 }, // B
        { holeId: 'h12', a: 5, b: 5 }, // half
        { holeId: 'h13', a: 4, b: 4 }, // half
        { holeId: 'h14', a: 4, b: 4 }, // half
        { holeId: 'h15', a: 4, b: 5 }, // A
        { holeId: 'h16', a: 3, b: 3 }, // half
        { holeId: 'h17', a: 4, b: 4 }, // half
        { holeId: 'h18', a: 5, b: 4 }, // B -> level
      ],
      extraHolesAllowed: false,
    },
    expected: {
      status: 'halved',
      winner: null,
      holesUp: 0, // wins_A 3 - wins_B 3
      holesRemaining: 0,
      display: 'Halved',
      dormie: false,
    },
  },
  {
    id: 'match-conceded-hole-no-invented-score',
    kind: 'match',
    section: '§20.2 · §8.6',
    description:
      'A conceded hole is awarded to the receiving side without inventing a numeric stroke score; match continues AS',
    // h01: A wins 4<5. h02: A picks up and concedes to B — no numeric score
    // for A is ever recorded or invented. h03 halved 4=4. h04+ not entered:
    // evaluation stops, match stands AS after 3 determined holes.
    // holes_up = 1 - 1 = 0; holes remaining = 18 - 3 = 15.
    input: {
      holes: COURSE_18,
      holeInputs: [
        { holeId: 'h01', a: 4, b: 5 },
        { holeId: 'h02', a: null, b: 4, concession: 'to_b' },
        { holeId: 'h03', a: 4, b: 4 },
      ],
      extraHolesAllowed: false,
    },
    expected: {
      status: 'in_progress',
      winner: null,
      holesUp: 0, // 1 win each
      holesRemaining: 15, // 18 - 3 determined
      display: 'AS',
      dormie: false,
      outcomes: [
        { holeId: 'h01', winner: 'a' },
        { holeId: 'h02', winner: 'b' }, // conceded: awarded without a score
        { holeId: 'h03', winner: 'half' },
        { holeId: 'h04', winner: null },
        { holeId: 'h05', winner: null },
        { holeId: 'h06', winner: null },
        { holeId: 'h07', winner: null },
        { holeId: 'h08', winner: null },
        { holeId: 'h09', winner: null },
        { holeId: 'h10', winner: null },
        { holeId: 'h11', winner: null },
        { holeId: 'h12', winner: null },
        { holeId: 'h13', winner: null },
        { holeId: 'h14', winner: null },
        { holeId: 'h15', winner: null },
        { holeId: 'h16', winner: null },
        { holeId: 'h17', winner: null },
        { holeId: 'h18', winner: null },
      ],
    },
  },
]

export const matchAllocationVectors: MatchAllocationVector[] = [
  {
    id: 'match-extra-hole-stroke-allocation',
    kind: 'match_allocation',
    section: '§20.2 · §8.6 · §9.4-9.5',
    description:
      'Handicap match allocation normalized from the lowest unrounded CH at 90%; extra holes replay these same per-hole allocations (maps are keyed by hole id)',
    // CH_A = 12729/1130 (~11.264602): HI 10.4, slope 130, CR 71.3, par 72
    //        (10.4 x 130/113 + (71.3 - 72), see ch-unrounded vector)
    // CH_B =  5969/1130 (~ 5.282301): HI  5.2, same tee
    //        (5.2 x 130/113 - 7/10 = (6760 - 791)/1130)
    // Lowest is CH_B. Differences from the lowest:
    //   diff_A = (12729 - 5969)/1130 = 6760/1130 = 676/113 (~5.982301)
    //   diff_B = 0
    // Apply 90% match allowance, round once (usga_whs_2024):
    //   rel_A = 676/113 x 90/100 = 3042/565 (~5.384071)
    //         -> floor(5.384071 + 0.5) = floor(5.884071) = 5
    //   rel_B = 0
    // Allocate rel_A = 5 by stroke index (SI <= 5):
    //   h04(SI1) h13(SI2) h08(SI3) h17(SI4) h07(SI5) -> 1 stroke each.
    // Side B receives the all-zero map. An extra hole is a replay of a
    // regulation hole and reuses exactly these per-hole values (spec §9.5).
    input: {
      courseHandicapA: rational(12729, 1130),
      courseHandicapB: rational(5969, 1130),
      allowance: percent(90),
      rounding: { kind: 'usga_whs_2024' },
      holes: COURSE_18,
    },
    expected: {
      strokesA: {
        h01: 0,
        h02: 0,
        h03: 0,
        h04: 1, // SI 1
        h05: 0,
        h06: 0,
        h07: 1, // SI 5
        h08: 1, // SI 3
        h09: 0,
        h10: 0,
        h11: 0,
        h12: 0,
        h13: 1, // SI 2
        h14: 0,
        h15: 0,
        h16: 0,
        h17: 1, // SI 4
        h18: 0,
      },
      strokesB: {
        h01: 0,
        h02: 0,
        h03: 0,
        h04: 0,
        h05: 0,
        h06: 0,
        h07: 0,
        h08: 0,
        h09: 0,
        h10: 0,
        h11: 0,
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
