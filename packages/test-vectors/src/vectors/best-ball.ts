/**
 * Golden vectors — best ball / best_k_of_m (spec §20.2 bullets 6-7; §8.3-8.4).
 *
 * COURSE_9: par 4,4,3,5,4,3,4,5,4 — SI n1:5 n2:1 n3:8 n4:3 n5:7 n6:9 n7:2
 * n8:4 n9:6.
 *
 * Two-person side: pA Playing Handicap 2, pB Playing Handicap 8.
 *   pA strokes (H=2, N=9: base 0, rem 2 -> SI<=2): n2(SI1), n7(SI2)
 *   pB strokes (H=8, N=9: base 0, rem 8 -> SI<=8): every hole except n6(SI9)
 *
 * Shared gross cards:
 *   hole  n1 n2 n3 n4 n5 n6 n7 n8 n9
 *   pA     4  5  3  5  4  3  5  6  4
 *   pB     5  5  4  6  5  3  5  6  4
 */

import { COURSE_9 } from '../holes.ts'
import { scoresFor } from './types.ts'
import type { BestBallVector } from './types.ts'

const MEMBER_A = {
  participantId: 'pA',
  playingHandicap: 2,
  scores: scoresFor('pA', COURSE_9, [4, 5, 3, 5, 4, 3, 5, 6, 4]),
}

const MEMBER_B = {
  participantId: 'pB',
  playingHandicap: 8,
  scores: scoresFor('pB', COURSE_9, [5, 5, 4, 6, 5, 3, 5, 6, 4]),
}

