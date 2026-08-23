import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  buildScoringFixture,
  scoreRequest,
  type ScoringFixture,
} from '../helpers/fixture.ts'
import { callFunction, stackIsUp } from '../helpers/stack.ts'

interface SubmitResult {
  status: string
  scoreRevision: number | null
  eventRevision: number | null
  projectionRevision: number | null
}

describe('durable score recovery after projection publication is deferred', () => {
  let fx: ScoringFixture

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    fx = await buildScoringFixture({ playerCount: 2 })
  }, 120_000)

  it('keeps the raw fact, replays idempotently, and converges through repair', async () => {
    const leaseToken = randomUUID()
    const claim = await fx.service.rpc('claim_projection_publish', {
      p_event_id: fx.eventId,
      p_revision: 0,
      p_lease_token: leaseToken,
    })
    if (claim.error) throw claim.error
    expect(claim.data).toBe('claimed')

    const request = scoreRequest(fx)
    const submitted = await callFunction<SubmitResult>(
      'submit-score',
      request,
      fx.director.accessToken,
    )
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200)
    expect(submitted.body).toMatchObject({
      status: 'queued_projection',
      scoreRevision: 1,
      eventRevision: 1,
      projectionRevision: null,
    })

    const { data: rawScore, error: scoreError } = await fx.service
      .from('individual_hole_scores')
      .select('gross_strokes,revision')
      .eq('event_entry_id', fx.entries[0].entryId)
      .eq('event_hole_id', fx.holes[0].id)
      .single()
    if (scoreError) throw scoreError
    expect(rawScore).toMatchObject({ gross_strokes: 4, revision: 1 })

    const replayed = await callFunction<SubmitResult>(
      'submit-score',
      request,
      fx.director.accessToken,
    )
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(200)
    expect(replayed.body.status).toBe('duplicate')
    const { count: mutationCount, error: mutationError } = await fx.service
      .from('score_mutations')
      .select('idempotency_key', { count: 'exact', head: true })
      .eq('idempotency_key', request.idempotencyKey as string)
    if (mutationError) throw mutationError
    expect(mutationCount).toBe(1)

    const released = await fx.service.rpc('release_projection_publish', {
      p_event_id: fx.eventId,
      p_revision: 1,
      p_lease_token: leaseToken,
    })
    if (released.error) throw released.error
    expect(released.data).toBe(true)

    const repaired = await callFunction<{ status: string; eventRevision: number }>(
      'rebuild-projections',
      { eventId: fx.eventId },
      fx.director.accessToken,
    )
    expect(repaired.status, JSON.stringify(repaired.body)).toBe(200)
    expect(repaired.body).toMatchObject({ status: 'published', eventRevision: 1 })

    const { data: projection, error: projectionError } = await fx.service
      .from('competition_projections')
      .select('event_revision,status')
      .eq('competition_id', fx.competitions.grossId)
      .eq('event_revision', 1)
      .single()
    if (projectionError) throw projectionError
    expect(projection).toMatchObject({ event_revision: 1, status: 'live' })
    const { data: row, error: rowError } = await fx.service
      .from('leaderboard_rows')
      .select('result_primary,thru')
      .eq('competition_id', fx.competitions.grossId)
      .eq('event_revision', 1)
      .not('result_primary', 'is', null)
      .single()
    if (rowError) throw rowError
    expect(Number(row.result_primary)).toBe(4)
    expect(row.thru).toBe(1)
  }, 120_000)
})
