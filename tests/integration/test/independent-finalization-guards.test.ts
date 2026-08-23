/** Focused database guards for independently sealed competition inputs. */

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  buildScoringFixture,
  LEAGUE_ID,
  type ScoringFixture,
} from '../helpers/fixture.ts'
import { callFunction, stackIsUp } from '../helpers/stack.ts'

const HTTP_TIMEOUT_MS = 120_000
const BACK_NINE = Array.from({ length: 9 }, (_, index) => index + 10)

function commonRules(
  format: string,
  holeScope: number[],
  team?: Record<string, unknown>,
) {
  return {
    format,
    schemaVersion: 1,
    metric: 'gross',
    holeScope,
    handicap: {
      profile: 'none',
      allowance: 1,
      rounding: 'half_up_toward_positive_infinity',
      matchNormalizeFromLowest: false,
      allocation: 'stroke_index',
    },
    ...(team ? { team } : {}),
    ties: { mode: 'tied', sequence: [] },
    incomplete: { live: 'provisional', final: 'no_return' },
    visibility: 'league',
  }
}

describe('independent finalization fact-kind and hole-scope guards', () => {
  let fx: ScoringFixture
  let teamBallTeamId: string
  let individualSourceTeamId: string
  let teamBallCompetitionId: string
  let individualSourceCompetitionId: string
  let teamBallEntityId: string

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    fx = await buildScoringFixture({ playerCount: 4 })

    teamBallTeamId = randomUUID()
    individualSourceTeamId = randomUUID()
    const teams = await fx.service.from('event_teams').insert([
      {
        id: teamBallTeamId,
        event_id: fx.eventId,
        name: `Team Ball ${teamBallTeamId.slice(0, 8)}`,
        status: 'active',
        playing_handicap: 0,
      },
      {
        id: individualSourceTeamId,
        event_id: fx.eventId,
        name: `Member Cards ${individualSourceTeamId.slice(0, 8)}`,
        status: 'active',
        playing_handicap: 0,
      },
    ])
    if (teams.error) throw teams.error

    const members = await fx.service.from('event_team_members').insert([
      { event_team_id: teamBallTeamId, event_entry_id: fx.entries[0]!.entryId, position: 1 },
      { event_team_id: teamBallTeamId, event_entry_id: fx.entries[1]!.entryId, position: 2 },
      { event_team_id: individualSourceTeamId, event_entry_id: fx.entries[2]!.entryId, position: 1 },
      { event_team_id: individualSourceTeamId, event_entry_id: fx.entries[3]!.entryId, position: 2 },
    ])
    if (members.error) throw members.error

    teamBallCompetitionId = randomUUID()
    individualSourceCompetitionId = randomUUID()
    const competitions = await fx.service.from('competitions').insert([
      {
        id: teamBallCompetitionId,
        event_id: fx.eventId,
        name: `Sealed team ball ${teamBallCompetitionId.slice(0, 8)}`,
        format: 'scramble',
        metric: 'gross',
        status: 'scoring_open',
        rules_schema_version: 1,
        rules_json: commonRules('scramble', [1], {
          teamSize: 2,
          bestK: 1,
          scoreSource: 'team_ball',
          weights: [0.35, 0.15],
        }),
        engine_version: 'test',
      },
      {
        id: individualSourceCompetitionId,
        event_id: fx.eventId,
        name: `Sealed member cards ${individualSourceCompetitionId.slice(0, 8)}`,
        format: 'aggregate',
        metric: 'gross',
        status: 'scoring_open',
        rules_schema_version: 1,
        rules_json: commonRules('aggregate', [1], {
          teamSize: 2,
          bestK: 2,
          scoreSource: 'individual',
        }),
        engine_version: 'test',
      },
    ])
    if (competitions.error) throw competitions.error

    const links = await fx.service.from('competition_rounds').insert([
      {
        competition_id: teamBallCompetitionId,
        round_id: fx.roundId,
        hole_scope: [1],
        weight: 1,
      },
      {
        competition_id: individualSourceCompetitionId,
        round_id: fx.roundId,
        hole_scope: [1],
        weight: 1,
      },
    ])
    if (links.error) throw links.error

    const entities = await fx.service.from('competition_entities').insert([
      {
        competition_id: teamBallCompetitionId,
        event_team_id: teamBallTeamId,
        eligibility_status: 'eligible',
      },
      {
        competition_id: individualSourceCompetitionId,
        event_team_id: individualSourceTeamId,
        eligibility_status: 'eligible',
      },
    ]).select('id,competition_id')
    if (entities.error) throw entities.error
    teamBallEntityId = entities.data?.find(
      (entity) => entity.competition_id === teamBallCompetitionId,
    )?.id as string
    expect(teamBallEntityId).toBeTruthy()

    const projectionHeaders = await fx.service.from('competition_projections').insert([
      {
        competition_id: teamBallCompetitionId,
        event_revision: 0,
        engine_version: 'test',
        projection_hash: 'a'.repeat(64),
        status: 'final',
      },
      {
        competition_id: individualSourceCompetitionId,
        event_revision: 0,
        engine_version: 'test',
        projection_hash: 'b'.repeat(64),
        status: 'final',
      },
      {
        competition_id: teamBallCompetitionId,
        event_revision: 2,
        engine_version: 'test',
        projection_hash: 'a'.repeat(64),
        status: 'live',
      },
    ])
    if (projectionHeaders.error) throw projectionHeaders.error
    const projectionRow = await fx.service.from('leaderboard_rows').insert({
      competition_id: teamBallCompetitionId,
      event_revision: 0,
      entity_id: teamBallEntityId,
      rank: 1,
      status: 'complete',
    })
    if (projectionRow.error) throw projectionRow.error

    for (const competitionId of [teamBallCompetitionId, individualSourceCompetitionId]) {
      const closed = await fx.service.from('competitions')
        .update({ status: 'scoring_closed' }).eq('id', competitionId)
      if (closed.error) throw closed.error
      const finalized = await fx.service.from('competitions').update({
        status: 'finalized',
        finalized_at: new Date().toISOString(),
        finalized_by: fx.director.profileId,
        final_result_hash: competitionId === teamBallCompetitionId
          ? 'a'.repeat(64)
          : 'b'.repeat(64),
      }).eq('id', competitionId)
      if (finalized.error) throw finalized.error
    }
  }, 240_000)

  it('exports the exact sealed revision rather than a later matching live hash', async () => {
    const snapshot = await fx.service.rpc('export_portable_snapshot', {
      p_actor: fx.director.profileId,
      p_league_id: LEAGUE_ID,
      p_event_id: fx.eventId,
    })
    if (snapshot.error) throw snapshot.error
    const data = snapshot.data as {
      authorized: boolean
      tables: {
        competition_projections: Array<Record<string, unknown>>
      }
    }
    expect(data.authorized).toBe(true)
    expect(data.tables.competition_projections.filter((projection) =>
      projection.competition_id === teamBallCompetitionId)).toEqual([
      expect.objectContaining({
        event_revision: 0,
        engine_version: 'test',
        projection_hash: 'a'.repeat(64),
        status: 'final',
      }),
    ])
  })

  it('locks only the raw fact kind consumed by each sealed team format', async () => {
    const hole = fx.holes[0]!

    const unrelatedMemberCard = await fx.service.from('individual_hole_scores').insert({
      event_id: fx.eventId,
      round_id: fx.roundId,
      event_entry_id: fx.entries[0]!.entryId,
      event_hole_id: hole.id,
      gross_strokes: 4,
      score_status: 'complete',
      revision: 1,
    })
    expect(unrelatedMemberCard.error).toBeNull()

    const sealedTeamBall = await fx.service.from('team_hole_scores').insert({
      event_id: fx.eventId,
      round_id: fx.roundId,
      event_team_id: teamBallTeamId,
      event_hole_id: hole.id,
      gross_strokes: 4,
      score_status: 'complete',
      revision: 1,
    })
    expect(sealedTeamBall.error?.code).toBe('23514')

    const unrelatedTeamBall = await fx.service.from('team_hole_scores').insert({
      event_id: fx.eventId,
      round_id: fx.roundId,
      event_team_id: individualSourceTeamId,
      event_hole_id: hole.id,
      gross_strokes: 5,
      score_status: 'complete',
      revision: 1,
    })
    expect(unrelatedTeamBall.error).toBeNull()

    const sealedMemberCard = await fx.service.from('individual_hole_scores').insert({
      event_id: fx.eventId,
      round_id: fx.roundId,
      event_entry_id: fx.entries[2]!.entryId,
      event_hole_id: hole.id,
      gross_strokes: 5,
      score_status: 'complete',
      revision: 1,
    })
    expect(sealedMemberCard.error?.code).toBe('23514')
  })

  it('exposes only the all-or-nothing fresh-project restore entrypoint', async () => {
    const matchCompetitionId = randomUUID()
    const matchHash = 'c'.repeat(64)
    const matchCompetition = await fx.service.from('competitions').insert({
      id: matchCompetitionId,
      event_id: fx.eventId,
      name: `Restored match ${matchCompetitionId.slice(0, 8)}`,
      format: 'match',
      metric: 'gross',
      status: 'scoring_open',
      rules_schema_version: 1,
      rules_json: commonRules('match', [1]),
      engine_version: 'test',
    })
    if (matchCompetition.error) throw matchCompetition.error
    const matchLink = await fx.service.from('competition_rounds').insert({
      competition_id: matchCompetitionId,
      round_id: fx.roundId,
      hole_scope: [1],
      weight: 1,
    })
    if (matchLink.error) throw matchLink.error
    const matchEntities = await fx.service.from('competition_entities').insert([
      {
        competition_id: matchCompetitionId,
        event_entry_id: fx.entries[0]!.entryId,
        eligibility_status: 'eligible',
      },
      {
        competition_id: matchCompetitionId,
        event_entry_id: fx.entries[1]!.entryId,
        eligibility_status: 'eligible',
      },
    ]).select('id')
    if (matchEntities.error) throw matchEntities.error
    const [sideA, sideB] = matchEntities.data ?? []
    expect(sideA?.id).toBeTruthy()
    expect(sideB?.id).toBeTruthy()

    // This setup bypasses the finalization Edge Function so it can exercise
    // the restore-only guards directly. Keep the hand-built finalized record
    // production-valid: league-wide exports must reject any finalized
    // competition that has no matching sealed projection artifact.
    const matchProjection = await fx.service.from('competition_projections').insert({
      competition_id: matchCompetitionId,
      event_revision: 0,
      engine_version: 'test',
      projection_hash: matchHash,
      status: 'final',
      warnings: [],
      summary_json: {},
    })
    if (matchProjection.error) throw matchProjection.error

    const matchClosed = await fx.service.from('competitions')
      .update({ status: 'scoring_closed' }).eq('id', matchCompetitionId)
    if (matchClosed.error) throw matchClosed.error
    const matchFinalized = await fx.service.from('competitions').update({
      status: 'finalized',
      finalized_at: new Date().toISOString(),
      finalized_by: fx.director.profileId,
      final_result_hash: matchHash,
    }).eq('id', matchCompetitionId)
    if (matchFinalized.error) throw matchFinalized.error

    const now = new Date().toISOString()
    const restoredMatch = await fx.service.rpc('restore_portable_matches', {
      p_rows: [{
        id: randomUUID(),
        competition_id: matchCompetitionId,
        round_id: fx.roundId,
        side_a_entity_id: sideA!.id,
        side_b_entity_id: sideB!.id,
        bracket_position: 1,
        status: 'complete',
        winner_entity_id: sideA!.id,
        result_summary: '1 UP',
        concession_by: null,
        concession_reason: null,
        created_at: now,
        updated_at: now,
      }],
    })
    expect(restoredMatch.error?.code).toBe('42501')

    const ordinaryMatchInsert = await fx.service.from('matches').insert({
      competition_id: matchCompetitionId,
      round_id: fx.roundId,
      side_a_entity_id: sideA!.id,
      side_b_entity_id: sideB!.id,
      status: 'scheduled',
    })
    expect(ordinaryMatchInsert.error?.code).toBe('23514')

    const { data: sealedCompetition, error: sealedCompetitionError } = await fx.service
      .from('competitions')
      .select('engine_version,final_result_hash,finalized_revision')
      .eq('id', teamBallCompetitionId)
      .single()
    if (sealedCompetitionError) throw sealedCompetitionError
    const restoredProjection = await fx.service.rpc('restore_portable_projection_artifact', {
      p_projections: [{
        competition_id: teamBallCompetitionId,
        event_revision: sealedCompetition!.finalized_revision,
        engine_version: sealedCompetition!.engine_version,
        projection_hash: sealedCompetition!.final_result_hash,
        status: 'final',
        calculated_at: now,
        warnings: [],
        summary_json: {},
      }],
      p_leaderboard_rows: [],
      p_hole_results: [],
    })
    expect(restoredProjection.error?.code).toBe('42501')

    const laterProjection = await fx.service.from('competition_projections').insert({
      competition_id: teamBallCompetitionId,
      event_revision: (sealedCompetition!.finalized_revision as number) + 1,
      engine_version: sealedCompetition!.engine_version,
      projection_hash: sealedCompetition!.final_result_hash,
      status: 'final',
      warnings: [],
      summary_json: {},
    })
    expect(laterProjection.error?.code).toBe('23514')
  }, HTTP_TIMEOUT_MS)

  it('locks the complete sealed tuple and both sides of projection moves', async () => {
    const original = await fx.service.from('competitions')
      .select('engine_version,final_result_hash,finalized_revision')
      .eq('id', teamBallCompetitionId)
      .single()
    if (original.error) throw original.error

    for (const patch of [
      { final_result_hash: 'f'.repeat(64) },
      { engine_version: 'tampered' },
      { finalized_revision: Number(original.data.finalized_revision) + 1 },
      { finalized_at: new Date(0).toISOString() },
      { finalized_by: null },
    ]) {
      const changed = await fx.service.from('competitions')
        .update(patch)
        .eq('id', teamBallCompetitionId)
      expect(changed.error?.code).toBe('23514')
    }

    const destinationId = randomUUID()
    const destination = await fx.service.from('competitions').insert({
      id: destinationId,
      event_id: fx.eventId,
      name: `Projection destination ${destinationId.slice(0, 8)}`,
      format: 'individual_stroke',
      metric: 'gross',
      status: 'scoring_open',
      rules_schema_version: 1,
      rules_json: commonRules('individual_stroke', [1]),
      engine_version: 'test',
    })
    if (destination.error) throw destination.error

    const movedHeader = await fx.service.from('competition_projections')
      .update({ competition_id: destinationId })
      .eq('competition_id', teamBallCompetitionId)
      .eq('event_revision', 0)
    expect(movedHeader.error?.code).toBe('23514')

    const movedRow = await fx.service.from('leaderboard_rows')
      .update({ competition_id: destinationId })
      .eq('competition_id', teamBallCompetitionId)
      .eq('event_revision', 0)
      .eq('entity_id', teamBallEntityId)
    expect(movedRow.error?.code).toBe('23514')

    const deletedHeader = await fx.service.from('competition_projections')
      .delete()
      .eq('competition_id', teamBallCompetitionId)
      .eq('event_revision', 0)
    expect(deletedHeader.error?.code).toBe('23514')
  }, HTTP_TIMEOUT_MS)

  it('finalizes a back-nine competition without overriding missing front-nine scores', async () => {
    const competitionId = randomUUID()
    const competition = await fx.service.from('competitions').insert({
      id: competitionId,
      event_id: fx.eventId,
      name: `Scoped gross ${competitionId.slice(0, 8)}`,
      format: 'individual_stroke',
      metric: 'gross',
      status: 'scoring_open',
      rules_schema_version: 1,
      rules_json: commonRules('individual_stroke', BACK_NINE),
      engine_version: 'test',
    })
    if (competition.error) throw competition.error

    const link = await fx.service.from('competition_rounds').insert({
      competition_id: competitionId,
      round_id: fx.roundId,
      hole_scope: BACK_NINE,
      weight: 1,
    })
    if (link.error) throw link.error

    const entities = await fx.service.from('competition_entities').insert(
      fx.entries.map((entry) => ({
        competition_id: competitionId,
        event_entry_id: entry.entryId,
        eligibility_status: 'eligible',
      })),
    )
    if (entities.error) throw entities.error

    const backHoles = fx.holes.filter((hole) => BACK_NINE.includes(hole.ordinal))
    const scores = await fx.service.from('individual_hole_scores').insert(
      fx.entries.flatMap((entry, entrant) => backHoles.map((hole) => ({
        event_id: fx.eventId,
        round_id: fx.roundId,
        event_entry_id: entry.entryId,
        event_hole_id: hole.id,
        gross_strokes: hole.par + entrant,
        score_status: 'complete',
        revision: 1,
      }))),
    )
    if (scores.error) throw scores.error

    const attestations = await fx.service.from('scorecard_attestations').insert(
      fx.entries.map((entry, index) => ({
        round_id: fx.roundId,
        event_entry_id: entry.entryId,
        profile_id: fx.director.profileId,
        attestation_type: 'director_override',
        score_revision: index === 0 ? 10 : 9,
        reason: 'Scoped integration card attestation',
      })),
    )
    if (attestations.error) throw attestations.error

    const finalized = await callFunction<{
      status: string
      missingScoreOverrides?: number
      finalResultHash?: string
    }>(
      'finalize-competition',
      { competitionId, overrideReason: null },
      fx.director.accessToken,
    )
    expect(finalized.status, JSON.stringify(finalized.body)).toBe(200)
    expect(finalized.body.status).toBe('finalized')
    expect(finalized.body.missingScoreOverrides).toBe(0)
    expect(finalized.body.finalResultHash).toMatch(/^[0-9a-f]{64}$/)
  }, HTTP_TIMEOUT_MS)
})
