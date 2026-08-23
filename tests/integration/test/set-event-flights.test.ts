/**
 * Organizer flight management (spec §5.2, §6.1, §11.8).
 *
 * Flight replacement is deliberately tested through an authenticated client:
 * the RPC owns authorization, full-payload validation, replace semantics, and
 * propagation into every scoring entity.
 */

import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  buildScoringFixture,
  LEAGUE_ID,
  SEASON_ID,
  type ScoringFixture,
} from '../helpers/fixture.ts'
import { stackIsUp, userClient } from '../helpers/stack.ts'

interface FlightResult {
  status: 'saved' | 'rejected'
  error_code?: string
  detail?: string
  flightCount?: number
  flights?: Array<{
    id: string
    name: string
    sortOrder: number
    participantIds: string[]
    teamIds: string[]
  }>
}

describe('set_event_flights (§5.2)', () => {
  let draft: ScoringFixture
  let stableFlightIds: [string, string] | null = null
  let lastValidResult: FlightResult
  let draftCompetitionId: string
  let draftSkinsCompetitionId: string

  const validPayload = () => [
    {
      ...(stableFlightIds ? { id: stableFlightIds[0] } : {}),
      name: 'A Flight',
      participantIds: [draft.entries[0].participantId, draft.entries[1].participantId],
    },
    {
      ...(stableFlightIds ? { id: stableFlightIds[1] } : {}),
      name: 'B Flight',
      participantIds: [draft.entries[2].participantId, draft.entries[3].participantId],
    },
  ]

  async function saveValidFlights() {
    const { data, error } = await userClient(draft.director.accessToken).rpc(
      'set_event_flights',
      { p_event_id: draft.eventId, p_flights: validPayload() },
    )
    expect(error).toBeNull()
    const result = data as FlightResult
    expect(result.status).toBe('saved')
    expect(result.flightCount).toBe(2)
    expect(result.flights).toHaveLength(2)
    const ids = result.flights?.map((flight) => flight.id)
    expect(ids).toHaveLength(2)
    stableFlightIds = [ids?.[0] as string, ids?.[1] as string]
    lastValidResult = result
  }

  async function currentState() {
    const [flights, entries, teams, entities, competitions] = await Promise.all([
      draft.service
        .from('flights')
        .select('id,name,sort_order')
        .eq('event_id', draft.eventId)
        .order('sort_order'),
      draft.service
        .from('event_entries')
        .select('id,participant_id,flight_id')
        .eq('event_id', draft.eventId)
        .order('participant_id'),
      draft.service
        .from('event_teams')
        .select('id,flight_id')
        .eq('event_id', draft.eventId)
        .order('id'),
      draft.service
        .from('competition_entities')
        .select('id,flight_id,competitions!inner(event_id)')
        .eq('competitions.event_id', draft.eventId)
        .order('id'),
      draft.service
        .from('competitions')
        .select('id,status,rules_json')
        .eq('event_id', draft.eventId)
        .order('id'),
    ])
    for (const result of [flights, entries, teams, entities, competitions]) {
      if (result.error) throw result.error
    }
    return {
      flights: flights.data,
      entries: entries.data,
      teams: teams.data,
      entities: entities.data,
      competitions: competitions.data,
    }
  }

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    draft = await buildScoringFixture({ playerCount: 4, leaveClosed: true })

    // The fixture stops at published with scoring-open competitions. Return the
    // score-free event and its competitions to their editable draft state.
    const event = await draft.service
      .from('events')
      .update({ status: 'draft' })
      .eq('id', draft.eventId)
    if (event.error) throw event.error

    const [sourceCompetitionResult, sourceSkinsResult] = await Promise.all([
      draft.service
        .from('competitions')
        .select('rules_json,rules_text,visibility')
        .eq('id', draft.competitions.grossId)
        .single(),
      draft.service
        .from('competitions')
        .select('rules_json,rules_text,visibility')
        .eq('id', draft.competitions.skinsId)
        .single(),
    ])
    if (sourceCompetitionResult.error) throw sourceCompetitionResult.error
    if (sourceSkinsResult.error) throw sourceSkinsResult.error
    const sourceCompetition = sourceCompetitionResult.data
    const sourceSkins = sourceSkinsResult.data
    draftCompetitionId = randomUUID()
    draftSkinsCompetitionId = randomUUID()
    const draftCompetition = await draft.service.from('competitions').insert([
      {
        id: draftCompetitionId,
        event_id: draft.eventId,
        name: 'Draft Flight Check',
        format: 'individual_stroke',
        metric: 'gross',
        status: 'draft',
        rules_schema_version: 1,
        rules_json: sourceCompetition.rules_json,
        rules_text: sourceCompetition.rules_text,
        engine_version: 'test',
        visibility: sourceCompetition.visibility,
        sort_order: 98,
      },
      {
        id: draftSkinsCompetitionId,
        event_id: draft.eventId,
        name: 'Draft Flight Skins Check',
        format: 'skins',
        metric: 'net',
        status: 'draft',
        rules_schema_version: 1,
        rules_json: sourceSkins.rules_json,
        rules_text: sourceSkins.rules_text,
        engine_version: 'test',
        visibility: sourceSkins.visibility,
        sort_order: 99,
      },
    ])
    if (draftCompetition.error) throw draftCompetition.error
    const draftEntities = await draft.service.from('competition_entities').insert(
      draft.entries.map((entry) => ({
        competition_id: draftCompetitionId,
        event_entry_id: entry.entryId,
      })),
    )
    if (draftEntities.error) throw draftEntities.error
  }, 120_000)

  beforeEach(async () => {
    const [profile, event] = await Promise.all([
      draft.service.from('profiles').update({ status: 'active' }).eq('id', draft.director.profileId),
      draft.service.from('events').update({ status: 'draft' }).eq('id', draft.eventId),
    ])
    if (profile.error) throw profile.error
    if (event.error) throw event.error
    await saveValidFlights()
  })

  it('creates stable flights and propagates assignments, draft rules, and audit scope', async () => {
    expect(lastValidResult.flights?.map((flight) => flight.name)).toEqual([
      'A Flight',
      'B Flight',
    ])
    expect(lastValidResult.flights?.map((flight) =>
      new Set(flight.participantIds))).toEqual([
      new Set([draft.entries[0].participantId, draft.entries[1].participantId]),
      new Set([draft.entries[2].participantId, draft.entries[3].participantId]),
    ])

    const state = await currentState()
    expect(state.entries?.every((entry) => entry.flight_id !== null)).toBe(true)
    expect(new Set(state.entries?.map((entry) => entry.flight_id)).size).toBe(2)
    expect(state.entities?.every((entity) => entity.flight_id !== null)).toBe(true)
    expect(state.competitions
      ?.filter((competition) => competition.status === 'draft')
      .every((competition) =>
        (competition.rules_json as { flighting?: string }).flighting === 'per_flight')).toBe(true)
    const draftSkins = state.competitions?.find((competition) =>
      competition.id === draftSkinsCompetitionId)
    expect((draftSkins?.rules_json as { skins?: { population?: string } })
      .skins?.population).toBe('flight')

    const { data: audit, error } = await draft.service
      .from('audit_events')
      .select('scope_league_id,scope_event_id,before_json,after_json')
      .eq('action', 'event.flights_set')
      .eq('target_id', draft.eventId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    if (error) throw error
    expect(audit.scope_league_id).toBe(LEAGUE_ID)
    expect(audit.scope_event_id).toBe(draft.eventId)
    expect(audit.before_json).toBeTruthy()
    expect(audit.after_json).toMatchObject({ flighting: 'per_flight' })
  })

  it('preserves ids across renames and returns the canonical replacement', async () => {
    const originalIds = [...(stableFlightIds as [string, string])]
    const { data, error } = await userClient(draft.director.accessToken).rpc(
      'set_event_flights',
      {
        p_event_id: draft.eventId,
        p_flights: [
          {
            id: originalIds[0],
            name: 'B Flight',
            participantIds: [draft.entries[0].participantId, draft.entries[1].participantId],
          },
          {
            id: originalIds[1],
            name: 'A Flight',
            participantIds: [draft.entries[2].participantId, draft.entries[3].participantId],
          },
        ],
      },
    )
    expect(error).toBeNull()
    const result = data as FlightResult
    expect(result.flights?.map((flight) => flight.id)).toEqual(originalIds)
    expect(result.flights?.map((flight) => flight.name)).toEqual(['B Flight', 'A Flight'])
  })

  it('validates the entire payload before changing any authoritative row', async () => {
    const before = await currentState()
    const invalidPayloads: unknown[] = [
      { name: 'not an array' },
      [null],
      [{ name: 'Missing members' }],
      [{ id: 'not-a-uuid', name: 'Bad id', participantIds: [] }],
      [
        {
          id: stableFlightIds?.[0],
          name: 'First id use',
          participantIds: [draft.entries[0].participantId, draft.entries[1].participantId],
        },
        {
          id: stableFlightIds?.[0],
          name: 'Second id use',
          participantIds: [draft.entries[2].participantId, draft.entries[3].participantId],
        },
      ],
      [
        { name: 'Duplicate', participantIds: [draft.entries[0].participantId] },
        {
          name: 'duplicate',
          participantIds: draft.entries.slice(1).map((entry) => entry.participantId),
        },
      ],
      [
        {
          name: 'A Flight',
          participantIds: [draft.entries[0].participantId, draft.entries[1].participantId],
        },
        {
          name: 'B Flight',
          participantIds: [
            draft.entries[1].participantId,
            draft.entries[2].participantId,
            draft.entries[3].participantId,
          ],
        },
      ],
      [
        {
          name: 'All players',
          participantIds: draft.entries.map((entry) => entry.participantId),
        },
        { name: 'Empty flight', participantIds: [] },
      ],
      [
        {
          name: 'A Flight',
          participantIds: draft.entries.slice(0, 3).map((entry) => entry.participantId),
        },
      ],
      [
        {
          name: 'A Flight',
          participantIds: [
            ...draft.entries.map((entry) => entry.participantId),
            randomUUID(),
          ],
        },
      ],
    ]

    for (const p_flights of invalidPayloads) {
      const { data } = await userClient(draft.director.accessToken).rpc(
        'set_event_flights',
        { p_event_id: draft.eventId, p_flights },
      )
      expect((data as FlightResult).status).toBe('rejected')
      expect((data as FlightResult).error_code).toBe('SNAPSHOT_INVALID')
      expect(await currentState()).toEqual(before)
    }
  })

  it('rejects an id owned by another event without touching either event', async () => {
    const foreignEventId = randomUUID()
    const foreignFlightId = randomUUID()
    const eventInsert = await draft.service.from('events').insert({
      id: foreignEventId,
      league_id: LEAGUE_ID,
      season_id: SEASON_ID,
      name: 'Foreign Flight Event',
      slug: `foreign-${foreignEventId.slice(0, 8)}`,
      timezone: 'America/Detroit',
      starts_at: new Date().toISOString(),
      status: 'draft',
    })
    if (eventInsert.error) throw eventInsert.error
    const flightInsert = await draft.service.from('flights').insert({
      id: foreignFlightId,
      event_id: foreignEventId,
      name: 'Foreign Flight',
      sort_order: 1,
    })
    if (flightInsert.error) throw flightInsert.error

    const before = await currentState()
    const { data } = await userClient(draft.director.accessToken).rpc(
      'set_event_flights',
      {
        p_event_id: draft.eventId,
        p_flights: [
          {
            id: foreignFlightId,
            name: 'Hijacked',
            participantIds: draft.entries.map((entry) => entry.participantId),
          },
        ],
      },
    )
    expect((data as FlightResult).error_code).toBe('SNAPSHOT_INVALID')
    expect(await currentState()).toEqual(before)
    const { data: foreign } = await draft.service
      .from('flights')
      .select('event_id,name')
      .eq('id', foreignFlightId)
      .single()
    expect(foreign).toEqual({ event_id: foreignEventId, name: 'Foreign Flight' })
  })

  it('derives team and team-entity flights and rejects split or unassigned teams', async () => {
    const teamIds = [randomUUID(), randomUUID()]
    const teams = await draft.service.from('event_teams').insert([
      { id: teamIds[0], event_id: draft.eventId, name: 'Team One' },
      { id: teamIds[1], event_id: draft.eventId, name: 'Team Two' },
    ])
    if (teams.error) throw teams.error
    const members = await draft.service.from('event_team_members').insert([
      { event_team_id: teamIds[0], event_entry_id: draft.entries[0].entryId, position: 1 },
      { event_team_id: teamIds[0], event_entry_id: draft.entries[1].entryId, position: 2 },
      { event_team_id: teamIds[1], event_entry_id: draft.entries[2].entryId, position: 1 },
      { event_team_id: teamIds[1], event_entry_id: draft.entries[3].entryId, position: 2 },
    ])
    if (members.error) throw members.error
    const entities = await draft.service.from('competition_entities').insert([
      { competition_id: draftCompetitionId, event_team_id: teamIds[0] },
      { competition_id: draftCompetitionId, event_team_id: teamIds[1] },
    ])
    if (entities.error) throw entities.error

    await saveValidFlights()
    const { data: assignedTeams } = await draft.service
      .from('event_teams')
      .select('id,flight_id')
      .in('id', teamIds)
      .order('name')
    expect(assignedTeams?.map((team) => team.flight_id)).toEqual(stableFlightIds)

    const { data: teamEntities } = await draft.service
      .from('competition_entities')
      .select('event_team_id,flight_id')
      .in('event_team_id', teamIds)
      .order('event_team_id')
    const teamFlight = new Map(assignedTeams?.map((team) => [team.id, team.flight_id]))
    expect(teamEntities?.every((entity) =>
      entity.flight_id === teamFlight.get(entity.event_team_id as string))).toBe(true)

    const before = await currentState()
    const invalidTeamPayloads = [
      [
        {
          name: 'A Flight',
          participantIds: [draft.entries[0].participantId, draft.entries[2].participantId],
        },
        {
          name: 'B Flight',
          participantIds: [draft.entries[1].participantId, draft.entries[3].participantId],
        },
      ],
      [
        {
          name: 'A Flight',
          participantIds: draft.entries.slice(0, 3).map((entry) => entry.participantId),
        },
      ],
    ]
    for (const p_flights of invalidTeamPayloads) {
      const { data } = await userClient(draft.director.accessToken).rpc(
        'set_event_flights',
        { p_event_id: draft.eventId, p_flights },
      )
      expect((data as FlightResult).error_code).toBe('SNAPSHOT_INVALID')
      expect(await currentState()).toEqual(before)
    }
  })

  it('accepts an empty replacement to remove flights and restore whole-field rules', async () => {
    const { data, error } = await userClient(draft.director.accessToken).rpc(
      'set_event_flights',
      { p_event_id: draft.eventId, p_flights: [] },
    )
    expect(error).toBeNull()
    expect(data).toMatchObject({ status: 'saved', flightCount: 0, flights: [] })

    const state = await currentState()
    expect(state.flights).toEqual([])
    expect(state.entries?.every((entry) => entry.flight_id === null)).toBe(true)
    expect(state.teams?.every((team) => team.flight_id === null)).toBe(true)
    expect(state.entities?.every((entity) => entity.flight_id === null)).toBe(true)
    expect(state.competitions
      ?.filter((competition) => competition.status === 'draft')
      .every((competition) =>
        (competition.rules_json as { flighting?: string }).flighting === 'none')).toBe(true)
    const draftSkins = state.competitions?.find((competition) =>
      competition.id === draftSkinsCompetitionId)
    expect((draftSkins?.rules_json as { skins?: { population?: string } })
      .skins?.population).toBe('field')
  })

  it('preserves an explicitly frozen group skins population while flights change', async () => {
    const current = await draft.service.from('competitions')
      .select('rules_json')
      .eq('id', draftSkinsCompetitionId)
      .single()
    if (current.error) throw current.error
    const rules = structuredClone(current.data.rules_json) as {
      skins: { population: string }
    }
    rules.skins.population = 'group'
    const frozen = await draft.service.from('competitions')
      .update({ rules_json: rules })
      .eq('id', draftSkinsCompetitionId)
    if (frozen.error) throw frozen.error

    await saveValidFlights()
    const state = await currentState()
    const draftSkins = state.competitions?.find((competition) =>
      competition.id === draftSkinsCompetitionId)
    expect((draftSkins?.rules_json as { skins?: { population?: string } })
      .skins?.population).toBe('group')
    expect((draftSkins?.rules_json as { flighting?: string }).flighting).toBe('per_flight')
  })

  it('rejects a caller with no organizer role', async () => {
    const before = await currentState()
    const { data, error } = await userClient(draft.outsider.accessToken).rpc(
      'set_event_flights',
      { p_event_id: draft.eventId, p_flights: validPayload() },
    )
    if (!error) expect((data as FlightResult).error_code).toBe('NOT_ASSIGNED')
    expect(await currentState()).toEqual(before)
  })

  it('requires an organizer to complete MFA before changing flights', async () => {
    expect(draft.director.aal1AccessToken).toBeDefined()
    const before = await currentState()
    const { data, error } = await userClient(draft.director.aal1AccessToken as string).rpc(
      'set_event_flights',
      { p_event_id: draft.eventId, p_flights: validPayload() },
    )
    expect(error).toBeNull()
    expect(data).toMatchObject({
      status: 'rejected',
      error_code: 'MFA_REQUIRED',
      detail: 'Complete multi-factor verification before changing flights',
    })
    expect(await currentState()).toEqual(before)
  })

  it('rejects an inactive organizer even when the JWT is still valid', async () => {
    const before = await currentState()
    const disabled = await draft.service
      .from('profiles')
      .update({ status: 'disabled' })
      .eq('id', draft.director.profileId)
    if (disabled.error) throw disabled.error
    let reactivationError: { message: string } | null = null
    try {
      const { data, error } = await userClient(draft.director.accessToken).rpc(
        'set_event_flights',
        { p_event_id: draft.eventId, p_flights: validPayload() },
      )
      expect(error).toBeNull()
      expect((data as FlightResult).error_code).toBe('AUTH_REQUIRED')
      expect(await currentState()).toEqual(before)
    } finally {
      const active = await draft.service
        .from('profiles')
        .update({ status: 'active' })
        .eq('id', draft.director.profileId)
      reactivationError = active.error
    }
    if (reactivationError) throw reactivationError
  })

  it('refuses to re-cut divisions once the event leaves draft', async () => {
    const before = await currentState()
    const published = await draft.service
      .from('events')
      .update({ status: 'published' })
      .eq('id', draft.eventId)
    if (published.error) throw published.error

    const { data } = await userClient(draft.director.accessToken).rpc(
      'set_event_flights',
      { p_event_id: draft.eventId, p_flights: [] },
    )
    expect((data as FlightResult).error_code).toBe('EVENT_LOCKED')
    expect(await currentState()).toEqual(before)
  })
})
