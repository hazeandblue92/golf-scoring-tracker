/**
 * Multi-round tournament aggregation (spec §8.14).
 *
 * "Supported aggregations: sum of stroke totals, sum of points, match points
 * table, and best r of n rounds. Each competition states whether handicaps are
 * snapshotted per event or per round. Cuts, playoffs, and substitutions are
 * explicit entries; deleted rows are never used to rewrite history."
 *
 * This module aggregates ALREADY-COMPUTED per-round values. Whether a round's
 * net came from an event-level or round-level handicap snapshot is settled
 * upstream when that round is scored — by the time a value arrives here the
 * frozen handicap has already been applied, so the choice cannot leak into the
 * aggregation math.
 *
 * A dropped round is never deleted: `RoundContribution.counted` records which
 * rounds fed the total, so a scorecard can show a struck-through round rather
 * than silently omitting it (§8.14: deleted rows are never used to rewrite
 * history).
 */

import { assignRanks } from '../common.ts'
import type { EngineWarning } from '../types.ts'

/** Per-round status as seen by the aggregator. */
export type MultiRoundStatus =
  | 'complete'
  | 'provisional'
  | 'not_started'
  | 'no_return'
  | 'withdrawn'
  | 'disqualified'

export interface RoundResult {
  roundId: string
  /** Strokes, points, or match points for the round; null when unavailable. */
  value: number | null
  /** competition_rounds.weight — defaults to 1. */
  weight?: number
  status: MultiRoundStatus
}

export interface MultiRoundEntity {
  entityId: string
  rounds: readonly RoundResult[]
  /** Entity-level status; anything but 'active' is never ranked. */
  entityStatus?: 'active' | 'withdrawn' | 'no_return' | 'disqualified'
}

export type MultiRoundAggregation =
  | { kind: 'sum_strokes' }
  | { kind: 'sum_points' }
  /** Match points table: points awarded per round, highest total wins. */
  | { kind: 'match_points' }
  /** Best r of n: keep the r best rounds, drop the rest. */
  | { kind: 'best_r_of_n'; count: number; basis: 'strokes' | 'points' }

export interface MultiRoundInput {
  entities: readonly MultiRoundEntity[]
  aggregation: MultiRoundAggregation
  /** 'live' ranks on what exists so far; 'final' refuses incomplete entries. */
  phase: 'live' | 'final'
}

export interface RoundContribution {
  roundId: string
  value: number | null
  weight: number
  /** Weighted value actually used, or null when the round has no value. */
  weightedValue: number | null
  /** False for a round dropped by best-r-of-n, or one with no value. */
  counted: boolean
  status: MultiRoundStatus
}

export interface MultiRoundRow {
  entityId: string
  /** Aggregated total across counted rounds, or null when not computable. */
  total: number | null
  /** Rounds with a usable value, counted or dropped. */
  roundsPlayed: number
  /** Rounds that fed the total. */
  roundsCounted: number
  rank: number | null
  isTied: boolean
  provisional: boolean
  status: 'complete' | 'provisional' | 'no_return' | 'withdrawn' | 'disqualified'
  contributions: RoundContribution[]
}

export interface MultiRoundResult {
  rows: MultiRoundRow[]
  warnings: EngineWarning[]
  provisional: boolean
}

/** Lower total wins for strokes; higher wins for points tables. */
export function aggregationDirection(
  aggregation: MultiRoundAggregation,
): 'asc' | 'desc' {
  switch (aggregation.kind) {
    case 'sum_strokes':
      return 'asc'
    case 'sum_points':
    case 'match_points':
      return 'desc'
    case 'best_r_of_n':
      return aggregation.basis === 'strokes' ? 'asc' : 'desc'
  }
}

/** Rounds required before an entity can be ranked at all. */
function requiredRounds(
  aggregation: MultiRoundAggregation,
  available: number,
): number {
  return aggregation.kind === 'best_r_of_n'
    ? Math.min(aggregation.count, available)
    : available
}

