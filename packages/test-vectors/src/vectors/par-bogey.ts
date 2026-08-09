/**
 * Golden vectors — Par/Bogey competition (spec §20.1 "every format";
 * §8.12; AC-FMT-001).
 *
 * COURSE_9: par 4,4,3,5,4,3,4,5,4.
 */

import { COURSE_9 } from '../holes.ts'
import { scoresFor } from './types.ts'
import type { ParBogeyVector } from './types.ts'

export const parBogeyVectors: ParBogeyVector[] = [
  {
    id: 'pb-gross-with-pickup-loss',
    kind: 'par_bogey',
    section: '§20.1 · §8.12 · §7.3',
    description:
      'Gross Par/Bogey: better than par +1, equal 0, worse -1; a pickup is a lost hole (-1), never zero',
    //   hole par gross    result
    //   n1    4    3       +1  (better)
    //   n2    4    5       -1  (worse)
    //   n3    3    3        0  (equal)
    //   n4    5    5        0
    //   n5    4    3       +1
    //   n6    3    4       -1
    //   n7    4    4        0
    //   n8    5   pickup   -1  (no score = loss)
    //   n9    4    4        0
    // total = +1-1+0+0+1-1+0-1+0 = -1
    input: {
      holes: COURSE_9,
      metric: 'gross',
      entries: [
        {
          entryId: 'pb-p1',
          entityStatus: 'active',
          playingHandicap: null, // gross Par/Bogey needs no handicap
          scores: scoresFor('pb-p1', COURSE_9, [
            3, 5, 3, 5, 3, 4, 4, 'picked_up', 4,
          ]),
        },
      ],
      phase: 'final',
    },
    expected: {
      rows: [
        {
          entryId: 'pb-p1',
          result: -1, // 2 wins - 3 losses (incl. the pickup) + 4 halves
          thru: 9,
          rank: 1,
          isTied: false,
          provisional: false,
          status: 'complete',
        },
      ],
    },
  },
]
