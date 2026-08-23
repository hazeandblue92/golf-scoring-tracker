import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  buildScoringFixture,
  createAccount,
  LEAGUE_ID,
  scoreRequest,
  type ScoringFixture,
  type TestAccount,
} from '../helpers/fixture.ts'
import { callFunction, stackIsUp } from '../helpers/stack.ts'

interface SubmitResult {
  status: string
  conflictId?: string
}

describe('atomic director-only conflict resolution', () => {
  let fx: ScoringFixture
  let unauthorized: TestAccount
  let conflictId: string

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    fx = await buildScoringFixture({ playerCount: 2 })
    unauthorized = await createAccount(fx.service, {
      displayName: 'MFA league member without director role',
      withMfa: true,
    })
    const membership = await fx.service.from('league_memberships').insert({
      league_id: LEAGUE_ID,
      profile_id: unauthorized.profileId,
      member_status: 'active',
    })
    if (membership.error) throw membership.error

    const committed = await callFunction<SubmitResult>(
      'submit-score',
      scoreRequest(fx, {
        value: { status: 'complete', grossStrokes: 4, notes: null },
      }),
      fx.director.accessToken,
    )
    expect(committed.status, JSON.stringify(committed.body)).toBe(200)

    const conflicted = await callFunction<SubmitResult>(
      'submit-score',
      scoreRequest(fx, {
        baseRevision: 0,
        value: { status: 'complete', grossStrokes: 5, notes: null },
      }),
      fx.scorer.accessToken,
    )
    expect(conflicted.status, JSON.stringify(conflicted.body)).toBe(409)
    expect(conflicted.body.status).toBe('conflict')
    if (conflicted.body.conflictId === undefined) throw new Error('conflict id missing')
    conflictId = conflicted.body.conflictId
  }, 120_000)

  async function state() {
    const [score, event, conflict] = await Promise.all([
      fx.service.from('individual_hole_scores')
        .select('gross_strokes,revision')
        .eq('event_entry_id', fx.entries[0].entryId)
        .eq('event_hole_id', fx.holes[0].id)
        .single(),
      fx.service.from('events')
        .select('scoring_revision')
        .eq('id', fx.eventId)
        .single(),
      fx.service.from('score_conflicts')
        .select('status,resolution_choice')
        .eq('id', conflictId)
        .single(),
    ])
    if (score.error) throw score.error
    if (event.error) throw event.error
    if (conflict.error) throw conflict.error
    return { score: score.data, event: event.data, conflict: conflict.data }
  }

  it('rejects AAL1 and non-director callers before any state changes', async () => {
    const before = await state()
    expect(before).toEqual({
      score: { gross_strokes: 4, revision: 1 },
      event: { scoring_revision: 1 },
      conflict: { status: 'open', resolution_choice: null },
    })

    const aal1Token = fx.director.aal1AccessToken
    if (aal1Token === undefined) throw new Error('director AAL1 token missing')
    const aal1 = await callFunction<{ errorCode?: string }>(
      'resolve-score-conflict',
      { conflictId, choice: 'local', reason: 'AAL1 must not resolve conflicts' },
      aal1Token,
    )
    expect(aal1.status).toBe(403)
    expect(aal1.body.errorCode).toBe('MFA_REQUIRED')

    const nonDirector = await callFunction<{ errorCode?: string }>(
      'resolve-score-conflict',
      { conflictId, choice: 'local', reason: 'Non-director must not resolve' },
      unauthorized.accessToken,
    )
    expect(nonDirector.status).toBe(403)
    expect(nonDirector.body.errorCode).toBe('NOT_ASSIGNED')
    expect(await state()).toEqual(before)
  }, 120_000)

  it('commits the chosen fact, revision, conflict, ledger, and audit exactly once', async () => {
    const leaseToken = randomUUID()
    const claimed = await fx.service.rpc('claim_projection_publish', {
      p_event_id: fx.eventId,
      p_revision: 1,
      p_lease_token: leaseToken,
    })
    if (claimed.error) throw claimed.error
    expect(claimed.data).toBe('claimed')

    const request = {
      conflictId,
      choice: 'local',
      reason: 'Committee selected the offline card after review',
    }
    const resolved = await callFunction<{
      status?: string
      eventRevision?: number
      scoreRevision?: number
      scoreChanged?: boolean
      projectionStatus?: string
    }>('resolve-score-conflict', request, fx.director.accessToken)
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200)
    expect(resolved.body).toMatchObject({
      status: 'resolved',
      eventRevision: 2,
      scoreRevision: 2,
      scoreChanged: true,
      projectionStatus: 'queued',
    })
    expect(await state()).toEqual({
      score: { gross_strokes: 5, revision: 2 },
      event: { scoring_revision: 2 },
      conflict: { status: 'resolved', resolution_choice: 'local' },
    })

    const [ledger, audit] = await Promise.all([
      fx.service.from('score_mutations')
        .select('actor_profile_id,result,event_revision,reason')
        .eq('event_id', fx.eventId)
        .eq('reason', request.reason),
      fx.service.from('audit_events')
        .select('actor_profile_id,scope_event_id,action,reason')
        .eq('target_id', conflictId)
        .eq('action', 'score_conflict.resolved'),
    ])
    if (ledger.error) throw ledger.error
    if (audit.error) throw audit.error
    expect(ledger.data).toEqual([expect.objectContaining({
      actor_profile_id: fx.director.profileId,
      result: 'committed',
      event_revision: 2,
      reason: request.reason,
    })])
    expect(audit.data).toEqual([expect.objectContaining({
      actor_profile_id: fx.director.profileId,
      scope_event_id: fx.eventId,
      action: 'score_conflict.resolved',
      reason: request.reason,
    })])

    // A duplicate receipt must not blindly report success when the durable
    // score commit outlived its first projection attempt. The retry detects
    // the stale artifact, reports it queued, and schedules repair without
    // another score mutation.
    const duplicate = await callFunction<{
      status?: string
      scoreChanged?: boolean
      projectionStatus?: string
    }>(
      'resolve-score-conflict',
      request,
      fx.director.accessToken,
    )
    expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(200)
    expect(duplicate.body).toMatchObject({
      status: 'duplicate',
      scoreChanged: false,
      projectionStatus: 'queued',
    })

    const released = await fx.service.rpc('release_projection_publish', {
      p_event_id: fx.eventId,
      p_revision: 2,
      p_lease_token: leaseToken,
    })
    if (released.error) throw released.error
    expect(released.data).toBe(true)

    let repairedRevision: number | null = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const projection = await fx.service.from('competition_projections')
        .select('event_revision')
        .eq('competition_id', fx.competitions.grossId)
        .order('event_revision', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (projection.error) throw projection.error
      repairedRevision = projection.data?.event_revision ?? null
      if (repairedRevision === 2) break
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    expect(repairedRevision).toBe(2)
    expect((await state()).event.scoring_revision).toBe(2)
  }, 120_000)

  it('keeps a conflict open when the captured server score has changed', async () => {
    const conflicted = await callFunction<SubmitResult>(
      'submit-score',
      scoreRequest(fx, {
        baseRevision: 1,
        value: { status: 'complete', grossStrokes: 6, notes: null },
      }),
      fx.scorer.accessToken,
    )
    expect(conflicted.status, JSON.stringify(conflicted.body)).toBe(409)
    if (conflicted.body.conflictId === undefined) throw new Error('stale conflict id missing')

    const changed = await callFunction<SubmitResult>(
      'submit-score',
      scoreRequest(fx, {
        baseRevision: 2,
        value: { status: 'complete', grossStrokes: 7, notes: null },
      }),
      fx.director.accessToken,
    )
    expect(changed.status, JSON.stringify(changed.body)).toBe(200)

    const staleResolution = await callFunction<{ errorCode?: string }>(
      'resolve-score-conflict',
      {
        conflictId: conflicted.body.conflictId,
        choice: 'server',
        reason: 'This server choice was captured before the latest edit',
      },
      fx.director.accessToken,
    )
    expect(staleResolution.status).toBe(409)
    expect(staleResolution.body.errorCode).toBe('BASE_REVISION_STALE')

    const [score, conflict] = await Promise.all([
      fx.service.from('individual_hole_scores')
        .select('gross_strokes,revision')
        .eq('event_entry_id', fx.entries[0].entryId)
        .eq('event_hole_id', fx.holes[0].id)
        .single(),
      fx.service.from('score_conflicts')
        .select('status,resolution_choice')
        .eq('id', conflicted.body.conflictId)
        .single(),
    ])
    if (score.error) throw score.error
    if (conflict.error) throw conflict.error
    expect(score.data).toEqual({ gross_strokes: 7, revision: 3 })
    expect(conflict.data).toEqual({ status: 'open', resolution_choice: null })
  }, 120_000)
})
