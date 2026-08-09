/**
 * Team-ball formats and team handicap presets (spec §8.8-§8.11, §9.7).
 *
 * Scramble (§8.8): the team Playing Handicap is a weighted sum of the
 * members' UNROUNDED Course Handicaps. The USGA Appendix C presets [S17] are
 * configuration defaults the Committee reviews and freezes, not immutable
 * business rules:
 *   two players:   35% low + 15% high
 *   three players: 30% low + 20% middle + 10% high
 *   four players:  25% + 20% + 15% + 10% from low to high
 * "Low" means lowest VALUE by exact rational compare, so a plus handicap
 * (negative internally) sorts below any positive handicap and takes the
 * largest weight.
 *
 * Foursomes / alternate shot (§8.9): 50% of the combined unrounded Course
 * Handicaps. Greensomes and Chapman/Pinehurst (§8.10): 60% of the lower plus
 * 40% of the higher unrounded Course Handicap. Every preset applies exactly
 * ONE final rounding step under the frozen rounding profile and records a
 * human-auditable explanation (spec §9.4 discipline).
 *
 * Team-ball totals: one team ball is scored per hole from TeamHoleScore
 * facts; individual hole scores are never fabricated (§8.8). Gross total is
 * the sum of completed team holes; net uses the frozen integer team Playing
 * Handicap allocated across holes by stroke index (§9.5). Missing data
 * propagates as provisional while live and resolves to no_return at final;
 * withdrawn/disqualified teams stay visible but are never competitively
 * ranked; equal totals share rank (ties stand, §8.15).
 */

import {
  type Rational,
  ZERO,
  add,
  compare,
  mul,
  percent,
  rational,
  roundHalfUpTowardPositiveInfinity,
  roundToDecimals,
  toNumber,
} from '../rational.ts'
import type {
  EngineWarning,
  EntityStatus,
  HoleResult,
  HoleSnapshot,
  RoundingProfile,
  TeamHoleScore,
} from '../types.ts'
import { type HoleComputation, assignRanks, computeHole, computeTotals } from '../common.ts'
import { allocateStrokes } from '../handicap/allocation.ts'

// ── Team handicap presets (§8.8-§8.10, [S17]) ───────────────────────────────

export interface TeamHandicapResult {
  /** Exact weighted combination of the unrounded Course Handicaps. */
  teamPlayingHandicapUnrounded: Rational
  /** Final signed integer team Playing Handicap after the one rounding step. */
  teamPlayingHandicap: number
  /** Human-auditable calculation explanation (spec §9.4). */
  explanation: string
}

/**
 * USGA Appendix C scramble weight presets [S17], ordered low to high to pair
 * with the ascending-sorted Course Handicaps. Configuration defaults only;
 * the Committee must review and freeze the weights.
 */
export const SCRAMBLE_WEIGHT_PRESETS: Record<2 | 3 | 4, Rational[]> = {
  2: [percent(35), percent(15)],
  3: [percent(30), percent(20), percent(10)],
  4: [percent(25), percent(20), percent(15), percent(10)],
}

/** The single final rounding step under the frozen profile. */
function roundFinal(unrounded: Rational, rounding: RoundingProfile): number {
  if (rounding.kind === 'usga_whs_2024') {
    return roundHalfUpTowardPositiveInfinity(unrounded)
  }
  const r = roundToDecimals(unrounded, 0, rounding.tieDirection)
  return r.num / r.den
}

/** Display formatting for explanations; never fed back into calculation. */
function fmtCh(r: Rational): string {
  return toNumber(r).toFixed(6)
}

function fmtWeight(r: Rational): string {
  return toNumber(r).toFixed(4)
}

