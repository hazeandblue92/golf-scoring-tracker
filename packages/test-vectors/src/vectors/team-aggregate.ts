/** Golden vector for configured hole-level team aggregate (spec §8.4). */

import { COURSE_9 } from '../holes.ts'
import { scoresFor } from './types.ts'
import type { TeamAggregateVector } from './types.ts'

const constantMember = (participantId: string, gross: number) => ({
  participantId,
  playingHandicap: 0,
  scores: scoresFor(participantId, COURSE_9, Array<number>(9).fill(gross)),
})

export const teamAggregateVectors: TeamAggregateVector[] = [
  {
    id: 'aggregate-all-four-hole-level',
    kind: 'team_aggregate',
    section: '§8.4 · AC-FMT-001',
    description: 'Four-player all-scores-count sums every member on each hole before ranking teams',
    input: {
      holes: COURSE_9,
      metric: 'gross',
      teamSize: 4,
      bestK: 4,
      teams: [
        {
          teamId: 'alpha',
          entityStatus: 'active',
          members: [
            constantMember('a1', 4),
            constantMember('a2', 5),
            constantMember('a3', 6),
            constantMember('a4', 7),
          ],
        },
        {
          teamId: 'beta',
          entityStatus: 'active',
          members: [
            constantMember('b1', 5),
            constantMember('b2', 5),
            constantMember('b3', 5),
            constantMember('b4', 5),
          ],
        },
      ],
      phase: 'final',
    },
    expected: {
      rows: [
        { teamId: 'beta', total: 180, thru: 9, rank: 1, status: 'complete' },
        { teamId: 'alpha', total: 198, thru: 9, rank: 2, status: 'complete' },
      ],
      provisional: false,
    },
  },
]
