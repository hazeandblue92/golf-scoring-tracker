/**
 * Golden vectors — incomplete / withdrawn / no-return / disqualified rank
 * behavior (spec §20.2 bullet 14; §7.3; §8.2; §21.1; AC-FMT-006).
 *
 * Same four entries run twice — live and final — over COURSE_9 gross stroke
 * play. Cards:
 *   e-complete   : 5,4,3,6,4,3,5,5,5           -> total 40 (all 9 holes)
 *   e-incomplete : 4,4,3,5,4,3, -, -, -        -> 23 through 6
 *   e-withdrawn  : 5,5,4, -, -, -, -, -, -     -> 14 through 3 (entity WD)
 *   e-dq         : 4,4,3,5,4,3,4,5,4           -> total 36 (entity DQ)
 */

import { COURSE_9 } from '../holes.ts'
import { scoresFor } from './types.ts'
import type { StrokePlayVector } from './types.ts'
import type { StrokePlayEntry } from '@gtt/scoring'

const ENTRIES: StrokePlayEntry[] = [
  {
    entryId: 'e-complete',
    entityStatus: 'active',
    playingHandicap: null, // gross-only entry (§21.1 missing rating/slope)
    // 5+4+3+6+4+3+5+5+5 = 40
    scores: scoresFor('e-complete', COURSE_9, [5, 4, 3, 6, 4, 3, 5, 5, 5]),
  },
  {
    entryId: 'e-incomplete',
    entityStatus: 'active',
    playingHandicap: null,
    // 4+4+3+5+4+3 = 23; n7-n9 have no facts yet (missing data, never zero)
    scores: scoresFor('e-incomplete', COURSE_9, [4, 4, 3, 5, 4, 3, null, null, null]),
  },
  {
    entryId: 'e-withdrawn',
    entityStatus: 'withdrawn',
    playingHandicap: null,
    // 5+5+4 = 14 before withdrawing
    scores: scoresFor('e-withdrawn', COURSE_9, [5, 5, 4, null, null, null, null, null, null]),
  },
  {
    entryId: 'e-dq',
    entityStatus: 'disqualified',
    playingHandicap: null,
    // full card 4+4+3+5+4+3+4+5+4 = 36 — complete, yet never ranked
    scores: scoresFor('e-dq', COURSE_9, [4, 4, 3, 5, 4, 3, 4, 5, 4]),
  },
]

export const statusBehaviorVectors: StrokePlayVector[] = [
  {
    id: 'status-live-provisional-rank',
    kind: 'stroke_play',
    section: '§20.2 · §7.3 · §21.1',
    description:
      'Live phase: the incomplete entry ranks provisionally on its current total; withdrawn/DQ stay visible with totals but are never ranked',
    // Rankable live totals: e-incomplete 23 (provisional), e-complete 40.
    //   23 < 40 -> e-incomplete rank 1 (provisional), e-complete rank 2.
    // e-withdrawn (14 thru 3) and e-dq (36, full card) are visible but
    // unranked: rank null.
    input: {
      holes: COURSE_9,
      metric: 'gross',
      entries: ENTRIES,
      phase: 'live',
    },
    expected: {
      rows: [
        {
          entryId: 'e-complete',
          grossTotal: 40, // 5+4+3+6+4+3+5+5+5
          thru: 9,
          rank: 2, // behind the provisional 23
          isTied: false,
          provisional: false,
          status: 'complete',
        },
        {
          entryId: 'e-incomplete',
          grossTotal: 23, // 4+4+3+5+4+3
          thru: 6,
          rank: 1, // provisional rank on current total
          isTied: false,
          provisional: true,
          status: 'provisional',
        },
        {
          entryId: 'e-withdrawn',
          grossTotal: 14, // 5+5+4 — visible, never ranked
          thru: 3,
          rank: null,
          isTied: false,
          provisional: false,
          status: 'withdrawn',
        },
        {
          entryId: 'e-dq',
          grossTotal: 36, // full card — visible, never ranked
          thru: 9,
          rank: null,
          isTied: false,
          provisional: false,
          status: 'disqualified',
        },
      ],
      provisional: true, // the incomplete active entry pins the board
    },
  },
  {
    id: 'status-final-no-return-rank',
    kind: 'stroke_play',
    section: '§20.2 · §7.3 · §8.2 · §21.1',
    description:
      'Final phase: the unreturned card resolves to no_return (visible, unranked); only the complete entry is ranked',
    // At finalization the pending holes of e-incomplete resolve the entry to
    // no_return: its partial total 23 stays visible but it can never be
    // ranked. e-complete (40) is the only ranked row -> rank 1.
    input: {
      holes: COURSE_9,
      metric: 'gross',
      entries: ENTRIES,
      phase: 'final',
    },
    expected: {
      rows: [
        {
          entryId: 'e-complete',
          grossTotal: 40,
          thru: 9,
          rank: 1, // only rankable entry at final
          isTied: false,
          provisional: false,
          status: 'complete',
        },
        {
          entryId: 'e-incomplete',
          grossTotal: 23, // partial sum remains visible
          thru: 6,
          rank: null,
          isTied: false,
          provisional: false,
          status: 'no_return',
        },
        {
          entryId: 'e-withdrawn',
          grossTotal: 14,
          thru: 3,
          rank: null,
          isTied: false,
          provisional: false,
          status: 'withdrawn',
        },
        {
          entryId: 'e-dq',
          grossTotal: 36,
          thru: 9,
          rank: null,
          isTied: false,
          provisional: false,
          status: 'disqualified',
        },
      ],
      provisional: false,
    },
  },
]
