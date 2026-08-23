import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { buildScoringFixture, LEAGUE_ID } from '../helpers/fixture.ts'
import { callFunction, stackIsUp, userClient } from '../helpers/stack.ts'

const HTTP_TIMEOUT_MS = 120_000

interface PortableResponse {
  tables: {
    events: Array<Record<string, unknown>>
    participants: Array<Record<string, unknown>>
    teams: Array<Record<string, unknown>>
    team_members: Array<Record<string, unknown>>
    event_teams: Array<Record<string, unknown>>
    individual_hole_scores: Array<Record<string, unknown>>
    team_hole_scores: Array<Record<string, unknown>>
  }
  scoreMutationRecords: Array<Record<string, unknown>>
  auditRecords: Array<Record<string, unknown>>
}

describe('portable export single-snapshot boundary', () => {
  it('is complete, sanitized, service-only, and coherent with concurrent scores', async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    const fx = await buildScoringFixture({ playerCount: 56 })
    const idPrefix = randomUUID().slice(0, 8)
    const scoreRows = fx.entries.flatMap((entry, entryIndex) => fx.holes.map((hole, index) => ({
      id: `${idPrefix}-0000-4000-8000-${(
        entryIndex * fx.holes.length + index + 1
      ).toString(16).padStart(12, '0')}`,
      event_id: fx.eventId,
      round_id: fx.roundId,
      event_entry_id: entry.entryId,
      event_hole_id: hole.id,
      gross_strokes: 4,
      score_status: 'complete',
      revision: 1,
      entered_by: fx.director.profileId,
      device_id_hash: `private-device-${entry.entryId}`,
      source: 'import',
    })))
    expect(scoreRows).toHaveLength(1_008)

    // Keep setup requests comfortably below gateway body limits. The export
    // itself returns one JSON row and must not inherit PostgREST's table cap.
    for (let offset = 0; offset < scoreRows.length; offset += 500) {
      const inserted = await fx.service.from('individual_hole_scores')
        .insert(scoreRows.slice(offset, offset + 500))
      if (inserted.error) throw inserted.error
    }

    const cappedRead = await fx.service.from('individual_hole_scores')
      .select('id')
      .eq('event_id', fx.eventId)
      .order('id')
    if (cappedRead.error) throw cappedRead.error
    expect(cappedRead.data).toHaveLength(1_000)

    const catalogParticipantId = randomUUID()
    const catalogTeamId = randomUUID()
    const catalogMemberId = randomUUID()
    const catalogParticipant = await fx.service.from('participants').insert({
      id: catalogParticipantId,
      league_id: LEAGUE_ID,
      display_name: `Unused export player ${catalogParticipantId.slice(0, 8)}`,
      sort_name: `Unused export player ${catalogParticipantId.slice(0, 8)}`,
      status: 'active',
    })
    if (catalogParticipant.error) throw catalogParticipant.error
    const catalogTeam = await fx.service.from('teams').insert({
      id: catalogTeamId,
      league_id: LEAGUE_ID,
      name: `Unused export team ${catalogTeamId.slice(0, 8)}`,
      status: 'active',
    })
    if (catalogTeam.error) throw catalogTeam.error
    const catalogMember = await fx.service.from('team_members').insert({
      id: catalogMemberId,
      team_id: catalogTeamId,
      participant_id: catalogParticipantId,
      valid_from: '2026-01-01',
    })
    if (catalogMember.error) throw catalogMember.error

    const teamId = randomUUID()
    const teamScoreId = randomUUID()
    const team = await fx.service.from('event_teams').insert({
      id: teamId,
      event_id: fx.eventId,
      source_team_id: catalogTeamId,
      name: `Export privacy team ${teamId.slice(0, 8)}`,
      status: 'active',
    })
    if (team.error) throw team.error
    const teamScore = await fx.service.from('team_hole_scores').insert({
      id: teamScoreId,
      event_id: fx.eventId,
      round_id: fx.roundId,
      event_team_id: teamId,
      event_hole_id: fx.holes[0]!.id,
      gross_strokes: 4,
      score_status: 'complete',
      revision: 1,
      entered_by: fx.director.profileId,
      device_id_hash: 'private-team-device',
      source: 'import',
    })
    if (teamScore.error) throw teamScore.error

    const portable = await callFunction<PortableResponse>(
      'export-league',
      { leagueId: LEAGUE_ID, eventId: fx.eventId },
      fx.director.accessToken,
    )
    expect(portable.status, JSON.stringify(portable.body)).toBe(200)
    expect(portable.body.tables.participants.some((row) =>
      row.id === catalogParticipantId)).toBe(false)
    expect(portable.body.tables.teams).toEqual([])
    expect(portable.body.tables.team_members).toEqual([])
    expect(portable.body.tables.event_teams.find((row) => row.id === teamId))
      .toMatchObject({ source_team_id: null })

    const individualScores = portable.body.tables.individual_hole_scores
    expect(individualScores).toHaveLength(scoreRows.length)
    expect(new Set(individualScores.map((row) => row.id))).toEqual(
      new Set(scoreRows.map((row) => row.id)),
    )
    expect(individualScores.every((row) =>
      row.entered_by === null && row.device_id_hash === null)).toBe(true)

    expect(portable.body.tables.team_hole_scores).toEqual([
      expect.objectContaining({
        id: teamScoreId,
        entered_by: null,
        device_id_hash: null,
      }),
    ])

    const caller = userClient(fx.director.accessToken)
    const directSnapshot = await caller.rpc('export_portable_snapshot', {
      p_actor: fx.director.profileId,
      p_league_id: LEAGUE_ID,
      p_event_id: fx.eventId,
    })
    expect(directSnapshot.error?.code).toBe('42501')

    const unauthorizedSnapshot = await fx.service.rpc('export_portable_snapshot', {
      p_actor: fx.outsider.profileId,
      p_league_id: LEAGUE_ID,
      p_event_id: fx.eventId,
    })
    if (unauthorizedSnapshot.error) throw unauthorizedSnapshot.error
    expect(unauthorizedSnapshot.data).toMatchObject({
      authorized: false,
      tables: { events: [], individual_hole_scores: [] },
    })

    // League-wide organizers remain authorized even when the requested event
    // does not exist, so the Edge boundary must preserve its explicit 404.
    const leagueGrant = await fx.service.from('role_assignments').insert({
      league_id: LEAGUE_ID,
      profile_id: fx.director.profileId,
      role: 'league_admin',
    })
    if (leagueGrant.error) throw leagueGrant.error
    const missingEvent = await callFunction(
      'export-league',
      { leagueId: LEAGUE_ID, eventId: randomUUID() },
      fx.director.accessToken,
    )
    expect(missingEvent.status).toBe(404)

    // apply_score_mutation changes one raw fact and scoring_revision in the
    // same commit. Every export taken while these commits race must therefore
    // observe exactly as many revision increments as updated score rows.
    const mutationRows = scoreRows.slice(0, 24)
    const exportPromises = Array.from({ length: 6 }, () =>
      callFunction<PortableResponse>(
        'export-league',
        { leagueId: LEAGUE_ID, eventId: fx.eventId },
        fx.director.accessToken,
      ))
    const mutationPromises = mutationRows.map((row, index) => caller.rpc(
      'apply_score_mutation',
      {
        p_idempotency_key: randomUUID(),
        p_event_id: fx.eventId,
        p_round_id: fx.roundId,
        p_target_kind: 'individual',
        p_entry_id: row.event_entry_id,
        p_team_id: null,
        p_hole_id: row.event_hole_id,
        p_base_revision: 1,
        p_status: 'complete',
        p_gross_strokes: 5,
        p_notes: null,
        p_client_recorded_at: new Date(Date.now() + index).toISOString(),
        p_device_id_hash: `concurrent-private-device-${index}`,
      },
    ))

    const [concurrentExports, mutations] = await Promise.all([
      Promise.all(exportPromises),
      Promise.all(mutationPromises),
    ])
    for (const mutation of mutations) {
      if (mutation.error) throw mutation.error
      expect(mutation.data).toMatchObject({ status: 'committed' })
    }

    const auditId = randomUUID()
    const audit = await fx.service.from('audit_events').insert({
      id: auditId,
      actor_profile_id: fx.director.profileId,
      action: 'portable_export.regression_evidence',
      scope_league_id: LEAGUE_ID,
      scope_event_id: fx.eventId,
      target_type: 'event',
      target_id: fx.eventId,
      correlation_id: randomUUID(),
    })
    if (audit.error) throw audit.error

    const leaguePortable = await callFunction<PortableResponse>(
      'export-league',
      { leagueId: LEAGUE_ID },
      fx.director.accessToken,
    )
    expect(leaguePortable.status, JSON.stringify(leaguePortable.body)).toBe(200)
    expect(leaguePortable.body.tables.participants.find((row) =>
      row.id === catalogParticipantId)).toMatchObject({
      id: catalogParticipantId,
      profile_id: null,
      organizer_notes: null,
    })
    expect(leaguePortable.body.tables.teams.find((row) => row.id === catalogTeamId))
      .toMatchObject({ id: catalogTeamId, league_id: LEAGUE_ID })
    expect(leaguePortable.body.tables.team_members.find((row) =>
      row.id === catalogMemberId)).toMatchObject({
      team_id: catalogTeamId,
      participant_id: catalogParticipantId,
    })
    expect(leaguePortable.body.tables.event_teams.find((row) => row.id === teamId))
      .toMatchObject({ source_team_id: catalogTeamId })

    const mutationEvidence = leaguePortable.body.scoreMutationRecords.filter((row) =>
      row.event_id === fx.eventId)
    expect(mutationEvidence.length).toBeGreaterThanOrEqual(mutationRows.length)
    expect(mutationEvidence.every((row) =>
      row.actor_profile_id === null && row.device_id_hash === null)).toBe(true)
    expect(leaguePortable.body.auditRecords.find((row) => row.id === auditId))
      .toMatchObject({ id: auditId, actor_profile_id: null })

    for (const snapshot of concurrentExports) {
      expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200)
      const event = snapshot.body.tables.events.find((row) => row.id === fx.eventId)
      const committedScoreUpdates = snapshot.body.tables.individual_hole_scores
        .reduce((total, row) => total + Number(row.revision) - 1, 0)
      expect(Number(event?.scoring_revision)).toBe(committedScoreUpdates)
    }
  }, HTTP_TIMEOUT_MS)
})
