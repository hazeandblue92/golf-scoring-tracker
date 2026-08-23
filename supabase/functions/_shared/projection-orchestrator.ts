/**
 * Projection orchestrator (spec §7.1-7.2, §8).
 *
 * Maps each competition's frozen, validated `rules_json` onto the SAME pure
 * engine the browser uses for offline previews, then shapes the result into
 * the `publish_projections` payload. No scoring logic lives here — this file
 * only translates stored snapshot rows into engine inputs and engine outputs
 * into projection rows.
 */

import { rulesJsonSchema } from '../../../packages/contracts/src/index.ts'
import {
  ENGINE_VERSION,
  RULES_SCHEMA_VERSION,
  applyCountback,
  calculateBestBall,
  calculateMatch,
  calculateMultiRound,
  calculateParBogey,
  matchStrokeAllocation,
  calculateSkins,
  calculateStableford,
  calculateStrokePlay,
  calculateTeamAggregate,
  calculateTeamBallTotals,
  canonicalNumericResult,
  compare,
  playingHandicap,
  rational,
  resultHash,
  strokesReceivedOnHole,
  type CanonicalValue,
  type EntityStatus,
  type HoleScoreStatus,
  type HoleSnapshot,
  type IndividualHoleScore,
  type RoundingProfile,
  type MatchHoleInput,
  type MultiRoundAggregation,
  type MultiRoundEntity,
  type Rational,
  type RoundResult,
  type SkinsRules,
  type StablefordRules,
  type TeamHoleScore,
} from '../../../packages/scoring/src/index.ts'
import type { ScoringSnapshot } from './snapshot.ts'
import type { SnapshotEntry } from './snapshot.ts'

export interface ProjectionRow {
  entityId: string
  rank: number | null
  isTied: boolean
  thru: number | null
  resultPrimary: number | null
  resultSecondary: number | null
  displayPrimary: string | null
  status: string
  detail: Record<string, unknown>
}

export interface ProjectionHoleResult {
  entityId: string
  eventHoleId: string
  gross?: number | null
  strokesReceived?: number
  net?: number | null
  relativeToPar?: number | null
  status?: string | null
  provisional?: boolean
  contributorEntryIds?: string[]
  matchResult?: string | null
  skinUnits?: number | null
  skinCarriedUnits?: number | null
  skinWinner?: boolean | null
  detail?: Record<string, unknown>
}

export interface CompetitionProjectionPayload {
  competitionId: string
  engineVersion: string
  projectionHash: string
  status: 'live' | 'final' | 'error'
  warnings: Array<{ code: string; message: string }>
  summary: Record<string, unknown>
  rows: ProjectionRow[]
  holeResults: ProjectionHoleResult[]
}

export interface ProjectionPayload {
  competitions: CompetitionProjectionPayload[]
}

/** Entity status stored on an event entry/team mapped to the engine's enum. */
function toEntityStatus(status: string | null | undefined): EntityStatus {
  switch (status) {
    case 'withdrawn':
      return 'withdrawn'
    case 'disqualified':
      return 'disqualified'
    case 'no_return':
      return 'no_return'
    default:
      return 'active'
  }
}

/** Locale-independent code-unit ordering for canonical/deterministic IDs. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Appendix A points map -> engine StablefordRules.
 *
 * A key of the form "N+" means "N or worse". It therefore sets BOTH the
 * upper bound of the relation map and the floor: without the numeric bound
 * the engine would clamp a double bogey down to the bogey entry and award
 * bogey points.
 */
export function toStablefordRules(
  points: Record<string, number>,
): StablefordRules {
  const pointsByRelation: Record<number, number> = {}
  let floorPoints = 0
  let sawOrWorse = false
  for (const [key, value] of Object.entries(points)) {
    const orWorse = /^(\d+)\+$/.exec(key)
    if (orWorse) {
      const relation = Number(orWorse[1])
      pointsByRelation[relation] = value
      floorPoints = value
      sawOrWorse = true
    } else {
      pointsByRelation[Number(key)] = value
    }
  }
  if (!sawOrWorse) {
    // No explicit "or worse" bucket: the worst listed relation is the floor.
    const relations = Object.keys(pointsByRelation).map(Number)
    const worst = Math.max(...relations)
    floorPoints = pointsByRelation[worst] ?? 0
  }
  return { pointsByRelation, floorPoints }
}

/**
 * The competition's holes in published order.
 *
 * `hole_ordinal` is unique per ROUND, not per event, so a two-round event has
 * two holes numbered 1. Filtering on ordinal alone would merge both rounds,
 * interleave them by number, and re-rank stroke indexes across 36 holes —
 * corrupting allocation. Rounds therefore scope the set first, and holes are
 * ordered by (round, ordinal) so a multi-round competition plays in sequence.
 */
function holeSnapshots(
  snapshot: ScoringSnapshot,
  roundIds: readonly string[],
  holeScope: number[] | null,
): HoleSnapshot[] {
  const roundOrder = new Map(roundIds.map((id, i) => [id, i]))
  const scoped = snapshot.holes.filter(
    (h) =>
      (roundIds.length === 0 || roundOrder.has(h.round_id)) &&
      (holeScope === null || holeScope.length === 0 || holeScope.includes(h.hole_ordinal)),
  )
  const ordered = [...scoped].sort((a, b) => {
    const round = (roundOrder.get(a.round_id) ?? 0) - (roundOrder.get(b.round_id) ?? 0)
    return round !== 0 ? round : a.hole_ordinal - b.hole_ordinal
  })
  // Stroke indexes must be a permutation of 1..N for the competition's own
  // allocation set (§9.5). A full round already satisfies this; a subset is
  // re-ranked by its published indexes so allocation stays well-defined.
  const bySi = [...ordered].sort((a, b) => a.stroke_index - b.stroke_index)
  const siRank = new Map<string, number>()
  bySi.forEach((h, i) => siRank.set(h.id, i + 1))
  return ordered.map((h, i) => ({
    id: h.id,
    ordinal: i + 1,
    par: h.par,
    strokeIndex: siRank.get(h.id) ?? h.stroke_index,
  }))
}

function individualScoresFor(
  snapshot: ScoringSnapshot,
  entryId: string,
  holeIds: Set<string>,
): IndividualHoleScore[] {
  return snapshot.individualScores
    .filter((s) => s.event_entry_id === entryId && holeIds.has(s.event_hole_id))
    .map((s) => ({
      participantId: entryId,
      holeId: s.event_hole_id,
      ...(s.gross_strokes === null ? {} : { grossStrokes: s.gross_strokes }),
      status: s.score_status as HoleScoreStatus,
      revision: s.revision,
    }))
}

interface MatchScoreFact {
  gross: number | null
  status: HoleScoreStatus
}

interface MatchScoringUnit {
  /** Side-qualified, deterministic key (an entry could be on more than one team). */
  key: string
  attributionEntryId: string | null
  courseHandicap: Rational | null
  scores: Map<string, MatchScoreFact>
}

interface MatchSideSource {
  /** Best-ball selects AFTER per-player match strokes have been applied. */
  kind: 'single_ball' | 'best_ball'
  units: MatchScoringUnit[]
}

interface MatchSideHole {
  gross: number | null
  status: HoleScoreStatus | null
  comparison: number | null
  strokesReceived: number
  contributorEntryId: string | null
  concedesHole: boolean
}

interface MatchTeamSourceConfig {
  teamSize: number
  scoreSource: 'individual' | 'team_ball'
}

function courseHandicapForEntry(
  snapshot: ScoringSnapshot,
  entryId: string,
): Rational | null {
  const entry = snapshot.entries.find((candidate) => candidate.id === entryId)
  if (!entry || entry.course_handicap_unrounded === null) {
    // Backward-compatible fallback for old snapshots that predate frozen CH.
    return entry?.playing_handicap === null || entry?.playing_handicap === undefined
      ? null
      : rational(entry.playing_handicap)
  }
  return rational(
    Math.round(entry.course_handicap_unrounded * 1_000_000),
    1_000_000,
  )
}

function scoreFactsForEntry(
  snapshot: ScoringSnapshot,
  entryId: string,
  holeIds: ReadonlySet<string>,
): Map<string, MatchScoreFact> {
  const scores = new Map<string, MatchScoreFact>()
  for (const score of snapshot.individualScores) {
    if (score.event_entry_id !== entryId || !holeIds.has(score.event_hole_id)) continue
    scores.set(score.event_hole_id, {
      gross: score.gross_strokes,
      status: score.score_status as HoleScoreStatus,
    })
  }
  return scores
}

/**
 * Preserve every match ball until the comparison step. In four-ball this is
 * essential: relative match strokes belong to PLAYERS and must be applied
 * before selecting the side's best net ball (§8.6).
 */
