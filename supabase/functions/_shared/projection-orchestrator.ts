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

/**
 * One match side's gross score per hole (§8.6).
 *
 * A side is a competition_entity, so it may be an individual or a team. For a
 * team the team ball wins when one exists (foursomes, scramble); otherwise the
 * side plays best-ball and the lowest member gross on the hole represents it.
 * Nothing is fabricated: a hole no one completed stays null and the engine
 * treats the hole as undetermined.
 */
function matchSideGrossByHole(
  snapshot: ScoringSnapshot,
  entity: { event_entry_id: string | null; event_team_id: string | null },
  holeIds: Set<string>,
): Map<string, number | null> {
  const byHole = new Map<string, number | null>()

  if (entity.event_entry_id) {
    for (const score of snapshot.individualScores) {
      if (score.event_entry_id !== entity.event_entry_id) continue
      if (!holeIds.has(score.event_hole_id)) continue
      byHole.set(score.event_hole_id, score.gross_strokes)
    }
    return byHole
  }

  if (!entity.event_team_id) return byHole
  const teamId = entity.event_team_id

  const teamBall = snapshot.teamScores.filter(
    (s) => s.event_team_id === teamId && holeIds.has(s.event_hole_id),
  )
  if (teamBall.length > 0) {
    for (const score of teamBall) byHole.set(score.event_hole_id, score.gross_strokes)
    return byHole
  }

  const memberEntryIds = new Set(
    snapshot.teamMembers
      .filter((m) => m.event_team_id === teamId)
      .map((m) => m.event_entry_id),
  )
  for (const score of snapshot.individualScores) {
    if (!memberEntryIds.has(score.event_entry_id)) continue
    if (!holeIds.has(score.event_hole_id)) continue
    const current = byHole.get(score.event_hole_id)
    if (score.gross_strokes === null) {
      if (current === undefined) byHole.set(score.event_hole_id, null)
      continue
    }
    if (current === undefined || current === null || score.gross_strokes < current) {
      byHole.set(score.event_hole_id, score.gross_strokes)
    }
  }
  return byHole
}

/**
 * A match side's unrounded Course Handicap, which §8.6 normalizes from the
 * lowest of the two. Teams carry a frozen team handicap; individuals carry the
 * exact unrounded value computed at publish.
 */
function matchSideCourseHandicap(
  snapshot: ScoringSnapshot,
  entity: { event_entry_id: string | null; event_team_id: string | null },
): Rational | null {
  if (entity.event_entry_id) {
    const entry = snapshot.entries.find((e) => e.id === entity.event_entry_id)
    if (!entry || entry.course_handicap_unrounded === null) {
      return entry?.playing_handicap === null || entry?.playing_handicap === undefined
        ? null
        : rational(entry.playing_handicap)
    }
    return rational(
      Math.round(entry.course_handicap_unrounded * 1_000_000),
      1_000_000,
    )
  }
  if (entity.event_team_id) {
    const team = snapshot.teams.find((t) => t.id === entity.event_team_id)
    if (!team || team.playing_handicap === null) return null
    return rational(team.playing_handicap)
  }
  return null
}

/**
 * The §8.14 aggregation a competition declares, or null when it is a single
 * round. `metric` decides the basis: points tables rank high, strokes low.
 */
function multiRoundAggregation(
  rules: { metric: 'gross' | 'net' | 'points'; multiRound?: { aggregation: string; count?: number } },
): MultiRoundAggregation | null {
  const config = rules.multiRound
  if (!config) return null
  const pointsBased = rules.metric === 'points'
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
    rows: rows
      .map((r) => ({
        entityId: r.entityId,
        rank: r.rank,
        isTied: r.isTied,
        thru: r.thru,
        resultPrimary: r.resultPrimary,
        resultSecondary: r.resultSecondary,
        status: r.status,
      }))
      .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0)),
  }
  return resultHash(canonical)
}

