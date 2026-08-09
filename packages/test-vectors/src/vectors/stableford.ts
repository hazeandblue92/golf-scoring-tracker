/**
 * Golden vectors — Stableford and Modified Stableford
 * (spec §20.2 bullet 8; §8.5).
 *
 * COURSE_9: par 4,4,3,5,4,3,4,5,4 — SI n1:5 n2:1 n3:8 n4:3 n5:7 n6:9 n7:2
 * n8:4 n9:6.
 */

import { COURSE_9 } from '../holes.ts'
import { scoresFor } from './types.ts'
import type { StablefordVector } from './types.ts'

export const stablefordVectors: StablefordVector[] = [
  {
    id: 'stb-standard-net-with-pickup-floor',
    kind: 'stableford',
    section: '§20.2 · §8.5 · §7.3',
    description:
      'Standard net Stableford: map edges give eagle-or-better/double-bogey-or-worse semantics; a pickup scores the floor (0)',
    // Standard map keyed by net relation to par (spec §8.5 table):
    //   -3:5 (albatross+), -2:4, -1:3, 0:2, 1:1, 2:0 (double bogey or worse)
    // Player PH 9 over N=9 holes: base floor(9/9)=1, rem 0 -> exactly 1
    // stroke received on every hole.
    //   hole par gross  net  relation  points
    //   n1    4    5     4      0        2
    //   n2    4    4     3     -1        3
    //   n3    3    4     3      0        2
    //   n4    5    7     6     +1        1
    //   n5    4    8     7     +3 -> clamps to map max key +2 -> 0
    //   n6    3   pickup  -    floorPoints = 0
    //   n7    4    3     2     -2        4
    //   n8    5    5     4     -1        3
    //   n9    4    4     3     -1        3
    // total = 2+3+2+1+0+0+4+3+3 = 18
    input: {
      holes: COURSE_9,
      metric: 'net',
      rules: {
        pointsByRelation: { [-3]: 5, [-2]: 4, [-1]: 3, 0: 2, 1: 1, 2: 0 },
        floorPoints: 0,
      },
      entries: [
        {
          entryId: 'stb-p1',
          entityStatus: 'active',
          playingHandicap: 9,
          scores: scoresFor('stb-p1', COURSE_9, [
            5, 4, 4, 7, 8, 'picked_up', 3, 5, 4,
          ]),
        },
      ],
      phase: 'final',
    },
    expected: {
      rows: [
        {
          entryId: 'stb-p1',
          points: 18, // 2+3+2+1+0+0+4+3+3
          thru: 9, // the pickup on n6 still counts as a played hole
          rank: 1,
          isTied: false,
          provisional: false,
          status: 'complete',
        },
      ],
      holePoints: [
        { holeId: 'n1', relation: 0, points: 2, provisional: false },
        { holeId: 'n2', relation: -1, points: 3, provisional: false },
        { holeId: 'n3', relation: 0, points: 2, provisional: false },
        { holeId: 'n4', relation: 1, points: 1, provisional: false },
        // recorded relation stays +3; the lookup clamps to key +2 -> 0
        { holeId: 'n5', relation: 3, points: 0, provisional: false },
        // pickup: no relation, configured floor 0 (spec §7.3 explicit award)
        { holeId: 'n6', relation: null, points: 0, provisional: false },
        { holeId: 'n7', relation: -2, points: 4, provisional: false },
        { holeId: 'n8', relation: -1, points: 3, provisional: false },
        { holeId: 'n9', relation: -1, points: 3, provisional: false },
      ],
    },
  },
  {
    id: 'stb-modified-custom-map-gross',
    kind: 'stableford',
    section: '§20.2 · §8.5',
    description:
      'Modified Stableford with a custom map including negative points; gross metric, pickup scores the configured floor (-3)',
    // Custom map (relation -> points): -3:8, -2:5, -1:2, 0:0, +1:-1, +2:-3
    // floorPoints -3 (pickup scores worst). Gross metric, no handicap needed.
    //   hole par gross  relation  points
    //   n1    4    3      -1        2
    //   n2    4    6      +2       -3
    //   n3    3    2      -1        2
    //   n4    5    3      -2        5
    //   n5    4    4       0        0
    //   n6    3    4      +1       -1
    //   n7    4    2      -2        5
    //   n8    5   pickup   -       floorPoints = -3
    //   n9    4    5      +1       -1
    // total = 2-3+2+5+0-1+5-3-1 = 6
    input: {
      holes: COURSE_9,
      metric: 'gross',
      rules: {
        pointsByRelation: { [-3]: 8, [-2]: 5, [-1]: 2, 0: 0, 1: -1, 2: -3 },
        floorPoints: -3,
      },
      entries: [
        {
          entryId: 'stb-p2',
          entityStatus: 'active',
          playingHandicap: null, // gross Stableford needs no handicap
          scores: scoresFor('stb-p2', COURSE_9, [
            3, 6, 2, 3, 4, 4, 2, 'picked_up', 5,
          ]),
        },
      ],
      phase: 'final',
    },
    expected: {
      rows: [
        {
          entryId: 'stb-p2',
          points: 6, // 2-3+2+5+0-1+5-3-1
          thru: 9,
          rank: 1,
          isTied: false,
          provisional: false,
          status: 'complete',
        },
      ],
      holePoints: [
        { holeId: 'n1', relation: -1, points: 2, provisional: false },
        { holeId: 'n2', relation: 2, points: -3, provisional: false },
        { holeId: 'n3', relation: -1, points: 2, provisional: false },
        { holeId: 'n4', relation: -2, points: 5, provisional: false },
        { holeId: 'n5', relation: 0, points: 0, provisional: false },
        { holeId: 'n6', relation: 1, points: -1, provisional: false },
        { holeId: 'n7', relation: -2, points: 5, provisional: false },
        // pickup scores the configured (negative) floor, never zero strokes
        { holeId: 'n8', relation: null, points: -3, provisional: false },
        { holeId: 'n9', relation: 1, points: -1, provisional: false },
      ],
    },
  },
]
