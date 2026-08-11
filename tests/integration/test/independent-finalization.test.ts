/**
 * Independent finalization and audited reopen (Appendix B, spec §12.2, §26).
 *
 * Sealing one competition is a statement about that competition only. Its
 * siblings must keep scoring, the event must stay open, and the exact score
 * facts the sealed result was computed from must become immutable — while a
 * hole outside its Terms scope stays writable. Correcting a sealed result is
 * a deliberate, MFA-gated, reasoned action that leaves an audit trail.
 *
 * The file drives one fixture event through a fixed sequence, so the statuses
 * asserted below are exact expectations rather than "at least".
 */

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import { buildScoringFixture, scoreRequest, type ScoringFixture } from '../helpers/fixture.ts'
import { callFunction, stackIsUp } from '../helpers/stack.ts'

/** The local stack is slow under parallel suites; none of this is a latency test. */
const HTTP_TIMEOUT_MS = 120_000

/** Holes 10–18. The sealed competition reads these and nothing else. */
const BACK_NINE = Array.from({ length: 9 }, (_, index) => index + 10)

function backNineGrossRules() {
  return {
    format: 'individual_stroke',
    schemaVersion: 1,
    metric: 'gross',
    holeScope: BACK_NINE,
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
  }
}

interface FinalizeBody {
  status: string
  finalResultHash?: string
  correlationId?: string
  detail?: string
}

interface ReopenBody {
  status: string
  competitionStatus?: string
  eventStatus?: string
  errorCode?: string
  detail?: string
}

interface SubmitScoreBody {
  status: string
  errorCode: string | null
  detail?: string
}

