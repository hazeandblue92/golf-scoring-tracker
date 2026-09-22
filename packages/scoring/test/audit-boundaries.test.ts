import { expect, it } from 'vitest'
import { computeHole } from '../src/common.ts'
import { sha256Hex } from '../src/canonical.ts'
import { calculateBestBall } from '../src/formats/best-ball.ts'
import { calculateMatch } from '../src/formats/match-play.ts'
import { calculateParBogey } from '../src/formats/par-bogey.ts'
import { calculateMultiRound } from '../src/formats/multi-round.ts'
import { resolveCountback } from '../src/formats/countback.ts'
import type { HoleScoreStatus } from '../src/types.ts'

const hole = { id: 'h1', ordinal: 1, par: 4, strokeIndex: 1 }

it('rejects incomplete and unknown score representations at the engine boundary', () => {
  const score = { participantId: 'p', holeId: 'h1', revision: 1 }
  expect(() => computeHole(hole, { ...score, status: 'complete' }, 0)).toThrow(/lacks grossStrokes/)
  expect(() => computeHole(hole, { ...score, status: 'invalid' as HoleScoreStatus }, 0)).toThrow(/unknown hole status/)
})

it('hashes two-byte and three-byte UTF-8 text interoperably', () => {
  for (const [value, digest] of [
    ['é', '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c'],
    ['漢', 'fc9f0d61dd80076ae5f0e41688aa0c3e8727b232b7a8c40c4f0671e0cd5d94c9'],
  ] as const) {
    expect(sha256Hex(value)).toBe(digest)
  }
})

it('uses the latest best-ball revision and breaks tied contributions by ID', () => {
  const member = (participantId: string) => ({ participantId, playingHandicap: 0, scores: [
    { participantId, holeId: 'h1', revision: 2, status: 'complete' as const, grossStrokes: 4 },
    { participantId, holeId: 'h1', revision: 1, status: 'complete' as const, grossStrokes: 2 },
  ] })
  const input = { holes: [hole], metric: 'gross' as const, bestK: 1, phase: 'final' as const,
    teams: [{ teamId: 't', entityStatus: 'active' as const, members: [member('z'), member('a')] }] }
  expect(calculateBestBall(input).teamHoles[0]?.contributorIds).toEqual(['a'])
  expect(() => calculateBestBall({ ...input, teams: [{ ...input.teams[0]!, members: [member('a'), member('a')] }] })).toThrow(/duplicate/)
})

it('rejects repeated match holes and ignores inputs outside the match scope', () => {
  expect(() => calculateMatch({ holes: [hole, hole], holeInputs: [], extraHolesAllowed: false })).toThrow(/duplicate hole/)
  const input = { holes: [hole], holeInputs: [], extraHolesAllowed: false }
  expect(calculateMatch({ ...input, holeInputs: [{ holeId: 'outside', a: 3, b: 4 }] })).toEqual(calculateMatch(input))
})

it('does not keep withdrawn par/bogey entries provisional or count their terminal holes', () => {
  for (const metric of ['net', 'gross'] as const) {
    const result = calculateParBogey({ holes: [hole], metric, phase: 'final', entries: [{
      entryId: 'e', entityStatus: 'withdrawn', playingHandicap: null,
      scores: [{ participantId: 'p', holeId: 'h1', status: 'withdrawn', revision: 1 }],
    }] })
    expect(result.rows[0]?.rank).toBeNull()
    expect(result.holeResults[0]?.provisional).toBe(false)
    expect(result.holeResults[0]?.outcome).toBeNull()
  }
})

it('excludes numeric subtotals attached to a terminal round', () => {
  const result = calculateMultiRound({ aggregation: { kind: 'sum_strokes' }, phase: 'final',
    entities: [{ entityId: 'e', rounds: [{ roundId: 'r', status: 'withdrawn', value: 30 }] }] })
  expect(result.rows[0]?.roundsCounted).toBe(0)
  expect(result.rows[0]?.contributions[0]?.counted).toBe(false)
})

it('retains settled countback groups while separating the remaining tied group', () => {
  const result = resolveCountback({ direction: 'asc', sequence: ['last_2', 'hole_2'], entities: [
    { entityId: 'a', holeValues: [2, 3] },
    { entityId: 'b', holeValues: [3, 2] },
    { entityId: 'c', holeValues: [4, 4] },
  ] })
  expect(result.placements.map((p) => p.entityId)).toEqual(['b', 'a', 'c'])
  expect(result.unresolved).toBe(false)
})