function matchSideSource(
  snapshot: ScoringSnapshot,
  entityId: string,
  entity: { event_entry_id: string | null; event_team_id: string | null },
  holeIds: ReadonlySet<string>,
  teamConfig: MatchTeamSourceConfig | undefined,
): MatchSideSource {
  if (entity.event_entry_id) {
    return {
      kind: 'single_ball',
      units: [{
        key: `${entityId}:${entity.event_entry_id}`,
        attributionEntryId: entity.event_entry_id,
        courseHandicap: courseHandicapForEntry(snapshot, entity.event_entry_id),
        scores: scoreFactsForEntry(snapshot, entity.event_entry_id, holeIds),
      }],
    }
  }

  if (!entity.event_team_id) return { kind: 'single_ball', units: [] }
  const teamId = entity.event_team_id
  if (!teamConfig) {
    throw new RangeError(
      `match team side '${entityId}' requires frozen rules.team.scoreSource`,
    )
  }
  const memberEntryIds = snapshot.teamMembers
    .filter((member) => member.event_team_id === teamId)
    .map((member) => member.event_entry_id)
    .sort()
  if (memberEntryIds.length !== teamConfig.teamSize) {
    throw new RangeError(
      `match team side '${entityId}' has ${memberEntryIds.length} member(s), ` +
        `but frozen rules require ${teamConfig.teamSize}`,
    )
  }

  if (teamConfig.scoreSource === 'team_ball') {
    const team = snapshot.teams.find((candidate) => candidate.id === teamId)
    if (!team) {
      throw new RangeError(`match team-ball side '${entityId}' references missing team '${teamId}'`)
    }
    const scores = new Map<string, MatchScoreFact>()
    for (const score of snapshot.teamScores) {
      if (score.event_team_id !== teamId || !holeIds.has(score.event_hole_id)) continue
      scores.set(score.event_hole_id, {
        gross: score.gross_strokes,
        status: score.score_status as HoleScoreStatus,
      })
    }
    return {
      kind: 'single_ball',
      units: [{
        key: `${entityId}:${teamId}`,
        attributionEntryId: null,
        // Never normalize a team ball from its already-rounded Playing
        // Handicap. The exact frozen team CH is the match-play input.
        courseHandicap:
          team?.course_handicap_unrounded === null ||
            team?.course_handicap_unrounded === undefined
            ? null
            : rational(
                Math.round(team.course_handicap_unrounded * 1_000_000),
                1_000_000,
              ),
        scores,
      }],
    }
  }

  return {
    kind: 'best_ball',
    units: memberEntryIds.map((entryId) => ({
      key: `${entityId}:${entryId}`,
      attributionEntryId: entryId,
      courseHandicap: courseHandicapForEntry(snapshot, entryId),
      scores: scoreFactsForEntry(snapshot, entryId, holeIds),
    })),
  }
}

function groupIdsForMatchSide(
  snapshot: ScoringSnapshot,
  roundId: string,
  entity: { event_entry_id: string | null; event_team_id: string | null },
): string[] {
  const roundGroupIds = new Set(
    snapshot.groups
      .filter((group) => group.round_id === roundId)
      .map((group) => group.id),
  )
  return snapshot.groupMembers
    .filter((member) =>
      roundGroupIds.has(member.group_id) &&
      (entity.event_entry_id !== null
        ? member.event_entry_id === entity.event_entry_id
        : member.event_team_id === entity.event_team_id),
    )
    .map((member) => member.group_id)
    .sort(compareText)
}

/** Rotate course-ordered holes into the pairing's frozen shotgun play order. */
function matchHolesInPlayOrder(
  snapshot: ScoringSnapshot,
  roundId: string,
  a: { event_entry_id: string | null; event_team_id: string | null },
  b: { event_entry_id: string | null; event_team_id: string | null },
  holes: readonly HoleSnapshot[],
): HoleSnapshot[] {
  const groupsA = new Set(groupIdsForMatchSide(snapshot, roundId, a))
  const shared = groupIdsForMatchSide(snapshot, roundId, b)
    .filter((groupId) => groupsA.has(groupId))
  if (shared.length !== 1) {
    throw new RangeError(
      `match pairing in round '${roundId}' requires exactly one shared frozen group; ` +
        `found ${shared.length}`,
    )
  }
  const group = snapshot.groups.find((candidate) => candidate.id === shared[0])
  if (!group) {
    throw new RangeError(`match pairing references missing group '${shared[0]}'`)
  }
  if (group.start_hole_ordinal === null || holes.length < 2) return [...holes]
  // Engine ordinals are re-based to the competition's hole scope. The group
  // start, however, is a COURSE ordinal. Looking at `hole.ordinal` here makes
  // a scoped back nine (engine ordinals 1..9) ignore a hole-10 shotgun start.
  const courseOrdinalByHoleId = new Map(
    snapshot.holes.map((hole) => [hole.id, hole.hole_ordinal]),
  )
  const start = holes.findIndex(
    (hole) =>
      (courseOrdinalByHoleId.get(hole.id) ?? hole.ordinal) >=
        group.start_hole_ordinal!,
  )
  if (start <= 0) return [...holes]
  return [...holes.slice(start), ...holes.slice(0, start)]
}

function matchSideHole(
  source: MatchSideSource,
  holeId: string,
  useNet: boolean,
  strokesByUnit: ReadonlyMap<string, ReadonlyMap<string, number>>,
  comparisonAvailable = true,
): MatchSideHole {
  const candidates: Array<{
    unit: MatchScoringUnit
    fact: MatchScoreFact
    comparison: number
    strokesReceived: number
  }> = []
  const facts: MatchScoreFact[] = []

  for (const unit of source.units) {
    const fact = unit.scores.get(holeId)
    if (!fact) continue
    facts.push(fact)
    if (fact.status !== 'complete' || fact.gross === null) continue
    if (!comparisonAvailable) continue
    const strokesReceived = useNet
      ? (strokesByUnit.get(unit.key)?.get(holeId) ?? 0)
      : 0
    candidates.push({
      unit,
      fact,
      comparison: fact.gross - strokesReceived,
      strokesReceived,
    })
  }

  candidates.sort((a, b) =>
    a.comparison - b.comparison || compareText(a.unit.key, b.unit.key),
  )
  // Four-ball/best-ball cannot select its low score until every partner's ball
  // is resolved. A completed 5 does not represent the side while a missing
  // partner could still post 4; terminal non-numeric facts are resolved and
  // therefore do not block selection from the remaining completed balls.
  const unresolvedUnit = source.units.some((unit) => {
    const fact = unit.scores.get(holeId)
    return !fact || fact.status === 'not_started' ||
      (fact.status === 'complete' && fact.gross === null)
  })
  const selected = candidates[0]
  if (selected && (source.kind === 'single_ball' || !unresolvedUnit)) {
    return {
      gross: selected.fact.gross,
      status: selected.fact.status,
      comparison: selected.comparison,
      strokesReceived: selected.strokesReceived,
      contributorEntryId: selected.unit.attributionEntryId,
      concedesHole: false,
    }
  }

  const concessionStatuses = facts.filter(
    (fact) => fact.status === 'conceded' || fact.status === 'picked_up',
  )
  const concedesHole = source.kind === 'single_ball'
    ? concessionStatuses.length > 0
    : facts.length === source.units.length && facts.length > 0 &&
      concessionStatuses.length === facts.length
  const preservedStatus = concedesHole
    ? concessionStatuses.map((fact) => fact.status).sort()[0] ?? null
    : source.kind === 'single_ball' && facts.length === 1
      ? facts[0]?.status ?? null
      : null
  const unavailableSingleFact = !comparisonAvailable && source.kind === 'single_ball'
    ? source.units[0]?.scores.get(holeId)
    : undefined
  return {
    gross:
      unavailableSingleFact?.status === 'complete'
        ? unavailableSingleFact.gross
        : null,
    status: unavailableSingleFact?.status ?? preservedStatus,
    comparison: null,
    strokesReceived: 0,
    contributorEntryId:
      unavailableSingleFact?.status === 'complete'
        ? source.units[0]?.attributionEntryId ?? null
        : null,
    concedesHole,
  }
}

/**
 * True when `roundId` falls at or after `fromRoundId` in the EVENT'S
 * authoritative round order. The effective round need not itself be linked to
 * a competition (for example, a R1+R3 aggregate with a R2 substitution).
 */
function roundIsAtOrAfter(
  eventRoundNumberById: ReadonlyMap<string, number>,
  roundId: string,
  fromRoundId: string,
): boolean {
  const at = eventRoundNumberById.get(roundId)
  const from = eventRoundNumberById.get(fromRoundId)
  if (at === undefined || from === undefined) {
    throw new RangeError(
      `substitution references unknown event round: current '${roundId}', effective '${fromRoundId}'`,
    )
  }
  return at >= from
}

/**
 * Re-rank rows inside each flight so every flight has its own rank 1
 * (§5.2 flight/division results). Rows the engine left unranked — withdrawn,
 * no-return, ineligible — stay unranked; they were never in contention.
 */
function rankWithinFlights(
  rows: readonly ProjectionRow[],
  flightOf: ReadonlyMap<string, string | null>,
  direction: 'asc' | 'desc',
): ProjectionRow[] {
  const groups = new Map<string, ProjectionRow[]>()
  const unranked: ProjectionRow[] = []
  for (const row of rows) {
    if (row.rank === null || row.resultPrimary === null) {
      unranked.push(row)
      continue
    }
    const key = flightOf.get(row.entityId)
    if (!key) {
      // An incomplete flight assignment is not a real division. Keep its
      // overall placement in detail, but do not silently create a phantom
      // "unassigned" flight with its own winner.
      unranked.push({ ...row, rank: null, isTied: false })
      continue
    }
    groups.set(key, [...(groups.get(key) ?? []), row])
  }

  const ranked: ProjectionRow[] = []
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => {
      const left = a.resultPrimary as number
      const right = b.resultPrimary as number
      const primary = direction === 'asc' ? left - right : right - left
      if (primary !== 0) return primary
      // Overall countback ran first. Its rank is the deterministic secondary
      // key inside a flight; unresolved overall ties still share that rank.
      return (a.rank ?? Number.MAX_SAFE_INTEGER) -
          (b.rank ?? Number.MAX_SAFE_INTEGER) ||
        compareText(a.entityId, b.entityId)
    })
    const placementKey = (row: ProjectionRow): string =>
      `${row.resultPrimary as number}:${row.rank ?? 'unranked'}`
    const counts = new Map<string, number>()
    for (const row of sorted) {
      const key = placementKey(row)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    let position = 1
    let previous: number | undefined
    let previousOverallRank: number | null | undefined
    let previousRank = 1
    for (const row of sorted) {
      const value = row.resultPrimary as number
      const samePlacement = value === previous && row.rank === previousOverallRank
      const rank = samePlacement ? previousRank : position
      ranked.push({
        ...row,
        rank,
        isTied: (counts.get(placementKey(row)) ?? 0) > 1,
      })
      previous = value
      previousOverallRank = row.rank
      previousRank = rank
      position += 1
    }
  }
  return [...ranked, ...unranked]
}

/**
 * The §8.14 aggregation a competition declares, or null when it is a single
 * round. `metric` decides the basis: points tables rank high, strokes low.
 */
