/**
 * Golden vectors — skins (spec §20.2 bullet 10; §8.7; §21.1; AC-FMT-005).
 *
 * Both vectors: COURSE_9, one unit per hole, carry_forward, finalCarry
 * 'expire', fractional units off. Skins values are UNITS, never money.
 */

import { COURSE_9 } from '../holes.ts'
import { skinsCard } from './types.ts'
import type { SkinsVector } from './types.ts'

export const skinsVectors: SkinsVector[] = [
  {
    id: 'skins-gross-unique-carry-multiwin-expire',
    kind: 'skins',
    section: '§20.2 · §8.7 · §21.1',
    description:
      'Gross skins: unique low win, tie/carry, multi-hole carry win, and a final unawarded carry that expires',
    // Gross metric scores (hole: e1, e2, e3) and pool flow
    // (pool = carried-in + 1 unit for the hole):
    //   n1: 4,5,5 -> e1 unique low  -> e1 wins 0+1 = 1
    //   n2: 4,4,5 -> e1/e2 tied     -> carry 0+1 = 1
    //   n3: 3,3,3 -> all tied       -> carry 1+1 = 2
    //   n4: 5,6,4 -> e3 unique low  -> e3 wins 2+1 = 3  (multi-hole carry win)
    //   n5: 4,4,4 -> tied           -> carry 0+1 = 1
    //   n6: 3,2,4 -> e2 unique low  -> e2 wins 1+1 = 2
    //   n7: 4,4,4 -> tied           -> carry 0+1 = 1
    //   n8: 5,5,6 -> e1/e2 tied     -> carry 1+1 = 2
    //   n9: 4,4,4 -> tied           -> carry 2+1 = 3
    // Final carried pool 3 follows frozen finalCarry 'expire': it stays
    // visible as unawarded units, never guessed onto a winner (spec §21.1).
    // totals: e1 = 1, e2 = 2, e3 = 3; awarded 6 + unawarded 3 = 9 holes x 1.
    input: {
      holes: COURSE_9,
      entries: [
        {
          entityId: 'e1',
          eligible: true,
          holeScores: skinsCard(COURSE_9, [4, 4, 3, 5, 4, 3, 4, 5, 4]),
        },
        {
          entityId: 'e2',
          eligible: true,
          holeScores: skinsCard(COURSE_9, [5, 4, 3, 6, 4, 2, 4, 5, 4]),
        },
        {
          entityId: 'e3',
          eligible: true,
          holeScores: skinsCard(COURSE_9, [5, 5, 3, 4, 4, 4, 4, 6, 4]),
        },
      ],
      rules: {
        population: 'field',
        carryMode: 'carry_forward',
        unitsPerHole: 1,
        finalCarry: 'expire',
        fractionalUnits: false,
      },
      phase: 'final',
    },
    expected: {
      holeOutcomes: [
        { holeId: 'n1', status: 'won', winnerId: 'e1', unitsAwarded: 1, poolCarriedIn: 0 },
        { holeId: 'n2', status: 'carried', winnerId: null, unitsAwarded: 0, poolCarriedIn: 0 },
        { holeId: 'n3', status: 'carried', winnerId: null, unitsAwarded: 0, poolCarriedIn: 1 },
        { holeId: 'n4', status: 'won', winnerId: 'e3', unitsAwarded: 3, poolCarriedIn: 2 },
        { holeId: 'n5', status: 'carried', winnerId: null, unitsAwarded: 0, poolCarriedIn: 0 },
        { holeId: 'n6', status: 'won', winnerId: 'e2', unitsAwarded: 2, poolCarriedIn: 1 },
        { holeId: 'n7', status: 'carried', winnerId: null, unitsAwarded: 0, poolCarriedIn: 0 },
        { holeId: 'n8', status: 'carried', winnerId: null, unitsAwarded: 0, poolCarriedIn: 1 },
        { holeId: 'n9', status: 'carried', winnerId: null, unitsAwarded: 0, poolCarriedIn: 2 },
      ],
      totals: [
        { entityId: 'e1', units: 1 }, // n1
        { entityId: 'e2', units: 2 }, // n6
        { entityId: 'e3', units: 3 }, // n4
      ],
      unawardedUnits: 3, // final carried pool expires, stays visible
      provisional: false,
      warningCodes: [], // 'expire' resolves silently by design
    },
  },
  {
    id: 'skins-net-unique-carry-multiwin-expire',
    kind: 'skins',
    section: '§20.2 · §8.7 · §9.5',
    description:
      'Net skins on upstream per-player net values: a stroke creates the unique low; tie/carry, multi-hole carry win, final carry expires',
    // Upstream net computation (net = gross - strokes received):
    //   f1 PH 0 (no strokes), f2 PH 4 (SI<=4: n2,n7,n4,n8), f3 PH 9 (1 every
    //   hole).
    //   hole  gross f1,f2,f3   strokes f1,f2,f3   NET f1,f2,f3
    //   n1        4, 5, 5          0,0,1            4,5,4
    //   n2        5, 5, 6          0,1,1            5,4,5
    //   n3        3, 4, 4          0,0,1            3,4,3
    //   n4        5, 6, 7          0,1,1            5,5,6
    //   n5        4, 5, 4          0,0,1            4,5,3
    //   n6        3, 3, 4          0,0,1            3,3,3
    //   n7        4, 5, 5          0,1,1            4,4,4
    //   n8        5, 6, 6          0,1,1            5,5,5
    //   n9        4, 5, 5          0,0,1            4,5,4
    // Pool flow (pool = carried-in + 1):
    //   n1: 4,5,4 -> f1/f3 tied -> carry 1
    //   n2: 5,4,5 -> f2 unique (stroke on SI 1) -> f2 wins 1+1 = 2
    //   n3: 3,4,3 -> f1/f3 tied -> carry 1
    //   n4: 5,5,6 -> f1/f2 tied -> carry 2
    //   n5: 4,5,3 -> f3 unique  -> f3 wins 2+1 = 3  (multi-hole carry win)
    //   n6: 3,3,3 -> tied       -> carry 1
    //   n7: 4,4,4 -> tied       -> carry 2
    //   n8: 5,5,5 -> tied       -> carry 3
    //   n9: 4,5,4 -> f1/f3 tied -> carry 4
    // Final carried pool 4 expires (frozen policy). totals: f1 0, f2 2, f3 3;
    // awarded 5 + unawarded 4 = 9 holes x 1.
    input: {
      holes: COURSE_9,
      entries: [
        {
          entityId: 'f1',
          eligible: true,
          holeScores: skinsCard(COURSE_9, [4, 5, 3, 5, 4, 3, 4, 5, 4]),
        },
        {
          entityId: 'f2',
          eligible: true,
          holeScores: skinsCard(COURSE_9, [5, 4, 4, 5, 5, 3, 4, 5, 5]),
        },
        {
          entityId: 'f3',
          eligible: true,
          holeScores: skinsCard(COURSE_9, [4, 5, 3, 6, 3, 3, 4, 5, 4]),
        },
      ],
      rules: {
        population: 'field',
        carryMode: 'carry_forward',
        unitsPerHole: 1,
        finalCarry: 'expire',
        fractionalUnits: false,
      },
      phase: 'final',
    },
    expected: {
      holeOutcomes: [
        { holeId: 'n1', status: 'carried', winnerId: null, unitsAwarded: 0, poolCarriedIn: 0 },
        { holeId: 'n2', status: 'won', winnerId: 'f2', unitsAwarded: 2, poolCarriedIn: 1 },
        { holeId: 'n3', status: 'carried', winnerId: null, unitsAwarded: 0, poolCarriedIn: 0 },
        { holeId: 'n4', status: 'carried', winnerId: null, unitsAwarded: 0, poolCarriedIn: 1 },
        { holeId: 'n5', status: 'won', winnerId: 'f3', unitsAwarded: 3, poolCarriedIn: 2 },
        { holeId: 'n6', status: 'carried', winnerId: null, unitsAwarded: 0, poolCarriedIn: 0 },
        { holeId: 'n7', status: 'carried', winnerId: null, unitsAwarded: 0, poolCarriedIn: 1 },
        { holeId: 'n8', status: 'carried', winnerId: null, unitsAwarded: 0, poolCarriedIn: 2 },
        { holeId: 'n9', status: 'carried', winnerId: null, unitsAwarded: 0, poolCarriedIn: 3 },
      ],
      totals: [
        { entityId: 'f1', units: 0 },
        { entityId: 'f2', units: 2 }, // n2
        { entityId: 'f3', units: 3 }, // n5
      ],
      unawardedUnits: 4, // final carried pool expires, stays visible
      provisional: false,
      warningCodes: [],
    },
  },
]
