/**
 * Hole-level team aggregate (spec §8.4).
 *
 * The same deterministic selector used by generalized best-k also defines
 * configured team aggregate: `bestK < teamSize` counts the lowest k member
 * scores, while `bestK === teamSize` is the explicit all-scores-count policy.
 * Keeping the policy hole-level prevents an accidental round-total aggregate.
 */

import {
  calculateBestBall,
  type BestBallInput,
  type BestBallResult,
} from './best-ball.ts'

export interface TeamAggregateInput extends Omit<BestBallInput, 'bestK'> {
  /** Frozen team size from rules_json. */
  teamSize: number
  /** Counting member scores per hole; equal to teamSize for all-scores-count. */
  bestK: number
}

export type TeamAggregateResult = BestBallResult

export function calculateTeamAggregate(
  input: TeamAggregateInput,
): TeamAggregateResult {
  if (!Number.isInteger(input.teamSize) || input.teamSize < 1) {
    throw new RangeError(`teamSize must be a positive integer, got ${input.teamSize}`)
  }
  if (!Number.isInteger(input.bestK) || input.bestK < 1 || input.bestK > input.teamSize) {
    throw new RangeError(
      `bestK must be an integer from 1 through teamSize, got ${input.bestK}`,
    )
  }
  for (const team of input.teams) {
    if (team.members.length !== input.teamSize) {
      throw new RangeError(
        `team ${team.teamId} has ${team.members.length} members; expected ${input.teamSize}`,
      )
    }
    if (new Set(team.members.map((member) => member.participantId)).size !== input.teamSize) {
      throw new RangeError(`team ${team.teamId} contains duplicate members`)
    }
  }

  return calculateBestBall({
    holes: input.holes,
    metric: input.metric,
    bestK: input.bestK,
    teams: input.teams,
    phase: input.phase,
  })
}
