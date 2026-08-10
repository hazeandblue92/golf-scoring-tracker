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

describe('Phase 2 two-person field trial', () => {
  const service = serviceClient()
  let owner: Awaited<ReturnType<typeof createAccount>>
  let eventId: string
  let roundId: string
  const holes = new Map<number, string>()
  const entries = new Map<string, string>()
  const competitions = new Map<string, string>()
  const teams = new Map<string, string>()

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    owner = await createAccount(service, { displayName: 'Phase 2 Owner' })
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

  it('creates and publishes one frozen roster with six simultaneous competitions', async () => {
    const noHandicapId = randomUUID()
    const noHandicap = await service.from('participants').insert({
      id: noHandicapId,
      league_id: LEAGUE_ID,
      display_name: 'Phase 2 Missing Handicap',
      sort_name: `Missing Handicap, Phase 2 ${noHandicapId}`,
      status: 'active',
    })
    if (noHandicap.error) throw noHandicap.error
    const blocked = await callFunction<{ detail: string }>('save-event-draft', {
      leagueId: LEAGUE_ID,
      seasonId: SEASON_ID,
      name: `Blocked Net Event ${randomUUID().slice(0, 8)}`,
      timezone: 'America/Detroit',
      startsAt: new Date(Date.now() + 172_800_000).toISOString(),
      endsAt: null,
      visibility: 'league',
      teeSetId: TEE_SET_BLUE,
      participantIds: [PLAYERS[0], PLAYERS[1], PLAYERS[2], noHandicapId],
      scorerProfileIds: [],
      competitionPreset: 'two_person_throwdown',
      teams: [
        { name: 'Complete Handicap Pair', participantIds: [PLAYERS[0], PLAYERS[1]] },
        { name: 'Missing Handicap Pair', participantIds: [PLAYERS[2], noHandicapId] },
      ],
    }, owner.accessToken)
    expect(blocked.status).toBe(409)
    expect(blocked.body.detail).toContain('current handicap for every selected player')

    const saved = await callFunction<{
      eventId: string
      roundId: string
      competitionIds: string[]
    }>('save-event-draft', {
      leagueId: LEAGUE_ID,
      seasonId: SEASON_ID,
      name: `Phase 2 Throwdown ${randomUUID().slice(0, 8)}`,
      timezone: 'America/Detroit',
      startsAt: new Date(Date.now() + 172_800_000).toISOString(),
      endsAt: null,
      visibility: 'league',
      teeSetId: TEE_SET_BLUE,
      participantIds: PLAYERS,
      scorerProfileIds: [],
      competitionPreset: 'two_person_throwdown',
      teams: [
        { name: 'Net Switch', participantIds: [PLAYERS[3], PLAYERS[2]] },
        { name: 'Steady Pair', participantIds: [PLAYERS[0], PLAYERS[1]] },
      ],
    }, owner.accessToken)
    expect(saved.status).toBe(200)
    eventId = saved.body.eventId
    roundId = saved.body.roundId
    expect(saved.body.competitionIds).toHaveLength(6)

    const published = await callFunction<{ status: string; teamSnapshotCount: number }>(
      'publish-event',
      { eventId, openScoring: true },
      owner.accessToken,
    )
    expect(published.status).toBe(200)
    expect(published.body.status).toBe('scoring_open')
    expect(published.body.teamSnapshotCount).toBe(2)

    const [entryRows, teamRows, competitionRows, holeRows] = await Promise.all([
      service.from('event_entries').select('id,participant_id,snapshot_hash,handicap_source,handicap_value,course_handicap_unrounded,playing_handicap').eq('event_id', eventId),
      service.from('event_teams').select('id,name,snapshot_hash,event_team_members(id)').eq('event_id', eventId),
      service.from('competitions').select('id,name,format,metric,rules_json').eq('event_id', eventId).order('sort_order'),
      service.from('event_holes').select('id,hole_ordinal,stroke_index').eq('round_id', roundId).lte('hole_ordinal', 4).order('hole_ordinal'),
    ])
    if (entryRows.error || teamRows.error || competitionRows.error || holeRows.error) {
      throw entryRows.error ?? teamRows.error ?? competitionRows.error ?? holeRows.error
    }
    for (const entry of entryRows.data ?? []) {
      entries.set(entry.participant_id, entry.id)
      expect(entry.snapshot_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.handicap_source).not.toBe('scratch_fallback')
      expect(entry.course_handicap_unrounded).not.toBeNull()
    }
    for (const team of teamRows.data ?? []) {
      teams.set(team.name, team.id)
      expect(team.snapshot_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(team.event_team_members).toHaveLength(2)
    }
    for (const competition of competitionRows.data ?? []) competitions.set(competition.name, competition.id)
    expect([...competitions.keys()]).toEqual([
      'Individual Gross', 'Individual Net', 'Two-Person Best Ball Gross',
      'Two-Person Best Ball Net', 'Gross Skins', 'Net Skins',
    ])
    expect((competitionRows.data?.[3]?.rules_json as { handicap: { allowance: number } }).handicap.allowance).toBe(0.85)
    for (const hole of holeRows.data ?? []) holes.set(hole.hole_ordinal, hole.id)
    expect(holeRows.data?.find((hole) => hole.hole_ordinal === 4)?.stroke_index).toBe(1)
  })

  it('reuses four raw scores across gross, net, best-ball, and skins projections', async () => {
    const decidingScores = new Map([
      [PLAYERS[3], 4],
      [PLAYERS[2], 5],
      [PLAYERS[0], 6],
      [PLAYERS[1], 6],
    ])
    let eventRevision = 0
    for (const [ordinal, eventHoleId] of holes) {
      for (const participantId of PLAYERS) {
        const submitted = await callFunction<{ status: string; eventRevision: number }>(
          'submit-score',
          {
            idempotencyKey: randomUUID(),
            eventId,
            roundId,
            target: { kind: 'individual', entryId: entries.get(participantId), holeId: eventHoleId },
            baseRevision: 0,
            value: { status: 'complete', grossStrokes: ordinal === 4 ? decidingScores.get(participantId) : 6, notes: null },
            clientRecordedAt: new Date().toISOString(),
            clientRelease: '0.1.0',
          },
          owner.accessToken,
        )
        expect(submitted.status).toBe(200)
        expect(['committed', 'queued_projection']).toContain(submitted.body.status)
        eventRevision = submitted.body.eventRevision
      }
    }
    expect(eventRevision).toBe(16)
    const holeId = holes.get(4)!

    const projectionRows = await service.from('competition_projections')
      .select('competition_id,event_revision,status')
      .in('competition_id', [...competitions.values()])
      .eq('event_revision', eventRevision)
    if (projectionRows.error) throw projectionRows.error
    expect(projectionRows.data).toHaveLength(6)
    expect(projectionRows.data?.every((row) => row.status === 'live')).toBe(true)

    const switchTeamId = teams.get('Net Switch')!
    const grossCompetitionId = competitions.get('Two-Person Best Ball Gross')!
    const netCompetitionId = competitions.get('Two-Person Best Ball Net')!
    const entityRows = await service.from('competition_entities')
      .select('id,competition_id')
      .eq('event_team_id', switchTeamId)
      .in('competition_id', [grossCompetitionId, netCompetitionId])
    if (entityRows.error) throw entityRows.error
    const entityByCompetition = new Map((entityRows.data ?? []).map((row) => [row.competition_id, row.id]))
    const bestBallHoles = await service.from('hole_results')
      .select('competition_id,entity_id,contributor_entry_ids')
      .in('competition_id', [grossCompetitionId, netCompetitionId])
      .eq('event_revision', eventRevision)
      .eq('event_hole_id', holeId)
    if (bestBallHoles.error) throw bestBallHoles.error
    const gross = bestBallHoles.data?.find((row) => row.entity_id === entityByCompetition.get(grossCompetitionId))
    const net = bestBallHoles.data?.find((row) => row.entity_id === entityByCompetition.get(netCompetitionId))
    expect(gross?.contributor_entry_ids).toEqual([entries.get(PLAYERS[3])])
    expect(net?.contributor_entry_ids).toEqual([entries.get(PLAYERS[2])])

    const skins = await service.from('hole_results')
      .select('competition_id,entity_id,skin_units,skin_winner')
      .in('competition_id', [competitions.get('Gross Skins')!, competitions.get('Net Skins')!])
      .eq('event_revision', eventRevision)
      .eq('event_hole_id', holeId)
    if (skins.error) throw skins.error
    const skinEntityIds = (skins.data ?? []).map((row) => row.entity_id)
    const skinEntities = await service.from('competition_entities').select('id,event_entry_id').in('id', skinEntityIds)
    if (skinEntities.error) throw skinEntities.error
    const winnerEntries = new Map((skinEntities.data ?? []).map((row) => [row.id, row.event_entry_id]))
    expect(winnerEntries.get(skins.data?.find((row) => row.competition_id === competitions.get('Gross Skins'))?.entity_id ?? '')).toBe(entries.get(PLAYERS[3]))
    expect(winnerEntries.get(skins.data?.find((row) => row.competition_id === competitions.get('Net Skins'))?.entity_id ?? '')).toBe(entries.get(PLAYERS[2]))
  }, 30_000)

  it('attests idempotently and exports the portable team roster', async () => {
    const request = {
      roundId,
      targetKind: 'individual',
      targetId: entries.get(PLAYERS[3]),
      attestationType: 'marker',
      reason: null,
    }
    const first = await callFunction<{ status: string; scoreRevision: number }>('attest-scorecard', request, owner.accessToken)
    const duplicate = await callFunction<{ status: string; scoreRevision: number }>('attest-scorecard', request, owner.accessToken)
    expect(first.status).toBe(200)
    expect(first.body.status).toBe('attested')
    expect(first.body.scoreRevision).toBe(4)
    expect(duplicate.body.status).toBe('duplicate')

    const exported = await callFunction<{
      attestationRecords: unknown[]
      tables: { event_teams: unknown[]; event_team_members: unknown[] }
    }>('export-league', { leagueId: LEAGUE_ID, eventId }, owner.accessToken)
    expect(exported.status).toBe(200)
    expect(exported.body.tables.event_teams).toHaveLength(2)
    expect(exported.body.tables.event_team_members).toHaveLength(4)
    expect(exported.body.attestationRecords).toHaveLength(1)
  })
})
