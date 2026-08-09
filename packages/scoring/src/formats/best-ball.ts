/**
 * Four-ball / best ball, generalized best_k_of_m (spec §8.3-8.4).
 *
 * "Four-ball" means partners each play their own ball and the side's hole
 * score is the lower eligible partner score; generalized here to best_k_of_m:
 *
 *   - Calculate each eligible member's gross or net hole score.
 *   - Sort ascending; ties break deterministically by participantId.
 *   - Sum the lowest k scores to form the team hole score; those k members
 *     are the hole's contributors.
 *   - Team total is the sum of complete team hole scores.
 *
 * Net best ball applies each member's allocated strokes BEFORE selecting the
 * best score (spec §8.3): never select the lowest gross and then subtract a
 * team handicap. In metric 'net' a member without a frozen playing handicap
 * cannot contribute (warning NET_NO_HANDICAP, once per member); the team may
 * still score through its remaining members.
 *
 * Missing data propagates as provisional (spec §7.3), never coerced to zero:
 *   - Fewer than k valid member scores on a hole: while live the hole is
 *     provisional; at finalization the hole — and therefore the team —
 *     is no_return (spec §8.3, §6.1 incomplete policy).
 *   - k valid scores present but an eligible member still pending while
 *     live: a tentative team score and contributors are reported, but the
 *     hole stays provisional because a pending member could still lower it.
 *     A member with a terminal non-complete status (picked up, conceded,
 *     no score, …) holds nothing open: the hole completes whenever the
 *     remaining valid scores satisfy k (spec §21.1 partner-pickup case).
 *
 * Withdrawn/disqualified teams remain visible but are never competitively
 * ranked; ties share rank (spec §4.6, §7.3).
 */

import { computeHole } from '../common.ts'
import { assignRanks } from '../common.ts'
import { allocateStrokes } from '../handicap/allocation.ts'
import type {
  EngineWarning,
  EntityStatus,
  HoleSnapshot,
  IndividualHoleScore,
} from '../types.ts'

export interface BestBallMember {
  participantId: string
  /** Frozen signed Playing Handicap; null when no valid handicap exists. */
  playingHandicap: number | null
  scores: IndividualHoleScore[]
}

export interface BestBallTeam {
  teamId: string
  entityStatus: EntityStatus
  members: BestBallMember[]
}

export interface BestBallInput {
  holes: HoleSnapshot[]
  metric: 'gross' | 'net'
  /** Number of counting scores per hole (best_k_of_m); four-ball is k=1. */
  bestK: number
  teams: BestBallTeam[]
  phase: 'live' | 'final'
}

export interface BestBallTeamHole {
  teamId: string
  holeId: string
  teamScore: number | null
  /** Counting members, deterministic on ties by (score, participantId). */
  contributorIds: string[]
  provisional: boolean
  status: 'complete' | 'provisional' | 'no_return'
}

export interface BestBallRow {
  teamId: string
  total: number | null
  /** Completed team holes. */
  thru: number
  rank: number | null
  isTied: boolean
  provisional: boolean
  status: EntityStatus | 'provisional' | 'complete' | 'no_return'
}

export interface BestBallResult {
  rows: BestBallRow[]
  teamHoles: BestBallTeamHole[]
  warnings: EngineWarning[]
  provisional: boolean
}

/** Per-member computation context after eligibility and stroke allocation. */
interface MemberContext {
  participantId: string
  /** holeId -> signed strokes received; null means zero (gross metric). */
  strokes: Map<string, number> | null
  /** holeId -> latest-revision score fact. */
  scoreByHole: Map<string, IndividualHoleScore>
}

interface TeamSummary {
  teamId: string
  entityStatus: EntityStatus
  total: number | null
  thru: number
  computedStatus: 'complete' | 'provisional' | 'no_return'
  provisional: boolean
}

