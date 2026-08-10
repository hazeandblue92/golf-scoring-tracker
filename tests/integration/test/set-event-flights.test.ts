/**
 * Organizer flight management (spec §5.2, §6.2).
 *
 * set_event_flights is the only way to create a flight, so its authorization
 * and its draft-only rule matter as much as the assignment logic: a flight
 * re-cut after publish would silently redraw a division that results were
 * already published against.
 */

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import { buildScoringFixture, type ScoringFixture } from '../helpers/fixture.ts'
import { stackIsUp, userClient } from '../helpers/stack.ts'

describe('set_event_flights (§5.2)', () => {
  let draft: ScoringFixture

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    // leaveClosed stops at 'published'; drop back to draft, which the state
    // machine allows before any accepted score exists.
    draft = await buildScoringFixture({ playerCount: 4, leaveClosed: true })
    const toDraft = await draft.service
      .from('events')
      .update({ status: 'draft' })
      .eq('id', draft.eventId)
    if (toDraft.error) throw toDraft.error
  }, 120_000)

  it('creates flights and assigns entries by participant', async () => {
    const client = userClient(draft.director.accessToken)
    const { data, error } = await client.rpc('set_event_flights', {
      p_event_id: draft.eventId,
      p_flights: [
        { name: 'A Flight', participantIds: [draft.entries[0].participantId, draft.entries[1].participantId] },
        { name: 'B Flight', participantIds: [draft.entries[2].participantId, draft.entries[3].participantId] },
      ],
    })
    expect(error).toBeNull()
    expect((data as { status: string }).status).toBe('saved')
    expect((data as { flights: number }).flights).toBe(2)

    const { data: flights } = await draft.service
      .from('flights')
      .select('id, name, sort_order')
      .eq('event_id', draft.eventId)
      .order('sort_order')
    expect(flights?.map((f) => f.name)).toEqual(['A Flight', 'B Flight'])

    const { data: entries } = await draft.service
      .from('event_entries')
      .select('id, flight_id')
      .eq('event_id', draft.eventId)
    expect(entries?.every((e) => e.flight_id !== null)).toBe(true)
    expect(new Set(entries?.map((e) => e.flight_id)).size).toBe(2)
  })

  it('replaces the whole set: a dropped flight releases its entries', async () => {
    const client = userClient(draft.director.accessToken)
    const { data: before } = await draft.service
      .from('flights').select('id, name').eq('event_id', draft.eventId).order('sort_order')
    const keep = before?.find((f) => f.name === 'A Flight')

    const { error } = await client.rpc('set_event_flights', {
      p_event_id: draft.eventId,
      p_flights: [
        { id: keep?.id, name: 'A Flight', participantIds: [draft.entries[0].participantId] },
      ],
    })
    expect(error).toBeNull()

    const { data: flights } = await draft.service
      .from('flights').select('id').eq('event_id', draft.eventId)
    expect(flights).toHaveLength(1)

    // The three entries no longer in a flight are released, not left pointing
    // at a deleted row.
    const { data: entries } = await draft.service
      .from('event_entries').select('flight_id').eq('event_id', draft.eventId)
    expect(entries?.filter((e) => e.flight_id !== null)).toHaveLength(1)
  })

  it('rejects a caller with no organizer role', async () => {
    const { data, error } = await userClient(draft.outsider.accessToken).rpc(
      'set_event_flights',
      { p_event_id: draft.eventId, p_flights: [{ name: 'Sneaky', participantIds: [] }] },
    )
    // Denied either by the function's own check or by EXECUTE privilege.
    if (!error) expect((data as { error_code: string }).error_code).toBe('NOT_ASSIGNED')

    const { data: flights } = await draft.service
      .from('flights').select('name').eq('event_id', draft.eventId)
    expect(flights?.some((f) => f.name === 'Sneaky')).toBe(false)
  })

  it('refuses an unnamed flight rather than creating a blank division', async () => {
    const { data } = await userClient(draft.director.accessToken).rpc('set_event_flights', {
      p_event_id: draft.eventId,
      p_flights: [{ name: '   ', participantIds: [] }],
    })
    expect((data as { error_code: string }).error_code).toBe('SNAPSHOT_INVALID')
  })

  it('refuses to re-cut divisions once the event leaves draft', async () => {
    const open = await draft.service
      .from('events').update({ status: 'published' }).eq('id', draft.eventId)
    if (open.error) throw open.error

    const { data } = await userClient(draft.director.accessToken).rpc('set_event_flights', {
      p_event_id: draft.eventId,
      p_flights: [{ name: 'Too late', participantIds: [] }],
    })
    expect((data as { error_code: string }).error_code).toBe('EVENT_LOCKED')

    const { data: flights } = await draft.service
      .from('flights').select('name').eq('event_id', draft.eventId)
    expect(flights?.some((f) => f.name === 'Too late')).toBe(false)
  })
})
