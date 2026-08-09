/**
 * Stableford and Modified Stableford (spec §8.5).
 *
 * relation = metric hole score - par, where the metric score is gross for
 * gross Stableford and net (gross - strokes received) for net Stableford.
 * Points come from a configurable ordered map keyed by integer relation —
 * never hardcoded result labels. A relation is clamped to the map's numeric
 * key bounds before lookup, so "eagle or better" and "double bogey or worse"
 * semantics emerge from the map edges. A clamped key that is still absent
 * falls back to `floorPoints`.
 *
 * A pickup/no-score/not-played hole receives `floorPoints` (default zero).
 * This is the one place the engine explicitly awards a configured value for
 * missing data (spec §7.3); everywhere else missing data stays provisional.
 * Live pending holes contribute null points and mark the entry provisional;
 * at finalization an unreturned hole resolves to the floor, because the
 * format's own rule ("no score" scores the floor) resolves the missing state
 * (spec §8.1, §8.5).
 *
 * Highest total points wins. Modified Stableford accepts any integer point
 * map, including negative values. Withdrawn/no-return/disqualified entities
 * remain visible but are never competitively ranked.
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
  StablefordRules,
} from '../types.ts'

export interface StablefordEntry {
  entryId: string
  entityStatus: EntityStatus
  /** Signed integer Playing Handicap; null when none is available. */
  playingHandicap: number | null
  scores: IndividualHoleScore[]
}

export interface StablefordInput {
  holes: HoleSnapshot[]
  metric: 'gross' | 'net'
  rules: StablefordRules
  entries: StablefordEntry[]
  phase: 'live' | 'final'
}

export interface StablefordHolePoints {
  entryId: string
  holeId: string
  /** Metric score minus par; null when no numeric metric score exists. */
  relation: number | null
  points: number | null
  provisional: boolean
}

export interface StablefordRow {
  entryId: string
  points: number
  thru: number
  rank: number | null
  isTied: boolean
  provisional: boolean
  status: EntityStatus | 'provisional' | 'complete'
}

export interface StablefordResult {
  rows: StablefordRow[]
  holePoints: StablefordHolePoints[]
  warnings: EngineWarning[]
  provisional: boolean
}

/** Terminal hole statuses that score the configured floor (spec §8.5). */
const FLOOR_STATUSES: ReadonlySet<HoleScoreStatus> = new Set([
  'picked_up',
  'no_score',
  'not_played',
  'conceded',
])

interface RelationBounds {
  min: number
  max: number
}

interface EntryComputation {
  entry: StablefordEntry
  points: number
  thru: number
  provisional: boolean
  rankable: boolean
  holePoints: StablefordHolePoints[]
}

