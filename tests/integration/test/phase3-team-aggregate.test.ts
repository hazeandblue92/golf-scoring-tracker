import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import { createAccount, LEAGUE_ID, SEASON_ID, TEE_SET_BLUE } from '../helpers/fixture.ts'
import { callFunction, serviceClient, stackIsUp } from '../helpers/stack.ts'

const PLAYERS = [
  '00000000-0000-4000-8000-000000000201',
  '00000000-0000-4000-8000-000000000202',
  '00000000-0000-4000-8000-000000000203',
  '00000000-0000-4000-8000-000000000204',
]

describe('Phase 3 hole-level team aggregate', () => {
  const service = serviceClient()
  let owner: Awaited<ReturnType<typeof createAccount>>

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    owner = await createAccount(service, { displayName: 'Phase 3 Aggregate Owner' })
    const membership = await service.from('league_memberships').insert({
      league_id: LEAGUE_ID,
      profile_id: owner.profileId,
      member_status: 'active',
    })
    if (membership.error) throw membership.error
    const role = await service.from('role_assignments').insert({
      league_id: LEAGUE_ID,
      profile_id: owner.profileId,
      role: 'owner',
    })
    if (role.error) throw role.error
  }, 60_000)

  it('publishes all-scores-count from individual facts and blocks incomplete finalization', async () => {
    const saved = await callFunction<{ eventId: string; roundId: string }>('save-event-draft', {
      leagueId: LEAGUE_ID,
      seasonId: SEASON_ID,
      name: `Phase 3 Aggregate ${randomUUID().slice(0, 8)}`,
      timezone: 'America/Detroit',
      startsAt: new Date(Date.now() + 172_800_000).toISOString(),
      endsAt: null,
      visibility: 'league',
      teeSetId: TEE_SET_BLUE,
      participantIds: PLAYERS,
      scorerProfileIds: [],
      competitionPreset: 'two_person_throwdown',
      teams: [
        { name: 'Team Alpha', participantIds: [PLAYERS[0], PLAYERS[1]] },
        { name: 'Team Beta', participantIds: [PLAYERS[2], PLAYERS[3]] },
      ],
    }, owner.accessToken)
    expect(saved.status).toBe(200)

    const [teamRows, entryRows] = await Promise.all([
      service.from('event_teams').select('id,name').eq('event_id', saved.body.eventId),
      service.from('event_entries').select('id,participant_id').eq('event_id', saved.body.eventId),
    ])
    if (teamRows.error || entryRows.error) throw teamRows.error ?? entryRows.error
    const teamByName = new Map((teamRows.data ?? []).map((team) => [team.name, team.id]))
    const entryByParticipant = new Map((entryRows.data ?? []).map((entry) => [entry.participant_id, entry.id]))
    const competitionId = randomUUID()
    const holeScope = Array.from({ length: 18 }, (_, index) => index + 1)
    const rules = {
      format: 'aggregate',
      schemaVersion: 1,
      metric: 'gross',
      holeScope,
      handicap: {
        profile: 'none', allowance: 1,
        rounding: 'half_up_toward_positive_infinity',
        matchNormalizeFromLowest: false, allocation: 'stroke_index',
      },
      team: { teamSize: 2, bestK: 2, scoreSource: 'individual' },
      ties: { mode: 'tied', sequence: [] },
      incomplete: { live: 'provisional', final: 'no_return' },
      visibility: 'league',
    }
    const competition = await service.from('competitions').insert({
      id: competitionId,
      event_id: saved.body.eventId,
      name: 'Two-Player Team Aggregate',
      format: 'aggregate',
      metric: 'gross',
      status: 'draft',
      rules_schema_version: 1,
      rules_json: rules,
      rules_text: 'Both individual gross scores count on every hole.',
      engine_version: '0.1.0',
      visibility: 'league',
      sort_order: 7,
    })
    if (competition.error) throw competition.error
    const competitionRound = await service.from('competition_rounds').insert({
      competition_id: competitionId,
      round_id: saved.body.roundId,
      hole_scope: null,
      weight: 1,
    })
    if (competitionRound.error) throw competitionRound.error
    const entities = await service.from('competition_entities').insert((teamRows.data ?? []).map((team) => ({
      competition_id: competitionId,
      event_team_id: team.id,
      eligibility_status: 'eligible',
    }))).select('id,event_team_id')
    if (entities.error) throw entities.error

    const published = await callFunction<{ status: string }>(
      'publish-event',
      { eventId: saved.body.eventId, openScoring: true },
      owner.accessToken,
    )
    expect(published.status, JSON.stringify(published.body)).toBe(200)

    const holeRow = await service.from('event_holes')
      .select('id').eq('round_id', saved.body.roundId).eq('hole_ordinal', 1).single()
    if (holeRow.error) throw holeRow.error
    const grossByPlayer = new Map([
      [PLAYERS[0], 4], [PLAYERS[1], 5], [PLAYERS[2], 6], [PLAYERS[3], 7],
    ])
    let eventRevision = 0
    for (const participantId of PLAYERS) {
      const submitted = await callFunction<{ eventRevision: number }>('submit-score', {
        idempotencyKey: randomUUID(),
        eventId: saved.body.eventId,
        roundId: saved.body.roundId,
        target: {
          kind: 'individual',
          entryId: entryByParticipant.get(participantId),
          holeId: holeRow.data.id,
        },
        baseRevision: 0,
        value: { status: 'complete', grossStrokes: grossByPlayer.get(participantId), notes: null },
        clientRecordedAt: new Date().toISOString(),
        clientRelease: '0.1.0',
      }, owner.accessToken)
      expect(submitted.status).toBe(200)
      eventRevision = submitted.body.eventRevision
    }
    expect(eventRevision).toBe(4)

    const projection = await service.from('competition_projections')
      .select('status,warnings,summary_json').eq('competition_id', competitionId)
      .eq('event_revision', eventRevision).single()
    if (projection.error) throw projection.error
    expect(projection.data.status).toBe('live')
    expect(projection.data.warnings).toEqual([])
    expect(projection.data.summary_json).toMatchObject({ format: 'aggregate', provisional: true })

    const entityByTeam = new Map((entities.data ?? []).map((entity) => [entity.event_team_id, entity.id]))
    const rows = await service.from('leaderboard_rows')
      .select('entity_id,rank,result_primary,detail_json')
      .eq('competition_id', competitionId).eq('event_revision', eventRevision)
      .order('rank')
    if (rows.error) throw rows.error
    expect(rows.data).toEqual([
      {
        entity_id: entityByTeam.get(teamByName.get('Team Alpha')!),
        rank: 1,
        result_primary: 9,
        detail_json: { aggregation: 'all_scores_count', bestK: 2, teamSize: 2 },
      },
      {
        entity_id: entityByTeam.get(teamByName.get('Team Beta')!),
        rank: 2,
        result_primary: 13,
        detail_json: { aggregation: 'all_scores_count', bestK: 2, teamSize: 2 },
      },
    ])

    const holeResults = await service.from('hole_results')
      .select('entity_id,gross,contributor_entry_ids,provisional')
      .eq('competition_id', competitionId).eq('event_revision', eventRevision)
      .eq('event_hole_id', holeRow.data.id)
    if (holeResults.error) throw holeResults.error
    expect(holeResults.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entity_id: entityByTeam.get(teamByName.get('Team Alpha')!),
        gross: 9,
        contributor_entry_ids: [entryByParticipant.get(PLAYERS[0]), entryByParticipant.get(PLAYERS[1])],
        provisional: false,
      }),
      expect.objectContaining({
        entity_id: entityByTeam.get(teamByName.get('Team Beta')!),
        gross: 13,
        contributor_entry_ids: [entryByParticipant.get(PLAYERS[2]), entryByParticipant.get(PLAYERS[3])],
        provisional: false,
      }),
    ]))

    const finalized = await callFunction<{ missingScores: number; unattestedCards: number }>(
      'finalize-competition',
      { competitionId, overrideReason: null },
      owner.accessToken,
    )
    expect(finalized.status).toBe(409)
    expect(finalized.body.missingScores).toBe(34)
    expect(finalized.body.unattestedCards).toBe(4)
  }, 60_000)
})
