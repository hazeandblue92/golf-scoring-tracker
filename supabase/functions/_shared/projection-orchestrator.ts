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
  calculateBestBall,
  calculateParBogey,
  calculateSkins,
  calculateStableford,
  calculateStrokePlay,
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

function holeSnapshots(
  snapshot: ScoringSnapshot,
  holeScope: number[] | null,
): HoleSnapshot[] {
  const scoped = snapshot.holes.filter(
    (h) => holeScope === null || holeScope.length === 0 || holeScope.includes(h.hole_ordinal),
  )
  const ordered = [...scoped].sort((a, b) => a.hole_ordinal - b.hole_ordinal)
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

    const scopeRow = snapshot.competitionRounds.find(
      (cr) => cr.competition_id === competition.id,
    )
    const holes = holeSnapshots(
      snapshot,
      scopeRow?.hole_scope ?? rules.holeScope ?? null,
    )
    const holeIds = new Set(holes.map((h) => h.id))
    const parTotal = holes.reduce((sum, h) => sum + h.par, 0)

    // entity id lookups: engine works in entry/team ids, projections store
    // competition_entities.id.
    const entityByEntry = new Map<string, string>()
    const entityByTeam = new Map<string, string>()
    for (const e of entities) {
      if (e.event_entry_id) entityByEntry.set(e.event_entry_id, e.id)
      if (e.event_team_id) entityByTeam.set(e.event_team_id, e.id)
    }

    let rows: ProjectionRow[] = []
    let holeResults: ProjectionHoleResult[] = []
    let provisional = false

    const metric = rules.metric === 'points' ? 'net' : rules.metric

    try {
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

        case 'best_k': {
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
          const result = calculateBestBall({
            holes,
            metric: metric as 'gross' | 'net',
            bestK: rules.team.bestK,
            teams,
            phase,
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
            detail: {},
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

        default: {
          // match / shamble / aggregate: the engine supports the calculation
          // but the snapshot wiring (pairings brackets, shamble score source,
          // multi-round aggregation) lands in Phase 2/3 (spec §22).
          warnings.push({
            code: 'ENGINE_FORMAT_DEFERRED',
            message: `format '${rules.format}' projection wiring is deferred to a later phase`,
          })
          provisional = true
        }
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
