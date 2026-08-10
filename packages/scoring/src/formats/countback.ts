/**
 * Countback tie resolution (spec §8.15).
 *
 * "Default ties remain ties. Optional countback MUST be selected before
 * scoring and define an ordered sequence such as last 9, last 6, last 3,
 * hole 18, then tied. 'Last' follows the published competition hole order,
 * not necessarily course hole number. Any random draw is a manual Committee
 * decision recorded in audit; the application does not silently randomize."
 *
 * Three consequences are load-bearing and deliberately encoded here:
 *
 *   1. Segments walk the PUBLISHED order the caller passes in. This module
 *      never reads a course hole number, so a shotgun start or a nine that
 *      plays 10-18 breaks ties on the order actually played (§18: "competitive
 *      countback follows published competition order").
 *   2. When the sequence is exhausted the entities stay tied. There is no
 *      fallback ordering, no draw, and no stable-sort tiebreak masquerading as
 *      a result.
 *   3. `playoff` mode is NOT resolved here. A playoff is a real-world event
 *      whose outcome the Committee records; inventing one from card data would
 *      fabricate a result.
 */

import type { EngineWarning } from '../types.ts'

export interface CountbackEntity {
  entityId: string
  /**
   * Metric value per hole in PUBLISHED competition order — strokes for stroke
   * formats, points for Stableford/Par-Bogey. `null` marks a hole with no
   * usable score.
   */
  holeValues: readonly (number | null)[]
}

export interface CountbackInput {
  /** The tied entities to separate. Fewer than two is a no-op. */
  entities: readonly CountbackEntity[]
  /** Ordered segment tokens, e.g. ['last_9','last_6','last_3','hole_18']. */
  sequence: readonly string[]
  /** 'asc' when the lower total wins (strokes); 'desc' for points formats. */
  direction: 'asc' | 'desc'
}

export interface CountbackPlacement {
  entityId: string
  /** 0-based order within the group; equal values remain tied. */
  order: number
  /** True while this entity is still level with another after every segment. */
  stillTied: boolean
  /** Segment token that separated this entity, or null if never separated. */
  resolvedBy: string | null
}

export interface CountbackResult {
  placements: CountbackPlacement[]
  /** True when at least one pair remains level after the whole sequence. */
  unresolved: boolean
  warnings: EngineWarning[]
}

/** Hole indexes (0-based, published order) a segment token selects. */
export function segmentIndexes(token: string, holeCount: number): number[] | null {
  const last = /^last_(\d+)$/.exec(token)
  if (last) {
    const n = Number(last[1])
    if (n <= 0 || n > holeCount) return null
    return Array.from({ length: n }, (_, i) => holeCount - n + i)
  }
  // `hole_N` is the Nth hole of the PUBLISHED order. In a standard 18-hole
  // competition 'hole_18' is therefore the last hole played, which is what the
  // §8.15 example means; it is not a lookup of course hole number 18.
  const single = /^hole_(\d+)$/.exec(token)
  if (single) {
    const n = Number(single[1])
    if (n <= 0 || n > holeCount) return null
    return [n - 1]
  }
  return null
}

function segmentTotal(
  entity: CountbackEntity,
  indexes: readonly number[],
): number | null {
  let total = 0
  for (const i of indexes) {
    const value = entity.holeValues[i]
    // A missing hole makes the segment total unknowable. Treating it as zero
    // would hand the tie to the player with the least evidence.
    if (value === null || value === undefined) return null
    total += value
  }
  return total
}

/**
 * Separate one tied group. Returns placements in resolved order; entities that
 * never separate share an `order` and are flagged `stillTied`.
 */