function multiRoundAggregation(
  rules: {
    format: string
    metric: 'gross' | 'net' | 'points'
    multiRound?: { aggregation: string; count?: number }
  },
): MultiRoundAggregation | null {
  const config = rules.multiRound
  if (!config) return null
  if (rules.format === 'match' && config.aggregation !== 'match_points') {
    throw new RangeError(
      `match competitions require multiRound aggregation 'match_points', got '${config.aggregation}'`,
    )
  }
  if (rules.format !== 'match' && config.aggregation === 'match_points') {
    throw new RangeError(
      `multiRound aggregation 'match_points' is only valid for match competitions, got '${rules.format}'`,
    )
  }
  // Stableford, Par/Bogey, and skins totals are always high-wins result values,
  // even when their per-hole comparison metric is gross or net.
  const pointsBased = rules.metric === 'points' || rules.format === 'stableford' ||
    rules.format === 'par_bogey' || rules.format === 'skins'
  switch (config.aggregation) {
    case 'match_points':
      return { kind: 'match_points' }
    case 'best_r_of_n':
      return {
        kind: 'best_r_of_n',
        count: config.count ?? 1,
        basis: pointsBased ? 'points' : 'strokes',
      }
    case 'sum':
      return pointsBased ? { kind: 'sum_points' } : { kind: 'sum_strokes' }
    default:
      return null
  }
}

function teamScoresFor(
  snapshot: ScoringSnapshot,
  teamId: string,
  holeIds: Set<string>,
): TeamHoleScore[] {
  return snapshot.teamScores
    .filter((s) => s.event_team_id === teamId && holeIds.has(s.event_hole_id))
    .map((s) => ({
      teamId,
      holeId: s.event_hole_id,
      ...(s.gross_strokes === null ? {} : { grossStrokes: s.gross_strokes }),
      status: s.score_status as HoleScoreStatus,
      revision: s.revision,
    }))
}

function displayTotal(total: number | null, par: number): string | null {
  if (total === null) return null
  const rel = total - par
  return rel === 0 ? 'E' : rel > 0 ? `+${rel}` : String(rel)
}

/** Derive the PH from the frozen unrounded CH and this competition's rules. */
function competitionPlayingHandicap(
  entry: SnapshotEntry,
  handicap: {
    profile: 'usga_whs_2024' | 'committee_custom' | 'none'
    allowance: number
    rounding:
      | 'half_up_toward_positive_infinity'
      | {
          kind: 'committee_custom'
          intermediatePrecision: number
          tieDirection: 'up' | 'down' | 'toward_zero' | 'away_from_zero'
          stepOrder: 'allowance_then_round' | 'round_then_allowance'
        }
  },
): number | null {
  // Gross formats ignore this value for ranking, but retain the roster's
  // frozen 100% PH for the established secondary net-total display.
  if (handicap.profile === 'none') return entry.playing_handicap
  if (entry.course_handicap_unrounded === null) return entry.playing_handicap

  const courseHandicap = rational(
    Math.round(entry.course_handicap_unrounded * 1_000_000),
    1_000_000,
  )
  const allowance = rational(Math.round(handicap.allowance * 1_000_000), 1_000_000)
  const rounding: RoundingProfile =
    handicap.rounding === 'half_up_toward_positive_infinity'
      ? { kind: 'usga_whs_2024' }
      : handicap.rounding
  return playingHandicap(courseHandicap, allowance, rounding).playingHandicap
}

/**
 * Canonical summary for hashing (spec §7.3). Only safe integers and strings
 * enter the hash so the digest is byte-stable across platforms.
 */
function hashOf(
  competitionId: string,
  rows: ProjectionRow[],
  eventRevision: number,
): string {
  const canonical: CanonicalValue = {
    competitionId,
    engineVersion: ENGINE_VERSION,
    rulesSchemaVersion: RULES_SCHEMA_VERSION,
    eventRevision,
    rows: [...rows]
      // Match competitions can legitimately publish the same entity once per
      // round before aggregation. Detail discriminators order those rows but
      // remain outside the established canonical hash shape.
      .sort((a, b) =>
        compareText(a.entityId, b.entityId) ||
        compareText(
          typeof a.detail.roundId === 'string' ? a.detail.roundId : '',
          typeof b.detail.roundId === 'string' ? b.detail.roundId : '',
        ) ||
        compareText(
          typeof a.detail.matchId === 'string' ? a.detail.matchId : '',
          typeof b.detail.matchId === 'string' ? b.detail.matchId : '',
        ),
      )
      .map((r) => ({
        entityId: r.entityId,
        rank: r.rank,
        isTied: r.isTied,
        thru: r.thru,
        resultPrimary: canonicalNumericResult(r.resultPrimary),
        resultSecondary: canonicalNumericResult(r.resultSecondary),
        status: r.status,
      })),
  }
  return resultHash(canonical)
}

export interface BuildProjectionOptions {
  /**
   * Calculate one not-yet-sealed competition under final missing-data policy.
   * The finalization workflow uses this to publish the exact artifact it will
   * subsequently seal, without relabelling every other live competition.
   */
  finalCompetitionId?: string
}

