/**
 * Shared deterministic course fixtures for the golden-vector suite
 * (spec §20.1-20.2). Plain data only.
 *
 * COURSE_18: pars sum to 72 (front 36 / back 36); stroke indexes are a
 * permutation of 1..18 (spec §4.3/§6.3) with odd indexes on the front nine
 * and even indexes on the back, a common committee allocation practice.
 *
 * COURSE_9: pars sum to 36; stroke indexes are a permutation of 1..9.
 */

import type { HoleSnapshot } from '@gtt/scoring'

export const COURSE_18: HoleSnapshot[] = [
  { id: 'h01', ordinal: 1, par: 4, strokeIndex: 7 },
  { id: 'h02', ordinal: 2, par: 5, strokeIndex: 13 },
  { id: 'h03', ordinal: 3, par: 3, strokeIndex: 17 },
  { id: 'h04', ordinal: 4, par: 4, strokeIndex: 1 },
  { id: 'h05', ordinal: 5, par: 4, strokeIndex: 9 },
  { id: 'h06', ordinal: 6, par: 3, strokeIndex: 15 },
  { id: 'h07', ordinal: 7, par: 5, strokeIndex: 5 },
  { id: 'h08', ordinal: 8, par: 4, strokeIndex: 3 },
  { id: 'h09', ordinal: 9, par: 4, strokeIndex: 11 },
  { id: 'h10', ordinal: 10, par: 4, strokeIndex: 8 },
  { id: 'h11', ordinal: 11, par: 3, strokeIndex: 18 },
  { id: 'h12', ordinal: 12, par: 5, strokeIndex: 14 },
  { id: 'h13', ordinal: 13, par: 4, strokeIndex: 2 },
  { id: 'h14', ordinal: 14, par: 4, strokeIndex: 10 },
  { id: 'h15', ordinal: 15, par: 5, strokeIndex: 6 },
  { id: 'h16', ordinal: 16, par: 3, strokeIndex: 16 },
  { id: 'h17', ordinal: 17, par: 4, strokeIndex: 4 },
  { id: 'h18', ordinal: 18, par: 4, strokeIndex: 12 },
]

/** 4+5+3+4+4+3+5+4+4 = 36 front; 4+3+5+4+4+5+3+4+4 = 36 back. */
export const COURSE_18_PAR = 72

export const COURSE_9: HoleSnapshot[] = [
  { id: 'n1', ordinal: 1, par: 4, strokeIndex: 5 },
  { id: 'n2', ordinal: 2, par: 4, strokeIndex: 1 },
  { id: 'n3', ordinal: 3, par: 3, strokeIndex: 8 },
  { id: 'n4', ordinal: 4, par: 5, strokeIndex: 3 },
  { id: 'n5', ordinal: 5, par: 4, strokeIndex: 7 },
  { id: 'n6', ordinal: 6, par: 3, strokeIndex: 9 },
  { id: 'n7', ordinal: 7, par: 4, strokeIndex: 2 },
  { id: 'n8', ordinal: 8, par: 5, strokeIndex: 4 },
  { id: 'n9', ordinal: 9, par: 4, strokeIndex: 6 },
]

/** 4+4+3+5+4+3+4+5+4 = 36. */
export const COURSE_9_PAR = 36
