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
  /** competition_rounds.weight (positive, at most four decimals) — defaults to 1. */
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
  /**
   * Authoritative competition round IDs. Supplying these prevents an entrant
   * with an omitted round from making its own short input look complete.
   * Existing callers may omit the field; the union of observed IDs is then
   * inferred for backward compatibility.
   */
  expectedRoundIds?: readonly string[]
  /**
   * Authoritative round count when IDs are not available. When both fields are
   * supplied, the count must equal expectedRoundIds.length.
   */
  expectedRoundCount?: number
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

/** competition_rounds.weight is numeric(8, 4), so keep it integer-scaled. */
const WEIGHT_SCALE = 10_000
const MAX_WEIGHT_UNITS = 99_999_999

/** leaderboard_rows result columns are numeric(14, 6). */
const RESULT_SCALE = 1_000_000
const MAX_RESULT_UNITS = 99_999_999_999_999
const BIGINT_WEIGHT_SCALE = BigInt(WEIGHT_SCALE)
const BIGINT_MAX_RESULT_UNITS = BigInt(MAX_RESULT_UNITS)

interface ExpectedRounds {
  /** Present only when the caller supplied authoritative identities. */
  ids: ReadonlySet<string> | null
  count: number
}

interface WorkingContribution {
  contribution: RoundContribution
  /** Weighted value scaled to numeric(14, 6); never a float product. */
  weightedUnits: number | null
  usable: boolean
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer, got ${value}`)
  }
}

function resolveExpectedRounds(input: MultiRoundInput): ExpectedRounds {
  const { entities, expectedRoundCount, expectedRoundIds } = input

  if (expectedRoundCount !== undefined) {
    validatePositiveInteger(expectedRoundCount, 'expectedRoundCount')
  }

  if (expectedRoundIds !== undefined) {
    if (expectedRoundIds.length === 0) {
      throw new RangeError('expectedRoundIds must contain at least one round')
    }
    const ids = new Set<string>()
    for (const roundId of expectedRoundIds) {
      if (roundId.length === 0) {
        throw new RangeError('expectedRoundIds cannot contain an empty round ID')
      }
      if (ids.has(roundId)) {
        throw new RangeError(`expectedRoundIds contains duplicate round '${roundId}'`)
      }
      ids.add(roundId)
    }
    if (expectedRoundCount !== undefined && expectedRoundCount !== ids.size) {
      throw new RangeError(
        `expectedRoundCount ${expectedRoundCount} does not match ` +
          `expectedRoundIds length ${ids.size}`,
      )
    }
    return { ids, count: ids.size }
  }

  // Backward-compatible inference is competition-wide, never per entrant. A
  // per-entrant count lets a late two-round entry appear complete in a
  // three-round sum merely because its missing round was omitted entirely.
  const observedIds = new Set<string>()
  for (const entity of entities) {
    for (const round of entity.rounds) observedIds.add(round.roundId)
  }
  const count = expectedRoundCount ?? observedIds.size
  if (observedIds.size > count) {
    throw new RangeError(
      `observed ${observedIds.size} competition rounds, exceeding ` +
        `expectedRoundCount ${count}`,
    )
  }
  return { ids: null, count }
}

function scaledWeight(round: RoundResult): number {
  const weight = round.weight ?? 1
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new RangeError(
      `round '${round.roundId}' weight must be finite and greater than zero, got ${weight}`,
    )
  }
  const units = Math.round(weight * WEIGHT_SCALE)
  if (!Number.isSafeInteger(units) || units / WEIGHT_SCALE !== weight) {
    throw new RangeError(
      `round '${round.roundId}' weight must have at most four decimal places, got ${weight}`,
    )
  }
  if (units > MAX_WEIGHT_UNITS) {
    throw new RangeError(
      `round '${round.roundId}' weight is outside the numeric(8, 4) supported range`,
    )
  }
  return units
}

function scaledRoundValue(round: RoundResult): number | null {
  if (round.value === null) return null
  if (!Number.isFinite(round.value)) {
    throw new RangeError(
      `round '${round.roundId}' value must be finite or null, got ${round.value}`,
    )
  }

  const units = Math.round(round.value * RESULT_SCALE)
  if (!Number.isSafeInteger(units) || units / RESULT_SCALE !== round.value) {
    throw new RangeError(
      `round '${round.roundId}' value must have at most six decimal places, got ${round.value}`,
    )
  }
  if (Math.abs(units) > MAX_RESULT_UNITS) {
    throw new RangeError(
      `round '${round.roundId}' value is outside the numeric(14, 6) supported range`,
    )
  }
  return units
}

function scaledWeightedValue(
  round: RoundResult,
  valueUnits: number | null,
  weightUnits: number,
): number | null {
  if (valueUnits === null) return null

  // A six-decimal value times a four-decimal weight can carry ten decimal
  // places. Keep the full product until divisibility proves that reducing it
  // to the result column's six places would not round or truncate anything.
  const productUnits = BigInt(valueUnits) * BigInt(weightUnits)
  if (productUnits % BIGINT_WEIGHT_SCALE !== 0n) {
    throw new RangeError(
      `round '${round.roundId}' weighted value cannot be represented losslessly ` +
        'with six decimal places',
    )
  }

  const weightedUnits = productUnits / BIGINT_WEIGHT_SCALE
  if (
    weightedUnits > BIGINT_MAX_RESULT_UNITS ||
    weightedUnits < -BIGINT_MAX_RESULT_UNITS
  ) {
    throw new RangeError(
      `round '${round.roundId}' weighted value is outside the numeric(14, 6) supported range`,
    )
  }
  return Number(weightedUnits)
}

function sumWeightedValues(
  entityId: string,
  values: readonly number[],
): number | null {
  if (values.length === 0) return null

  let totalUnits = 0n
  for (const value of values) totalUnits += BigInt(value)
  if (
    totalUnits > BIGINT_MAX_RESULT_UNITS ||
    totalUnits < -BIGINT_MAX_RESULT_UNITS
  ) {
    throw new RangeError(
      `entity '${entityId}' weighted total is outside the numeric(14, 6) supported range`,
    )
  }
  return Number(totalUnits)
}

function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0
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

export function calculateMultiRound(input: MultiRoundInput): MultiRoundResult {
  const { entities, aggregation, phase } = input
  const warnings: EngineWarning[] = []
  const direction = aggregationDirection(aggregation)
  const expectedRounds = resolveExpectedRounds(input)

  if (aggregation.kind === 'best_r_of_n') {
    validatePositiveInteger(aggregation.count, 'best_r_of_n count')
  }

  const seen = new Set<string>()
  const computed = entities.map((entity) => {
    if (seen.has(entity.entityId)) {
      throw new RangeError(`duplicate entityId '${entity.entityId}'`)
    }
    seen.add(entity.entityId)

    const seenRounds = new Set<string>()
    const working: WorkingContribution[] = entity.rounds.map((round) => {
      if (round.roundId.length === 0) {
        throw new RangeError(`entity '${entity.entityId}' has an empty roundId`)
      }
      if (seenRounds.has(round.roundId)) {
        throw new RangeError(
          `entity '${entity.entityId}' has multiple results for round '${round.roundId}'`,
        )
      }
      seenRounds.add(round.roundId)
      if (expectedRounds.ids !== null && !expectedRounds.ids.has(round.roundId)) {
        throw new RangeError(
          `entity '${entity.entityId}' has result for unexpected round '${round.roundId}'`,
        )
      }

      const weightUnits = scaledWeight(round)
      const weight = weightUnits / WEIGHT_SCALE
      const valueUnits = scaledRoundValue(round)
      const weightedUnits = scaledWeightedValue(round, valueUnits, weightUnits)
      const contribution: RoundContribution = {
        roundId: round.roundId,
        value: round.value,
        weight,
        weightedValue:
          weightedUnits === null ? null : weightedUnits / RESULT_SCALE,
        counted: false,
        status: round.status,
      }
      return {
        contribution,
        weightedUnits,
        // A partial numeric subtotal attached to a terminal round status is
        // displayable history, not a scoreable completed round.
        usable:
          weightedUnits !== null &&
          (round.status === 'complete' || round.status === 'provisional'),
      }
    })

    const usable = working.filter(
      (c): c is WorkingContribution & { weightedUnits: number } =>
        c.usable && c.weightedUnits !== null,
    )
    const anyProvisional = working.some(
      (c) => c.contribution.status === 'provisional',
    )
    const usableRoundIds = new Set(
      usable.map((c) => c.contribution.roundId),
    )
    const hasEveryExpectedRound =
      usable.length >= expectedRounds.count &&
      (expectedRounds.ids === null ||
        [...expectedRounds.ids].every((roundId) => usableRoundIds.has(roundId)))
    const lacksRequiredRounds = aggregation.kind === 'best_r_of_n'
      ? usable.length < aggregation.count
      : !hasEveryExpectedRound

    // Choose the counting rounds. For best-r-of-n the weighted value decides
    // which rounds survive, so a weighted round is worth what it will actually
    // contribute rather than its raw score.
    let counting: Array<WorkingContribution & { weightedUnits: number }>
    if (aggregation.kind === 'best_r_of_n') {
      counting = [...usable]
        .sort((a, b) => {
          const comparison = compareNumbers(a.weightedUnits, b.weightedUnits)
          return direction === 'asc' ? comparison : -comparison
        })
        .slice(0, aggregation.count)
    } else {
      counting = usable
    }
    for (const round of counting) round.contribution.counted = true

    let status: MultiRoundRow['status']
    let rankable = false
    let provisional = false

    if (entity.entityStatus && entity.entityStatus !== 'active') {
      status = entity.entityStatus
    } else if (lacksRequiredRounds || anyProvisional) {
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

    const totalUnits = sumWeightedValues(
      entity.entityId,
      counting.map((c) => c.weightedUnits),
    )
    const total = totalUnits === null ? null : totalUnits / RESULT_SCALE

    if (
      aggregation.kind === 'best_r_of_n' &&
      phase === 'final' &&
      lacksRequiredRounds
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
      contributions: working.map((c) => c.contribution),
    }
    return { row, rankable, totalUnits }
  })

  // Rank on the integer-scaled side channel. Public decimal totals are for
  // display/serialization only and never feed back into comparisons.
  const ranked = assignRanks(
    computed,
    (c) => (c.rankable ? c.totalUnits : null),
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