describe('independent competition finalization (Appendix B)', () => {
  let fx: ScoringFixture
  /** Gross competition scoped to holes 10–18 only. */
  let backNineId: string
  let sealedHash: string

  /** Hole 3 belongs to no sealed competition; hole 12 is a sealed input. */
  const frontHole = () => fx.holes[2]!
  const backHole = () => fx.holes[11]!
  const entryId = () => fx.entries[0]!.entryId

  async function competitionStatuses(): Promise<Map<string, {
    status: string
    final_result_hash: string | null
    finalized_at: string | null
  }>> {
    const { data, error } = await fx.service
      .from('competitions')
      .select('id,status,final_result_hash,finalized_at')
      .eq('event_id', fx.eventId)
    if (error) throw new Error(`competitions read failed — ${error.message}`)
    return new Map(data!.map((row) => [row.id as string, row as never]))
  }

  async function eventStatus(): Promise<string> {
    const { data, error } = await fx.service
      .from('events').select('status').eq('id', fx.eventId).single()
    if (error) throw new Error(`events read failed — ${error.message}`)
    return data!.status as string
  }

  async function roundStatus(): Promise<string> {
    const { data, error } = await fx.service
      .from('rounds').select('status').eq('id', fx.roundId).single()
    if (error) throw new Error(`rounds read failed — ${error.message}`)
    return data!.status as string
  }

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    fx = await buildScoringFixture({ playerCount: 2 })

    // publish-event opens the round in the real workflow; the fixture inserts
    // rounds directly, so mirror that here to exercise the round cascade.
    const opened = await fx.service.from('rounds')
      .update({ status: 'in_progress' }).eq('id', fx.roundId)
    if (opened.error) throw opened.error

    backNineId = randomUUID()
    const competition = await fx.service.from('competitions').insert({
      id: backNineId,
      event_id: fx.eventId,
      name: 'Back Nine Gross',
      format: 'individual_stroke',
      metric: 'gross',
      status: 'scoring_open',
      rules_schema_version: 1,
      rules_json: backNineGrossRules(),
      engine_version: 'test',
      sort_order: 80,
    })
    if (competition.error) throw competition.error

    const link = await fx.service.from('competition_rounds').insert({
      competition_id: backNineId,
      round_id: fx.roundId,
      hole_scope: BACK_NINE,
      weight: 1,
    })
    if (link.error) throw link.error

    const entities = await fx.service.from('competition_entities').insert(
      fx.entries.map((entry) => ({
        competition_id: backNineId,
        event_entry_id: entry.entryId,
        eligibility_status: 'eligible',
      })),
    )
    if (entities.error) throw entities.error

    // Complete, attested cards for every entrant. A partially scored skins
    // pool is genuinely provisional and must not seal, so the close-out below
    // only means something on a field that is actually finished.
    const scores = await fx.service.from('individual_hole_scores').insert(
      fx.entries.flatMap((entry, entrant) => fx.holes.map((hole) => ({
        event_id: fx.eventId,
        round_id: fx.roundId,
        event_entry_id: entry.entryId,
        event_hole_id: hole.id,
        gross_strokes: hole.par + entrant,
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
        score_revision: fx.holes.length,
        reason: 'Integration close-out attestation',
      })),
    )
    if (attestations.error) throw attestations.error
  }, 240_000)

  it('seals one competition without closing scoring for its siblings', async () => {
    const finalized = await callFunction<FinalizeBody>(
      'finalize-competition',
      { competitionId: backNineId, overrideReason: null },
      fx.director.accessToken,
    )
    expect(finalized.status, JSON.stringify(finalized.body)).toBe(200)
    expect(finalized.body.status).toBe('finalized')
    expect(finalized.body.finalResultHash).toMatch(/^[0-9a-f]{64}$/)
    sealedHash = finalized.body.finalResultHash!

    const statuses = await competitionStatuses()
    expect(statuses.get(backNineId)?.status).toBe('finalized')
    expect(statuses.get(backNineId)?.final_result_hash).toBe(sealedHash)

    for (const siblingId of [
      fx.competitions.grossId,
      fx.competitions.netId,
      fx.competitions.skinsId,
    ]) {
      expect(statuses.get(siblingId)?.status, `sibling ${siblingId} must stay open`)
        .toBe('scoring_open')
      expect(statuses.get(siblingId)?.final_result_hash).toBeNull()
    }

    // The event and its round hold their live states until nothing is open.
    expect(await eventStatus()).toBe('scoring_open')
    expect(await roundStatus()).toBe('in_progress')

    // The sealed artifact is stored at the revision it was computed from.
    const { data: projection, error } = await fx.service
      .from('competition_projections')
      .select('status,projection_hash')
      .eq('competition_id', backNineId)
      .order('event_revision', { ascending: false })
      .limit(1)
      .single()
    if (error) throw error
    expect(projection?.status).toBe('final')
    expect(projection?.projection_hash).toBe(sealedHash)
  }, HTTP_TIMEOUT_MS)

  it('keeps unsealed holes writable while sealed inputs are immutable', async () => {
    const front = await callFunction<SubmitScoreBody>(
      'submit-score',
      scoreRequest(fx, {
        target: { kind: 'individual', entryId: entryId(), holeId: frontHole().id },
        baseRevision: 1,
        value: { status: 'complete', grossStrokes: 6, notes: null },
      }),
      fx.scorer.accessToken,
    )
    expect(front.status, JSON.stringify(front.body)).toBe(200)
    expect(front.body.status).toBe('committed')

    const back = await callFunction<SubmitScoreBody>(
      'submit-score',
      scoreRequest(fx, {
        target: { kind: 'individual', entryId: entryId(), holeId: backHole().id },
        baseRevision: 1,
        value: { status: 'complete', grossStrokes: 6, notes: null },
      }),
      fx.scorer.accessToken,
    )
    expect(back.status, JSON.stringify(back.body)).toBe(409)
    expect(back.body.status).toBe('rejected')
    expect(back.body.errorCode).toBe('EVENT_LOCKED')

    // Defense in depth: even a service-role write cannot touch a sealed input.
    const direct = await fx.service.from('individual_hole_scores')
      .update({ gross_strokes: 9 })
      .eq('event_entry_id', entryId())
      .eq('event_hole_id', backHole().id)
    expect(direct.error?.code).toBe('23514')
  }, HTTP_TIMEOUT_MS)

  it('refuses to reopen without a verified authenticator, a reason, or a sealed target', async () => {
    const withoutMfa = await callFunction<ReopenBody>(
      'reopen-competition',
      { competitionId: backNineId, reason: 'Committee correction after review' },
      fx.director.aal1AccessToken,
    )
    expect(withoutMfa.status, JSON.stringify(withoutMfa.body)).toBe(403)
    expect(withoutMfa.body.errorCode).toBe('MFA_REQUIRED')

    const withoutReason = await callFunction<ReopenBody>(
      'reopen-competition',
      { competitionId: backNineId, reason: '  ' },
      fx.director.accessToken,
    )
    expect(withoutReason.status, JSON.stringify(withoutReason.body)).toBe(400)

    const notSealed = await callFunction<ReopenBody>(
      'reopen-competition',
      { competitionId: fx.competitions.grossId, reason: 'Nothing to correct yet' },
      fx.director.accessToken,
    )
    expect(notSealed.status, JSON.stringify(notSealed.body)).toBe(409)

    // None of the refusals may move a status.
    const statuses = await competitionStatuses()
    expect(statuses.get(backNineId)?.status).toBe('finalized')
    expect(statuses.get(fx.competitions.grossId)?.status).toBe('scoring_open')
  }, HTTP_TIMEOUT_MS)

  it('reopens exactly one sealed competition and restores its inputs', async () => {
    const reason = 'Attested card corrected after committee review'
    const reopened = await callFunction<ReopenBody>(
      'reopen-competition',
      { competitionId: backNineId, reason },
      fx.director.accessToken,
    )
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200)
    expect(reopened.body.status).toBe('reopened')
    expect(reopened.body.competitionStatus).toBe('scoring_open')

    const statuses = await competitionStatuses()
    expect(statuses.get(backNineId)?.status).toBe('scoring_open')
    expect(statuses.get(backNineId)?.final_result_hash).toBeNull()
    expect(statuses.get(backNineId)?.finalized_at).toBeNull()
    expect(await eventStatus()).toBe('scoring_open')

    const { data: audit, error } = await fx.service
      .from('audit_events')
      .select('action,reason,target_id,before_json,after_json')
      .eq('target_id', backNineId)
      .eq('action', 'competition.reopened')
      .single()
    if (error) throw error
    expect(audit?.reason).toBe(reason)
    expect((audit?.before_json as { finalResultHash?: string })?.finalResultHash)
      .toBe(sealedHash)
    expect((audit?.after_json as { finalResultHash?: string | null })?.finalResultHash)
      .toBeNull()

    // The previously sealed hole accepts corrections again.
    const corrected = await callFunction<SubmitScoreBody>(
      'submit-score',
      scoreRequest(fx, {
        target: { kind: 'individual', entryId: entryId(), holeId: backHole().id },
        baseRevision: 1,
        value: { status: 'complete', grossStrokes: 6, notes: null },
      }),
      fx.scorer.accessToken,
    )
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200)
    expect(corrected.body.status).toBe('committed')
  }, HTTP_TIMEOUT_MS)

  it('closes the round and the event only after every competition is sealed', async () => {
    const remaining = [
      fx.competitions.grossId,
      fx.competitions.netId,
      fx.competitions.skinsId,
      backNineId,
    ]

    for (const [index, competitionId] of remaining.entries()) {
      const finalized = await callFunction<FinalizeBody>(
        'finalize-competition',
        { competitionId, overrideReason: 'Committee close-out for the whole event' },
        fx.director.accessToken,
      )
      expect(finalized.status, JSON.stringify(finalized.body)).toBe(200)
      expect(finalized.body.status).toBe('finalized')

      const last = index === remaining.length - 1
      expect(await eventStatus(), last
        ? 'the event finalizes with its last competition'
        : 'the event stays open while any competition is unsealed',
      ).toBe(last ? 'finalized' : 'scoring_open')
      expect(await roundStatus()).toBe(last ? 'complete' : 'in_progress')
    }

    const statuses = await competitionStatuses()
    for (const competitionId of remaining) {
      expect(statuses.get(competitionId)?.status).toBe('finalized')
      expect(statuses.get(competitionId)?.final_result_hash)
        .toMatch(/^[0-9a-f]{64}$/)
    }
  }, HTTP_TIMEOUT_MS)
})
