/**
 * Production match-result workflow: auth + MFA, atomic revision/audit, strict
 * terminal winner semantics, projection repair, portable export, and sealed
 * immutability. The sequence is intentional: it drives one competition from
 * unfinished to final and proves an override can never skip that lifecycle.
 */

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  buildScoringFixture,
  createAccount,
  LEAGUE_ID,
  type ScoringFixture,
  type TestAccount,
} from '../helpers/fixture.ts'
import {
  callFunction,
  stackIsUp,
  userClient,
} from '../helpers/stack.ts'

const HTTP_TIMEOUT_MS = 120_000

const matchRules = {
  format: 'match',
  schemaVersion: 1,
  metric: 'gross',
  holeScope: Array.from({ length: 18 }, (_, index) => index + 1),
  handicap: {
    profile: 'none',
    allowance: 1,
    rounding: 'half_up_toward_positive_infinity',
    matchNormalizeFromLowest: false,
    allocation: 'stroke_index',
  },
  ties: { mode: 'tied', sequence: [] },
  incomplete: { live: 'provisional', final: 'no_return' },
  visibility: 'league',
} as const

interface MatchReceipt {
  status?: string
  changed?: boolean
  eventRevision?: number
  projectionRevision?: number | null
  correlationId?: string
  errorCode?: string
  detail?: string
}

