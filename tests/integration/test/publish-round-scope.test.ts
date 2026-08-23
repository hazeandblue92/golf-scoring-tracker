import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  buildScoringFixture,
  LEAGUE_ID,
  SEASON_ID,
  TEE_SET_BLUE,
  type ScoringFixture,
} from '../helpers/fixture.ts'
import { callFunction, stackIsUp } from '../helpers/stack.ts'

function strokeRules(metric: 'gross' | 'net') {
  return {
    format: 'individual_stroke',
    schemaVersion: 1,
    metric,
    holeScope: Array.from({ length: 18 }, (_, index) => index + 1),
    handicap: {
      profile: metric === 'net' ? 'usga_whs_2024' : 'none',
      allowance: 1,
      rounding: 'half_up_toward_positive_infinity',
      matchNormalizeFromLowest: false,
      allocation: 'stroke_index',
    },
    ties: { mode: 'tied', sequence: [] },
    incomplete: { live: 'provisional', final: 'no_return' },
    visibility: 'league',
  }
}

describe('competition round scope publish boundary', () => {
  let fx: ScoringFixture

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    fx = await buildScoringFixture({ playerCount: 2, leaveClosed: true })
    const owner = await fx.service.from('role_assignments').insert({
      league_id: LEAGUE_ID,
      profile_id: fx.director.profileId,
      role: 'owner',
    })
    if (owner.error) throw owner.error
  }, 120_000)

  it('rejects every unscoped competition before snapshot or lifecycle changes commit', async () => {
    const eventId = randomUUID()
    const roundId = randomUUID()
    const grossId = randomUUID()
    const unscopedNetId = randomUUID()
    const event = await fx.service.from('events').insert({
      id: eventId,
      league_id: LEAGUE_ID,
      season_id: SEASON_ID,
      name: `Unscoped publish ${eventId.slice(0, 8)}`,
      slug: `unscoped-${eventId.slice(0, 8)}`,
      timezone: 'America/Detroit',
      starts_at: '2026-10-10T13:00:00Z',
      status: 'draft',
    })
    if (event.error) throw event.error
    const round = await fx.service.from('rounds').insert({
      id: roundId,
      event_id: eventId,
      round_number: 1,
      name: 'Round 1',
      hole_count: 18,
      source_tee_set_id: TEE_SET_BLUE,
      status: 'scheduled',
    })
    if (round.error) throw round.error
    const entry = await fx.service.from('event_entries').insert({
      id: randomUUID(),
      event_id: eventId,
      participant_id: fx.entries[0].participantId,
      status: 'active',
      handicap_source: 'manual_verified',
      handicap_value: 4,
      course_handicap_unrounded: 4,
      playing_handicap: 4,
      allowance: 1,
    }).select('id').single()
    if (entry.error) throw entry.error
    const competitions = await fx.service.from('competitions').insert([
      {
        id: grossId,
        event_id: eventId,
        name: 'Scoped gross',
        format: 'individual_stroke',
        metric: 'gross',
        status: 'draft',
        rules_schema_version: 1,
        rules_json: strokeRules('gross'),
        engine_version: 'test',
      },
      {
        id: unscopedNetId,
        event_id: eventId,
        name: 'Unscoped net',
        format: 'individual_stroke',
        metric: 'net',
        status: 'draft',
        rules_schema_version: 1,
        rules_json: strokeRules('net'),
        engine_version: 'test',
      },
    ])
    if (competitions.error) throw competitions.error
    const scope = await fx.service.from('competition_rounds').insert({
      competition_id: grossId,
      round_id: roundId,
      weight: 1,
    })
    if (scope.error) throw scope.error
    const entities = await fx.service.from('competition_entities').insert([
      {
        competition_id: grossId,
        event_entry_id: entry.data.id,
        eligibility_status: 'eligible',
      },
      {
        competition_id: unscopedNetId,
        event_entry_id: entry.data.id,
        eligibility_status: 'eligible',
      },
    ])
    if (entities.error) throw entities.error

    const published = await callFunction<{ errorCode?: string; detail?: string }>(
      'publish-event',
      { eventId, openScoring: true },
      fx.director.accessToken,
    )
    expect(published.status).toBe(409)
    expect(published.body.errorCode).toBe('SNAPSHOT_INVALID')
    expect(published.body.detail).toContain('authoritative event round')

    const [eventAfter, competitionsAfter, snapshots, holes, audits] = await Promise.all([
      fx.service.from('events').select('status,published_snapshot_version').eq('id', eventId).single(),
      fx.service.from('competitions').select('id,status').in('id', [grossId, unscopedNetId]),
      fx.service.from('event_tee_snapshots').select('id').eq('round_id', roundId),
      fx.service.from('event_holes').select('id').eq('round_id', roundId),
      fx.service.from('audit_events')
        .select('id')
        .eq('scope_event_id', eventId)
        .in('action', ['event.published', 'event.published_and_opened']),
    ])
    if (eventAfter.error) throw eventAfter.error
    if (competitionsAfter.error) throw competitionsAfter.error
    if (snapshots.error) throw snapshots.error
    if (holes.error) throw holes.error
    if (audits.error) throw audits.error
    expect(eventAfter.data).toEqual({ status: 'draft', published_snapshot_version: null })
    expect(competitionsAfter.data).toHaveLength(2)
    expect(competitionsAfter.data?.every((row) => row.status === 'draft')).toBe(true)
    expect(snapshots.data).toEqual([])
    expect(holes.data).toEqual([])
    expect(audits.data).toEqual([])
  }, 120_000)

  it('rejects sudden-death skins before freezing a rule with no adjudication fact', async () => {
    const eventId = randomUUID()
    const roundId = randomUUID()
    const competitionId = randomUUID()
    const rules = {
      ...strokeRules('gross'),
      format: 'skins',
      skins: {
        population: 'field',
        carryMode: 'carry_forward',
        unitsPerHole: 1,
        finalCarry: 'sudden_death',
      },
    }
    const event = await fx.service.from('events').insert({
      id: eventId,
      league_id: LEAGUE_ID,
      season_id: SEASON_ID,
      name: `Sudden death publish ${eventId.slice(0, 8)}`,
      slug: `sudden-death-${eventId.slice(0, 8)}`,
      timezone: 'America/Detroit',
      starts_at: '2026-10-11T13:00:00Z',
      status: 'draft',
    })
    if (event.error) throw event.error
    const round = await fx.service.from('rounds').insert({
      id: roundId,
      event_id: eventId,
      round_number: 1,
      name: 'Round 1',
      hole_count: 18,
      source_tee_set_id: TEE_SET_BLUE,
      status: 'scheduled',
    })
    if (round.error) throw round.error
    const competition = await fx.service.from('competitions').insert({
      id: competitionId,
      event_id: eventId,
      name: `Unsupported sudden death ${competitionId.slice(0, 8)}`,
      format: 'individual_stroke',
      metric: 'gross',
      status: 'draft',
      rules_schema_version: 1,
      rules_json: strokeRules('gross'),
      engine_version: 'test',
    })
    if (competition.error) throw competition.error
    const scope = await fx.service.from('competition_rounds').insert({
      competition_id: competitionId,
      round_id: roundId,
      weight: 1,
    })
    if (scope.error) throw scope.error

    const attempted = await fx.service.from('competitions')
      .update({
        format: 'skins',
        rules_json: rules,
        status: 'published',
      })
      .eq('id', competitionId)
    expect(attempted.error?.code).toBe('23514')
    expect(attempted.error?.message).toContain('adjudication fact')
    const after = await fx.service.from('competitions')
      .select('format,status,rules_json')
      .eq('id', competitionId)
      .single()
    if (after.error) throw after.error
    expect(after.data).toMatchObject({
      format: 'individual_stroke',
      status: 'draft',
      rules_json: { format: 'individual_stroke' },
    })
  })

  it('validates the destination event when reparenting and publishing atomically', async () => {
    const oldEventId = randomUUID()
    const oldRoundId = randomUUID()
    const newEventId = randomUUID()
    const competitionId = randomUUID()
    const events = await fx.service.from('events').insert([
      {
        id: oldEventId,
        league_id: LEAGUE_ID,
        season_id: SEASON_ID,
        name: `Reparent source ${oldEventId.slice(0, 8)}`,
        slug: `reparent-source-${oldEventId.slice(0, 8)}`,
        timezone: 'America/Detroit',
        starts_at: '2026-10-12T13:00:00Z',
        status: 'draft',
      },
      {
        id: newEventId,
        league_id: LEAGUE_ID,
        season_id: SEASON_ID,
        name: `Reparent destination ${newEventId.slice(0, 8)}`,
        slug: `reparent-destination-${newEventId.slice(0, 8)}`,
        timezone: 'America/Detroit',
        starts_at: '2026-10-13T13:00:00Z',
        status: 'draft',
      },
    ])
    if (events.error) throw events.error
    const round = await fx.service.from('rounds').insert({
      id: oldRoundId,
      event_id: oldEventId,
      round_number: 1,
      name: 'Round 1',
      hole_count: 18,
      source_tee_set_id: TEE_SET_BLUE,
      status: 'scheduled',
    })
    if (round.error) throw round.error
    const competition = await fx.service.from('competitions').insert({
      id: competitionId,
      event_id: oldEventId,
      name: `Atomic reparent ${competitionId.slice(0, 8)}`,
      format: 'individual_stroke',
      metric: 'gross',
      status: 'draft',
      rules_schema_version: 1,
      rules_json: strokeRules('gross'),
      engine_version: 'test',
    })
    if (competition.error) throw competition.error
    const scope = await fx.service.from('competition_rounds').insert({
      competition_id: competitionId,
      round_id: oldRoundId,
      weight: 1,
    })
    if (scope.error) throw scope.error

    const attempted = await fx.service.from('competitions')
      .update({ event_id: newEventId, status: 'published' })
      .eq('id', competitionId)
    expect(attempted.error?.code).toBe('23514')
    expect(attempted.error?.message).toContain('authoritative event round')

    const after = await fx.service.from('competitions')
      .select('event_id,status')
      .eq('id', competitionId)
      .single()
    if (after.error) throw after.error
    expect(after.data).toEqual({ event_id: oldEventId, status: 'draft' })
  })
})
