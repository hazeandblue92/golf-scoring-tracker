/**
 * Golden vector `deferred-two-device-conflict` (spec §20.2, §7.2, §10.4).
 *
 * Two devices edit the same hole while one of them is offline. The second
 * write MUST NOT silently overwrite the first: the server rejects it as a
 * conflict, preserves the stored score, and records the disagreement for a
 * human to resolve. The subtle counter-case is the benign retry — the SAME
 * actor replaying the value it already committed is not a disagreement and
 * must succeed instead of manufacturing a conflict.
 *
 * The whole file drives one fixture event through a fixed sequence, so every
 * revision number below is an exact expectation, not a "greater than".
 */

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildScoringFixture, scoreRequest, type ScoringFixture } from '../helpers/fixture.ts'
import { callFunction, stackIsUp } from '../helpers/stack.ts'

interface SubmitScoreBody {
  status: string
  scoreRevision: number | null
  eventRevision: number | null
  projectionRevision: number | null
  conflictId?: string | null
  errorCode: string | null
  correlationId: string
  detail?: string
  projectionStatus?: string
}

interface FinalizeBody {
  status: string
  missingScores?: number
  openConflicts?: number
  unattestedCards?: number
  correlationId: string
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Per-test budget. Every assertion here is about protocol semantics, never
 * latency, and the local stack is slow while other suites hammer it — so allow
 * far more than the suite default rather than let load look like a defect.
 */
const HTTP_TIMEOUT_MS = 120_000

/** Device A wrote a 4; device B, which never saw that write, believes it is a 6. */
const DEVICE_A_STROKES = 4
const DEVICE_B_STROKES = 6
/**
 * A third value, submitted by the actor who already owns the stored row. The
 * §10.4 replay branch is guarded by TWO conditions — same actor AND identical
 * value — so it needs a negative case that differs only in the value, or a
 * regression that drops the value comparison reads as "benign retry" and
 * silently overwrites.
 */
const SAME_ACTOR_REVISED_STROKES = 7

/** The canonical value shape stored in payload/ledger JSON columns (§4.5). */
const payload = (grossStrokes: number) => ({
  status: 'complete',
  grossStrokes,
  notes: null,
})

describe('deferred-two-device-conflict (spec §20.2, §7.2, §10.4)', () => {
  let fx: ScoringFixture

  // Idempotency keys are pinned so each assertion can address exactly the
  // ledger row produced by exactly one HTTP call.
  const keyDeviceA = randomUUID()
  const keyDeviceB = randomUUID()
  const keyReplay = randomUUID()
  const keyRebased = randomUUID()
  const keyOtherHole = randomUUID()
  const keySameActorEdit = randomUUID()
  const keyOtherActorEcho = randomUUID()

  /** conflictId returned by the 409; later tests match it against the row. */
  let conflictId: string | null = null

  const holeOne = () => fx.holes[0]
  const holeTwo = () => fx.holes[1]
  const entryId = () => fx.entries[0].entryId

  async function eventRevision(): Promise<number> {
    const { data, error } = await fx.service
      .from('events')
      .select('scoring_revision')
      .eq('id', fx.eventId)
      .single()
    if (error) throw new Error(`events read failed — ${error.message}`)
    return data!.scoring_revision as number
  }

  async function storedScore(holeId: string) {
    const { data, error } = await fx.service
      .from('individual_hole_scores')
      .select('gross_strokes, score_status, revision, entered_by')
      .eq('event_entry_id', entryId())
      .eq('event_hole_id', holeId)
      .maybeSingle()
    if (error) throw new Error(`individual_hole_scores read failed — ${error.message}`)
    return data
  }

  /** All conflicts recorded for this fixture's event/entry/hole — never global. */
  async function conflictRows(holeId: string) {
    const { data, error } = await fx.service
      .from('score_conflicts')
      .select(
        'id, event_id, round_id, target_kind, event_entry_id, event_hole_id, ' +
          'local_payload, server_payload, local_actor_profile_id, ' +
          'server_actor_profile_id, base_revision, server_revision, status',
      )
      .eq('event_id', fx.eventId)
      .eq('event_entry_id', entryId())
      .eq('event_hole_id', holeId)
    if (error) throw new Error(`score_conflicts read failed — ${error.message}`)
    return data ?? []
  }

  async function mutationRows(holeId: string) {
    const { data, error } = await fx.service
      .from('score_mutations')
      .select(
        'idempotency_key, base_revision, prior_value, new_value, ' +
          'actor_profile_id, result, event_revision',
      )
      .eq('event_id', fx.eventId)
      .eq('event_entry_id', entryId())
      .eq('event_hole_id', holeId)
      .order('created_at', { ascending: true })
    if (error) throw new Error(`score_mutations read failed — ${error.message}`)
    return data ?? []
  }

  beforeAll(async () => {
    // The readiness probe carries its own 30s budget, which a cold vitest
    // worker can burn through while the stack is busy. Probe a few times so a
    // slow start is not reported as "the stack is down"; a genuinely absent
    // stack still fails with the actionable message.
    let up = false
    for (let attempt = 0; attempt < 3 && !up; attempt++) {
      up = await stackIsUp()
    }
    expect(up, 'local Supabase stack must be running (`npm run backend:start`)').toBe(true)

    // GoTrue on the local stack intermittently times out the admin-create /
    // password-grant calls when several suites build fixtures at once. That is
    // setup flakiness, not behaviour under test, so retry the build rather than
    // let it masquerade as a conflict-protocol failure.
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fx = await buildScoringFixture()
        return
      } catch (err) {
        lastError = err
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    throw new Error(`fixture build failed after 3 attempts — ${String(lastError)}`)
    // Hook budget below: probing and a fixture build can each take tens of
    // seconds on a loaded stack, so setup needs more headroom than the
    // suite-wide 60s hook timeout.
  }, 240_000)

  it('spec §10.4 — device A (director) commits hole 1 from baseRevision 0', async () => {
    const res = await callFunction<SubmitScoreBody>(
      'submit-score',
      scoreRequest(fx, {
        idempotencyKey: keyDeviceA,
        baseRevision: 0,
        value: { status: 'complete', grossStrokes: DEVICE_A_STROKES, notes: null },
      }),
      fx.director.accessToken,
    )

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.status).toBe('committed')
    // First write to a hole: score revision starts at 1, and the event's
    // scoring revision advances by exactly one per committed mutation.
    expect(res.body.scoreRevision).toBe(1)
    expect(res.body.eventRevision).toBe(1)
    expect(res.body.projectionRevision).toBe(1)
    expect(res.body.errorCode).toBeNull()
    expect(await eventRevision()).toBe(1)
  }, HTTP_TIMEOUT_MS)

  it('spec §20.2 — device B submitting the same hole at stale baseRevision 0 is a 409 conflict', async () => {
    const res = await callFunction<SubmitScoreBody>(
      'submit-score',
      scoreRequest(fx, {
        idempotencyKey: keyDeviceB,
        baseRevision: 0, // second device never saw device A's write
        value: { status: 'complete', grossStrokes: DEVICE_B_STROKES, notes: null },
      }),
      fx.scorer.accessToken,
    )

    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.status).toBe('conflict')
    expect(res.body.errorCode).toBe('BASE_REVISION_STALE')
    expect(res.body.conflictId).toEqual(expect.stringMatching(UUID_RE))
    // The server tells the loser where the truth actually is, so the client can
    // rebase (see the resubmit test) rather than guess.
    expect(res.body.scoreRevision).toBe(1)
    expect(res.body.eventRevision).toBe(1)
    expect(res.body.projectionRevision).toBeNull()

    // Read the durable state back with service credentials in the same test
    // that performed the rejected write, so the rejection is proven to be a
    // rejection rather than inferred from a later test's ordering.
    expect(await eventRevision()).toBe(1)
    const score = await storedScore(holeOne().id)
    expect(score!.gross_strokes).toBe(DEVICE_A_STROKES)
    expect(score!.revision).toBe(1)

    conflictId = res.body.conflictId ?? null
  }, HTTP_TIMEOUT_MS)

