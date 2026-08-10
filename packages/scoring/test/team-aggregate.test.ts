import { describe, expect, it } from 'vitest'

import {
  calculateTeamAggregate,
  type BestBallTeam,
  type HoleSnapshot,
  type IndividualHoleScore,
} from '../src/index.ts'

const holes: HoleSnapshot[] = [
  { id: 'h1', ordinal: 1, par: 4, strokeIndex: 1 },
  { id: 'h2', ordinal: 2, par: 4, strokeIndex: 2 },
]

function member(participantId: string, values: Array<number | null>) {
  const scores: IndividualHoleScore[] = values.flatMap((grossStrokes, index) => {
    const hole = holes[index]
    return grossStrokes === null || hole === undefined
      ? []
      : [{ participantId, holeId: hole.id, grossStrokes, status: 'complete' as const, revision: 1 }]
  })
  return { participantId, playingHandicap: 0, scores }
}

function fourPlayerTeams(): BestBallTeam[] {
  return [
    {
      teamId: 'alpha',
      entityStatus: 'active',
      members: [member('a1', [4, 4]), member('a2', [5, 4]), member('a3', [6, 4]), member('a4', [7, 4])],
    },
    {
      teamId: 'beta',
      entityStatus: 'active',
      members: [member('b1', [5, 5]), member('b2', [5, 5]), member('b3', [5, 5]), member('b4', [5, 5])],
    },
  ]
}

describe('team aggregate (spec §8.4)', () => {
  it('counts every member at the hole level when bestK equals teamSize', () => {
    const result = calculateTeamAggregate({
      holes,
      metric: 'gross',
      teamSize: 4,
      bestK: 4,
      teams: fourPlayerTeams(),
      phase: 'final',
    })

    expect(result.rows.map((row) => ({ teamId: row.teamId, total: row.total, rank: row.rank }))).toEqual([
      { teamId: 'alpha', total: 38, rank: 1 },
      { teamId: 'beta', total: 40, rank: 2 },
    ])
    expect(result.teamHoles.find((hole) => hole.teamId === 'alpha' && hole.holeId === 'h1')).toMatchObject({
      teamScore: 22,
      contributorIds: ['a1', 'a2', 'a3', 'a4'],
      status: 'complete',
    })
  })

  it('keeps a live all-scores-count hole provisional when one member is missing', () => {
    const teams = fourPlayerTeams()
    teams[0]!.members[3] = member('a4', [null, 4])
    const live = calculateTeamAggregate({
      holes,
      metric: 'gross',
      teamSize: 4,
      bestK: 4,
      teams,
      phase: 'live',
    })
    expect(live.teamHoles.find((hole) => hole.teamId === 'alpha' && hole.holeId === 'h1')).toMatchObject({
      teamScore: null,
      status: 'provisional',
    })

    const final = calculateTeamAggregate({
      holes,
      metric: 'gross',
      teamSize: 4,
      bestK: 4,
      teams,
      phase: 'final',
    })
    expect(final.rows.find((row) => row.teamId === 'alpha')).toMatchObject({
      total: null,
      status: 'no_return',
    })
  })

  it('rejects inconsistent frozen team rules and rosters', () => {
    expect(() => calculateTeamAggregate({
      holes,
      metric: 'gross',
      teamSize: 4,
      bestK: 5,
      teams: fourPlayerTeams(),
      phase: 'final',
    })).toThrow(RangeError)
    expect(() => calculateTeamAggregate({
      holes,
      metric: 'gross',
      teamSize: 3,
      bestK: 3,
      teams: fourPlayerTeams(),
      phase: 'final',
    })).toThrow(/expected 3/)
  })
})