export function scrambleTeamHandicap(
  courseHandicaps: Rational[],
  weights: Rational[],
  rounding: RoundingProfile,
): TeamHandicapResult {
  if (courseHandicaps.length !== weights.length) {
    throw new RangeError(
      `scramble weight count ${weights.length} does not match ` +
        `course handicap count ${courseHandicaps.length}`,
    )
  }
  if (courseHandicaps.length === 0) {
    throw new RangeError('scramble requires at least one course handicap')
  }
  // Ascending by exact rational value: a plus handicap (negative internally)
  // sorts below any positive handicap and pairs with the largest weight.
  const sorted = [...courseHandicaps].sort(compare)
  let unrounded = ZERO
  const terms: string[] = []
  for (let i = 0; i < sorted.length; i += 1) {
    const ch = sorted[i]
    const weight = weights[i]
    if (ch === undefined || weight === undefined) {
      throw new RangeError(`missing scramble term at position ${i}`)
    }
    unrounded = add(unrounded, mul(ch, weight))
    terms.push(`ch=${fmtCh(ch)} x w=${fmtWeight(weight)}`)
  }
  const final = roundFinal(unrounded, rounding)
  return {
    teamPlayingHandicapUnrounded: unrounded,
    teamPlayingHandicap: final,
    explanation:
      `scramble sum(${terms.join(' + ')}) -> ` +
      `unrounded=${fmtCh(unrounded)} -> ` +
      `team_playing_handicap=${final} (${rounding.kind})`,
  }
}

export function foursomesTeamHandicap(
  a: Rational,
  b: Rational,
  rounding: RoundingProfile,
): TeamHandicapResult {
  const unrounded = mul(add(a, b), rational(1, 2))
  const final = roundFinal(unrounded, rounding)
  return {
    teamPlayingHandicapUnrounded: unrounded,
    teamPlayingHandicap: final,
    explanation:
      `foursomes (ch_a=${fmtCh(a)} + ch_b=${fmtCh(b)}) x allowance=0.5000 -> ` +
      `unrounded=${fmtCh(unrounded)} -> ` +
      `team_playing_handicap=${final} (${rounding.kind})`,
  }
}

export function greensomesTeamHandicap(
  a: Rational,
  b: Rational,
  rounding: RoundingProfile,
): TeamHandicapResult {
  // Lower/higher by exact rational VALUE: a plus handicap is the lower one.
  const aIsLower = compare(a, b) <= 0
  const lower = aIsLower ? a : b
  const higher = aIsLower ? b : a
  const unrounded = add(mul(lower, percent(60)), mul(higher, percent(40)))
  const final = roundFinal(unrounded, rounding)
  return {
    teamPlayingHandicapUnrounded: unrounded,
    teamPlayingHandicap: final,
    explanation:
      `greensomes lower=${fmtCh(lower)} x 0.6000 + higher=${fmtCh(higher)} x 0.4000 -> ` +
      `unrounded=${fmtCh(unrounded)} -> ` +
      `team_playing_handicap=${final} (${rounding.kind})`,
  }
}

// ── Team-ball totals (§8.8-§8.10) ───────────────────────────────────────────

export interface TeamBallTeam {
  teamId: string
  entityStatus: EntityStatus
  /**
   * Frozen signed integer team Playing Handicap (plus handicaps negative).
   * null = no valid frozen team handicap; an explicit scratch assignment is 0.
   */
  teamPlayingHandicap: number | null
  /** One team ball per hole; individual scores are never fabricated. */
  scores: TeamHoleScore[]
}

export interface TeamBallInput {
  holes: HoleSnapshot[]
  metric: 'gross' | 'net'
  teams: TeamBallTeam[]
  phase: 'live' | 'final'
}

export interface TeamBallRow {
  teamId: string
  grossTotal: number | null
  netTotal: number | null
  /** Completed-hole count for thru display. */
  thru: number
  rank: number | null
  isTied: boolean
  provisional: boolean
  status: EntityStatus | 'provisional' | 'complete' | 'no_return'
}

export interface TeamBallResult {
  rows: TeamBallRow[]
  holeResults: HoleResult[]
  warnings: EngineWarning[]
  provisional: boolean
}

