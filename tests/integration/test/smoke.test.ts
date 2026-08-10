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
})
