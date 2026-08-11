import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  buildScoringFixture,
  LEAGUE_ID,
  SEASON_ID,
  type ScoringFixture,
} from '../helpers/fixture.ts'
import { stackIsUp, userClient } from '../helpers/stack.ts'

function matchRules() {
  return {
    format: 'match',
    schemaVersion: 1,
    metric: 'gross',
    holeScope: Array.from({ length: 18 }, (_, index) => index + 1),
    handicap: {
      profile: 'none', allowance: 1,
      rounding: 'half_up_toward_positive_infinity',
      matchNormalizeFromLowest: false, allocation: 'stroke_index',
    },
    ties: { mode: 'tied', sequence: [] },
    incomplete: { live: 'provisional', final: 'no_return' },
    visibility: 'league',
    multiRound: { aggregation: 'match_points' },
  }
}

describe('organizer substitution workflow (§8.14)', () => {
  let fx: ScoringFixture
  let incomingParticipantId: string

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    fx = await buildScoringFixture({ playerCount: 2, leaveClosed: true })
    incomingParticipantId = randomUUID()
    const participant = await fx.service.from('participants').insert({
      id: incomingParticipantId,
      league_id: LEAGUE_ID,
      profile_id: null,
      display_name: 'Late Replacement',
      sort_name: 'replacement, late',
      status: 'active',
    })
    if (participant.error) throw participant.error
    const handicap = await fx.service.from('participant_handicaps').insert({
      participant_id: incomingParticipantId,
      value: 9.2,
      source: 'manual_verified',
      effective_from: '2020-01-01',
    })
    if (handicap.error) throw handicap.error
  }, 120_000)

  it('creates a frozen replacement without rewriting the outgoing entry', async () => {
    const outgoing = fx.entries[0]
    const reason = 'Original player withdrew before the opening round'
    const { data, error } = await userClient(fx.director.accessToken).rpc(
      'substitute_event_entry',
      {
        p_event_id: fx.eventId,
        p_outgoing_entry_id: outgoing.entryId,
        p_incoming_participant_id: incomingParticipantId,
        p_effective_round_id: fx.roundId,
        p_reason: reason,
      },
    )
    expect(error).toBeNull()
    const result = data as {
      status: string
      eventEntryId: string
      effectiveRoundId: string
    }
    expect(result.status).toBe('saved')
    expect(result.effectiveRoundId).toBe(fx.roundId)

    const [
      { data: replacement },
      { data: original },
      { data: entities },
      { data: audit },
      { data: outgoingPermissions },
      { data: incomingPermissions },
    ] =
      await Promise.all([
        fx.service.from('event_entries')
          .select('participant_id,replaces_entry_id,effective_from_round_id,substitution_reason,tee_snapshot_id,snapshot_hash,handicap_source,handicap_value,course_handicap_unrounded,playing_handicap')
          .eq('id', result.eventEntryId).single(),
        fx.service.from('event_entries')
          .select('participant_id,status')
          .eq('id', outgoing.entryId).single(),
        fx.service.from('competition_entities')
          .select('competition_id,event_entry_id')
          .eq('event_entry_id', result.eventEntryId),
        fx.service.from('audit_events')
          .select('scope_league_id,scope_event_id,reason,before_json,after_json')
          .eq('action', 'event.entry_substituted')
          .eq('target_id', result.eventEntryId).single(),
        fx.service.from('scoring_permissions')
          .select('id')
          .eq('event_id', fx.eventId)
          .eq('participant_id', outgoing.participantId)
          .is('valid_to', null),
        fx.service.from('scoring_permissions')
          .select('id')
          .eq('event_id', fx.eventId)
          .eq('participant_id', incomingParticipantId)
          .is('valid_to', null),
      ])

    expect(replacement).toMatchObject({
      participant_id: incomingParticipantId,
      replaces_entry_id: outgoing.entryId,
      effective_from_round_id: fx.roundId,
      substitution_reason: reason,
      handicap_source: 'manual_verified',
      handicap_value: 9.2,
    })
    expect(replacement?.tee_snapshot_id).not.toBeNull()
    expect(replacement?.snapshot_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(Number(replacement?.course_handicap_unrounded)).toBeCloseTo(9.821239, 6)
    expect(replacement?.playing_handicap).toBe(10)
    expect(original).toEqual({ participant_id: outgoing.participantId, status: 'active' })
    expect(outgoingPermissions).toHaveLength(0)
    expect(incomingPermissions).toHaveLength(1)
    expect(entities).toHaveLength(3)
    expect(new Set(entities?.map((entity) => entity.competition_id))).toEqual(
      new Set(Object.values(fx.competitions)),
    )
    expect(audit).toMatchObject({
      scope_league_id: LEAGUE_ID,
      scope_event_id: fx.eventId,
      reason,
      before_json: {
        outgoingEntryId: outgoing.entryId,
        outgoingParticipantId: outgoing.participantId,
      },
      after_json: {
        incomingEntryId: result.eventEntryId,
        incomingParticipantId,
        effectiveRoundId: fx.roundId,
      },
    })
  })

  it('rejects an unauthorized organizer without creating another entry', async () => {
    const secondIncoming = randomUUID()
    const inserted = await fx.service.from('participants').insert({
      id: secondIncoming,
      league_id: LEAGUE_ID,
      profile_id: null,
      display_name: 'Unauthorized Replacement',
      sort_name: 'replacement, unauthorized',
      status: 'active',
    })
    if (inserted.error) throw inserted.error

    const { data } = await userClient(fx.outsider.accessToken).rpc(
      'substitute_event_entry',
      {
        p_event_id: fx.eventId,
        p_outgoing_entry_id: fx.entries[1].entryId,
        p_incoming_participant_id: secondIncoming,
        p_effective_round_id: fx.roundId,
        p_reason: 'Should not be authorized',
      },
    )
    expect(data).toMatchObject({ status: 'rejected', error_code: 'NOT_ASSIGNED' })
    const { count } = await fx.service.from('event_entries')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', fx.eventId)
      .eq('participant_id', secondIncoming)
    expect(count).toBe(0)
  })

  it('rejects a still-valid JWT as soon as the director account is disabled', async () => {
    const disabled = await fx.service.from('profiles')
      .update({ status: 'disabled' })
      .eq('id', fx.director.profileId)
    if (disabled.error) throw disabled.error
    const { data } = await userClient(fx.director.accessToken).rpc(
      'substitute_event_entry',
      {
        p_event_id: fx.eventId,
        p_outgoing_entry_id: fx.entries[1].entryId,
        p_incoming_participant_id: randomUUID(),
        p_effective_round_id: fx.roundId,
        p_reason: 'Disabled account attempt',
      },
    )
    const restored = await fx.service.from('profiles')
      .update({ status: 'active' })
      .eq('id', fx.director.profileId)
    if (restored.error) throw restored.error
    expect(data).toMatchObject({ status: 'rejected', error_code: 'ACCOUNT_DISABLED' })
  })

  it('moves effective-round match pairings to the replacement entity', async () => {
    const outgoing = fx.entries[1]
    const replacementParticipantId = randomUUID()
    const participant = await fx.service.from('participants').insert({
      id: replacementParticipantId,
      league_id: LEAGUE_ID,
      profile_id: null,
      display_name: 'Match Replacement',
      sort_name: 'replacement, match',
      status: 'active',
    })
    if (participant.error) throw participant.error

    const competitionId = randomUUID()
    const competition = await fx.service.from('competitions').insert({
      id: competitionId,
      event_id: fx.eventId,
      name: 'Substitution match',
      format: 'match',
      metric: 'gross',
      status: 'scoring_open',
      rules_schema_version: 1,
      rules_json: matchRules(),
      engine_version: 'test',
      sort_order: 50,
    })
    if (competition.error) throw competition.error
    const link = await fx.service.from('competition_rounds').insert({
      competition_id: competitionId,
      round_id: fx.roundId,
      hole_scope: null,
      weight: 1,
    })
    if (link.error) throw link.error

    const outgoingEntityId = randomUUID()
    const opponentEntityId = randomUUID()
    const entities = await fx.service.from('competition_entities').insert([
      {
        id: outgoingEntityId,
        competition_id: competitionId,
        event_entry_id: outgoing.entryId,
        eligibility_status: 'eligible',
      },
      {
        id: opponentEntityId,
        competition_id: competitionId,
        event_entry_id: fx.entries[0].entryId,
        eligibility_status: 'eligible',
      },
    ])
    if (entities.error) throw entities.error
    const matchId = randomUUID()
    const match = await fx.service.from('matches').insert({
      id: matchId,
      competition_id: competitionId,
      round_id: fx.roundId,
      side_a_entity_id: outgoingEntityId,
      side_b_entity_id: opponentEntityId,
      status: 'scheduled',
    })
    if (match.error) throw match.error

    const started = await fx.service.from('matches').update({
      status: 'conceded',
      winner_entity_id: outgoingEntityId,
    }).eq('id', matchId)
    if (started.error) throw started.error
    const { data: rejected } = await userClient(fx.director.accessToken).rpc(
      'substitute_event_entry',
      {
        p_event_id: fx.eventId,
        p_outgoing_entry_id: outgoing.entryId,
        p_incoming_participant_id: replacementParticipantId,
        p_effective_round_id: fx.roundId,
        p_reason: 'A completed match must keep its contestant',
      },
    )
    expect(rejected).toMatchObject({ status: 'rejected', error_code: 'CONFLICT' })
    const resetMatch = await fx.service.from('matches').update({
      status: 'scheduled',
      winner_entity_id: null,
    }).eq('id', matchId)
    if (resetMatch.error) throw resetMatch.error

    const { data, error } = await userClient(fx.director.accessToken).rpc(
      'substitute_event_entry',
      {
        p_event_id: fx.eventId,
        p_outgoing_entry_id: outgoing.entryId,
        p_incoming_participant_id: replacementParticipantId,
        p_effective_round_id: fx.roundId,
        p_reason: 'Replacement owns the scheduled match',
      },
    )
    expect(error).toBeNull()
    const result = data as { status: string; eventEntryId: string }
    expect(result.status).toBe('saved')

    const [{ data: replacementEntity }, { data: updatedMatch }] = await Promise.all([
      fx.service.from('competition_entities')
        .select('id')
        .eq('competition_id', competitionId)
        .eq('event_entry_id', result.eventEntryId)
        .single(),
      fx.service.from('matches')
        .select('side_a_entity_id,side_b_entity_id')
        .eq('id', matchId)
        .single(),
    ])
    expect(updatedMatch).toEqual({
      side_a_entity_id: replacementEntity?.id,
      side_b_entity_id: opponentEntityId,
    })
  })

  it('enforces same-event replacement references at the database boundary', async () => {
    const sourceParticipantId = randomUUID()
    const sourceEntryId = randomUUID()
    const sourceParticipant = await fx.service.from('participants').insert({
      id: sourceParticipantId,
      league_id: LEAGUE_ID,
      profile_id: null,
      display_name: 'Cross-event source',
      sort_name: 'source, cross-event',
      status: 'active',
    })
    if (sourceParticipant.error) throw sourceParticipant.error
    const sourceEntry = await fx.service.from('event_entries').insert({
      id: sourceEntryId,
      event_id: fx.eventId,
      participant_id: sourceParticipantId,
      status: 'active',
    })
    if (sourceEntry.error) throw sourceEntry.error

    const otherEventId = randomUUID()
    const event = await fx.service.from('events').insert({
      id: otherEventId,
      league_id: LEAGUE_ID,
      season_id: SEASON_ID,
      name: `Foreign substitution ${otherEventId.slice(0, 8)}`,
      slug: `foreign-sub-${otherEventId.slice(0, 8)}`,
      timezone: 'America/Detroit',
      starts_at: new Date().toISOString(),
      status: 'draft',
    })
    if (event.error) throw event.error

    const invalid = await fx.service.from('event_entries').insert({
      event_id: otherEventId,
      participant_id: fx.entries[1].participantId,
      effective_from_round_id: fx.roundId,
      replaces_entry_id: sourceEntryId,
      substitution_reason: 'Cross-event references must fail',
    })
    expect(invalid.error).not.toBeNull()
    expect(invalid.error?.code).toBe('23503')
  })
})