interface TeamComputation {
  team: TeamBallTeam
  grossTotal: number | null
  netTotal: number | null
  thru: number
  status: TeamBallRow['status']
  provisional: boolean
  /** Competition-metric value used for ranking, or null when ineligible. */
  rankValue: number | null
}

export function calculateTeamBallTotals(input: TeamBallInput): TeamBallResult {
  const { holes, metric, teams, phase } = input
  const warnings: EngineWarning[] = []
  const holeResults: HoleResult[] = []

  const holeIds = new Set(holes.map((h) => h.id))
  const seenTeamIds = new Set<string>()

  const computations: TeamComputation[] = teams.map((team) => {
    if (seenTeamIds.has(team.teamId)) {
      throw new RangeError(`duplicate teamId '${team.teamId}'`)
    }
    seenTeamIds.add(team.teamId)

    const hasHandicap = team.teamPlayingHandicap !== null
    // Allocation also validates the stroke-index permutation. A null handicap
    // allocates zero strokes; its net stays null (never coerced) below.
    const strokes = allocateStrokes(team.teamPlayingHandicap ?? 0, holes)

    const scoreByHole = new Map<string, TeamHoleScore>()
    for (const score of team.scores) {
      if (!holeIds.has(score.holeId)) continue
      if (scoreByHole.has(score.holeId)) {
        throw new RangeError(
          `team '${team.teamId}' has multiple scores for hole '${score.holeId}'`,
        )
      }
      scoreByHole.set(score.holeId, score)
    }

    const holeComputations: HoleComputation[] = []
    for (const hole of holes) {
      const strokesReceived = strokes.get(hole.id) ?? 0
      const comp = computeHole(hole, scoreByHole.get(hole.id), strokesReceived)
      holeComputations.push(comp)

      const net = hasHandicap ? comp.net : null
      const metricHole = metric === 'gross' ? comp.gross : net
      holeResults.push({
        entityId: team.teamId,
        holeId: hole.id,
        gross: comp.gross,
        strokesReceived,
        net,
        relativeToPar: metricHole === null ? null : metricHole - hole.par,
        status: comp.status,
        provisional: comp.pending,
      })
    }

    const totals = computeTotals(holeComputations)
    const grossTotal = totals.grossTotal
    // Without a frozen team handicap the net total is null, never coerced.
    const netTotal = hasHandicap ? totals.netTotal : null

    if (metric === 'net' && !hasHandicap) {
      warnings.push({
        code: 'NET_NO_HANDICAP',
        message:
          `Team '${team.teamId}' has no valid frozen team Playing Handicap and is ` +
          `ineligible for the net competition; assign explicit scratch (0) to include it.`,
        context: { teamId: team.teamId },
      })
    }

    const cardComplete = !totals.provisional && !totals.hasTerminalGap
    const metricEligible = metric === 'gross' || hasHandicap

    let status: TeamBallRow['status']
    let provisional = false
    let rankEligible = false
    if (team.entityStatus !== 'active') {
      status = team.entityStatus
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

    const metricTotal = metric === 'gross' ? grossTotal : netTotal
    return {
      team,
      grossTotal,
      netTotal,
      thru: totals.completed,
      status,
      provisional,
      rankValue: rankEligible ? metricTotal : null,
    }
  })

  const ranked = assignRanks(computations, (c) => c.rankValue, 'asc')
  const rankByTeamId = new Map<string, { rank: number | null; isTied: boolean }>()
  for (const r of ranked) {
    rankByTeamId.set(r.entry.team.teamId, { rank: r.rank, isTied: r.isTied })
  }

  const rows: TeamBallRow[] = computations.map((c) => {
    const placement = rankByTeamId.get(c.team.teamId) ?? { rank: null, isTied: false }
    return {
      teamId: c.team.teamId,
      grossTotal: c.grossTotal,
      netTotal: c.netTotal,
      thru: c.thru,
      rank: placement.rank,
      isTied: placement.isTied,
      provisional: c.provisional,
      status: c.status,
    }
  })

  return {
    rows,
    holeResults,
    warnings,
    provisional: rows.some((r) => r.provisional),
  }
}
