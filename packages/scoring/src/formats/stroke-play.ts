/**
 * Individual stroke play (spec §8.1-§8.2).
 *
 * Gross: rank the lowest complete gross total ascending. Net: rank the lowest
 * complete net total using the frozen integer Playing Handicap and stroke
 * allocation; both gross and net totals are always populated for display when
 * computable. Equal totals share rank (default: ties stand, spec §8.15).
 *
 * A player without a valid frozen handicap (playingHandicap === null) is
 * ineligible for a net competition unless the Committee explicitly assigned
 * scratch (playingHandicap === 0); the engine emits warning NET_NO_HANDICAP
 * and leaves the row visible but unranked.
 *
 * Maximum-score cap policies (spec §8.2) — fixed, par_plus_n,
 * net_double_bogey — cap the competition metric totals only. The entered
 * gross is preserved in holeResults and every hole where the cap actually
 * reduced the counted score is recorded in cappedHoleIds so display can badge
 * it; the engine never silently caps.
 *
 * Incomplete handling (spec §7.3, §21.1): while phase is 'live', an entry
 * with pending holes (or a terminal non-complete gap that the Committee may
 * still correct) ranks provisionally on its current totals with
 * provisional=true. At phase 'final', any pending hole or terminal
 * non-complete gap resolves the entry to 'no_return': visible, never ranked.
 * Withdrawn/disqualified entities likewise remain visible but are never
 * competitively ranked.
 */

import type {
  EngineWarning,
  EntityStatus,
  HoleResult,
  HoleSnapshot,
  IndividualHoleScore,
  MaximumScoreRules,
} from '../types.ts'
import { assignRanks, computeHole } from '../common.ts'
import { allocateStrokes } from '../handicap/allocation.ts'

export interface StrokePlayEntry {
  entryId: string
  entityStatus: EntityStatus
  /**
   * Frozen signed integer Playing Handicap (plus handicaps negative).
   * null = no valid frozen handicap; an explicit scratch assignment is 0.
   */
  playingHandicap: number | null
  scores: IndividualHoleScore[]
}

export interface StrokePlayInput {
  holes: HoleSnapshot[]
  metric: 'gross' | 'net'
  entries: StrokePlayEntry[]
  maximumScore?: MaximumScoreRules
  phase: 'live' | 'final'
}

export interface StrokePlayRow {
  entryId: string
  grossTotal: number | null
  netTotal: number | null
  /** Completed-hole count for thru display. */
  thru: number
  rank: number | null
  isTied: boolean
  provisional: boolean
  status: EntityStatus | 'provisional' | 'complete' | 'no_return'
  /** Holes where the maximum-score cap reduced the counted score (badge). */
  cappedHoleIds: string[]
}

export interface StrokePlayResult {
  rows: StrokePlayRow[]
  holeResults: HoleResult[]
  warnings: EngineWarning[]
  provisional: boolean
}

/**
 * Gross-score cap for one hole under a maximum-score policy (spec §8.2).
 * net_double_bogey uses the signed strokes received on that hole, so a plus
 * player's cap sits below par + 2.
 */
function grossCapForHole(
  rules: MaximumScoreRules,
  hole: HoleSnapshot,
  strokesReceived: number,
): number {
  switch (rules.policy) {
    case 'fixed': {
      if (rules.value === undefined || !Number.isInteger(rules.value) || rules.value < 1) {
        throw new RangeError(
          `maximum score policy 'fixed' requires a positive integer value`,
        )
      }
      return rules.value
    }
    case 'par_plus_n': {
      if (rules.value === undefined || !Number.isInteger(rules.value) || rules.value < 0) {
        throw new RangeError(
          `maximum score policy 'par_plus_n' requires a nonnegative integer value`,
        )
      }
      return hole.par + rules.value
    }
    case 'net_double_bogey':
      return hole.par + 2 + strokesReceived
  }
}

interface EntryComputation {
  entry: StrokePlayEntry
  /** Sum of entered gross over completed holes (uncapped). */
  rawGross: number | null
  /** Sum of entered net over completed holes (uncapped); null without handicap. */
  rawNet: number | null
  /** Competition gross total with the cap applied per hole. */
  cappedGross: number | null
  /** Competition net total with the cap applied per hole; null without handicap. */
  cappedNet: number | null
  thru: number
  pending: boolean
  terminalGap: boolean
  cappedHoleIds: string[]
  status: StrokePlayRow['status']
  provisional: boolean
  /** Competition-metric value used for ranking, or null when ineligible. */
  rankValue: number | null
}

