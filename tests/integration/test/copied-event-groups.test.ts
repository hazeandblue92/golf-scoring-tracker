import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import { createAccount, LEAGUE_ID, SEASON_ID, TEE_SET_BLUE } from '../helpers/fixture.ts'
import { anonClient, callFunction, serviceClient, stackIsUp, userClient } from '../helpers/stack.ts'

describe('copied event tee groups and scoring boundaries', () => {
  const service = serviceClient()
  const participants = Array.from({ length: 8 }, () => randomUUID())
  let owner: Awaited<ReturnType<typeof createAccount>>
  let player: Awaited<ReturnType<typeof createAccount>>
  let marker: Awaited<ReturnType<typeof createAccount>>
  let eventId: string
  let roundId: string

  const teams = [0, 2, 4, 6].map((offset) => ({
    name: `Pair ${offset / 2 + 1}`,
    participantIds: participants.slice(offset, offset + 2),
  }))
  // Deliberately different from the preset's adjacent-team grouping.
  const groups = [
    { label: 'East tee', startHoleOrdinal: 10, participantIds: [participants[0], participants[1], participants[4], participants[5]] },
    { label: 'West tee', startHoleOrdinal: 1, participantIds: [participants[2], participants[3], participants[6], participants[7]] },
  ]

  function request() {
    return {
      leagueId: LEAGUE_ID, seasonId: SEASON_ID,
      name: `Copied groups ${randomUUID().slice(0, 8)}`,
      timezone: 'America/Detroit', startsAt: new Date(Date.now() + 86400000).toISOString(),
      endsAt: null, visibility: 'league', teeSetId: TEE_SET_BLUE,
      participantIds: participants, scorerProfileIds: [marker.profileId],
      competitionPreset: 'two_person_throwdown', teams, groups,
    }
  }

  async function savedGroups() {
    const result = await service.from('groups')
      .select('id,label,start_hole_ordinal,sort_order,group_members(event_team_id,event_entry_id,sort_order)')
      .eq('round_id', roundId).order('sort_order')
    expect(result.error).toBeNull()
    return result.data
  }

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    owner = await createAccount(service, { displayName: 'Copy Owner', withMfa: true })
    player = await createAccount(service, { displayName: 'Copy Player', withMfa: true })
    marker = await createAccount(service, { displayName: 'Copy Field Marker' })
    const membership = await service.from('league_memberships').insert(
      [owner, player, marker].map((account) => ({
        league_id: LEAGUE_ID, profile_id: account.profileId, member_status: 'active',
      })),
    )
    expect(membership.error).toBeNull()
    const role = await service.from('role_assignments').insert({
      league_id: LEAGUE_ID, profile_id: owner.profileId, role: 'owner',
    })
    expect(role.error).toBeNull()
    const roster = await service.from('participants').insert(participants.map((id, index) => ({
      id, league_id: LEAGUE_ID, display_name: `Copy Player ${id.slice(0, 8)}`,
      sort_name: `copy ${id}`, status: 'active', profile_id: index === 0 ? player.profileId : null,
    })))
    expect(roster.error).toBeNull()
    const handicaps = await service.from('participant_handicaps').insert(participants.map((id) => ({
      participant_id: id, value: 0, source: 'manual_verified', effective_from: '2026-01-01',
      verified_by: owner.profileId, verified_at: new Date().toISOString(),
    })))
    expect(handicaps.error).toBeNull()
    const saved = await callFunction<{ eventId: string; roundId: string }>('save-event-draft', request(), owner.accessToken)
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    eventId = saved.body.eventId
    roundId = saved.body.roundId
  }, 240000)

  it('retains explicit group labels, starting holes, and non-adjacent pairs', async () => {
    const rows = await savedGroups()
    expect(rows?.map((row) => [row.label, row.start_hole_ordinal])).toEqual([['East tee', 10], ['West tee', 1]])
    const members = await service.from('event_teams')
      .select('id,event_team_members(event_entries(participant_id))').eq('event_id', eventId)
    expect(members.error).toBeNull()
    const byId = new Map(members.data?.map((team) => [team.id,
      team.event_team_members.map((member) => member.event_entries.participant_id)]))
    for (const [index, row] of (rows ?? []).entries()) {
      expect(row.group_members.flatMap((member) => byId.get(member.event_team_id) ?? []).sort())
        .toEqual([...groups[index].participantIds].sort())
    }
  })

  it('keeps automatic markers within their copied group after repeated saves', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const saved = await callFunction('save-event-draft', { ...request(), eventId }, owner.accessToken)
      expect(saved.status, JSON.stringify(saved.body)).toBe(200)
      const permissions = await service.from('scoring_permissions')
        .select('scorer_profile_id,participant_id,grant_origin').eq('event_id', eventId)
      expect(permissions.error).toBeNull()
      const rows = permissions.data ?? []
      expect(rows.filter((row) => row.grant_origin === 'group_auto').map((row) => row.participant_id).sort())
        .toEqual([...groups[0].participantIds].sort())
      expect(rows.filter((row) => row.grant_origin === 'self').map((row) => row.participant_id)).toEqual([participants[0]])
      expect(rows.filter((row) => row.grant_origin === 'explicit_field').every((row) => row.scorer_profile_id === marker.profileId)).toBe(true)
      expect(rows.filter((row) => row.grant_origin === 'explicit_field')).toHaveLength(8)
    }
  })

  it('rolls back the entire draft when copied groups split teams or repeat participants', async () => {
    const before = await savedGroups()
    for (const invalidGroups of [
      [groups[0], groups[0]],
      [
        { ...groups[0], participantIds: [participants[0], participants[2], participants[4], participants[5]] },
        { ...groups[1], participantIds: [participants[1], participants[3], participants[6], participants[7]] },
      ],
    ]) {
      const saved = await callFunction('save-event-draft', { ...request(), eventId, groups: invalidGroups }, owner.accessToken)
      expect(saved.status).toBe(409)
      expect(await savedGroups()).toEqual(before)
    }
  })

  it('denies direct browser RPC access and a non-organizer with MFA', async () => {
    for (const client of [anonClient(), userClient(player.accessToken)]) {
      const denied = await client.rpc('save_event_draft_with_groups', { p_actor: owner.profileId, p_body: request() })
      expect(denied.error?.code).toBe('42501')
    }
    const denied = await callFunction('save-event-draft', request(), player.accessToken)
    expect(denied.status).toBe(403)
  })

  it('accepts a score inside the copied group and rejects a score outside it', async () => {
    const published = await callFunction('publish-event', { eventId, openScoring: true }, owner.accessToken)
    expect(published.status, JSON.stringify(published.body)).toBe(200)
    const entries = await service.from('event_entries').select('id,participant_id').eq('event_id', eventId)
    const holes = await service.from('event_holes').select('id').eq('round_id', roundId).order('hole_ordinal').limit(1)
    expect(entries.error).toBeNull()
    expect(holes.error).toBeNull()
    for (const [index, expectedStatus] of [[4, 200], [2, 403]]) {
      const response = await callFunction('submit-score', {
        idempotencyKey: randomUUID(), eventId, roundId,
        target: { kind: 'individual', entryId: entries.data?.find((entry) => entry.participant_id === participants[index])?.id, holeId: holes.data?.[0]?.id },
        baseRevision: 0, value: { status: 'complete', grossStrokes: 4, notes: null },
        clientRecordedAt: new Date().toISOString(), clientRelease: '0.1.0',
      }, player.accessToken)
      expect(response.status, JSON.stringify(response.body)).toBe(expectedStatus)
    }
  })
})
