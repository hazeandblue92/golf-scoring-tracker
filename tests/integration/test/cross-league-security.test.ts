import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  buildScoringFixture,
  type ScoringFixture,
} from '../helpers/fixture.ts'
import { stackIsUp, userClient } from '../helpers/stack.ts'

const ISOLATED_LEAGUE_ID = '00000000-0000-4000-8000-000000000002'

describe('isolated second-league boundary', () => {
  let fx: ScoringFixture
  let foreignLeagueId: string
  let foreignEventId: string
  let foreignParticipantId: string

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    fx = await buildScoringFixture({ playerCount: 2 })

    // The service role intentionally cannot create deployments/leagues. A
    // synthetic archived league is seeded by postgres solely so this test can
    // prove row isolation without weakening that production privilege.
    foreignLeagueId = ISOLATED_LEAGUE_ID

    const seasonId = randomUUID()
    const season = await fx.service.from('seasons').insert({
      id: seasonId,
      league_id: foreignLeagueId,
      name: 'Isolated season',
      starts_on: '2026-01-01',
      ends_on: '2026-12-31',
      status: 'planned',
    })
    if (season.error) throw season.error

    foreignParticipantId = randomUUID()
    const participant = await fx.service.from('participants').insert({
      id: foreignParticipantId,
      league_id: foreignLeagueId,
      display_name: 'Foreign Player',
      sort_name: 'player, foreign',
      organizer_notes: 'Must remain inside the isolated league',
      status: 'active',
    })
    if (participant.error) throw participant.error

    foreignEventId = randomUUID()
    const event = await fx.service.from('events').insert({
      id: foreignEventId,
      league_id: foreignLeagueId,
      season_id: seasonId,
      name: 'Foreign organizer-only event',
      slug: `foreign-${foreignEventId.slice(0, 8)}`,
      timezone: 'America/Detroit',
      starts_at: '2026-10-01T13:00:00Z',
      status: 'draft',
      visibility: 'organizers',
    })
    if (event.error) throw event.error
  }, 120_000)

  it('does not expose foreign league, roster, event, or organizer notes', async () => {
    const caller = userClient(fx.director.accessToken)
    const [league, participant, event, notes] = await Promise.all([
      caller.from('leagues').select('id').eq('id', foreignLeagueId),
      caller.from('participants')
        .select('id,display_name')
        .eq('id', foreignParticipantId),
      caller.from('events').select('id,name').eq('id', foreignEventId),
      caller.rpc('participant_organizer_notes', {
        p_participant_id: foreignParticipantId,
      }),
    ])

    for (const result of [league, participant, event]) {
      expect(result.error).toBeNull()
      expect(result.data).toEqual([])
    }
    expect(notes.error).toBeNull()
    expect(notes.data).toBeNull()
  })

  it('rejects a privileged workflow against the foreign event', async () => {
    const caller = userClient(fx.director.accessToken)
    const { data, error } = await caller.rpc('set_event_flights', {
      p_event_id: foreignEventId,
      p_flights: [],
    })
    expect(error).toBeNull()
    expect(data).toMatchObject({ status: 'rejected', error_code: 'NOT_ASSIGNED' })
  })
})