export function buildProjections(snapshot: ScoringSnapshot): ProjectionPayload {
  const phase: 'live' | 'final' =
    snapshot.event.status === 'finalized' ? 'final' : 'live'
  const competitions: CompetitionProjectionPayload[] = []

  for (const competition of snapshot.competitions) {
    const warnings: Array<{ code: string; message: string }> = []
    const entities = snapshot.competitionEntities.filter(
      (e) => e.competition_id === competition.id,
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

    // Every round this competition spans, in the order competition_rounds
    // declares. A competition with no rows is event-wide (single round).
    const compRounds = snapshot.competitionRounds.filter(
      (cr) => cr.competition_id === competition.id,
    )
    const scopeRow = compRounds[0]
    const roundIds = compRounds.map((cr) => cr.round_id)
    const allHoles = holeSnapshots(
      snapshot,
      roundIds,
      scopeRow?.hole_scope ?? rules.holeScope ?? null,
    )

    // entity id lookups: engine works in entry/team ids, projections store
    // competition_entities.id.
    const entityByEntry = new Map<string, string>()
    const entityByTeam = new Map<string, string>()
    for (const e of entities) {
      if (e.event_entry_id) entityByEntry.set(e.event_entry_id, e.id)
      if (e.event_team_id) entityByTeam.set(e.event_team_id, e.id)
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
    const computeForHoles = (holes: HoleSnapshot[]) => {
      const holeIds = new Set(holes.map((h) => h.id))
      const parTotal = holes.reduce((sum, h) => sum + h.par, 0)
      let rows: ProjectionRow[] = []
      let holeResults: ProjectionHoleResult[] = []
      let provisional = false

      switch (rules.format) {
        case 'individual_stroke': {
          const entries = entities
            .filter((e) => e.event_entry_id)
            .map((e) => {
              const entry = snapshot.entries.find((x) => x.id === e.event_entry_id)!
              return {
                entryId: entry.id,
                entityStatus: toEntityStatus(entry.status),
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
          const teams = entities
            .filter((e) => e.event_team_id)
            .map((e) => {
              const team = snapshot.teams.find((t) => t.id === e.event_team_id)!
              const memberEntryIds = snapshot.teamMembers
                .filter((m) => m.event_team_id === team.id)
                .map((m) => m.event_entry_id)
              return {
                teamId: team.id,
                entityStatus: toEntityStatus(team.status),
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
          const entries = entities
            .filter((e) => e.event_entry_id)
            .map((e) => {
              const entry = snapshot.entries.find((x) => x.id === e.event_entry_id)!
              return {
                entryId: entry.id,
                entityStatus: toEntityStatus(entry.status),
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
          const entries = entities
            .filter((e) => e.event_entry_id)
            .map((e) => {
              const entry = snapshot.entries.find((x) => x.id === e.event_entry_id)!
              return {
                entryId: entry.id,
                entityStatus: toEntityStatus(entry.status),
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
          break
        }

        case 'skins': {
          // Skins run on individual entries under the frozen population rule;
          // team populations use the team ball score.
          const useTeams = rules.skins.population === 'teams'
          const skinEntries = useTeams
            ? entities
                .filter((e) => e.event_team_id)
                .map((e) => {
                  const team = snapshot.teams.find((t) => t.id === e.event_team_id)!
                  const scores = teamScoresFor(snapshot, team.id, holeIds)
                  return {
                    entityId: team.id,
                    eligible: toEntityStatus(team.status) === 'active',
                    holeScores: holes.map((h) => {
                      const s = scores.find((x) => x.holeId === h.id)
                      return {
                        holeId: h.id,
                        score: s?.grossStrokes ?? null,
                        terminal: s !== undefined && s.status !== 'complete' && s.status !== 'not_started',
                      }
                    }),
                  }
                })
            : entities
                .filter((e) => e.event_entry_id)
                .map((e) => {
                  const entry = snapshot.entries.find((x) => x.id === e.event_entry_id)!
                  const scores = individualScoresFor(snapshot, entry.id, holeIds)
                  return {
                    entityId: entry.id,
                    eligible: toEntityStatus(entry.status) === 'active',
                    holeScores: holes.map((h) => {
                      const s = scores.find((x) => x.holeId === h.id)
                      const gross = s?.grossStrokes ?? null
                      let score: number | null = gross
                      const playingHandicapValue = competitionPlayingHandicap(
                        entry,
                        rules.handicap,
                      )
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
          const result = calculateSkins({
            holes,
            entries: skinEntries,
            rules: skinsRules,
            phase,
          })
          provisional = result.provisional
          warnings.push(...result.warnings.map((w) => ({ code: w.code, message: w.message })))
          const lookup = useTeams ? entityByTeam : entityByEntry
          rows = result.totals.map((t) => ({
            entityId: lookup.get(t.entityId) ?? t.entityId,
            rank: null,
            isTied: false,
            thru: null,
            resultPrimary: t.units,
            resultSecondary: null,
            displayPrimary: `${t.units}`,
            status: 'complete',
            detail: {},
          }))
          holeResults = result.holeOutcomes.map((o) => ({
            entityId: o.winnerId ? (lookup.get(o.winnerId) ?? o.winnerId) : (rows[0]?.entityId ?? ''),
            eventHoleId: o.holeId,
            skinUnits: o.unitsAwarded,
            skinCarriedUnits: o.poolCarriedIn,
            skinWinner: o.winnerId !== null,
            provisional: o.status === 'provisional',
            detail: { outcome: o.status },
          })).filter((h) => h.entityId !== '')
          break
        }

        case 'scramble':
        case 'foursomes':
        case 'greensomes':
        case 'chapman': {
          const teams = entities
            .filter((e) => e.event_team_id)
            .map((e) => {
              const team = snapshot.teams.find((t) => t.id === e.event_team_id)!
              return {
                teamId: team.id,
                entityStatus: toEntityStatus(team.status),
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
          const entityById = new Map(entities.map((e) => [e.id, e]))
          const pairings = snapshot.matches.filter(
            (m) => m.competition_id === competition.id,
          )
          if (pairings.length === 0) {
            warnings.push({
              code: 'MATCH_NO_PAIRINGS',
              message:
                'No match pairings exist for this competition; publish creates ' +
                'them before scoring can produce standings.',
            })
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

          for (const pairing of pairings) {
            const a = pairing.side_a_entity_id
              ? entityById.get(pairing.side_a_entity_id)
              : undefined
            const b = pairing.side_b_entity_id
              ? entityById.get(pairing.side_b_entity_id)
              : undefined
            if (!a || !b) {
              // A bye or an unfilled bracket slot: nothing to compute, and
              // inventing a walkover result is the Committee's call.
              continue
            }

            const grossA = matchSideGrossByHole(snapshot, a, holeIds)
            const grossB = matchSideGrossByHole(snapshot, b, holeIds)

            // §8.6 handicap match play: normalize from the LOWER unrounded
            // Course Handicap, apply the match allowance, round once, then
            // allocate the positive difference by stroke index.
            let strokesA = new Map<string, number>()
            let strokesB = new Map<string, number>()
            if (metric === 'net') {
              const chA = matchSideCourseHandicap(snapshot, a)
              const chB = matchSideCourseHandicap(snapshot, b)
              if (chA === null || chB === null) {
                warnings.push({
                  code: 'MATCH_NET_HANDICAP_MISSING',
                  message:
                    `Match '${pairing.id}' cannot be scored net because a side ` +
                    'has no frozen Course Handicap; it is shown gross.',
                })
              } else {
                const allocation = matchStrokeAllocation({
                  courseHandicapA: chA,
                  courseHandicapB: chB,
                  allowance,
                  rounding,
                  holes,
                })
                strokesA = allocation.strokesA
                strokesB = allocation.strokesB
              }
            }

            const holeInputs: MatchHoleInput[] = holes.map((hole) => {
              const rawA = grossA.get(hole.id) ?? null
              const rawB = grossB.get(hole.id) ?? null
              return {
                holeId: hole.id,
                a: rawA === null ? null : rawA - (strokesA.get(hole.id) ?? 0),
                b: rawB === null ? null : rawB - (strokesB.get(hole.id) ?? 0),
              }
            })

            const conceded =
              pairing.status === 'conceded' && pairing.winner_entity_id
                ? {
                    winner: (pairing.winner_entity_id === a.id ? 'a' : 'b') as 'a' | 'b',
                  }
                : undefined

            const state = calculateMatch({
              holes,
              holeInputs,
              extraHolesAllowed: false,
              ...(conceded ? { matchConcession: conceded } : {}),
            })

            if (state.status === 'in_progress') provisional = true

            const sideRow = (
              entityId: string,
              opponentId: string,
              side: 'a' | 'b',
            ): ProjectionRow => {
              const up = side === 'a' ? state.holesUp : -state.holesUp
              const won = state.winner !== null && state.winner === side
              const lost = state.winner !== null && state.winner !== side
              return {
                entityId,
                // Bracket standings are not a stroke leaderboard; ordering is
                // by bracket position, so rank stays null rather than implying
                // a field ranking that does not exist.
                rank: null,
                isTied: false,
                thru: state.outcomes.filter((o) => o.winner !== null).length,
                resultPrimary: up,
                resultSecondary: state.holesRemaining,
                displayPrimary: state.display,
                status:
                  state.status === 'in_progress'
                    ? 'provisional'
                    : 'complete',
                detail: {
                  matchId: pairing.id,
                  opponentEntityId: opponentId,
                  matchStatus: state.status,
                  holesUp: up,
                  holesRemaining: state.holesRemaining,
                  dormie: state.dormie,
                  outcome: won ? 'won' : lost ? 'lost' : state.status === 'halved' ? 'halved' : 'in_progress',
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
              const rawA = grossA.get(outcome.holeId) ?? null
              const rawB = grossB.get(outcome.holeId) ?? null
              holeResults.push({
                entityId: a.id,
                eventHoleId: outcome.holeId,
                gross: rawA,
                matchResult:
                  outcome.winner === 'half' ? 'half' : outcome.winner === 'a' ? 'win' : 'loss',
                detail: { matchId: pairing.id },
              })
              holeResults.push({
                entityId: b.id,
                eventHoleId: outcome.holeId,
                gross: rawB,
                matchResult:
                  outcome.winner === 'half' ? 'half' : outcome.winner === 'b' ? 'win' : 'loss',
                detail: { matchId: pairing.id },
              })
            }
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

    try {
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
          ),
        }))

        const byEntity = new Map<string, MultiRoundEntity>()
        for (const round of perRound) {
          if (round.result.provisional) provisional = true
          holeResults.push(...round.result.holeResults)
          for (const row of round.result.rows) {
            let entity = byEntity.get(row.entityId)
            if (!entity) {
              entity = { entityId: row.entityId, rounds: [] }
              byEntity.set(row.entityId, entity)
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
          }
        }

        const aggregated = calculateMultiRound({
          entities: [...byEntity.values()],
          aggregation,
          phase,
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
            })),
          },
        }))
      } else {
        const single = computeForHoles(allHoles)
        rows = single.rows
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
        const pointsFormat = rules.metric === 'points' || rules.format === 'stableford'
        const byEntity = new Map<string, Array<number | null>>()
        // Published order across every round the competition spans.
        const holeOrder = allHoles.map((h) => h.id)
        const indexOfHole = new Map(holeOrder.map((id, i) => [id, i]))

        for (const result of holeResults) {
          const position = indexOfHole.get(result.eventHoleId)
          if (position === undefined) continue
          let values = byEntity.get(result.entityId)
          if (!values) {
            values = Array.from({ length: holeOrder.length }, () => null)
            byEntity.set(result.entityId, values)
          }
          const points = (result.detail as { points?: number } | undefined)?.points
          const value = pointsFormat
            ? points ?? null
            : metric === 'net'
              ? result.net ?? result.gross ?? null
              : result.gross ?? null
          values[position] = value === undefined ? null : value
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
          const applied = applyCountback(
            rows.map((r) => ({ entityId: r.entityId, rank: r.rank, isTied: r.isTied })),
            byEntity,
            { mode: rules.ties.mode, sequence: rules.ties.sequence },
            pointsFormat ? 'desc' : 'asc',
          )
          const placementById = new Map(applied.rows.map((r) => [r.entityId, r]))
          rows = rows.map((row) => {
            const placement = placementById.get(row.entityId)
            return placement
              ? { ...row, rank: placement.rank, isTied: placement.isTied }
              : row
          })
          warnings.push(
            ...applied.warnings.map((w) => ({ code: w.code, message: w.message })),
          )
        }
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