  it('spec §10.4 — the stored score is device A’s value, not last-write-wins', async () => {
    const score = await storedScore(holeOne().id)

    // The entire point of the vector: a rejected write leaves zero trace on the
    // score row — same value, same revision, same author.
    expect(score).not.toBeNull()
    expect(score!.gross_strokes).toBe(DEVICE_A_STROKES)
    expect(score!.revision).toBe(1)
    expect(score!.score_status).toBe('complete')
    expect(score!.entered_by).toBe(fx.director.profileId)
  }, HTTP_TIMEOUT_MS)

  it('spec §10.4 — exactly one score_conflicts row captures both sides of the disagreement', async () => {
    const rows = await conflictRows(holeOne().id)

    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.id).toBe(conflictId)
    expect(row.base_revision).toBe(0) // what device B claimed
    expect(row.server_revision).toBe(1) // what the server actually held
    expect(row.local_actor_profile_id).toBe(fx.scorer.profileId) // losing device
    expect(row.server_actor_profile_id).toBe(fx.director.profileId) // stored value's author
    expect(row.target_kind).toBe('individual')
    expect(row.round_id).toBe(fx.roundId)
    // Both payloads are retained WHOLE so a director can resolve by choosing
    // one; exact equality, because a partial match would not notice a payload
    // that silently dropped a field on the way into the row.
    expect(row.local_payload).toEqual(payload(DEVICE_B_STROKES))
    expect(row.server_payload).toEqual(payload(DEVICE_A_STROKES))
    expect(row.status).toBe('open')
  }, HTTP_TIMEOUT_MS)

  it('spec §7.2 — the conflict is ledgered as result=conflict and does not advance events.scoring_revision', async () => {
    const rows = await mutationRows(holeOne().id)

    // Exactly two attempts have touched this hole so far: A committed, B lost.
    expect(rows).toHaveLength(2)

    const committed = rows.find((r) => r.idempotency_key === keyDeviceA)
    expect(committed?.result).toBe('committed')
    expect(committed?.actor_profile_id).toBe(fx.director.profileId)
    expect(committed?.base_revision).toBe(0)
    // Nothing existed before the first write, so there is no prior value to
    // record — a fabricated one would corrupt the audit trail.
    expect(committed?.prior_value).toBeNull()
    expect(committed?.new_value).toEqual(payload(DEVICE_A_STROKES))
    expect(committed?.event_revision).toBe(1)

    const conflicted = rows.find((r) => r.idempotency_key === keyDeviceB)
    expect(conflicted?.result).toBe('conflict')
    expect(conflicted?.actor_profile_id).toBe(fx.scorer.profileId)
    expect(conflicted?.base_revision).toBe(0)
    expect(conflicted?.new_value).toEqual(payload(DEVICE_B_STROKES))
    expect(conflicted?.prior_value).toEqual(payload(DEVICE_A_STROKES))
    // The ledger stamps the revision in force at the time; a conflict consumes
    // no revision, so it is still 1.
    expect(conflicted?.event_revision).toBe(1)

    expect(await eventRevision()).toBe(1)
  }, HTTP_TIMEOUT_MS)

  it('spec §10.4 — the SAME actor replaying its own committed value on a stale base is a benign retry, not a conflict', async () => {
    expect(await mutationRows(holeOne().id)).toHaveLength(2)

    const res = await callFunction<SubmitScoreBody>(
      'submit-score',
      scoreRequest(fx, {
        // A fresh key means idempotency cannot short-circuit this: the retry
        // branch has to be reached through the stale-base comparison itself.
        idempotencyKey: keyReplay,
        baseRevision: 0,
        value: { status: 'complete', grossStrokes: DEVICE_A_STROKES, notes: null },
      }),
      fx.director.accessToken,
    )

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.status).toBe('committed')
    expect(res.body.errorCode).toBeNull()
    // Nothing changed, so every revision stands still — a retry is not an edit.
    // The projection republishes at the SAME revision it already held; had the
    // replay been mistakenly applied, this would read 2.
    expect(res.body.scoreRevision).toBe(1)
    expect(res.body.eventRevision).toBe(1)
    expect(res.body.projectionRevision).toBe(1)
    expect(res.body.conflictId ?? null).toBeNull()
    expect(await eventRevision()).toBe(1)

    // The distinction that matters: no second conflict, and no ledger row for
    // an operation that changed nothing.
    const conflicts = await conflictRows(holeOne().id)
    expect(conflicts).toHaveLength(1)
    // Same row, untouched — a count alone would not notice the original being
    // deleted and replaced by a freshly manufactured one.
    expect(conflicts[0].id).toBe(conflictId)
    expect(conflicts[0].base_revision).toBe(0)
    expect(conflicts[0].server_revision).toBe(1)
    expect(conflicts[0].status).toBe('open')

    const after = await mutationRows(holeOne().id)
    expect(after).toHaveLength(2)
    expect(after.some((r) => r.idempotency_key === keyReplay)).toBe(false)

    const score = await storedScore(holeOne().id)
    expect(score!.gross_strokes).toBe(DEVICE_A_STROKES)
    expect(score!.revision).toBe(1)
    expect(score!.entered_by).toBe(fx.director.profileId)
  }, HTTP_TIMEOUT_MS)

  it('spec §10.4 — device B succeeds once it rebases onto baseRevision 1', async () => {
    const res = await callFunction<SubmitScoreBody>(
      'submit-score',
      scoreRequest(fx, {
        idempotencyKey: keyRebased,
        baseRevision: 1, // the server_revision handed back with the 409
        value: { status: 'complete', grossStrokes: DEVICE_B_STROKES, notes: null },
      }),
      fx.scorer.accessToken,
    )

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.status).toBe('committed')
    expect(res.body.scoreRevision).toBe(2)
    expect(res.body.eventRevision).toBe(2)
    expect(res.body.projectionRevision).toBe(2)

    const score = await storedScore(holeOne().id)
    expect(score!.gross_strokes).toBe(DEVICE_B_STROKES)
    expect(score!.revision).toBe(2)
    expect(score!.entered_by).toBe(fx.scorer.profileId)

    // Rebasing must not fabricate a second conflict — and it is not itself a
    // resolution: §10.4 reserves that for an explicit human choice, so the
    // original row must still be open with its original revisions.
    const conflicts = await conflictRows(holeOne().id)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].id).toBe(conflictId)
    expect(conflicts[0].status).toBe('open')
    expect(conflicts[0].base_revision).toBe(0)
    expect(conflicts[0].server_revision).toBe(1)

    // The winning write is ledgered with the value it displaced, which is the
    // audit trail a director needs when reviewing how the hole settled.
    const rows = await mutationRows(holeOne().id)
    expect(rows).toHaveLength(3)
    const rebased = rows.find((r) => r.idempotency_key === keyRebased)
    expect(rebased?.result).toBe('committed')
    expect(rebased?.actor_profile_id).toBe(fx.scorer.profileId)
    expect(rebased?.base_revision).toBe(1)
    expect(rebased?.prior_value).toEqual(payload(DEVICE_A_STROKES))
    expect(rebased?.new_value).toEqual(payload(DEVICE_B_STROKES))
    expect(rebased?.event_revision).toBe(2)

    expect(await eventRevision()).toBe(2)
  }, HTTP_TIMEOUT_MS)

  it('spec §7.2 — an open conflict on hole 1 does not block a write to hole 2', async () => {
    const res = await callFunction<SubmitScoreBody>(
      'submit-score',
      scoreRequest(fx, {
        idempotencyKey: keyOtherHole,
        target: { kind: 'individual', entryId: entryId(), holeId: holeTwo().id },
        baseRevision: 0,
        value: { status: 'complete', grossStrokes: 5, notes: null },
      }),
      fx.scorer.accessToken,
    )

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.status).toBe('committed')
    // Conflicts are per-hole state, so hole 2 is still a first write.
    expect(res.body.scoreRevision).toBe(1)
    expect(res.body.eventRevision).toBe(3)
    expect(res.body.projectionRevision).toBe(3)

    const score = await storedScore(holeTwo().id)
    expect(score!.gross_strokes).toBe(5)
    expect(score!.revision).toBe(1)
    expect(score!.entered_by).toBe(fx.scorer.profileId)

    expect(await conflictRows(holeTwo().id)).toHaveLength(0)
    const holeTwoLedger = await mutationRows(holeTwo().id)
    expect(holeTwoLedger).toHaveLength(1)
    expect(holeTwoLedger[0].idempotency_key).toBe(keyOtherHole)
    expect(holeTwoLedger[0].result).toBe('committed')
    expect(holeTwoLedger[0].prior_value).toBeNull()
    expect(holeTwoLedger[0].event_revision).toBe(3)

    // Independence cuts both ways: hole 1's settled score and its still-open
    // conflict must be exactly where the previous tests left them.
    const holeOneScore = await storedScore(holeOne().id)
    expect(holeOneScore!.gross_strokes).toBe(DEVICE_B_STROKES)
    expect(holeOneScore!.revision).toBe(2)
    const holeOneConflicts = await conflictRows(holeOne().id)
    expect(holeOneConflicts).toHaveLength(1)
    expect(holeOneConflicts[0].id).toBe(conflictId)
    expect(holeOneConflicts[0].status).toBe('open')
  }, HTTP_TIMEOUT_MS)

  it('spec §10.4 — the SAME actor submitting a DIFFERENT value on a stale base is a conflict, not a replay', async () => {
    // The hole now belongs to the scorer at revision 2. The scorer submits
    // again from a device still stuck at baseRevision 0 — same actor, but a
    // value the server has never seen. If the replay branch compared only the
    // ACTOR, this would return 200 and overwrite: last-write-wins through the
    // back door. §10.4 requires "replaying an identical value" for success.
    const res = await callFunction<SubmitScoreBody>(
      'submit-score',
      scoreRequest(fx, {
        idempotencyKey: keySameActorEdit,
        baseRevision: 0,
        value: {
          status: 'complete',
          grossStrokes: SAME_ACTOR_REVISED_STROKES,
          notes: null,
        },
      }),
      fx.scorer.accessToken,
    )

    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.status).toBe('conflict')
    expect(res.body.errorCode).toBe('BASE_REVISION_STALE')
    expect(res.body.conflictId).toEqual(expect.stringMatching(UUID_RE))
    expect(res.body.conflictId).not.toBe(conflictId)
    expect(res.body.scoreRevision).toBe(2)
    expect(res.body.eventRevision).toBe(3)
    expect(res.body.projectionRevision).toBeNull()

    const rows = await conflictRows(holeOne().id)
    expect(rows).toHaveLength(2)
    const row = rows.find((r) => r.id === res.body.conflictId)
    expect(row, 'the 409 conflictId must address a real row').toBeDefined()
    expect(row!.base_revision).toBe(0)
    expect(row!.server_revision).toBe(2)
    // Both sides are the same person — a device disagreeing with itself is
    // still a disagreement, and the record must say so honestly.
    expect(row!.local_actor_profile_id).toBe(fx.scorer.profileId)
    expect(row!.server_actor_profile_id).toBe(fx.scorer.profileId)
    expect(row!.local_payload).toEqual(payload(SAME_ACTOR_REVISED_STROKES))
    expect(row!.server_payload).toEqual(payload(DEVICE_B_STROKES))
    expect(row!.status).toBe('open')

    // Nothing moved.
    const score = await storedScore(holeOne().id)
    expect(score!.gross_strokes).toBe(DEVICE_B_STROKES)
    expect(score!.revision).toBe(2)
    expect(score!.entered_by).toBe(fx.scorer.profileId)
    expect(await eventRevision()).toBe(3)

    const ledger = await mutationRows(holeOne().id)
    expect(ledger).toHaveLength(4)
    const attempt = ledger.find((r) => r.idempotency_key === keySameActorEdit)
    expect(attempt?.result).toBe('conflict')
    expect(attempt?.actor_profile_id).toBe(fx.scorer.profileId)
    expect(attempt?.base_revision).toBe(0)
    expect(attempt?.new_value).toEqual(payload(SAME_ACTOR_REVISED_STROKES))
    expect(attempt?.prior_value).toEqual(payload(DEVICE_B_STROKES))
    expect(attempt?.event_revision).toBe(3)
  }, HTTP_TIMEOUT_MS)

  it('spec §10.4 — a DIFFERENT actor echoing the identical stored value on a stale base is still a conflict', async () => {
    // The mirror image of the previous test: identical value, different actor.
    // §10.4 grants success only to "the same actor/device ... replaying an
    // identical value"; everything else creates a conflict record. This pins
    // the actor half of the guard, which value-equality alone cannot prove.
    const res = await callFunction<SubmitScoreBody>(
      'submit-score',
      scoreRequest(fx, {
        idempotencyKey: keyOtherActorEcho,
        baseRevision: 0,
        value: { status: 'complete', grossStrokes: DEVICE_B_STROKES, notes: null },
      }),
      fx.director.accessToken,
    )

    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.status).toBe('conflict')
    expect(res.body.errorCode).toBe('BASE_REVISION_STALE')
    expect(res.body.conflictId).toEqual(expect.stringMatching(UUID_RE))
    expect(res.body.scoreRevision).toBe(2)
    expect(res.body.eventRevision).toBe(3)

    const rows = await conflictRows(holeOne().id)
    expect(rows).toHaveLength(3)
    const row = rows.find((r) => r.id === res.body.conflictId)
    expect(row, 'the 409 conflictId must address a real row').toBeDefined()
    expect(row!.local_actor_profile_id).toBe(fx.director.profileId)
    expect(row!.server_actor_profile_id).toBe(fx.scorer.profileId)
    expect(row!.base_revision).toBe(0)
    expect(row!.server_revision).toBe(2)
    expect(row!.local_payload).toEqual(payload(DEVICE_B_STROKES))
    expect(row!.server_payload).toEqual(payload(DEVICE_B_STROKES))

    const score = await storedScore(holeOne().id)
    expect(score!.gross_strokes).toBe(DEVICE_B_STROKES)
    expect(score!.revision).toBe(2)
    expect(score!.entered_by).toBe(fx.scorer.profileId)
    expect(await eventRevision()).toBe(3)
  }, HTTP_TIMEOUT_MS)

  it('AC-009: finalization refuses every unresolved conflict without an explicit override', async () => {
    const openConflicts = await conflictRows(holeOne().id)
    expect(openConflicts).toHaveLength(3)
    expect(openConflicts.every((row) => row.status === 'open')).toBe(true)

    const res = await callFunction<FinalizeBody>(
      'finalize-competition',
      {
        competitionId: fx.competitions.grossId,
        overrideReason: null,
      },
      fx.director.accessToken,
    )

    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.status).toBe('blocked')
    expect(res.body.openConflicts).toBe(3)
    expect(res.body.missingScores).toBeGreaterThan(0)

    const { data, error } = await fx.service
      .from('competitions')
      .select('status,finalized_at,final_result_hash')
      .eq('id', fx.competitions.grossId)
      .single()
    if (error) throw new Error(`competition read failed — ${error.message}`)
    expect(data.status).not.toBe('finalized')
    expect(data.finalized_at).toBeNull()
    expect(data.final_result_hash).toBeNull()
  }, HTTP_TIMEOUT_MS)
})