export function buildProjections(
  snapshot: ScoringSnapshot,
  options: BuildProjectionOptions = {},
): ProjectionPayload {
  const competitions: CompetitionProjectionPayload[] = []
  const eventRoundNumberById = new Map(
    snapshot.rounds.map((round) => [round.id, round.round_number]),
  )

  for (const competition of snapshot.competitions) {
    // A finalized competition's projection hash is a sealed artifact at its
    // final event revision. Later scoring revisions for other competitions in
    // the event must not create a replacement row for that sealed result.
    if (competition.status === 'finalized') continue
    const phase: 'live' | 'final' =
      options.finalCompetitionId === competition.id
        ? 'final'
        : 'live'
    const warnings: Array<{ code: string; message: string }> = []
    const declaredEntities = snapshot.competitionEntities.filter(
      (e) => e.competition_id === competition.id,
    )
    // Eligibility is a competition-level fact, distinct from the event entry
    // or team lifecycle status. Only eligible entities may affect winners,
    // carries, match sides, or ranks; pending/ineligible rows remain visible as
    // inert audit/detail rows below.
    const entities = declaredEntities.filter(
      (entity) => entity.eligibility_status === 'eligible',
    )
    const excludedEntities = declaredEntities.filter(
      (entity) => entity.eligibility_status !== 'eligible',
    )

    const parsed = rulesJsonSchema.safeParse(competition.rules_json)
    if (!parsed.success) {
      competitions.push({
        competitionId: competition.id,
        engineVersion: ENGINE_VERSION,
        projectionHash: hashOf(competition.id, [], snapshot.event.scoring_revision),
        status: 'error',
        warnings: [
          {
            code: 'RULES_INVALID',
            message: `rules_json failed validation: ${parsed.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; ')}`,
          },
        ],
        summary: {},
        rows: [],
        holeResults: [],
      })
      continue
    }
    const rules = parsed.data
    if (
      competition.format !== rules.format ||
      competition.metric !== rules.metric ||
      competition.rules_schema_version !== rules.schemaVersion ||
      competition.rules_schema_version !== RULES_SCHEMA_VERSION
    ) {
      const mismatches = [
        ...(competition.format === rules.format
          ? []
          : [`format column '${competition.format}' != rules '${rules.format}'`]),
        ...(competition.metric === rules.metric
          ? []
          : [`metric column '${competition.metric}' != rules '${rules.metric}'`]),
        ...(competition.rules_schema_version === rules.schemaVersion
          ? []
          : [
              `rules_schema_version column '${competition.rules_schema_version}' ` +
              `!= rules '${rules.schemaVersion}'`,
            ]),
        ...(competition.rules_schema_version === RULES_SCHEMA_VERSION
          ? []
          : [
              `rules_schema_version '${competition.rules_schema_version}' ` +
              `is unsupported by engine schema '${RULES_SCHEMA_VERSION}'`,
            ]),
      ]
      competitions.push({
        competitionId: competition.id,
        engineVersion: ENGINE_VERSION,
        projectionHash: hashOf(competition.id, [], snapshot.event.scoring_revision),
        status: 'error',
        warnings: [{
          code: 'RULES_COLUMN_MISMATCH',
          message: `frozen competition columns disagree with rules_json: ${mismatches.join('; ')}`,
        }],
        summary: {},
        rows: [],
        holeResults: [],
      })
      continue
    }

    // Every competition must declare its exact round scope. Falling back to
    // every event hole would let a malformed restore silently change the
    // frozen Terms of Competition and produce a plausible but false result.
    const compRounds = snapshot.competitionRounds.filter(
      (cr) => cr.competition_id === competition.id,
    )
    if (compRounds.length === 0) {
      competitions.push({
        competitionId: competition.id,
        engineVersion: ENGINE_VERSION,
        projectionHash: hashOf(competition.id, [], snapshot.event.scoring_revision),
        status: 'error',
        warnings: [{
          code: 'RULES_INVALID',
          message:
            'competition has no declared competition_rounds scope; results ' +
            'cannot fall back to event-wide holes',
        }],
        summary: {},
        rows: [],
        holeResults: [],
      })
      continue
    }
    const roundIds = compRounds.map((cr) => cr.round_id)
    // Each competition_round owns its own scope. Concatenating independently
    // scoped rounds preserves published order without leaking round one's
    // front/back-nine selection into every later round.
    const allHoles = compRounds.flatMap((cr) =>
      holeSnapshots(
        snapshot,
        [cr.round_id],
        cr.hole_scope ?? rules.holeScope ?? null,
      ),
    )

    // entity id lookups: engine works in entry/team ids, projections store
    // competition_entities.id.
    const entityByEntry = new Map<string, string>()
    const entityByTeam = new Map<string, string>()
    for (const e of entities) {
      if (e.event_entry_id) entityByEntry.set(e.event_entry_id, e.id)
      if (e.event_team_id) entityByTeam.set(e.event_team_id, e.id)
    }
    const entityOfEntry = new Map(entityByEntry)
    const entryOfEntity = new Map<string, string>()
    for (const entity of entities) {
      if (entity.event_entry_id) entryOfEntity.set(entity.id, entity.event_entry_id)
    }
    const entryById = new Map(snapshot.entries.map((entry) => [entry.id, entry]))
    const slotOf = (entityId: string): string => {
      let entryId = entryOfEntity.get(entityId)
      const seen = new Set<string>()
      while (entryId && !seen.has(entryId)) {
        seen.add(entryId)
        const replaced = entryById.get(entryId)?.replaces_entry_id ?? null
        if (!replaced) break
        const replacedEntity = entityOfEntry.get(replaced)
        if (!replacedEntity) break
        entityId = replacedEntity
        entryId = replaced
      }
      return entityId
    }
    const chainDepthOf = (entityId: string): number => {
      let entryId = entryOfEntity.get(entityId)
      const seen = new Set<string>()
      let depth = 0
      while (entryId && !seen.has(entryId)) {
        seen.add(entryId)
        const replaced = entryById.get(entryId)?.replaces_entry_id ?? null
        if (!replaced) break
        depth += 1
        entryId = replaced
      }
      return depth
    }
    const supersededFrom = new Map<string, string>()
    for (const entry of snapshot.entries) {
      if (entry.replaces_entry_id && entry.effective_from_round_id) {
        supersededFrom.set(entry.replaces_entry_id, entry.effective_from_round_id)
      }
    }
    const entityHoldsRound = (
      entity: (typeof entities)[number],
      roundId: string,
    ): boolean => {
      if (!entity.event_entry_id) return true
      const entry = entryById.get(entity.event_entry_id)
      if (!entry) return true
      if (
        entry.effective_from_round_id &&
        !roundIsAtOrAfter(eventRoundNumberById, roundId, entry.effective_from_round_id)
      ) {
        return false
      }
      const supersededAt = supersededFrom.get(entry.id)
      return !supersededAt ||
        !roundIsAtOrAfter(eventRoundNumberById, roundId, supersededAt)
    }

    const metric = rules.metric === 'points' ? 'net' : rules.metric

    /**
     * One scoring pass over a hole set.
     *
     * For a single-round competition that is the whole competition. For a
     * multi-round one it is a SINGLE round, so §8.14 can aggregate rounds that
     * were each scored under their own handicap allocation — the alternative,
     * scoring one merged 36-hole card, would spread a player's Playing
     * Handicap across both rounds and allocate strokes to stroke indexes
     * 1..36 that no scorecard has.
     */
    const computeForHoles = (
      holes: HoleSnapshot[],
      roundId: string | null,
      applyCurrentEntityStatus = true,
    ) => {
      const scoringEntities = roundId === null
        ? entities
        : entities.filter((entity) => entityHoldsRound(entity, roundId))
      const holeIds = new Set(holes.map((h) => h.id))
      const parTotal = holes.reduce((sum, h) => sum + h.par, 0)
      let rows: ProjectionRow[] = []
      let holeResults: ProjectionHoleResult[] = []
      let provisional = false

      switch (rules.format) {
        case 'individual_stroke': {
          const entries = scoringEntities
            .filter((e) => e.event_entry_id)
            .map((e) => {
              const entry = snapshot.entries.find((x) => x.id === e.event_entry_id)!
              return {
                entryId: entry.id,
                entityStatus: applyCurrentEntityStatus
                  ? toEntityStatus(entry.status)
                  : 'active',
                playingHandicap: competitionPlayingHandicap(entry, rules.handicap),
                scores: individualScoresFor(snapshot, entry.id, holeIds),
              }
            })
          const result = calculateStrokePlay({
            holes,
            metric: metric as 'gross' | 'net',
            entries,
            phase,
          })
          provisional = result.provisional
          warnings.push(...result.warnings.map((w) => ({ code: w.code, message: w.message })))
          rows = result.rows.map((r) => {
            const primary = metric === 'net' ? r.netTotal : r.grossTotal
            return {
              entityId: entityByEntry.get(r.entryId) ?? r.entryId,
              rank: r.rank,
              isTied: r.isTied,
              thru: r.thru,
              resultPrimary: primary,
              resultSecondary: metric === 'net' ? r.grossTotal : r.netTotal,
              displayPrimary: displayTotal(primary, parTotal),
              status: r.status,
              detail: { grossTotal: r.grossTotal, netTotal: r.netTotal },
            }
          })
          holeResults = result.holeResults.map((h) => ({
            entityId: entityByEntry.get(h.entityId) ?? h.entityId,
            eventHoleId: h.holeId,
            gross: h.gross,
            strokesReceived: h.strokesReceived,
            net: h.net,
            relativeToPar: h.relativeToPar,
            status: h.status,
            provisional: h.provisional,
          }))
          break
        }

        // Shamble joins these two deliberately: §8.11 says that after the
        // selected drive players complete their own balls and the hole is
        // scored "as best k of m or team aggregate using explicit individual
        // hole scores" — precisely this path. It needs no engine of its own.
        case 'best_k':
        case 'shamble':
        case 'aggregate': {
          if (rules.format !== 'best_k' && rules.team.scoreSource !== 'individual') {
            throw new RangeError(
              `${rules.format} requires individual member scores`,
            )
          }
          const teams = scoringEntities
            .filter((e) => e.event_team_id)
            .map((e) => {
              const team = snapshot.teams.find((t) => t.id === e.event_team_id)!
              const memberEntryIds = snapshot.teamMembers
                .filter((m) => m.event_team_id === team.id)
                .map((m) => m.event_entry_id)
              return {
                teamId: team.id,
                entityStatus: applyCurrentEntityStatus
                  ? toEntityStatus(team.status)
                  : 'active',
                members: memberEntryIds.map((entryId) => {
                  const entry = snapshot.entries.find((x) => x.id === entryId)!
                  return {
                    participantId: entry.id,
                    playingHandicap: competitionPlayingHandicap(entry, rules.handicap),
                    scores: individualScoresFor(snapshot, entry.id, holeIds),
                  }
                }),
              }
            })
          const commonInput = {
            holes,
            metric: metric as 'gross' | 'net',
            teams,
            phase,
          }
          // "All scores count" is the aggregate engine; anything narrower is
          // best-ball selection. A shamble organizer picks either by setting
          // bestK, so the format alone does not decide.
          const countsEveryMember =
            rules.format === 'aggregate' ||
            (rules.format === 'shamble' && rules.team.bestK === rules.team.teamSize)
          const result = countsEveryMember
            ? calculateTeamAggregate({
                ...commonInput,
                teamSize: rules.team.teamSize,
                bestK: rules.team.bestK,
              })
            : calculateBestBall({
                ...commonInput,
                bestK: rules.team.bestK,
              })
          provisional = result.provisional
          warnings.push(...result.warnings.map((w) => ({ code: w.code, message: w.message })))
          rows = result.rows.map((r) => ({
            entityId: entityByTeam.get(r.teamId) ?? r.teamId,
            rank: r.rank,
            isTied: r.isTied,
            thru: r.thru,
            resultPrimary: r.total,
            resultSecondary: null,
            displayPrimary: displayTotal(r.total, parTotal),
            status: r.status,
            detail: {
              aggregation: rules.team.bestK === rules.team.teamSize
                ? 'all_scores_count'
                : 'best_k',
              bestK: rules.team.bestK,
              teamSize: rules.team.teamSize,
            },
          }))
          holeResults = result.teamHoles.map((h) => ({
            entityId: entityByTeam.get(h.teamId) ?? h.teamId,
            eventHoleId: h.holeId,
            gross: h.teamScore,
            provisional: h.provisional,
            contributorEntryIds: h.contributorIds,
            detail: { holeStatus: h.status },
          }))
          break
        }

        case 'stableford': {
          const entries = scoringEntities
            .filter((e) => e.event_entry_id)
            .map((e) => {
              const entry = snapshot.entries.find((x) => x.id === e.event_entry_id)!
              return {
                entryId: entry.id,
                entityStatus: applyCurrentEntityStatus
                  ? toEntityStatus(entry.status)
                  : 'active',
                playingHandicap: competitionPlayingHandicap(entry, rules.handicap),
                scores: individualScoresFor(snapshot, entry.id, holeIds),
              }
            })
          const result = calculateStableford({
            holes,
            metric: metric as 'gross' | 'net',
            rules: toStablefordRules(rules.points as Record<string, number>),
            entries,
            phase,
          })
          provisional = result.provisional
          warnings.push(...result.warnings.map((w) => ({ code: w.code, message: w.message })))
          rows = result.rows.map((r) => ({
            entityId: entityByEntry.get(r.entryId) ?? r.entryId,
            rank: r.rank,
            isTied: r.isTied,
            thru: r.thru,
            resultPrimary: r.points,
            resultSecondary: null,
            displayPrimary: `${r.points} pts`,
            status: r.status,
            detail: {},
          }))
          // Per-hole points drive the scorecard and are the values §8.15
          // counts back on for a points competition.
          holeResults = result.holePoints.map((h) => ({
            entityId: entityByEntry.get(h.entryId) ?? h.entryId,
            eventHoleId: h.holeId,
            relativeToPar: h.relation,
            provisional: h.provisional,
            detail: { points: h.points },
          }))
          break
        }

        case 'par_bogey': {
          const entries = scoringEntities
            .filter((e) => e.event_entry_id)
            .map((e) => {
              const entry = snapshot.entries.find((x) => x.id === e.event_entry_id)!
              return {
                entryId: entry.id,
                entityStatus: applyCurrentEntityStatus
                  ? toEntityStatus(entry.status)
                  : 'active',
                playingHandicap: competitionPlayingHandicap(entry, rules.handicap),
                scores: individualScoresFor(snapshot, entry.id, holeIds),
              }
            })
          const result = calculateParBogey({
            holes,
            metric: metric as 'gross' | 'net',
            entries,
            phase,
          })
          provisional = result.provisional
          warnings.push(...result.warnings.map((w) => ({ code: w.code, message: w.message })))
          rows = result.rows.map((r) => ({
            entityId: entityByEntry.get(r.entryId) ?? r.entryId,
            rank: r.rank,
            isTied: r.isTied,
            thru: r.thru,
            resultPrimary: r.result,
            resultSecondary: null,
            displayPrimary: r.result > 0 ? `+${r.result}` : String(r.result),
            status: r.status,
            detail: {},
          }))
          holeResults = result.holeResults.map((holeResult) => ({
            entityId: entityByEntry.get(holeResult.entryId) ?? holeResult.entryId,
            eventHoleId: holeResult.holeId,
            gross: holeResult.gross,
            ...(holeResult.strokesReceived === null
              ? {}
              : { strokesReceived: holeResult.strokesReceived }),
            net: holeResult.net,
            status: holeResult.status,
            provisional: holeResult.provisional,
            detail: { points: holeResult.outcome },
          }))
          break
        }

        case 'skins': {
          // Skins run on individual entries under the frozen population rule;
          // team populations use the team ball score.
          const useTeams = rules.skins.population === 'teams'
          const skinEntries = useTeams
            ? scoringEntities
                .filter((e) => e.event_team_id)
                .map((e) => {
                  const team = snapshot.teams.find((t) => t.id === e.event_team_id)!
                  const scores = teamScoresFor(snapshot, team.id, holeIds)
                  if (metric === 'net' && team.playing_handicap === null) {
                    warnings.push({
                      code: 'SKINS_NET_HANDICAP_MISSING',
                      message:
                        `Team '${team.id}' has no frozen Playing Handicap; ` +
                        'its net skins values remain unresolved.',
                    })
                  }
                  return {
                    entityId: team.id,
                    eligible: !applyCurrentEntityStatus ||
                      toEntityStatus(team.status) === 'active',
                    holeScores: holes.map((h) => {
                      const s = scores.find((x) => x.holeId === h.id)
                      const gross = s?.grossStrokes ?? null
                      const score = metric === 'net'
                        ? gross === null || team.playing_handicap === null
                          ? null
                          : gross - strokesReceivedOnHole(
                              team.playing_handicap,
                              holes.length,
                              h.strokeIndex,
                            )
                        : gross
                      return {
                        holeId: h.id,
                        score,
                        terminal: s !== undefined && s.status !== 'complete' && s.status !== 'not_started',
                      }
                    }),
                  }
                })
            : scoringEntities
                .filter((e) => e.event_entry_id)
                .map((e) => {
                  const entry = snapshot.entries.find((x) => x.id === e.event_entry_id)!
                  const scores = individualScoresFor(snapshot, entry.id, holeIds)
                  const playingHandicapValue = competitionPlayingHandicap(
                    entry,
                    rules.handicap,
                  )
                  if (metric === 'net' && playingHandicapValue === null) {
                    warnings.push({
                      code: 'SKINS_NET_HANDICAP_MISSING',
                      message:
                        `Entry '${entry.id}' has no frozen Playing Handicap; ` +
                        'its net skins values remain unresolved.',
                    })
                  }
                  return {
                    entityId: entry.id,
                    eligible: !applyCurrentEntityStatus ||
                      toEntityStatus(entry.status) === 'active',
                    holeScores: holes.map((h) => {
                      const s = scores.find((x) => x.holeId === h.id)
                      const gross = s?.grossStrokes ?? null
                      let score: number | null =
                        metric === 'net' && playingHandicapValue === null
                          ? null
                          : gross
                      if (score !== null && metric === 'net' && playingHandicapValue !== null) {
                        score =
                          score -
                          strokesReceivedOnHole(
                            playingHandicapValue,
                            holes.length,
                            h.strokeIndex,
                          )
                      }
                      return {
                        holeId: h.id,
                        score,
                        terminal:
                          s !== undefined && s.status !== 'complete' && s.status !== 'not_started',
                      }
                    }),
                  }
                })
          const skinsRules: SkinsRules = {
            population: rules.skins.population,
            carryMode: rules.skins.carryMode,
            unitsPerHole: rules.skins.unitsPerHole,
            finalCarry: rules.skins.finalCarry,
            fractionalUnits: rules.skins.fractionalUnits ?? false,
          }
          const lookup = useTeams ? entityByTeam : entityByEntry

          // §8.7: skins run on a DEFINED population. 'field' is one pool, but
          // 'flight' means an independent pool (and independent carry) per
          // flight — pooling them would let a player in one flight take a skin
          // off someone they never competed against.
          const skinFlightOf = new Map<string, string | null>()
          for (const entity of scoringEntities) {
            const engineId = entity.event_team_id ?? entity.event_entry_id
            if (!engineId) continue
            const entry = entity.event_entry_id
              ? snapshot.entries.find((x) => x.id === entity.event_entry_id)
              : undefined
            const team = entity.event_team_id
              ? snapshot.teams.find((x) => x.id === entity.event_team_id)
              : undefined
            skinFlightOf.set(
              engineId,
              entity.flight_id ?? entry?.flight_id ?? team?.flight_id ?? null,
            )
          }

          let pools: Array<typeof skinEntries> = [skinEntries]
          if (rules.skins.population === 'flight') {
            const keys = [...new Set(skinEntries.map((e) => skinFlightOf.get(e.entityId) ?? null))]
            if (keys.length === 1 && keys[0] === null) {
              provisional = true
              warnings.push({
                code: 'SKINS_FLIGHT_NOT_ASSIGNED',
                message:
                  'Skins population is per flight but no entrant has a flight ' +
                  'assigned; the whole field shares one pool.',
              })
            } else {
              if (keys.includes(null)) {
                provisional = true
                warnings.push({
                  code: 'SKINS_FLIGHT_ASSIGNMENTS_INCOMPLETE',
                  message:
                    'Some skins entrants have no flight assignment. They are ' +
                    'kept in an explicit unassigned fallback pool so they do ' +
                    'not affect a named flight carry.',
                })
              }
              pools = keys.map((key) =>
                skinEntries.filter((e) => (skinFlightOf.get(e.entityId) ?? null) === key),
              )
            }
          } else if (rules.skins.population === 'group') {
            const roundIdsForHoles = new Set(
              snapshot.holes
                .filter((hole) => holeIds.has(hole.id))
                .map((hole) => hole.round_id),
            )
            const eligibleGroupIds = new Set(
              snapshot.groups
                .filter((group) => roundIdsForHoles.has(group.round_id))
                .map((group) => group.id),
            )
            const groupIdsByEntry = new Map<string, string[]>()
            for (const member of snapshot.groupMembers) {
              if (!eligibleGroupIds.has(member.group_id)) continue
              // A frozen tee group may store its four individuals directly or
              // store the two event teams that make up the group. Group skins
              // are an individual population, so expand team membership here
              // without changing the authoritative group facts.
              const memberEntryIds = member.event_entry_id
                ? [member.event_entry_id]
                : member.event_team_id
                  ? snapshot.teamMembers
                      .filter((teamMember) =>
                        teamMember.event_team_id === member.event_team_id
                      )
                      .map((teamMember) => teamMember.event_entry_id)
                  : []
              for (const entryId of memberEntryIds) {
                const existing = groupIdsByEntry.get(entryId) ?? []
                groupIdsByEntry.set(entryId, [...existing, member.group_id])
              }
            }
            for (const entry of skinEntries) {
              const memberships = [...new Set(groupIdsByEntry.get(entry.entityId) ?? [])]
                .sort(compareText)
              if (memberships.length > 1) {
                throw new RangeError(
                  `skins entry '${entry.entityId}' belongs to multiple groups ` +
                    `for the same competition round: ${memberships.join(', ')}`,
                )
              }
            }
            const keys = [...new Set(
              skinEntries.map((entry) => groupIdsByEntry.get(entry.entityId)?.[0] ?? null),
            )]
            if (keys.length === 1 && keys[0] === null) {
              provisional = true
              warnings.push({
                code: 'SKINS_GROUP_NOT_ASSIGNED',
                message:
                  'Skins population is per group but no entrant has a frozen ' +
                  'group assignment; the whole field shares one fallback pool.',
              })
            } else {
              if (keys.includes(null)) {
                provisional = true
                warnings.push({
                  code: 'SKINS_GROUP_ASSIGNMENTS_INCOMPLETE',
                  message:
                    'Some skins entrants have no group assignment. They are kept ' +
                    'in an explicit unassigned fallback pool so they do not affect ' +
                    'a named group carry.',
                })
              }
              pools = keys.map((key) =>
                skinEntries.filter(
                  (entry) => (groupIdsByEntry.get(entry.entityId)?.[0] ?? null) === key,
                ),
              )
            }
          }

          for (const pool of pools) {
            if (pool.length === 0) continue
            const result = calculateSkins({
              holes,
              entries: pool,
              rules: skinsRules,
              phase,
            })
            if (result.provisional) provisional = true
            warnings.push(
              ...result.warnings.map((w) => ({ code: w.code, message: w.message })),
            )
            const poolRows: ProjectionRow[] = result.totals.map((t) => ({
              entityId: lookup.get(t.entityId) ?? t.entityId,
              rank: null,
              isTied: false,
              thru: null,
              resultPrimary: t.units,
              resultSecondary: null,
              displayPrimary: `${t.units}`,
              // An unresolved carry makes the round provisional. This matters
              // especially to multi-round aggregation, which must not treat a
              // partial units total as a completed round contribution.
              status: result.provisional ? 'provisional' : 'complete',
              detail: {},
            }))
            rows.push(...poolRows)
            // A carry/tie belongs to the pool, not a player, while the current
            // hole_results key requires an entity. Use a stable placeholder
            // and mark it explicitly below; skinWinner=false prevents display
            // or downstream code from treating this as an award.
            const deterministicPlaceholder = poolRows
              .map((row) => row.entityId)
              .sort()[0] ?? ''
            holeResults.push(
              ...result.holeOutcomes
                .map((o) => ({
                  entityId: o.winnerId
                    ? (lookup.get(o.winnerId) ?? o.winnerId)
                    : deterministicPlaceholder,
                  eventHoleId: o.holeId,
                  skinUnits: o.unitsAwarded,
                  skinCarriedUnits: o.poolCarriedIn,
                  skinWinner: o.winnerId !== null,
                  provisional: o.status === 'provisional',
                  detail: {
                    outcome: o.status,
                    ...(o.winnerId === null ? { attribution: 'pool_placeholder' } : {}),
                  },
                }))
                .filter((h) => h.entityId !== ''),
            )
          }
          break
        }

        case 'scramble':
        case 'foursomes':
        case 'greensomes':
        case 'chapman': {
          const teams = scoringEntities
            .filter((e) => e.event_team_id)
            .map((e) => {
              const team = snapshot.teams.find((t) => t.id === e.event_team_id)!
              return {
                teamId: team.id,
                entityStatus: applyCurrentEntityStatus
                  ? toEntityStatus(team.status)
                  : 'active',
                teamPlayingHandicap: team.playing_handicap,
                scores: teamScoresFor(snapshot, team.id, holeIds),
              }
            })
          const result = calculateTeamBallTotals({
            holes,
            metric: metric as 'gross' | 'net',
            teams,
            phase,
          })
          provisional = result.provisional
          warnings.push(...result.warnings.map((w) => ({ code: w.code, message: w.message })))
          rows = result.rows.map((r) => {
            const primary = metric === 'net' ? r.netTotal : r.grossTotal
            return {
              entityId: entityByTeam.get(r.teamId) ?? r.teamId,
              rank: r.rank,
              isTied: r.isTied,
              thru: r.thru,
              resultPrimary: primary,
              resultSecondary: metric === 'net' ? r.grossTotal : r.netTotal,
              displayPrimary: displayTotal(primary, parTotal),
              status: r.status,
              detail: { grossTotal: r.grossTotal, netTotal: r.netTotal },
            }
          })
          holeResults = result.holeResults.map((h) => ({
            entityId: entityByTeam.get(h.entityId) ?? h.entityId,
            eventHoleId: h.holeId,
            gross: h.gross,
            strokesReceived: h.strokesReceived,
            net: h.net,
            relativeToPar: h.relativeToPar,
            status: h.status,
            provisional: h.provisional,
          }))
          break
        }

        case 'match': {
          // Pairings live in `matches`; each side is a competition_entity, so
          // one code path covers individual, best-ball, and team-ball matches
          // (§8.6). One projection row per SIDE per match carries that match's
          // state, because a player in a bracket has a standing per match.
          const entityById = new Map(scoringEntities.map((e) => [e.id, e]))
          const pairings = snapshot.matches.filter(
            (m) =>
              m.competition_id === competition.id &&
              (roundId === null || m.round_id === roundId),
          )
          if (pairings.length === 0) {
            warnings.push({
              code: 'MATCH_NO_PAIRINGS',
              message:
                'No match pairings exist for this competition; publish creates ' +
                'them before scoring can produce standings.',
            })
            provisional = true
          }

          const allowance = rational(
            Math.round(rules.handicap.allowance * 1_000_000),
            1_000_000,
          )
          // The WHS default token maps to the association profile, matching
          // competitionPlayingHandicap above.
          const rounding: RoundingProfile =
            rules.handicap.rounding === 'half_up_toward_positive_infinity'
              ? { kind: 'usga_whs_2024' }
              : rules.handicap.rounding

          const seenSides = new Set<string>()
          const usesMatchPoints = rules.multiRound?.aggregation === 'match_points'

          for (const pairing of pairings) {
            const a = pairing.side_a_entity_id
              ? entityById.get(pairing.side_a_entity_id)
              : undefined
            const b = pairing.side_b_entity_id
              ? entityById.get(pairing.side_b_entity_id)
              : undefined
            if (!a || !b) {
              // A one-sided bracket remains unresolved until the Committee
              // records an explicit walkover. Once recorded, the sole present
              // side is authoritative and receives the same deterministic
              // match-points win as a two-sided walkover. Never infer a bye
              // from the missing side alone.
              const present = a ?? b
              if (!present) {
                provisional = true
                warnings.push({
                  code: 'MATCH_EMPTY_PAIRING',
                  message: `Match '${pairing.id}' has no assigned side and remains unresolved.`,
                })
                continue
              }
              if (seenSides.has(present.id)) {
                throw new RangeError(
                  `round '${roundId ?? pairing.round_id}' contains more than one ` +
                  `match for side '${present.id}'`,
                )
              }
              seenSides.add(present.id)
              const recordedWalkover = pairing.status === 'walkover' &&
                pairing.winner_entity_id === present.id
              if (!recordedWalkover) {
                provisional = true
                warnings.push({
                  code: 'MATCH_OPEN_BRACKET_SLOT',
                  message:
                    `Match '${pairing.id}' has one assigned side but no ` +
                    'authoritative walkover; the pairing remains unresolved.',
                })
                continue
              }
              rows.push({
                entityId: present.id,
                rank: null,
                isTied: false,
                thru: 0,
                resultPrimary: usesMatchPoints ? 2 : 0,
                resultSecondary: 0,
                displayPrimary: 'Walkover',
                status: 'complete',
                detail: {
                  matchId: pairing.id,
                  roundId: pairing.round_id,
                  opponentEntityId: null,
                  matchStatus: 'won',
                  matchPoints: 2,
                  holesUp: 0,
                  holesRemaining: 0,
                  dormie: false,
                  outcome: 'won',
                  lifecycleStatus: 'walkover',
                  ...(pairing.bracket_position === null
                    ? {}
                    : { bracketPosition: pairing.bracket_position }),
                },
              })
              continue
            }

            // A side may play only one match in a given round. Enforcing that
            // invariant here guarantees exactly one match-points contribution
            // per side/round instead of letting input order decide which one
            // survives aggregation.
            if (seenSides.has(a.id) || seenSides.has(b.id)) {
              throw new RangeError(
                `round '${roundId ?? pairing.round_id}' contains more than one ` +
                `match for side '${seenSides.has(a.id) ? a.id : b.id}'`,
              )
            }
            seenSides.add(a.id)
            seenSides.add(b.id)

            const matchHoles = matchHolesInPlayOrder(
              snapshot,
              pairing.round_id,
              a,
              b,
              holes,
            )
            const sourceA = matchSideSource(snapshot, a.id, a, holeIds, rules.team)
            const sourceB = matchSideSource(snapshot, b.id, b, holeIds, rules.team)
            const allUnits = [...sourceA.units, ...sourceB.units]

            // §8.6: normalize every scoring ball from the LOWEST exact CH in
            // the match. For four-ball that means four independent player
            // allocations; the best net ball is selected only afterwards.
            const strokesByUnit = new Map<string, ReadonlyMap<string, number>>()
            const useNet = metric === 'net'
            let netComparisonAvailable = true
            if (useNet) {
              const handicaps = allUnits.map((unit) => unit.courseHandicap)
              if (allUnits.length === 0 || handicaps.some((ch) => ch === null)) {
                netComparisonAvailable = false
                warnings.push({
                  code: 'MATCH_NET_HANDICAP_MISSING',
                  message:
                    `Match '${pairing.id}' cannot be scored net because a ball ` +
                    'has no frozen unrounded Course Handicap; comparisons remain unresolved.',
                })
              } else {
                const exactHandicaps = handicaps as Rational[]
                const lowest = exactHandicaps.reduce((current, candidate) =>
                  compare(candidate, current) < 0 ? candidate : current,
                )
                for (const unit of allUnits) {
                  const allocation = matchStrokeAllocation({
                    courseHandicapA: lowest,
                    courseHandicapB: unit.courseHandicap as Rational,
                    allowance,
                    rounding,
                    holes: matchHoles,
                  })
                  strokesByUnit.set(unit.key, allocation.strokesB)
                }
              }
            }

            const holeFacts = matchHoles.map((hole) => ({
              hole,
              a: matchSideHole(
                sourceA,
                hole.id,
                useNet,
                strokesByUnit,
                netComparisonAvailable,
              ),
              b: matchSideHole(
                sourceB,
                hole.id,
                useNet,
                strokesByUnit,
                netComparisonAvailable,
              ),
            }))
            const holeInputs: MatchHoleInput[] = holeFacts.map(({ hole, a: holeA, b: holeB }) => {
              const concession = holeA.concedesHole && !holeB.concedesHole
                ? 'to_b' as const
                : holeB.concedesHole && !holeA.concedesHole
                  ? 'to_a' as const
                  : undefined
              return {
                holeId: hole.id,
                a: holeA.comparison,
                b: holeB.comparison,
                ...(concession ? { concession } : {}),
              }
            })

            // Treat a stored winner as authoritative only when it is one of
            // this pairing's sides. The database enforces the same invariant,
            // but keeping the projection boundary defensive prevents a
            // malformed snapshot from awarding the match to side B merely
            // because an unrelated id was not side A.
            const authoritativeWinner = pairing.winner_entity_id === a.id
              ? 'a' as const
              : pairing.winner_entity_id === b.id
                ? 'b' as const
                : null
            const conceded = pairing.status === 'conceded' && authoritativeWinner
              ? { winner: authoritativeWinner }
              : undefined

            let state = calculateMatch({
              holes: matchHoles,
              holeInputs,
              extraHolesAllowed: false,
              ...(conceded ? { matchConcession: conceded } : {}),
            })

            // `matches.status` is the Committee's terminal match lifecycle.
            // Walkovers and confirmed complete results can legitimately have
            // no hole scores, so deriving terminal state only from hole facts
            // would leave the projection live while finalization considers
            // the match finished. Preserve any computed holes-up detail, but
            // make the stored terminal result authoritative for win/half and
            // the deterministic 2/1/0 match-points table.
            if (
              (pairing.status === 'walkover' || pairing.status === 'complete') &&
              authoritativeWinner
            ) {
              const label = authoritativeWinner === 'a' ? 'A' : 'B'
              state = {
                ...state,
                status: 'won',
                winner: authoritativeWinner,
                display: `${label} wins (${pairing.status})`,
                dormie: false,
              }
            } else if (pairing.status === 'complete' && authoritativeWinner === null) {
              state = {
                ...state,
                status: 'halved',
                winner: null,
                display: 'Halved (complete)',
                dormie: false,
              }
            }

            const lifecycleUnfinished =
              !['complete', 'conceded', 'walkover'].includes(pairing.status) ||
              ((pairing.status === 'conceded' || pairing.status === 'walkover') &&
                authoritativeWinner === null)
            if (state.status === 'in_progress' || lifecycleUnfinished) {
              provisional = true
            }

            const sideRow = (
              entityId: string,
              opponentId: string,
              side: 'a' | 'b',
            ): ProjectionRow => {
              const up = side === 'a' ? state.holesUp : -state.holesUp
              const won = state.winner !== null && state.winner === side
              const lost = state.winner !== null && state.winner !== side
              // Multi-round match play aggregates a frozen 2/1/0 table:
              // win (including concession) = 2, half = 1, loss = 0. A live
              // match has no points yet. Holes-up remains in detail/display.
              const matchPoints = state.status === 'in_progress'
                ? null
                : state.status === 'halved'
                  ? 1
                  : won
                    ? 2
                    : 0
              return {
                entityId,
                // Bracket standings are not a stroke leaderboard; ordering is
                // by bracket position, so rank stays null rather than implying
                // a field ranking that does not exist.
                rank: null,
                isTied: false,
                thru: state.outcomes.filter((o) => o.winner !== null).length,
                resultPrimary: usesMatchPoints ? matchPoints : up,
                resultSecondary: state.holesRemaining,
                displayPrimary: state.display,
                status:
                  state.status === 'in_progress' || lifecycleUnfinished
                    ? 'provisional'
                    : 'complete',
                detail: {
                  matchId: pairing.id,
                  roundId: pairing.round_id,
                  opponentEntityId: opponentId,
                  matchStatus: state.status,
                  matchPoints,
                  holesUp: up,
                  holesRemaining: state.holesRemaining,
                  dormie: state.dormie,
                  outcome: won
                    ? 'won'
                    : lost
                      ? 'lost'
                      : state.status === 'halved'
                        ? 'halved'
                        : 'in_progress',
                  ...(pairing.bracket_position === null
                    ? {}
                    : { bracketPosition: pairing.bracket_position }),
                },
              }
            }

            rows.push(sideRow(a.id, b.id, 'a'))
            rows.push(sideRow(b.id, a.id, 'b'))

            for (const outcome of state.outcomes) {
              if (outcome.winner === null) continue
              const facts = holeFacts.find((candidate) => candidate.hole.id === outcome.holeId)
              if (!facts) continue
              holeResults.push({
                entityId: a.id,
                eventHoleId: outcome.holeId,
                gross: facts.a.gross,
                strokesReceived: facts.a.strokesReceived,
                net: useNet ? facts.a.comparison : null,
                status: facts.a.status,
                matchResult:
                  outcome.winner === 'half' ? 'half' : outcome.winner === 'a' ? 'win' : 'loss',
                ...(facts.a.contributorEntryId
                  ? { contributorEntryIds: [facts.a.contributorEntryId] }
                  : {}),
                detail: { matchId: pairing.id, roundId: pairing.round_id },
              })
              holeResults.push({
                entityId: b.id,
                eventHoleId: outcome.holeId,
                gross: facts.b.gross,
                strokesReceived: facts.b.strokesReceived,
                net: useNet ? facts.b.comparison : null,
                status: facts.b.status,
                matchResult:
                  outcome.winner === 'half' ? 'half' : outcome.winner === 'b' ? 'win' : 'loss',
                ...(facts.b.contributorEntryId
                  ? { contributorEntryIds: [facts.b.contributorEntryId] }
                  : {}),
                detail: { matchId: pairing.id, roundId: pairing.round_id },
              })
            }
          }

          const unpairedEntities = scoringEntities.filter(
            (entity) => !seenSides.has(entity.id),
          )
          if (unpairedEntities.length > 0) {
            provisional = true
          }
          break
        }

        default: {
          // Every format in the rules_json union is wired above, so this is an
          // exhaustiveness guard rather than a deferral. `never` makes adding a
          // format to the union without wiring it a compile error, not a
          // silently provisional leaderboard.
          const unwired: never = rules
          warnings.push({
            code: 'ENGINE_FORMAT_UNWIRED',
            message:
              `format '${(unwired as { format?: string }).format ?? 'unknown'}' ` +
              'has no projection wiring',
          })
          provisional = true
        }
      }

      return { rows, holeResults, provisional }
    }

    let rows: ProjectionRow[] = []
    let holeResults: ProjectionHoleResult[] = []
    let provisional = false
    // Hole-result attribution remains the player who actually scored. This
    // separate lookup only tells countback which continuous substitution slot
    // owns that historical value.
    const countbackEntityOf = new Map<string, string>()
    for (const entity of entities) {
      countbackEntityOf.set(entity.id, slotOf(entity.id))
    }

    try {
      if (compRounds.length > 1 && rules.multiRound === undefined) {
        throw new RangeError(
          `competition spans ${compRounds.length} rounds but rules_json has no multiRound aggregation`,
        )
      }
      if (compRounds.length < 2 && rules.multiRound !== undefined) {
        throw new RangeError(
          `competition declares multiRound aggregation but is linked to ${compRounds.length} round(s)`,
        )
      }

      // §8.14 multi-round: score each round on its own holes, then aggregate.
      // Only competitions that actually span rounds AND declare an aggregation
      // take this path; a one-round competition is unchanged.
      const aggregation = multiRoundAggregation(rules)
      if (aggregation && compRounds.length > 1) {
        const perRound = compRounds.map((cr) => ({
          roundId: cr.round_id,
          weight: Number(cr.weight ?? 1),
          // Each round gets its OWN holeSnapshots pass so ordinals restart at 1
          // and stroke indexes re-rank within that round. Filtering the merged
          // set instead would leave round two allocating on indexes 19..36.
          result: computeForHoles(
            holeSnapshots(snapshot, [cr.round_id], cr.hole_scope ?? rules.holeScope ?? null),
            cr.round_id,
            false,
          ),
        }))

        // §8.14 substitutions: aggregate each effective holder under the root
        // competition entity while keeping per-hole attribution on the player
        // who actually recorded the round.
        const byEntity = new Map<string, MultiRoundEntity>()
        const roundDetailBySlot = new Map<string, Map<string, Record<string, unknown>>>()
        const entityStatusFor = (entityId: string): EntityStatus => {
          const entity = entities.find((candidate) => candidate.id === entityId)
          const entry = entity?.event_entry_id
            ? snapshot.entries.find((candidate) => candidate.id === entity.event_entry_id)
            : undefined
          const team = entity?.event_team_id
            ? snapshot.teams.find((candidate) => candidate.id === entity.event_team_id)
            : undefined
          return toEntityStatus(entry?.status ?? team?.status)
        }

        // Resolve status from the current holder of a substitution slot. A
        // later active substitute keeps the slot rankable; a direct entrant
        // (or latest holder) that withdrew/was DQ'd remains visible unranked.
        const statusBySlot = new Map<
          string,
          {
            effectiveOrder: number
            chainDepth: number
            sourceEntityId: string
            status: EntityStatus
          }
        >()
        for (const sourceEntity of entities) {
          const slot = slotOf(sourceEntity.id)
          countbackEntityOf.set(sourceEntity.id, slot)
          const entry = sourceEntity.event_entry_id
            ? snapshot.entries.find(
                (candidate) => candidate.id === sourceEntity.event_entry_id,
              )
            : undefined
          const effectiveOrder = entry?.effective_from_round_id
            ? eventRoundNumberById.get(entry.effective_from_round_id)
            : Number.MIN_SAFE_INTEGER
          if (effectiveOrder === undefined) {
            throw new RangeError(
              `substitution entry '${entry?.id ?? sourceEntity.event_entry_id ?? sourceEntity.id}' ` +
                `references unknown effective round ` +
                `'${entry?.effective_from_round_id ?? 'unknown'}'`,
            )
          }
          const chainDepth = chainDepthOf(sourceEntity.id)
          const current = statusBySlot.get(slot)
          if (
            !current ||
            effectiveOrder > current.effectiveOrder ||
            (effectiveOrder === current.effectiveOrder && chainDepth > current.chainDepth) ||
            (effectiveOrder === current.effectiveOrder &&
              chainDepth === current.chainDepth &&
              compareText(sourceEntity.id, current.sourceEntityId) < 0)
          ) {
            statusBySlot.set(slot, {
              effectiveOrder,
              chainDepth,
              sourceEntityId: sourceEntity.id,
              status: entityStatusFor(sourceEntity.id),
            })
          }
        }

        // Initialize every declared slot so authoritative expected-round
        // validation can flag a missing pairing/result instead of dropping it.
        for (const [slot, status] of statusBySlot) {
          if (!byEntity.has(slot)) {
            byEntity.set(slot, {
              entityId: slot,
              rounds: [],
              entityStatus: status.status,
            })
          }
        }

        for (const round of perRound) {
          if (round.result.provisional) provisional = true
          holeResults.push(...round.result.holeResults)
          for (const row of round.result.rows) {
            const entryId = entryOfEntity.get(row.entityId)
            const entry = entryId
              ? snapshot.entries.find((e) => e.id === entryId)
              : undefined
            // An entry that had not joined yet contributes nothing to the
            // rounds before its effective round — it did not play them, and a
            // no-return there would wrongly cost the slot a counting round.
            if (
              entry?.effective_from_round_id &&
              entry.effective_from_round_id !== round.roundId &&
              !roundIsAtOrAfter(
                eventRoundNumberById,
                round.roundId,
                entry.effective_from_round_id,
              )
            ) {
              continue
            }
            const supersededAt = entryId ? supersededFrom.get(entryId) : undefined
            if (
              supersededAt &&
              roundIsAtOrAfter(eventRoundNumberById, round.roundId, supersededAt)
            ) {
              continue
            }
            const slot = slotOf(row.entityId)
            countbackEntityOf.set(row.entityId, slot)
            let entity = byEntity.get(slot)
            if (!entity) {
              entity = {
                entityId: slot,
                rounds: [],
                entityStatus: entityStatusFor(slot),
              }
              byEntity.set(slot, entity)
            }
            ;(entity.rounds as RoundResult[]).push({
              roundId: round.roundId,
              value: row.resultPrimary,
              weight: round.weight,
              status:
                row.status === 'complete'
                  ? 'complete'
                  : row.status === 'provisional'
                    ? 'provisional'
                    : (row.status as RoundResult['status']),
            })
            let details = roundDetailBySlot.get(slot)
            if (!details) {
              details = new Map()
              roundDetailBySlot.set(slot, details)
            }
            details.set(round.roundId, row.detail)
          }
        }

        const aggregated = calculateMultiRound({
          entities: [...byEntity.values()],
          aggregation,
          phase,
          expectedRoundIds: roundIds,
        })
        warnings.push(
          ...aggregated.warnings.map((w) => ({ code: w.code, message: w.message })),
        )
        if (aggregated.provisional) provisional = true

        rows = aggregated.rows.map((row) => ({
          entityId: row.entityId,
          rank: row.rank,
          isTied: row.isTied,
          thru: row.roundsCounted,
          resultPrimary: row.total,
          resultSecondary: row.roundsPlayed,
          displayPrimary: row.total === null ? null : String(row.total),
          status: row.status,
          detail: {
            aggregation: aggregation.kind,
            roundsPlayed: row.roundsPlayed,
            roundsCounted: row.roundsCounted,
            // Dropped rounds stay visible: §8.14 forbids deleted rows
            // rewriting history, so the scorecard can strike them through.
            rounds: row.contributions.map((c) => ({
              roundId: c.roundId,
              value: c.value,
              weight: c.weight,
              counted: c.counted,
              ...(roundDetailBySlot.get(row.entityId)?.get(c.roundId)
                ? { detail: roundDetailBySlot.get(row.entityId)?.get(c.roundId) }
                : {}),
            })),
          },
        }))
      } else {
        const roundIdsForHoles = [...new Set(
          snapshot.holes
            .filter((hole) => allHoles.some((scoped) => scoped.id === hole.id))
            .map((hole) => hole.round_id),
        )]
        const singleRoundContext = compRounds.length === 1
          ? compRounds[0]?.round_id ?? null
          : roundIdsForHoles.length === 1
            ? roundIdsForHoles[0] ?? null
            : null
        const single = computeForHoles(
          allHoles,
          singleRoundContext,
        )
        rows = single.rows.map((row) => ({
          ...row,
          entityId: slotOf(row.entityId),
        }))
        const seenSlots = new Set<string>()
        for (const row of rows) {
          if (seenSlots.has(row.entityId)) {
            throw new RangeError(
              `single-round substitution slot '${row.entityId}' has multiple ` +
              'effective scoring holders',
            )
          }
          seenSlots.add(row.entityId)
        }
        holeResults = single.holeResults
        provisional = single.provisional
      }
    } catch (err) {
      warnings.push({
        code: 'ENGINE_ERROR',
        message: err instanceof Error ? err.message : String(err),
      })
      competitions.push({
        competitionId: competition.id,
        engineVersion: ENGINE_VERSION,
        projectionHash: hashOf(competition.id, [], snapshot.event.scoring_revision),
        status: 'error',
        warnings,
        summary: {},
        rows: [],
        holeResults: [],
      })
      continue
    }

    rows.push(...excludedEntities.map((entity) => ({
      entityId: entity.id,
      rank: null,
      isTied: false,
      thru: null,
      resultPrimary: null,
      resultSecondary: null,
      displayPrimary: null,
      status: entity.eligibility_status ?? 'pending',
      detail: { eligibilityStatus: entity.eligibility_status ?? 'pending' },
    })))

    // ── Flighted ranking (§5.2) ──────────────────────────────────────────
    // A competition entity carries its own flight; entries and teams fall
    // back to their frozen roster flight so an organizer assigns each once.
    const flightOf = new Map<string, string | null>()
    for (const entity of declaredEntities) {
      const entry = entity.event_entry_id
        ? snapshot.entries.find((x) => x.id === entity.event_entry_id)
        : undefined
      const team = entity.event_team_id
        ? snapshot.teams.find((x) => x.id === entity.event_team_id)
        : undefined
      flightOf.set(
        entity.id,
        entity.flight_id ?? entry?.flight_id ?? team?.flight_id ?? null,
      )
    }
    const rankHigh = rules.metric === 'points' || rules.format === 'stableford' ||
      rules.format === 'par_bogey' || rules.format === 'skins'
    const rankDirection: 'asc' | 'desc' = rankHigh ? 'desc' : 'asc'

    // ── Countback (§8.15) ────────────────────────────────────────────────
    // Applied here rather than inside each engine so one implementation of
    // the rule serves every rankable format. Match play is excluded: a
    // bracket has no shared rank to separate, and skins awards per hole.
    if (rules.ties.mode === 'countback' && rules.ties.sequence.length > 0) {
      if (rules.format === 'match' || rules.format === 'skins') {
        warnings.push({
          code: 'COUNTBACK_NOT_APPLICABLE',
          message: `Countback does not apply to '${rules.format}' and was ignored.`,
        })
      } else {
        const pointsFormat = rules.metric === 'points' || rules.format === 'stableford' ||
          rules.format === 'par_bogey'
        const byEntity = new Map<string, Array<number | null>>()
        // Published order across every round the competition spans.
        const holeOrder = allHoles.map((h) => h.id)
        const indexOfHole = new Map(holeOrder.map((id, i) => [id, i]))

        for (const result of holeResults) {
          const position = indexOfHole.get(result.eventHoleId)
          if (position === undefined) continue
          const countbackEntityId = countbackEntityOf.get(result.entityId) ?? result.entityId
          let values = byEntity.get(countbackEntityId)
          if (!values) {
            values = Array.from({ length: holeOrder.length }, () => null)
            byEntity.set(countbackEntityId, values)
          }
          const points = (result.detail as { points?: number } | undefined)?.points
          const value = pointsFormat
            ? points ?? null
            : metric === 'net'
              ? result.net ?? result.gross ?? null
              : result.gross ?? null
          // A substitution chain publishes null placeholder hole results for
          // holders who were not effective in this round. Never let one erase
          // the numeric fact from the holder who actually played the slot.
          if (value !== null && value !== undefined) values[position] = value
        }

        if (byEntity.size === 0) {
          // No per-hole values exist for this format (Par/Bogey publishes none
          // today), so a countback here would be a no-op presented as applied.
          warnings.push({
            code: 'COUNTBACK_NO_HOLE_VALUES',
            message:
              `Countback is configured but '${rules.format}' publishes no ` +
              'per-hole values to count back on; ties stand.',
          })
        } else {
          // Resolve the overall field first. Per-flight ranking below uses the
          // resulting placement as its secondary key, so both overall and
          // division placements retain the declared countback order.
          const partitions = [rows]

          const placementById = new Map<
            string,
            { entityId: string; rank: number | null; isTied: boolean }
          >()
          for (const partition of partitions) {
            const applied = applyCountback(
              partition.map((r) => ({
                entityId: r.entityId,
                rank: r.rank,
                isTied: r.isTied,
              })),
              byEntity,
              { mode: rules.ties.mode, sequence: rules.ties.sequence },
              pointsFormat ? 'desc' : 'asc',
            )
            for (const placed of applied.rows) placementById.set(placed.entityId, placed)
            warnings.push(
              ...applied.warnings.map((w) => ({ code: w.code, message: w.message })),
            )
          }
          rows = rows.map((row) => {
            const placement = placementById.get(row.entityId)
            return placement
              ? { ...row, rank: placement.rank, isTied: placement.isTied }
              : row
          })
        }
      }
    }

    // ── Flighted ranking (§5.2), after overall countback ─────────────────
    if (rules.flighting === 'per_flight' && rules.format !== 'match') {
      // Retain the final field placement before division ranks overwrite it.
      rows = rows.map((row) => ({
        ...row,
        detail: {
          ...row.detail,
          overallRank: row.rank,
          overallIsTied: row.isTied,
        },
      }))
      const distinctFlights = new Set(
        rows.map((row) => flightOf.get(row.entityId) ?? null)
          .filter((flightId) => flightId !== null),
      )
      const unassigned = rows.filter((row) => !flightOf.get(row.entityId))
      if (distinctFlights.size === 0) {
        warnings.push({
          code: 'FLIGHTS_NOT_ASSIGNED',
          message:
            'Competition is configured to rank per flight but no entrant has a ' +
            'flight assigned; the whole field is ranked together.',
        })
      } else {
        if (unassigned.length > 0) {
          warnings.push({
            code: 'FLIGHTS_INCOMPLETE',
            message:
              `${unassigned.length} entrant(s) have no flight assignment and ` +
              'remain visible without a per-flight rank.',
          })
        }
        rows = rankWithinFlights(rows, flightOf, rankDirection)
      }
    }
    for (const row of rows) {
      const flightId = flightOf.get(row.entityId) ?? null
      if (flightId !== null) {
        row.detail = { ...row.detail, flightId }
      }
    }

    competitions.push({
      competitionId: competition.id,
      engineVersion: ENGINE_VERSION,
      projectionHash: hashOf(competition.id, rows, snapshot.event.scoring_revision),
      status: phase === 'final' && !provisional ? 'final' : 'live',
      warnings,
      summary: {
        format: rules.format,
        metric: rules.metric,
        provisional,
        entities: rows.length,
      },
      rows,
      holeResults,
    })
  }

  return { competitions }
}