describe('authoritative match lifecycle (§8.6)', () => {
  let fx: ScoringFixture
  let noRole: TestAccount
  let competitionId: string
  let pairedMatchId: string
  let byeMatchId: string
  let sideAId: string
  let sideBId: string
  let byeSideId: string

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    fx = await buildScoringFixture({ playerCount: 3 })
    noRole = await createAccount(fx.service, {
      displayName: 'No-role MFA user',
      withMfa: true,
    })

    competitionId = randomUUID()
    const competition = await fx.service.from('competitions').insert({
      id: competitionId,
      event_id: fx.eventId,
      name: 'Integration Match Play',
      format: 'match',
      metric: 'gross',
      status: 'scoring_open',
      rules_schema_version: 1,
      rules_json: matchRules,
      rules_text: 'Individual gross match play; ties stand.',
      engine_version: 'test',
      sort_order: 40,
    })
    if (competition.error) throw competition.error

    const link = await fx.service.from('competition_rounds').insert({
      competition_id: competitionId,
      round_id: fx.roundId,
      hole_scope: null,
      weight: 1,
    })
    if (link.error) throw link.error

    const entities = await fx.service.from('competition_entities').insert(
      fx.entries.map((entry) => ({
        id: randomUUID(),
        competition_id: competitionId,
        event_entry_id: entry.entryId,
        eligibility_status: 'eligible',
      })),
    ).select('id,event_entry_id')
    if (entities.error || !entities.data) throw entities.error
    const entityByEntry = new Map(entities.data.map((entity) => [
      entity.event_entry_id as string,
      entity.id as string,
    ]))
    sideAId = entityByEntry.get(fx.entries[0]!.entryId)!
    sideBId = entityByEntry.get(fx.entries[1]!.entryId)!
    byeSideId = entityByEntry.get(fx.entries[2]!.entryId)!

    const groupId = randomUUID()
    const group = await fx.service.from('groups').insert({
      id: groupId,
      round_id: fx.roundId,
      label: 'Match group',
      start_hole_ordinal: 1,
      sort_order: 1,
    })
    if (group.error) throw group.error
    const groupMembers = await fx.service.from('group_members').insert(
      fx.entries.map((entry, index) => ({
        group_id: groupId,
        event_entry_id: entry.entryId,
        sort_order: index + 1,
      })),
    )
    if (groupMembers.error) throw groupMembers.error

    pairedMatchId = randomUUID()
    byeMatchId = randomUUID()
    const matches = await fx.service.from('matches').insert([
      {
        id: pairedMatchId,
        competition_id: competitionId,
        round_id: fx.roundId,
        side_a_entity_id: sideAId,
        side_b_entity_id: sideBId,
        bracket_position: 1,
        status: 'scheduled',
      },
      {
        id: byeMatchId,
        competition_id: competitionId,
        round_id: fx.roundId,
        side_a_entity_id: byeSideId,
        side_b_entity_id: null,
        bracket_position: 2,
        status: 'scheduled',
      },
    ])
    if (matches.error) throw matches.error

    const projected = await callFunction<MatchReceipt>(
      'rebuild-projections',
      { eventId: fx.eventId },
      fx.director.accessToken,
    )
    expect(projected.status, JSON.stringify(projected.body)).toBe(200)
  }, HTTP_TIMEOUT_MS)

  it('keeps browser tables read-only and rejects missing auth, MFA, and role', async () => {
    const direct = await userClient(fx.director.accessToken)
      .from('matches')
      .update({ result_summary: 'Bypassed' })
      .eq('id', pairedMatchId)
    expect(direct.error).not.toBeNull()
    expect(direct.error?.code).toBe('42501')

    const body = {
      matchId: pairedMatchId,
      status: 'conceded',
      winnerEntityId: sideBId,
      resultSummary: 'Conceded',
      reason: 'Committee confirmed the concession',
    }
    const anonymous = await callFunction<MatchReceipt>('set-match-result', body)
    expect(anonymous.status).toBe(401)
    expect(anonymous.body.errorCode).toBe('AUTH_REQUIRED')

    const aal1 = await callFunction<MatchReceipt>(
      'set-match-result',
      body,
      fx.director.aal1AccessToken,
    )
    expect(aal1.status).toBe(403)
    expect(aal1.body.errorCode).toBe('MFA_REQUIRED')

    const unauthorized = await callFunction<MatchReceipt>(
      'set-match-result',
      body,
      noRole.accessToken,
    )
    expect(unauthorized.status).toBe(403)
    expect(unauthorized.body.errorCode).toBe('NOT_ASSIGNED')
  })

  it('does not let a free-text finalization override finish a scheduled match', async () => {
    const blocked = await callFunction<{ status?: string; matchBlockers?: number }>(
      'finalize-competition',
      {
        competitionId,
        overrideReason: 'Attempted override must not manufacture winners',
      },
      fx.director.accessToken,
    )
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409)
    expect(blocked.body.status).toBe('blocked')
    expect(blocked.body.matchBlockers).toBe(2)
  })

  it('rejects a winner outside the pairing without revision or audit drift', async () => {
    const invalid = await callFunction<MatchReceipt>(
      'set-match-result',
      {
        matchId: pairedMatchId,
        status: 'complete',
        winnerEntityId: byeSideId,
        resultSummary: 'Invalid winner',
        reason: 'Negative integration assertion',
      },
      fx.director.accessToken,
    )
    expect(invalid.status).toBe(409)
    expect(invalid.body.errorCode).toBe('SCORE_INVALID')

    const [{ data: event }, { count: auditCount }] = await Promise.all([
      fx.service.from('events').select('scoring_revision').eq('id', fx.eventId).single(),
      fx.service.from('audit_events').select('*', { count: 'exact', head: true })
        .eq('target_type', 'match')
        .eq('target_id', pairedMatchId),
    ])
    expect(event?.scoring_revision).toBe(0)
    expect(auditCount).toBe(0)
  })

  it('atomically records a concession, advances exactly one revision, and audits scope', async () => {
    const request = {
      matchId: pairedMatchId,
      status: 'conceded',
      winnerEntityId: sideBId,
      resultSummary: 'Conceded after 12',
      reason: 'Both sides confirmed the concession to the Committee',
    }
    const saved = await callFunction<MatchReceipt>(
      'set-match-result',
      request,
      fx.director.accessToken,
    )
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body.status).toBe('committed')
    expect(saved.body.changed).toBe(true)
    expect(saved.body.eventRevision).toBe(1)
    expect(saved.body.projectionRevision).toBe(1)
    expect(saved.body.correlationId).toMatch(/^[0-9a-f-]{36}$/)

    const [{ data: event }, { data: match }, { data: audit }] = await Promise.all([
      fx.service.from('events').select('scoring_revision').eq('id', fx.eventId).single(),
      fx.service.from('matches')
        .select('status,winner_entity_id,result_summary,concession_by,concession_reason')
        .eq('id', pairedMatchId)
        .single(),
      fx.service.from('audit_events')
        .select('actor_profile_id,action,scope_league_id,scope_event_id,target_type,target_id,reason,before_json,after_json,correlation_id')
        .eq('target_type', 'match')
        .eq('target_id', pairedMatchId)
        .single(),
    ])
    expect(event?.scoring_revision).toBe(1)
    expect(match).toMatchObject({
      status: 'conceded',
      winner_entity_id: sideBId,
      result_summary: 'Conceded after 12',
      concession_by: fx.director.profileId,
      concession_reason: request.reason,
    })
    expect(audit).toMatchObject({
      actor_profile_id: fx.director.profileId,
      action: 'match.result_set',
      scope_league_id: LEAGUE_ID,
      scope_event_id: fx.eventId,
      target_type: 'match',
      target_id: pairedMatchId,
      reason: request.reason,
      correlation_id: saved.body.correlationId,
      before_json: expect.objectContaining({ status: 'scheduled' }),
      after_json: expect.objectContaining({
        status: 'conceded',
        winnerEntityId: sideBId,
        eventRevision: 1,
      }),
    })

    const retry = await callFunction<MatchReceipt>(
      'set-match-result',
      request,
      fx.director.accessToken,
    )
    expect(retry.status).toBe(200)
    expect(retry.body.changed).toBe(false)
    expect(retry.body.eventRevision).toBe(1)
    const { count } = await fx.service.from('audit_events')
      .select('*', { count: 'exact', head: true })
      .eq('target_type', 'match')
      .eq('target_id', pairedMatchId)
    expect(count).toBe(1)
  }, HTTP_TIMEOUT_MS)

  it('publishes a one-sided walkover without inventing a missing opponent', async () => {
    const saved = await callFunction<MatchReceipt>(
      'set-match-result',
      {
        matchId: byeMatchId,
        status: 'walkover',
        winnerEntityId: byeSideId,
        resultSummary: 'Walkover',
        reason: 'Opponent slot was not filled by the published start',
      },
      fx.director.accessToken,
    )
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body.changed).toBe(true)
    expect(saved.body.eventRevision).toBe(2)
    expect(saved.body.projectionRevision).toBe(2)

    const { data: row, error } = await fx.service.from('leaderboard_rows')
      .select('entity_id,status,display_primary,detail_json')
      .eq('competition_id', competitionId)
      .eq('event_revision', 2)
      .eq('entity_id', byeSideId)
      .single()
    if (error) throw error
    expect(row).toMatchObject({
      entity_id: byeSideId,
      status: 'complete',
      display_primary: 'Walkover',
      detail_json: expect.objectContaining({
        matchId: byeMatchId,
        opponentEntityId: null,
        outcome: 'won',
        lifecycleStatus: 'walkover',
      }),
    })
  }, HTTP_TIMEOUT_MS)

  it('exports the API-updated match facts without auth-linked concession identity', async () => {
    const exported = await callFunction<{
      tables?: { matches?: Array<Record<string, unknown>> }
    }>(
      'export-league',
      { leagueId: LEAGUE_ID, eventId: fx.eventId },
      fx.director.accessToken,
    )
    expect(exported.status, JSON.stringify(exported.body)).toBe(200)
    const matches = exported.body.tables?.matches ?? []
    expect(matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: pairedMatchId,
        status: 'conceded',
        winner_entity_id: sideBId,
        result_summary: 'Conceded after 12',
        concession_by: null,
      }),
      expect.objectContaining({
        id: byeMatchId,
        status: 'walkover',
        winner_entity_id: byeSideId,
        concession_by: null,
      }),
    ]))
  }, HTTP_TIMEOUT_MS)

  it('seals terminal facts and rejects later correction without revision drift', async () => {
    const finalized = await callFunction<{ status?: string; finalResultHash?: string }>(
      'finalize-competition',
      { competitionId, overrideReason: null },
      fx.director.accessToken,
    )
    expect(finalized.status, JSON.stringify(finalized.body)).toBe(200)
    expect(finalized.body.status).toBe('finalized')
    expect(finalized.body.finalResultHash).toMatch(/^[0-9a-f]{64}$/)

    const locked = await callFunction<MatchReceipt>(
      'set-match-result',
      {
        matchId: pairedMatchId,
        status: 'complete',
        winnerEntityId: null,
        resultSummary: 'Halved',
        reason: 'This correction must be rejected after finalization',
      },
      fx.director.accessToken,
    )
    expect(locked.status).toBe(409)
    expect(locked.body.errorCode).toBe('EVENT_LOCKED')

    const [{ data: event }, { count: auditCount }] = await Promise.all([
      fx.service.from('events').select('scoring_revision').eq('id', fx.eventId).single(),
      fx.service.from('audit_events').select('*', { count: 'exact', head: true })
        .eq('action', 'match.result_set')
        .eq('scope_event_id', fx.eventId),
    ])
    expect(event?.scoring_revision).toBe(2)
    expect(auditCount).toBe(2)
  }, HTTP_TIMEOUT_MS)
})