export function calculateBestBall(input: BestBallInput): BestBallResult {
  const { holes, metric, bestK, teams, phase } = input
  if (!Number.isInteger(bestK) || bestK < 1) {
    throw new RangeError(`bestK must be a positive integer, got ${bestK}`)
  }

  const warnings: EngineWarning[] = []
  const teamHoles: BestBallTeamHole[] = []
  const summaries: TeamSummary[] = []

  for (const team of teams) {
    // ── Member eligibility and stroke allocation (net-before-select) ────────
    const members: MemberContext[] = []
    for (const member of team.members) {
      if (metric === 'net' && member.playingHandicap === null) {
        // Spec §8.3/§9: without a frozen handicap the member cannot
        // contribute a net score; the team scores through the others.
        warnings.push({
          code: 'NET_NO_HANDICAP',
          message:
            `participant ${member.participantId} has no playing handicap ` +
            `and cannot contribute to net best ball for team ${team.teamId}`,
          context: { participantId: member.participantId, teamId: team.teamId },
        })
        continue
      }
      const strokes =
        metric === 'net' && member.playingHandicap !== null
          ? allocateStrokes(member.playingHandicap, holes)
          : null
      const scoreByHole = new Map<string, IndividualHoleScore>()
      for (const score of member.scores) {
        const previous = scoreByHole.get(score.holeId)
        if (previous === undefined || score.revision > previous.revision) {
          scoreByHole.set(score.holeId, score)
        }
      }
      members.push({ participantId: member.participantId, strokes, scoreByHole })
    }

    // ── Per-hole best_k_of_m selection ──────────────────────────────────────
    let thru = 0
    let completeSum = 0
    let anyCompleteHole = false
    let anyProvisionalHole = false
    let anyNoReturnHole = false

    for (const hole of holes) {
      const candidates: Array<{ participantId: string; value: number }> = []
      let pendingMembers = 0
      for (const member of members) {
        const strokesReceived = member.strokes?.get(hole.id) ?? 0
        const computed = computeHole(
          hole,
          member.scoreByHole.get(hole.id),
          strokesReceived,
        )
        if (computed.pending) {
          pendingMembers += 1
          continue
        }
        if (computed.status !== 'complete') continue // terminal, no value
        const value = metric === 'net' ? computed.net : computed.gross
        if (value === null) continue // unreachable: complete implies numeric
        candidates.push({ participantId: member.participantId, value })
      }
      // Deterministic ascending order by (score, participantId).
      candidates.sort((a, b) =>
        a.value !== b.value
          ? a.value - b.value
          : a.participantId < b.participantId
            ? -1
            : a.participantId > b.participantId
              ? 1
              : 0,
      )

      let teamScore: number | null = null
      let contributorIds: string[] = []
      let status: 'complete' | 'provisional' | 'no_return'
      if (candidates.length >= bestK) {
        let sum = 0
        const counting = candidates.slice(0, bestK)
        for (const c of counting) sum += c.value
        teamScore = sum
        contributorIds = counting.map((c) => c.participantId)
        // A pending member could still lower the selection while live; a
        // picked-up/terminal member is ignored because k is satisfied.
        status =
          phase === 'final' || pendingMembers === 0 ? 'complete' : 'provisional'
        if (status === 'complete') {
          thru += 1
          completeSum += sum
          anyCompleteHole = true
        } else {
          anyProvisionalHole = true
        }
      } else {
        status = phase === 'live' ? 'provisional' : 'no_return'
        if (status === 'provisional') anyProvisionalHole = true
        else anyNoReturnHole = true
      }

      teamHoles.push({
        teamId: team.teamId,
        holeId: hole.id,
        teamScore,
        contributorIds,
        provisional: status === 'provisional',
        status,
      })
    }

    // ── Team summary ────────────────────────────────────────────────────────
    // A finalized team missing any hole has no returnable total (no_return);
    // otherwise the total sums complete team hole scores (spec §8.3).
    const total = anyNoReturnHole || !anyCompleteHole ? null : completeSum
    const computedStatus: TeamSummary['computedStatus'] = anyNoReturnHole
      ? 'no_return'
      : anyProvisionalHole
        ? 'provisional'
        : 'complete'
    summaries.push({
      teamId: team.teamId,
      entityStatus: team.entityStatus,
      total,
      thru,
      computedStatus,
      provisional: anyProvisionalHole,
    })
  }

  // ── Ranking: ascending total; ties share rank; only active teams compete ─
  const active = summaries.filter((s) => s.entityStatus === 'active')
  const nonActive = summaries.filter((s) => s.entityStatus !== 'active')
  const rows: BestBallRow[] = assignRanks(active, (s) => s.total, 'asc').map(
    ({ entry, rank, isTied }) => ({
      teamId: entry.teamId,
      total: entry.total,
      thru: entry.thru,
      rank,
      isTied,
      provisional: entry.provisional,
      status: entry.computedStatus,
    }),
  )
  // Withdrawn/disqualified/no-return entities stay visible, never ranked.
  for (const s of nonActive) {
    rows.push({
      teamId: s.teamId,
      total: s.total,
      thru: s.thru,
      rank: null,
      isTied: false,
      provisional: s.provisional,
      status: s.entityStatus,
    })
  }

  return {
    rows,
    teamHoles,
    warnings,
    provisional: active.some((s) => s.provisional),
  }
}
