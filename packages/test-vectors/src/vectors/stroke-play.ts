/**
 * Golden vectors — individual stroke play (spec §20.2 bullet 1; §8.1-8.2).
 */

import { COURSE_18 } from '../holes.ts'
import { scoresFor } from './types.ts'
import type { StrokePlayVector } from './types.ts'

export const strokePlayVectors: StrokePlayVector[] = [
  {
    id: 'sp-scratch-gross-18-hole-total',
    kind: 'stroke_play',
    section: '§20.2 · §8.2 · §8.1',
    description: 'Scratch player, complete 18-hole card: gross total is the plain sum',
    // Card vs par (scratch, strokes received 0 on every hole so net == gross):
    //   hole  h01 h02 h03 h04 h05 h06 h07 h08 h09 | h10 h11 h12 h13 h14 h15 h16 h17 h18
    //   par     4   5   3   4   4   3   5   4   4 |   4   3   5   4   4   5   3   4   4
    //   gross   4   5   3   5   4   2   5   4   4 |   4   3   6   4   5   5   3   4   4
    // front = 4+5+3+5+4+2+5+4+4 = 36
    // back  = 4+3+6+4+5+5+3+4+4 = 38
    // total = 36 + 38 = 74; net total = 74 - 0 = 74
    input: {
      holes: COURSE_18,
      metric: 'gross',
      entries: [
        {
          entryId: 'p-scratch',
          entityStatus: 'active',
          playingHandicap: 0,
          scores: scoresFor('p-scratch', COURSE_18, [
            4, 5, 3, 5, 4, 2, 5, 4, 4, // front 36
            4, 3, 6, 4, 5, 5, 3, 4, 4, // back 38
          ]),
        },
      ],
      phase: 'final',
    },
    expected: {
      rows: [
        {
          entryId: 'p-scratch',
          grossTotal: 74, // 36 + 38
          netTotal: 74, // 74 - 0 strokes received
          thru: 18,
          rank: 1,
          isTied: false,
          provisional: false,
          status: 'complete',
          cappedHoleIds: [], // no maximum-score policy configured
        },
      ],
      provisional: false,
      warningCodes: [],
    },
  },
]
