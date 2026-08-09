/**
 * Par/Bogey competition (spec §8.12).
 *
 * Each hole's gross or net score is compared with the target (normally par):
 * better = +1, equal = 0, worse or no score = -1. A pickup/no-score/
 * not-played hole is a loss (-1), never zero. Highest cumulative result
 * wins. Live pending holes contribute nothing and mark the entry
 * provisional; at finalization an unreturned hole resolves to a loss
 * because the format's own worse-or-no-score rule resolves the missing
 * state (spec §8.1, §8.12).
 *
 * Withdrawn/no-return/disqualified entities remain visible but are never
 * competitively ranked.
 */

import { allocateStrokes } from '../handicap/allocation.ts'
import { assignRanks, computeHole } from '../common.ts'
import type { HoleComputation } from '../common.ts'
import type {
  EngineWarning,
  EntityStatus,
  HoleScoreStatus,
  HoleSnapshot,
  IndividualHoleScore,
} from '../types.ts'
import type { StablefordEntry } from './stableford.ts'

export interface ParBogeyInput {
  holes: HoleSnapshot[]
  metric: 'gross' | 'net'
  entries: StablefordEntry[]
  phase: 'live' | 'final'
}

export interface ParBogeyRow {
  entryId: string
  result: number
  thru: number
  rank: number | null
  isTied: boolean
  provisional: boolean
  status: EntityStatus | 'provisional' | 'complete'
}

export interface ParBogeyResult {
  rows: ParBogeyRow[]
  warnings: EngineWarning[]
  provisional: boolean
}

/** Terminal hole statuses that count as a lost hole (spec §8.12). */
const LOSS_STATUSES: ReadonlySet<HoleScoreStatus> = new Set([
  'picked_up',
  'no_score',
  'not_played',
  'conceded',
])

interface EntryComputation {
  entry: StablefordEntry
  result: number
  thru: number
  provisional: boolean
  rankable: boolean
}

export function calculateParBogey(input: ParBogeyInput): ParBogeyResult {
  const warnings: EngineWarning[] = []
  const computations = input.entries.map((entry) =>
    computeEntry(entry, input, warnings),
  )
  const ranked = assignRanks(
    computations,
    (c) => (c.rankable ? c.result : null),
    'desc',
  )
  const rows: ParBogeyRow[] = ranked.map(({ entry: c, rank, isTied }) => ({
    entryId: c.entry.entryId,
    result: c.result,
    thru: c.thru,
    rank,
    isTied,
    provisional: c.provisional,
    status: rowStatus(c),
  }))
  return {
    rows,
    warnings,
    provisional: computations.some((c) => c.provisional),
  }
}

function rowStatus(
  c: EntryComputation,
): EntityStatus | 'provisional' | 'complete' {
  if (c.entry.entityStatus !== 'active') return c.entry.entityStatus
  return c.provisional ? 'provisional' : 'complete'
}

function computeEntry(
  entry: StablefordEntry,
  input: ParBogeyInput,
  warnings: EngineWarning[],
): EntryComputation {
  const active = entry.entityStatus === 'active'
  let strokesByHole: Map<string, number> | null = null
  let handicapMissing = false
  if (input.metric === 'net') {
    if (entry.playingHandicap === null) {
      handicapMissing = true
      warnings.push({
        code: 'PAR_BOGEY_NET_HANDICAP_MISSING',
        message:
          `entry ${entry.entryId} has no Playing Handicap; ` +
          'net Par/Bogey results cannot be computed',
        context: { entryId: entry.entryId },
      })
    } else {
      strokesByHole = allocateStrokes(entry.playingHandicap, input.holes)
    }
  }
  const byHole = latestScores(entry.scores)
  let result = 0
  let thru = 0
  let provisional = false
  for (const hole of input.holes) {
    const score = byHole.get(hole.id)
    if (score !== undefined && score.status !== 'not_started') thru += 1
    if (handicapMissing) {
      // Never coerce strokes received to zero; the entry stays
      // provisional and unranked until a handicap exists.
      if (active) provisional = true
      continue
    }
    const strokes = strokesByHole?.get(hole.id) ?? 0
    const computed = computeHole(hole, score, strokes)
    const outcome = holeResultFor(hole, computed, input, active)
    if (outcome.result !== null) result += outcome.result
    if (outcome.provisional) provisional = true
  }
  return {
    entry,
    result,
    thru,
    provisional,
    rankable: active && !handicapMissing,
  }
}

function holeResultFor(
  hole: HoleSnapshot,
  computed: HoleComputation,
  input: ParBogeyInput,
  active: boolean,
): { result: number | null; provisional: boolean } {
  if (computed.pending) {
    if (input.phase === 'live') {
      // A withdrawn/DQ entity's unplayed holes never pin the board.
      return { result: null, provisional: active }
    }
    // Finalization: an unreturned hole is a no-score, which loses (-1).
    return active
      ? { result: -1, provisional: false }
      : { result: null, provisional: false }
  }
  if (computed.status === 'complete') {
    const metricScore = input.metric === 'net' ? computed.net : computed.gross
    if (metricScore === null) {
      throw new RangeError(`complete hole ${hole.id} lacks a metric score`)
    }
    if (metricScore < hole.par) return { result: 1, provisional: false }
    if (metricScore === hole.par) return { result: 0, provisional: false }
    return { result: -1, provisional: false }
  }
  if (LOSS_STATUSES.has(computed.status)) {
    return { result: -1, provisional: false }
  }
  // Hole-level withdrawn/disqualified: terminal, excluded from the sum.
  return { result: null, provisional: false }
}

/** Latest-revision score per hole; earlier revisions are superseded facts. */
function latestScores(
  scores: readonly IndividualHoleScore[],
): Map<string, IndividualHoleScore> {
  const map = new Map<string, IndividualHoleScore>()
  for (const score of scores) {
    const previous = map.get(score.holeId)
    if (previous === undefined || score.revision > previous.revision) {
      map.set(score.holeId, score)
    }
  }
  return map
}