export function calculateMultiRound(input: MultiRoundInput): MultiRoundResult {
  const { entities, aggregation, phase } = input
  const warnings: EngineWarning[] = []
  const direction = aggregationDirection(aggregation)

  if (aggregation.kind === 'best_r_of_n' && aggregation.count < 1) {
    throw new RangeError(
      `best_r_of_n requires counting at least one round, got ${aggregation.count}`,
    )
  }

  const seen = new Set<string>()
  const computed = entities.map((entity) => {
    if (seen.has(entity.entityId)) {
      throw new RangeError(`duplicate entityId '${entity.entityId}'`)
    }
    seen.add(entity.entityId)

    const seenRounds = new Set<string>()
    const contributions: RoundContribution[] = entity.rounds.map((round) => {
      if (seenRounds.has(round.roundId)) {
        throw new RangeError(
          `entity '${entity.entityId}' has multiple results for round '${round.roundId}'`,
        )
      }
      seenRounds.add(round.roundId)
      const weight = round.weight ?? 1
      if (weight < 0) {
        throw new RangeError(
          `round '${round.roundId}' has negative weight ${weight}`,
        )
      }
      return {
        roundId: round.roundId,
        value: round.value,
        weight,
        weightedValue: round.value === null ? null : round.value * weight,
        counted: false,
        status: round.status,
      }
    })

    const usable = contributions.filter(
      (c): c is RoundContribution & { weightedValue: number } =>
        c.weightedValue !== null,
    )
    const anyProvisional = contributions.some((c) => c.status === 'provisional')
    const needed = requiredRounds(aggregation, entity.rounds.length)

    // Choose the counting rounds. For best-r-of-n the weighted value decides
    // which rounds survive, so a weighted round is worth what it will actually
    // contribute rather than its raw score.
    let counting: Array<RoundContribution & { weightedValue: number }>
    if (aggregation.kind === 'best_r_of_n') {
      counting = [...usable]
        .sort((a, b) =>
          direction === 'asc'
            ? a.weightedValue - b.weightedValue
            : b.weightedValue - a.weightedValue,
        )
        .slice(0, aggregation.count)
    } else {
      counting = usable
    }
    for (const round of counting) round.counted = true

    let status: MultiRoundRow['status']
    let rankable = false
    let provisional = false

    if (entity.entityStatus && entity.entityStatus !== 'active') {
      status = entity.entityStatus
    } else if (usable.length < needed || anyProvisional) {
      // Not every required round has landed yet.
      if (phase === 'final') {
        status = 'no_return'
      } else {
        status = 'provisional'
        provisional = true
        // Live standings rank on what exists; §8.14 gives no basis for hiding
        // a partial multi-round entry mid-tournament.
        rankable = counting.length > 0
      }
    } else {
      status = 'complete'
      rankable = true
    }

    const total = counting.length
      ? counting.reduce((sum, c) => sum + c.weightedValue, 0)
      : null

    if (
      aggregation.kind === 'best_r_of_n' &&
      phase === 'final' &&
      usable.length < aggregation.count
    ) {
      warnings.push({
        code: 'MULTI_ROUND_INSUFFICIENT_ROUNDS',
        message:
          `Entity '${entity.entityId}' has ${usable.length} scoreable round(s) ` +
          `but the competition counts the best ${aggregation.count}; it cannot be ranked.`,
        context: { entityId: entity.entityId, available: usable.length, required: aggregation.count },
      })
    }

    const row: MultiRoundRow = {
      entityId: entity.entityId,
      total,
      roundsPlayed: usable.length,
      roundsCounted: counting.length,
      rank: null,
      isTied: false,
      provisional,
      status,
      contributions,
    }
    return { row, rankable }
  })

  // Rank on a side channel so `rankable` never has to live on the public row.
  const ranked = assignRanks(
    computed,
    (c) => (c.rankable && c.row.total !== null ? c.row.total : null),
    direction,
  )
  for (const placed of ranked) {
    placed.entry.row.rank = placed.rank
    placed.entry.row.isTied = placed.isTied
  }

  const rows = computed.map((c) => c.row)

  return {
    rows,
    warnings,
    provisional: rows.some((r) => r.provisional),
  }
}