export function calculateStrokePlay(input: StrokePlayInput): StrokePlayResult {
  const { holes, metric, entries, maximumScore, phase } = input
  const warnings: EngineWarning[] = []
  const holeResults: HoleResult[] = []

  const holeIds = new Set(holes.map((h) => h.id))
  const seenEntryIds = new Set<string>()

  const computations: EntryComputation[] = entries.map((entry) => {
    if (seenEntryIds.has(entry.entryId)) {
      throw new RangeError(`duplicate entryId '${entry.entryId}'`)
    }
    seenEntryIds.add(entry.entryId)

    const hasHandicap = entry.playingHandicap !== null
    // Allocation also validates the stroke-index permutation. A null handicap
    // allocates zero strokes; its net remains null (never coerced) below.
    const strokes = allocateStrokes(entry.playingHandicap ?? 0, holes)

    const scoreByHole = new Map<string, IndividualHoleScore>()
    for (const score of entry.scores) {
      if (!holeIds.has(score.holeId)) continue
      if (scoreByHole.has(score.holeId)) {
        throw new RangeError(
          `entry '${entry.entryId}' has multiple scores for hole '${score.holeId}'`,
        )
      }
      scoreByHole.set(score.holeId, score)
    }

    let rawGross: number | null = null
    let rawNet: number | null = null
    let cappedGross: number | null = null
    let cappedNet: number | null = null
    let thru = 0
    let pending = false
    let terminalGap = false
    const cappedHoleIds: string[] = []

    for (const hole of holes) {
      const strokesReceived = strokes.get(hole.id) ?? 0
      const comp = computeHole(hole, scoreByHole.get(hole.id), strokesReceived)
      if (comp.pending) pending = true
      else if (comp.status !== 'complete') terminalGap = true

      const net = hasHandicap ? comp.net : null
      if (comp.gross !== null) {
        thru += 1
        rawGross = (rawGross ?? 0) + comp.gross
        if (net !== null) rawNet = (rawNet ?? 0) + net

        let counted = comp.gross
        if (maximumScore !== undefined) {
          const cap = grossCapForHole(maximumScore, hole, strokesReceived)
          if (comp.gross > cap) {
            counted = cap
            cappedHoleIds.push(hole.id)
          }
        }
        cappedGross = (cappedGross ?? 0) + counted
        if (hasHandicap) cappedNet = (cappedNet ?? 0) + (counted - strokesReceived)
      }

      const metricHole = metric === 'gross' ? comp.gross : net
      holeResults.push({
        entityId: entry.entryId,
        holeId: hole.id,
        gross: comp.gross,
        strokesReceived,
        net,
        relativeToPar: metricHole === null ? null : metricHole - hole.par,
        status: comp.status,
        provisional: comp.pending,
      })
    }

    if (metric === 'net' && !hasHandicap) {
      warnings.push({
        code: 'NET_NO_HANDICAP',
        message:
          `Entry '${entry.entryId}' has no valid frozen Playing Handicap and is ` +
          `ineligible for the net competition; assign explicit scratch (0) to include it.`,
        context: { entryId: entry.entryId },
      })
    }

    const cardComplete = !pending && !terminalGap
    const metricEligible = metric === 'gross' || hasHandicap

    let status: StrokePlayRow['status']
    let provisional = false
    let rankEligible = false
    if (entry.entityStatus !== 'active') {
      status = entry.entityStatus
    } else if (cardComplete) {
      status = 'complete'
      rankEligible = metricEligible
    } else if (phase === 'final') {
      status = 'no_return'
    } else {
      status = 'provisional'
      provisional = true
      rankEligible = metricEligible
    }

    const metricTotal = metric === 'gross' ? cappedGross : cappedNet
    return {
      entry,
      rawGross,
      rawNet,
      cappedGross,
      cappedNet,
      thru,
      pending,
      terminalGap,
      cappedHoleIds,
      status,
      provisional,
      rankValue: rankEligible ? metricTotal : null,
    }
  })

  const ranked = assignRanks(computations, (c) => c.rankValue, 'asc')
  const rankByEntryId = new Map<string, { rank: number | null; isTied: boolean }>()
  for (const r of ranked) {
    rankByEntryId.set(r.entry.entry.entryId, { rank: r.rank, isTied: r.isTied })
  }

  const rows: StrokePlayRow[] = computations.map((c) => {
    const placement = rankByEntryId.get(c.entry.entryId) ?? { rank: null, isTied: false }
    return {
      entryId: c.entry.entryId,
      grossTotal: metric === 'gross' ? c.cappedGross : c.rawGross,
      netTotal: metric === 'net' ? c.cappedNet : c.rawNet,
      thru: c.thru,
      rank: placement.rank,
      isTied: placement.isTied,
      provisional: c.provisional,
      status: c.status,
      cappedHoleIds: c.cappedHoleIds,
    }
  })

  return {
    rows,
    holeResults,
    warnings,
    provisional: rows.some((r) => r.provisional),
  }
}
