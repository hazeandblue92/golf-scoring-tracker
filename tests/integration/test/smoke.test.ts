/**
 * Harness smoke test: proves the fixture builder produces a scorable event and
 * that the submit-score pipeline reaches the leaderboard. If this fails, every
 * other integration suite is untrustworthy, so it asserts the plumbing only.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { buildScoringFixture, scoreRequest, type ScoringFixture } from '../helpers/fixture.ts'
import { callFunction, stackIsUp } from '../helpers/stack.ts'

describe('integration harness', () => {
  let fx: ScoringFixture

  beforeAll(async () => {
    expect(
      await stackIsUp(),
      'local Supabase stack must be running (`npm run backend:start`)',
    ).toBe(true)
    fx = await buildScoringFixture()
  })

  it('builds a scoring_open event with holes, entries, and competitions', async () => {
    const { data } = await fx.service
      .from('events')
      .select('status, scoring_revision')
      .eq('id', fx.eventId)
      .single()

    expect(data?.status).toBe('scoring_open')
    expect(fx.holes).toHaveLength(18)
    expect(fx.entries).toHaveLength(4)
    expect(fx.holes.reduce((sum, h) => sum + h.par, 0)).toBe(72)
  })

  it('accepts a score from the event director and publishes projections', async () => {
    const res = await callFunction<Record<string, unknown>>(
      'submit-score',
      scoreRequest(fx),
      fx.director.accessToken,
    )

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.status).toBe('committed')
    expect(res.body.scoreRevision).toBe(1)
    expect(res.body.eventRevision).toBe(1)
    expect(res.body.projectionRevision).toBe(1)
  })

  it('lands the score on the leaderboard', async () => {
    const { data } = await fx.service
      .from('leaderboard_rows')
      .select('entity_id, thru')
      .eq('competition_id', fx.competitions.grossId)
      .eq('event_revision', 1)

    expect(data?.length ?? 0).toBeGreaterThan(0)
  })

  it('repairs the newest projection after two overlapping score writes', async () => {
    const writes = await Promise.all([1, 2].map((holeIndex) => callFunction<{
      eventRevision: number
    }>(
      'submit-score',
      scoreRequest(fx, {
        target: {
          kind: 'individual',
          entryId: fx.entries[0].entryId,
          holeId: fx.holes[holeIndex].id,
        },
      }),
      fx.director.accessToken,
    )))
    expect(writes.every((write) => write.status === 200)).toBe(true)
    const expectedRevision = Math.max(...writes.map((write) => write.body.eventRevision))
    const deadline = Date.now() + 3_000
    let projectionRevision = -1
    do {
      const { data } = await fx.service
        .from('competition_projections')
        .select('event_revision')
        .eq('competition_id', fx.competitions.grossId)
        .order('event_revision', { ascending: false })
        .limit(1)
        .maybeSingle()
      projectionRevision = Number(data?.event_revision ?? -1)
      if (projectionRevision === expectedRevision) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    expect(projectionRevision).toBe(expectedRevision)
  })

  it('rejects an unexpired JWT immediately after its profile is disabled', async () => {
    const disabled = await fx.service
      .from('profiles')
      .update({ status: 'disabled' })
      .eq('id', fx.director.profileId)
    if (disabled.error) throw disabled.error

    const result = await callFunction<{ errorCode: string }>(
      'submit-score',
      scoreRequest(fx, {
        target: {
          kind: 'individual',
          entryId: fx.entries[0].entryId,
          holeId: fx.holes[3].id,
        },
      }),
      fx.director.accessToken,
    )
    expect(result.status).toBe(401)
    expect(result.body.errorCode).toBe('AUTH_REQUIRED')
  })
})
