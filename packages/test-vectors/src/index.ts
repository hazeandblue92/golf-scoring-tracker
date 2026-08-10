/**
 * @gtt/test-vectors — human-reviewed golden scoring scenarios
 * (spec §20.1-20.2).
 *
 * Client preview and server projection MUST both pass this suite (spec §7.3).
 * `allVectors` is the combined run list; `deferredVectors` documents the
 * §20.2 bullets that need the database layer or a later-phase engine module.
 */

export { COURSE_18, COURSE_18_PAR, COURSE_9, COURSE_9_PAR } from './holes.ts'

export type {
  AllocationVector,
  BestBallVector,
  CardEntry,
  CountbackVector,
  CourseHandicapVector,
  GoldenVector,
  MatchAllocationVector,
  MatchVector,
  MultiRoundVector,
  PairTeamHandicapVector,
  ParBogeyVector,
  PlayingHandicapRoundingVector,
  ScrambleHandicapVector,
  SkinsVector,
  StablefordVector,
  StrokePlayVector,
  TeamHandicapExpectation,
  TeamAggregateVector,
  VectorBase,
} from './vectors/types.ts'
export { scoresFor, skinsCard } from './vectors/types.ts'

export { allocationVectors } from './vectors/allocation.ts'
export { bestBallVectors } from './vectors/best-ball.ts'
export {
  courseHandicapVectors,
  roundingVectors,
} from './vectors/course-handicap.ts'
export { countbackVectors } from './vectors/countback.ts'
export { deferredVectors } from './vectors/deferred.ts'
export type { DeferredVector } from './vectors/deferred.ts'
export { matchAllocationVectors, matchVectors } from './vectors/match-play.ts'
export { multiRoundVectors } from './vectors/multi-round.ts'
export { parBogeyVectors } from './vectors/par-bogey.ts'
export { skinsVectors } from './vectors/skins.ts'
export { stablefordVectors } from './vectors/stableford.ts'
export { teamAggregateVectors } from './vectors/team-aggregate.ts'
export { statusBehaviorVectors } from './vectors/status-behavior.ts'
export { strokePlayVectors } from './vectors/stroke-play.ts'
export {
  pairTeamHandicapVectors,
  scrambleHandicapVectors,
} from './vectors/team-handicap.ts'

import type { GoldenVector } from './vectors/types.ts'
import { allocationVectors } from './vectors/allocation.ts'
import { bestBallVectors } from './vectors/best-ball.ts'
import {
  courseHandicapVectors,
  roundingVectors,
} from './vectors/course-handicap.ts'
import { countbackVectors } from './vectors/countback.ts'
import { matchAllocationVectors, matchVectors } from './vectors/match-play.ts'
import { multiRoundVectors } from './vectors/multi-round.ts'
import { parBogeyVectors } from './vectors/par-bogey.ts'
import { skinsVectors } from './vectors/skins.ts'
import { stablefordVectors } from './vectors/stableford.ts'
import { teamAggregateVectors } from './vectors/team-aggregate.ts'
import { statusBehaviorVectors } from './vectors/status-behavior.ts'
import { strokePlayVectors } from './vectors/stroke-play.ts'
import {
  pairTeamHandicapVectors,
  scrambleHandicapVectors,
} from './vectors/team-handicap.ts'

/** Every runnable golden vector, in §20.2 bullet order. */
export const allVectors: GoldenVector[] = [
  ...strokePlayVectors,
  ...allocationVectors,
  ...courseHandicapVectors,
  ...roundingVectors,
  ...bestBallVectors,
  ...teamAggregateVectors,
  ...stablefordVectors,
  ...matchVectors,
  ...matchAllocationVectors,
  ...skinsVectors,
  ...scrambleHandicapVectors,
  ...pairTeamHandicapVectors,
  ...multiRoundVectors,
  ...countbackVectors,
  ...statusBehaviorVectors,
  ...parBogeyVectors,
]