export function resolveCountback(input: CountbackInput): CountbackResult {
  const { entities, sequence, direction } = input
  const warnings: EngineWarning[] = []

  if (entities.length < 2) {
    return {
      placements: entities.map((e) => ({
        entityId: e.entityId,
        order: 0,
        stillTied: false,
        resolvedBy: null,
      })),
      unresolved: false,
      warnings,
    }
  }

  // Safe: the < 2 case returned above, so there is at least one entity.
  const holeCount = (entities[0] as CountbackEntity).holeValues.length
  for (const entity of entities) {
    if (entity.holeValues.length !== holeCount) {
      throw new RangeError(
        `countback entity '${entity.entityId}' has ${entity.holeValues.length} holes, expected ${holeCount}`,
      )
    }
  }

  // Groups still level, each carrying the segment that last separated it.
  let groups: Array<{ members: CountbackEntity[]; resolvedBy: string | null }> = [
    { members: [...entities], resolvedBy: null },
  ]

  for (const token of sequence) {
    const indexes = segmentIndexes(token, holeCount)
    if (indexes === null) {
      warnings.push({
        code: 'COUNTBACK_SEGMENT_INVALID',
        message:
          `Countback segment '${token}' does not select holes within a ` +
          `${holeCount}-hole competition order and was skipped.`,
        context: { segment: token, holeCount },
      })
      continue
    }
    if (!groups.some((g) => g.members.length > 1)) break

    const next: typeof groups = []
    for (const group of groups) {
      if (group.members.length === 1) {
        next.push(group)
        continue
      }

      const totals: Array<{ member: CountbackEntity; total: number | null }> =
        group.members.map((m) => ({ member: m, total: segmentTotal(m, indexes) }))
      if (totals.some((t) => t.total === null)) {
        // Conservative by design: §8.15 is silent on incomplete cards, and
        // ranking a complete card above an incomplete one (or vice versa)
        // would be invented policy. The segment simply cannot decide.
        warnings.push({
          code: 'COUNTBACK_SEGMENT_INCOMPLETE',
          message:
            `Countback segment '${token}' could not be applied because at ` +
            `least one tied entity has no score for every hole in it.`,
          context: { segment: token },
        })
        next.push(group)
        continue
      }

      type Scored = { member: CountbackEntity; total: number }
      const sorted: Scored[] = (totals as Scored[])
        .slice()
        .sort((a, b) => (direction === 'asc' ? a.total - b.total : b.total - a.total))
      let run: Scored[] = []
      let runTotal: number | null = null
      for (const item of sorted) {
        if (runTotal !== null && item.total !== runTotal) {
          next.push({
            members: run.map((r) => r.member),
            resolvedBy: run.length === 1 ? token : group.resolvedBy,
          })
          run = []
        }
        run.push(item)
        runTotal = item.total
      }
      if (run.length > 0) {
        next.push({
          members: run.map((r) => r.member),
          resolvedBy: run.length === 1 ? token : group.resolvedBy,
        })
      }
    }
    groups = next
  }

  const placements: CountbackPlacement[] = []
  let order = 0
  for (const group of groups) {
    const stillTied = group.members.length > 1
    for (const member of group.members) {
      placements.push({
        entityId: member.entityId,
        order,
        stillTied,
        resolvedBy: stillTied ? null : group.resolvedBy,
      })
    }
    order += group.members.length
  }

  const unresolved = groups.some((g) => g.members.length > 1)
  if (unresolved && sequence.length > 0) {
    warnings.push({
      code: 'COUNTBACK_UNRESOLVED',
      message:
        'Countback did not separate every tied entity; the remaining ties ' +
        'stand. A playoff or draw is a Committee decision recorded in audit.',
    })
  }

  return { placements, unresolved, warnings }
}

export interface RankedEntity {
  entityId: string
  rank: number | null
  isTied: boolean
}

/**
 * Apply countback across a whole leaderboard: every shared rank is separated
 * independently, and ranks are renumbered so positions stay competition-legal
 * (1, 2, 3 …, with genuine remaining ties still sharing a rank).
 *
 * Unranked rows (rank null — withdrawn, no-return, ineligible) pass through
 * untouched: they were never in contention.
 */
export function applyCountback(
  ranked: readonly RankedEntity[],
  holeValuesById: ReadonlyMap<string, readonly (number | null)[]>,
  ties: { mode: 'tied' | 'countback' | 'playoff'; sequence: readonly string[] },
  direction: 'asc' | 'desc',
): { rows: RankedEntity[]; warnings: EngineWarning[] } {
  if (ties.mode !== 'countback' || ties.sequence.length === 0) {
    return { rows: [...ranked], warnings: [] }
  }

  const warnings: EngineWarning[] = []
  const byRank = new Map<number, RankedEntity[]>()
  const unranked: RankedEntity[] = []
  for (const row of ranked) {
    if (row.rank === null) unranked.push(row)
    else byRank.set(row.rank, [...(byRank.get(row.rank) ?? []), row])
  }

  const resolved: RankedEntity[] = []
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const group = byRank.get(rank) as RankedEntity[]
    if (group.length === 1) {
      resolved.push({ ...(group[0] as RankedEntity), isTied: false })
      continue
    }

    const entities: CountbackEntity[] = []
    let missing = false
    for (const row of group) {
      const values = holeValuesById.get(row.entityId)
      if (!values) {
        missing = true
        break
      }
      entities.push({ entityId: row.entityId, holeValues: values })
    }
    if (missing) {
      for (const row of group) resolved.push(row)
      continue
    }

    const result = resolveCountback({ entities, sequence: ties.sequence, direction })
    warnings.push(...result.warnings)

    const byId = new Map(group.map((r) => [r.entityId, r]))
    const ordered = [...result.placements].sort((a, b) => a.order - b.order)
    for (const placement of ordered) {
      const row = byId.get(placement.entityId) as RankedEntity
      resolved.push({
        ...row,
        // Offset within the shared block: a group sharing rank 3 occupies
        // 3, 4, 5 once separated.
        rank: rank + placement.order,
        isTied: placement.stillTied,
      })
    }
  }

  resolved.sort((a, b) => (a.rank as number) - (b.rank as number))
  return { rows: [...resolved, ...unranked], warnings }
}
