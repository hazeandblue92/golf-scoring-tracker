/**
 * Common hole-result and total calculation (spec §8.1).
 *
 *   net_hole = gross_hole - strokes_received_on_hole
 *   relative_to_par = selected_metric_hole - par
 *   gross_total = sum(completed gross holes)
 *   net_total = sum(completed net holes)
 *
 * strokes_received_on_hole may be negative for a plus handicap, which
 * increases net score. A total is provisional until all holes required by the
 * competition have a valid score or an explicit format rule resolves the
 * missing state. Missing data propagates as provisional; it is never coerced
 * to zero except where a format explicitly awards zero for a pickup/no-score.
 */

import type {
  HoleScoreStatus,
  HoleSnapshot,
  IndividualHoleScore,
  TeamHoleScore,
} from './types.ts'

export interface HoleComputation {
  holeId: string
  gross: number | null
  strokesReceived: number
  net: number | null
  status: HoleScoreStatus
  /** True when this hole still awaits a valid value or terminal status. */
  pending: boolean
}

export type AnyHoleScore = IndividualHoleScore | TeamHoleScore

/** Statuses under which a hole no longer awaits input but has no number. */
const TERMINAL_WITHOUT_VALUE: ReadonlySet<HoleScoreStatus> = new Set([
  'picked_up',
  'conceded',
  'not_played',
  'no_score',
  'withdrawn',
  'disqualified',
])

export function computeHole(
  hole: HoleSnapshot,
  score: AnyHoleScore | undefined,
  strokesReceived: number,
): HoleComputation {
  if (score === undefined || score.status === 'not_started') {
    return {
      holeId: hole.id,
      gross: null,
      strokesReceived,
      net: null,
      status: score?.status ?? 'not_started',
      pending: true,
    }
  }
  if (score.status === 'complete') {
    if (score.grossStrokes === undefined) {
      throw new RangeError(`complete score for hole ${hole.id} lacks grossStrokes`)
    }
    return {
      holeId: hole.id,
      gross: score.grossStrokes,
      strokesReceived,
      net: score.grossStrokes - strokesReceived,
      status: 'complete',
      pending: false,
    }
  }
  if (TERMINAL_WITHOUT_VALUE.has(score.status)) {
    if (score.grossStrokes !== undefined) {
      throw new RangeError(
        `hole ${hole.id}: numeric value and nonnumeric terminal status ` +
          `'${score.status}' are mutually exclusive`,
      )
    }
    return {
      holeId: hole.id,
      gross: null,
      strokesReceived,
      net: null,
      status: score.status,
      pending: false,
    }
  }
  throw new RangeError(`unknown hole status '${score.status}'`)
}

export interface Totals {
  /** Sum of completed gross holes; null when no hole is complete. */
  grossTotal: number | null
  /** Sum of completed net holes; null when no hole is complete. */
  netTotal: number | null
  /** Completed-hole count (thru for display). */
  completed: number
  /** True while any competition hole still awaits a value or terminal status. */
  provisional: boolean
  /** True when a terminal non-complete status makes a full total impossible. */
  hasTerminalGap: boolean
}

export function computeTotals(holes: readonly HoleComputation[]): Totals {
  let grossTotal: number | null = null
  let netTotal: number | null = null
  let completed = 0
  let pending = false
  let terminalGap = false
  for (const h of holes) {
    if (h.pending) pending = true
    else if (h.status !== 'complete') terminalGap = true
    if (h.gross !== null && h.net !== null) {
      grossTotal = (grossTotal ?? 0) + h.gross
      netTotal = (netTotal ?? 0) + h.net
      completed += 1
    }
  }
  return {
    grossTotal,
    netTotal,
    completed,
    provisional: pending,
    hasTerminalGap: terminalGap,
  }
}

/**
 * Competition-standard ranking (spec §4.6): deterministic sort by ascending
 * (or descending) result, equal results share a tied rank, and non-ranked
 * entities (withdrawn/DQ/no-return/incomplete) sort after ranked ones.
 * Display-name ordering is presentation only and never enters this function.
 */
export function assignRanks<T>(
  entries: readonly T[],
  resultOf: (t: T) => number | null,
  direction: 'asc' | 'desc',
): Array<{ entry: T; rank: number | null; isTied: boolean }> {
  const ranked = entries
    .map((entry) => ({ entry, result: resultOf(entry) }))
    .filter((e): e is { entry: T; result: number } => e.result !== null)
    .sort((a, b) => (direction === 'asc' ? a.result - b.result : b.result - a.result))

  const out: Array<{ entry: T; rank: number | null; isTied: boolean }> = []
  const counts = new Map<number, number>()
  for (const e of ranked) counts.set(e.result, (counts.get(e.result) ?? 0) + 1)

  let position = 1
  let prevResult: number | undefined
  let prevRank = 1
  for (const e of ranked) {
    const rank = e.result === prevResult ? prevRank : position
    out.push({
      entry: e.entry,
      rank,
      isTied: (counts.get(e.result) ?? 0) > 1,
    })
    prevResult = e.result
    prevRank = rank
    position += 1
  }
  for (const e of entries) {
    if (resultOf(e) === null) out.push({ entry: e, rank: null, isTied: false })
  }
  return out
}
