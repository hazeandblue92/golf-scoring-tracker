/**
 * Countback golden vectors (spec §8.15, §20.2).
 *
 * The sequence walks the PUBLISHED competition hole order, so these vectors
 * are written against that order directly. The last vector is the important
 * one: identical cards must stay tied, because §8.15 forbids the application
 * silently resolving a tie it cannot justify.
 */

import type { CountbackVector } from './types.ts'

const SEQUENCE = ['last_9', 'last_6', 'last_3', 'hole_18']

/** 18 published-order values at `base`, with 0-based index overrides. */
function card(base: number, overrides: Record<number, number | null> = {}) {
  const values: Array<number | null> = Array.from({ length: 18 }, () => base)
  for (const [index, value] of Object.entries(overrides)) {
    values[Number(index)] = value
  }
  return values
}

export const countbackVectors: CountbackVector[] = [
  {
    id: 'countback-last-nine-separates',
    kind: 'countback',
    section: '§8.15 · AC-FMT-001',
    description: 'Equal totals separate on the last nine of the published order',
    input: {
      // Both go round in the same total; B is a stroke better coming home.
      entities: [
        { entityId: 'A', holeValues: card(4, { 0: 3, 17: 5 }) },
        { entityId: 'B', holeValues: card(4, { 0: 5, 17: 3 }) },
      ],
      sequence: SEQUENCE,
      direction: 'asc',
    },
    expected: {
      placements: [
        { entityId: 'B', order: 0, stillTied: false, resolvedBy: 'last_9' },
        { entityId: 'A', order: 1, stillTied: false },
      ],
      unresolved: false,
    },
  },
  {
    id: 'countback-final-hole-decides',
    kind: 'countback',
    section: '§8.15',
    description:
      'When every wider window is level the final published hole decides',
    input: {
      entities: [
        { entityId: 'A', holeValues: card(4, { 16: 3, 17: 5 }) },
        { entityId: 'B', holeValues: card(4, { 16: 5, 17: 3 }) },
      ],
      sequence: SEQUENCE,
      direction: 'asc',
    },
    expected: {
      placements: [
        { entityId: 'B', order: 0, stillTied: false, resolvedBy: 'hole_18' },
        { entityId: 'A', order: 1, stillTied: false },
      ],
      unresolved: false,
    },
  },
  {
    id: 'countback-identical-cards-stay-tied',
    kind: 'countback',
    section: '§8.15',
    description:
      'Identical cards remain tied through the whole sequence; the app never randomizes',
    input: {
      entities: [
        { entityId: 'A', holeValues: card(4) },
        { entityId: 'B', holeValues: card(4) },
      ],
      sequence: SEQUENCE,
      direction: 'asc',
    },
    expected: {
      placements: [
        { entityId: 'A', order: 0, stillTied: true, resolvedBy: null },
        { entityId: 'B', order: 0, stillTied: true, resolvedBy: null },
      ],
      unresolved: true,
      warningCodes: ['COUNTBACK_UNRESOLVED'],
    },
  },
  {
    id: 'countback-points-take-the-higher-total',
    kind: 'countback',
    section: '§8.15 · §8.5',
    description: 'A points competition counts back on the HIGHER segment total',
    input: {
      entities: [
        { entityId: 'A', holeValues: card(2, { 17: 4 }) },
        { entityId: 'B', holeValues: card(2, { 17: 1 }) },
      ],
      sequence: ['last_3'],
      direction: 'desc',
    },
    expected: {
      placements: [
        { entityId: 'A', order: 0, stillTied: false, resolvedBy: 'last_3' },
        { entityId: 'B', order: 1, stillTied: false },
      ],
      unresolved: false,
    },
  },
]
