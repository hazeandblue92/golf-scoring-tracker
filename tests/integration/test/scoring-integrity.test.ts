import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  buildScoringFixture,
  LEAGUE_ID,
  SEASON_ID,
  type ScoringFixture,
} from '../helpers/fixture.ts'
import { callFunction, stackIsUp } from '../helpers/stack.ts'

function suddenDeathSkinsRules() {
  return {
    format: 'skins',
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
    skins: {
      population: 'field',
      carryMode: 'carry_forward',
      unitsPerHole: 1,
      finalCarry: 'sudden_death',
    },
  }
}

describe('cross-event scoring relationships', () => {
  let fx: ScoringFixture
  let foreignRoundId: string
  let foreignEntryId: string

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    fx = await buildScoringFixture({ playerCount: 2, leaveClosed: true })

    const foreignEventId = randomUUID()
    const event = await fx.service.from('events').insert({
      id: foreignEventId,
      league_id: LEAGUE_ID,
      season_id: SEASON_ID,
      name: `Foreign integrity event ${foreignEventId.slice(0, 8)}`,
      slug: `foreign-integrity-${foreignEventId.slice(0, 8)}`,
      timezone: 'America/Detroit',
      starts_at: new Date().toISOString(),
      status: 'draft',
    })
    if (event.error) throw event.error

    foreignRoundId = randomUUID()
    const round = await fx.service.from('rounds').insert({
      id: foreignRoundId,
      event_id: foreignEventId,
      round_number: 1,
      name: 'Foreign round',
      hole_count: 18,
      status: 'scheduled',
    })
    if (round.error) throw round.error

    foreignEntryId = randomUUID()
    const entry = await fx.service.from('event_entries').insert({
      id: foreignEntryId,
      event_id: foreignEventId,
      participant_id: fx.entries[0].participantId,
      status: 'active',
    })
    if (entry.error) throw entry.error
  }, 120_000)

  it('rejects foreign rounds, entries, and team members at the database boundary', async () => {
    const teamId = randomUUID()
    const team = await fx.service.from('event_teams').insert({
      id: teamId,
      event_id: fx.eventId,
      name: 'Integrity team',
      status: 'active',
    })
    if (team.error) throw team.error

    const groupId = randomUUID()
    const group = await fx.service.from('groups').insert({
      id: groupId,
      round_id: fx.roundId,
      label: `Integrity group ${groupId.slice(0, 8)}`,
    })
    if (group.error) throw group.error

    const [roundLink, entity, teamMember, groupMember, permission] = await Promise.all([
      fx.service.from('competition_rounds').insert({
        competition_id: fx.competitions.grossId,
        round_id: foreignRoundId,
        weight: 1,
      }),
      fx.service.from('competition_entities').insert({
        competition_id: fx.competitions.grossId,
        event_entry_id: foreignEntryId,
        eligibility_status: 'eligible',
      }),
      fx.service.from('event_team_members').insert({
        event_team_id: teamId,
        event_entry_id: foreignEntryId,
        position: 1,
      }),
      fx.service.from('group_members').insert({
        group_id: groupId,
        event_entry_id: foreignEntryId,
      }),
      fx.service.from('scoring_permissions').insert({
        event_id: fx.eventId,
        round_id: foreignRoundId,
        scorer_profile_id: fx.director.profileId,
        participant_id: fx.entries[0].participantId,
        permission_type: 'marker',
      }),
    ])

    for (const result of [roundLink, entity, teamMember, groupMember]) {
      expect(result.error?.code).toBe('23514')
    }
    expect(permission.error?.code).toBe('23503')
  })

  it('rejects routing columns that disagree with authoritative rules', async () => {
    const mismatch = await fx.service.from('competitions').insert({
      id: randomUUID(),
      event_id: fx.eventId,
      name: `Rules mismatch ${randomUUID().slice(0, 8)}`,
      format: 'individual_stroke',
      metric: 'gross',
      status: 'scoring_closed',
      rules_schema_version: 1,
      rules_json: suddenDeathSkinsRules(),
      engine_version: 'test',
      sort_order: 91,
    })

    expect(mismatch.error?.code).toBe('23514')
  })

  it('blocks finalization while a sudden-death skins carry is unresolved', async () => {
    const opened = await fx.service.from('events')
      .update({ status: 'scoring_open' })
      .eq('id', fx.eventId)
    if (opened.error) throw opened.error
    const round = await fx.service.from('rounds')
      .update({ status: 'in_progress' })
      .eq('id', fx.roundId)
    if (round.error) throw round.error

    const competitionId = randomUUID()
    const competition = await fx.service.from('competitions').insert({
      id: competitionId,
      event_id: fx.eventId,
      name: 'Sudden-death carry proof',
      format: 'skins',
      metric: 'gross',
      status: 'scoring_open',
      rules_schema_version: 1,
      rules_json: suddenDeathSkinsRules(),
      engine_version: 'test',
      sort_order: 90,
    })
    if (competition.error) throw competition.error
    const link = await fx.service.from('competition_rounds').insert({
      competition_id: competitionId,
      round_id: fx.roundId,
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

    const scores = await fx.service.from('individual_hole_scores').insert(
      fx.entries.flatMap((entry) => fx.holes.map((hole) => ({
        event_id: fx.eventId,
        round_id: fx.roundId,
        event_entry_id: entry.entryId,
        event_hole_id: hole.id,
        gross_strokes: 4,
        score_status: 'complete',
        revision: 1,
      }))),
    )
    if (scores.error) throw scores.error
    const attestations = await fx.service.from('scorecard_attestations').insert(
      fx.entries.map((entry) => ({
        round_id: fx.roundId,
        event_entry_id: entry.entryId,
        profile_id: fx.director.profileId,
        attestation_type: 'director_override',
        score_revision: 18,
        reason: 'Integration carry proof',
      })),
    )
    if (attestations.error) throw attestations.error

    const rebuilt = await callFunction<{ status: string }>(
      'rebuild-projections',
      { eventId: fx.eventId },
      fx.director.accessToken,
    )
    expect(rebuilt.status, JSON.stringify(rebuilt.body)).toBe(200)
    const { data: projection } = await fx.service.from('competition_projections')
      .select('warnings')
      .eq('competition_id', competitionId)
      .single()
    expect(projection?.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SKINS_SUDDEN_DEATH_PENDING' }),
    ]))

    const finalized = await callFunction<{ status: string; carryBlockers?: number }>(
      'finalize-competition',
      { competitionId, overrideReason: null },
      fx.director.accessToken,
    )
    expect(finalized.status).toBe(409)
    expect(finalized.body).toMatchObject({ status: 'blocked', carryBlockers: 1 })

    const overridden = await callFunction<{ status: string; carryBlockers?: number }>(
      'finalize-competition',
      { competitionId, overrideReason: 'Committee accepts unresolved carry' },
      fx.director.accessToken,
    )
    expect(overridden.status).toBe(409)
    expect(overridden.body).toMatchObject({ status: 'blocked', carryBlockers: 1 })

    const { data: eventAfterBlock } = await fx.service.from('events')
      .select('status')
      .eq('id', fx.eventId)
      .single()
    expect(eventAfterBlock?.status).toBe('scoring_open')
  })
})