export const bestBallVectors: BestBallVector[] = [
  {
    id: 'bb-two-person-gross',
    kind: 'best_ball',
    section: '§20.2 · §8.3',
    description:
      'Two-person GROSS best ball: pA holds every hole (ties break by participantId)',
    // Gross selection per hole (lower gross wins; tie -> lower participantId):
    //   n1: min(4,5)=4 pA | n2: 5=5 tie -> pA | n3: min(3,4)=3 pA
    //   n4: min(5,6)=5 pA | n5: min(4,5)=4 pA | n6: 3=3 tie -> pA
    //   n7: 5=5 tie -> pA | n8: 6=6 tie -> pA | n9: 4=4 tie -> pA
    // total = 4+5+3+5+4+3+5+6+4 = 39
    input: {
      holes: COURSE_9,
      metric: 'gross',
      bestK: 1,
      teams: [
        {
          teamId: 'bb-t1',
          entityStatus: 'active',
          members: [MEMBER_A, MEMBER_B],
        },
      ],
      phase: 'final',
    },
    expected: {
      rows: [
        {
          teamId: 'bb-t1',
          total: 39, // 4+5+3+5+4+3+5+6+4
          thru: 9,
          rank: 1,
          isTied: false,
          provisional: false,
          status: 'complete',
        },
      ],
      teamHoles: [
        { holeId: 'n1', teamScore: 4, contributorIds: ['pA'], status: 'complete' },
        { holeId: 'n2', teamScore: 5, contributorIds: ['pA'], status: 'complete' },
        { holeId: 'n3', teamScore: 3, contributorIds: ['pA'], status: 'complete' },
        { holeId: 'n4', teamScore: 5, contributorIds: ['pA'], status: 'complete' },
        { holeId: 'n5', teamScore: 4, contributorIds: ['pA'], status: 'complete' },
        { holeId: 'n6', teamScore: 3, contributorIds: ['pA'], status: 'complete' },
        { holeId: 'n7', teamScore: 5, contributorIds: ['pA'], status: 'complete' },
        // gross keeps pA on n8/n9; the NET vector below flips both to pB
        { holeId: 'n8', teamScore: 6, contributorIds: ['pA'], status: 'complete' },
        { holeId: 'n9', teamScore: 4, contributorIds: ['pA'], status: 'complete' },
      ],
      provisional: false,
    },
  },
  {
    id: 'bb-two-person-net-partner-differs',
    kind: 'best_ball',
    section: '§20.2 · §8.3 · AC-FMT-002',
    description:
      'Two-person NET best ball on the same cards: strokes applied per player BEFORE selection flip holes n8 and n9 to pB',
    // Net per hole (gross - strokes received):
    //   pA: n1 4-0=4  n2 5-1=4  n3 3-0=3  n4 5-0=5  n5 4-0=4
    //       n6 3-0=3  n7 5-1=4  n8 6-0=6  n9 4-0=4
    //   pB: n1 5-1=4  n2 5-1=4  n3 4-1=3  n4 6-1=5  n5 5-1=4
    //       n6 3-0=3  n7 5-1=4  n8 6-1=5  n9 4-1=3
    // Selection (lower net; tie -> lower participantId):
    //   n1 4 tie->pA | n2 4 tie->pA | n3 3 tie->pA | n4 5 tie->pA
    //   n5 4 tie->pA | n6 3 tie->pA | n7 4 tie->pA
    //   n8 pB 5 < pA 6 -> pB | n9 pB 3 < pA 4 -> pB
    // total = 4+4+3+5+4+3+4+5+3 = 35
    input: {
      holes: COURSE_9,
      metric: 'net',
      bestK: 1,
      teams: [
        {
          teamId: 'bb-t1',
          entityStatus: 'active',
          members: [MEMBER_A, MEMBER_B],
        },
      ],
      phase: 'final',
    },
    expected: {
      rows: [
        {
          teamId: 'bb-t1',
          total: 35, // 4+4+3+5+4+3+4+5+3
          thru: 9,
          rank: 1,
          isTied: false,
          provisional: false,
          status: 'complete',
        },
      ],
      teamHoles: [
        { holeId: 'n1', teamScore: 4, contributorIds: ['pA'], status: 'complete' },
        { holeId: 'n2', teamScore: 4, contributorIds: ['pA'], status: 'complete' },
        { holeId: 'n3', teamScore: 3, contributorIds: ['pA'], status: 'complete' },
        { holeId: 'n4', teamScore: 5, contributorIds: ['pA'], status: 'complete' },
        { holeId: 'n5', teamScore: 4, contributorIds: ['pA'], status: 'complete' },
        { holeId: 'n6', teamScore: 3, contributorIds: ['pA'], status: 'complete' },
        { holeId: 'n7', teamScore: 4, contributorIds: ['pA'], status: 'complete' },
        // pB net 5 beats pA net 6 (gross tie 6-6): selected partner differs
        { holeId: 'n8', teamScore: 5, contributorIds: ['pB'], status: 'complete' },
        // pB net 3 beats pA net 4 (gross tie 4-4): selected partner differs
        { holeId: 'n9', teamScore: 3, contributorIds: ['pB'], status: 'complete' },
      ],
      provisional: false,
    },
  },
  {
    id: 'bb-best-2-of-4-equal-contributor-scores',
    kind: 'best_ball',
    section: '§20.2 · §8.3-8.4',
    description:
      'Best 2 of 4 (gross): equal contributor scores break deterministically by participantId',
    // Cards (hole: p1, p2, p3, p4) and best-two selection:
    //   n1: 4,4,4,5 -> sorted p1(4),p2(4),p3(4),p4(5) -> p1+p2 = 8
    //   n2: 5,4,6,4 -> p2(4),p4(4)                    -> 4+4  = 8
    //   n3: 3,4,3,3 -> p1(3),p3(3),p4(3) -> p1+p3     -> 3+3  = 6
    //   n4: 6,5,5,7 -> p2(5),p3(5)                    -> 5+5  = 10
    //   n5: 4,5,5,5 -> p1(4),p2(5),p3(5),p4(5) -> p1+p2 -> 4+5 = 9
    //   n6: 4,3,4,4 -> p2(3),p1(4),p3(4),p4(4) -> p2+p1 -> 3+4 = 7
    //   n7: 5,5,4,4 -> p3(4),p4(4)                    -> 4+4  = 8
    //   n8: 5,6,6,5 -> p1(5),p4(5)                    -> 5+5  = 10
    //   n9: 4,4,5,6 -> p1(4),p2(4)                    -> 4+4  = 8
    // total = 8+8+6+10+9+7+8+10+8 = 74
    input: {
      holes: COURSE_9,
      metric: 'gross',
      bestK: 2,
      teams: [
        {
          teamId: 'bb-t4',
          entityStatus: 'active',
          members: [
            {
              participantId: 'p1',
              playingHandicap: null,
              scores: scoresFor('p1', COURSE_9, [4, 5, 3, 6, 4, 4, 5, 5, 4]),
            },
            {
              participantId: 'p2',
              playingHandicap: null,
              scores: scoresFor('p2', COURSE_9, [4, 4, 4, 5, 5, 3, 5, 6, 4]),
            },
            {
              participantId: 'p3',
              playingHandicap: null,
              scores: scoresFor('p3', COURSE_9, [4, 6, 3, 5, 5, 4, 4, 6, 5]),
            },
            {
              participantId: 'p4',
              playingHandicap: null,
              scores: scoresFor('p4', COURSE_9, [5, 4, 3, 7, 5, 4, 4, 5, 6]),
            },
          ],
        },
      ],
      phase: 'final',
    },
    expected: {
      rows: [
        {
          teamId: 'bb-t4',
          total: 74, // 8+8+6+10+9+7+8+10+8
          thru: 9,
          rank: 1,
          isTied: false,
          provisional: false,
          status: 'complete',
        },
      ],
      teamHoles: [
        // three players tied on 4: deterministic pick p1,p2 by id
        { holeId: 'n1', teamScore: 8, contributorIds: ['p1', 'p2'] },
        { holeId: 'n2', teamScore: 8, contributorIds: ['p2', 'p4'] },
        // three players tied on 3: deterministic pick p1,p3 by id
        { holeId: 'n3', teamScore: 6, contributorIds: ['p1', 'p3'] },
        { holeId: 'n4', teamScore: 10, contributorIds: ['p2', 'p3'] },
        // p2,p3,p4 tied on 5 for the second slot: p2 by id
        { holeId: 'n5', teamScore: 9, contributorIds: ['p1', 'p2'] },
        // sorted (value, id): p2(3) then p1(4) ahead of p3/p4(4)
        { holeId: 'n6', teamScore: 7, contributorIds: ['p2', 'p1'] },
        { holeId: 'n7', teamScore: 8, contributorIds: ['p3', 'p4'] },
        { holeId: 'n8', teamScore: 10, contributorIds: ['p1', 'p4'] },
        { holeId: 'n9', teamScore: 8, contributorIds: ['p1', 'p2'] },
      ],
      provisional: false,
    },
  },
]