export function calculateStableford(input: StablefordInput): StablefordResult {
  const warnings: EngineWarning[] = []
  const bounds = relationBounds(input.rules, warnings)
  const computations = input.entries.map((entry) =>
    computeEntry(entry, input, bounds, warnings),
  )
  const ranked = assignRanks(
    computations,
    (c) => (c.rankable ? c.points : null),
    'desc',
  )
  const rows: StablefordRow[] = ranked.map(({ entry: c, rank, isTied }) => ({
    entryId: c.entry.entryId,
    points: c.points,
    thru: c.thru,
    rank,
    isTied,
    provisional: c.provisional,
    status: rowStatus(c),
  }))
  return {
    rows,
    holePoints: computations.flatMap((c) => c.holePoints),
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
  input: StablefordInput,
  bounds: RelationBounds | null,
  warnings: EngineWarning[],
): EntryComputation {
  const active = entry.entityStatus === 'active'
  let strokesByHole: Map<string, number> | null = null
  let handicapMissing = false
  if (input.metric === 'net') {
    if (entry.playingHandicap === null) {
      handicapMissing = true
      warnings.push({
        code: 'STABLEFORD_NET_HANDICAP_MISSING',
        message:
          `entry ${entry.entryId} has no Playing Handicap; ` +
          'net Stableford points cannot be computed',
        context: { entryId: entry.entryId },
      })
    } else {
      strokesByHole = allocateStrokes(entry.playingHandicap, input.holes)
    }
  }
  const byHole = latestScores(entry.scores)
  const holePoints: StablefordHolePoints[] = []
  let points = 0
  let thru = 0
  let provisional = false
  for (const hole of input.holes) {
    const score = byHole.get(hole.id)
    if (score !== undefined && score.status !== 'not_started') thru += 1
    if (handicapMissing) {
      // Net metric without a handicap can never resolve; stays provisional
      // and unranked rather than coercing strokes received to zero.
      holePoints.push({
        entryId: entry.entryId,
        holeId: hole.id,
        relation: null,
        points: null,
        provisional: active,
      })
      if (active) provisional = true
      continue
    }
    const strokes = strokesByHole?.get(hole.id) ?? 0
    const computed = computeHole(hole, score, strokes)
    const hp = holePointsFor(entry.entryId, hole, computed, input, bounds, active)
    holePoints.push(hp)
    if (hp.points !== null) points += hp.points
    if (hp.provisional) provisional = true
  }
  return {
    entry,
    points,
    thru,
    provisional,
    rankable: active && !handicapMissing,
    holePoints,
  }
}

function holePointsFor(
  entryId: string,
  hole: HoleSnapshot,
  computed: HoleComputation,
  input: StablefordInput,
  bounds: RelationBounds | null,
  active: boolean,
): StablefordHolePoints {
  const base = { entryId, holeId: hole.id }
  if (computed.pending) {
    if (input.phase === 'live') {
      // A withdrawn/DQ entity's unplayed holes never pin the board.
      return { ...base, relation: null, points: null, provisional: active }
    }
    // Finalization: the format rule resolves an unreturned hole as a
    // no-score, which scores the configured floor (spec §8.5).
    return active
      ? { ...base, relation: null, points: input.rules.floorPoints, provisional: false }
      : { ...base, relation: null, points: null, provisional: false }
  }
  if (computed.status === 'complete') {
    const metricScore = input.metric === 'net' ? computed.net : computed.gross
    if (metricScore === null) {
      throw new RangeError(`complete hole ${hole.id} lacks a metric score`)
    }
    const relation = metricScore - hole.par
    return {
      ...base,
      relation,
      points: pointsForRelation(relation, input.rules, bounds),
      provisional: false,
    }
  }
  if (FLOOR_STATUSES.has(computed.status)) {
    return {
      ...base,
      relation: null,
      points: input.rules.floorPoints,
      provisional: false,
    }
  }
  // Hole-level withdrawn/disqualified: terminal, no award.
  return { ...base, relation: null, points: null, provisional: false }
}

function pointsForRelation(
  relation: number,
  rules: StablefordRules,
  bounds: RelationBounds | null,
): number {
  if (bounds === null) return rules.floorPoints
  const clamped = Math.min(Math.max(relation, bounds.min), bounds.max)
  const points = rules.pointsByRelation[clamped]
  return points === undefined ? rules.floorPoints : points
}

function relationBounds(
  rules: StablefordRules,
  warnings: EngineWarning[],
): RelationBounds | null {
  if (!Number.isInteger(rules.floorPoints)) {
    throw new RangeError(
      `floorPoints must be an integer, got ${rules.floorPoints}`,
    )
  }
  const keys: number[] = []
  for (const [key, value] of Object.entries(rules.pointsByRelation)) {
    const relation = Number(key)
    if (!Number.isInteger(relation)) {
      throw new RangeError(
        `pointsByRelation key '${key}' is not an integer relation`,
      )
    }
    if (!Number.isInteger(value)) {
      throw new RangeError(
        `pointsByRelation[${key}] must be an integer, got ${value}`,
      )
    }
    keys.push(relation)
  }
  if (keys.length === 0) {
    warnings.push({
      code: 'STABLEFORD_POINTS_MAP_EMPTY',
      message: 'pointsByRelation is empty; every relation falls back to floorPoints',
    })
    return null
  }
  return { min: Math.min(...keys), max: Math.max(...keys) }
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
