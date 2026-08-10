/**
 * Authorization boundary suite — the Phase 0 exit gate for "allowed and denied
 * paths with real JWTs" (spec §2.2 roles, §7.2 write protocol, §12.4 error
 * codes, §14.3 access matrix, §25 scorer model).
 *
 * Two boundaries are exercised, and only these two exist:
 *
 *   1. submit-score, the single sanctioned write door. Permission is decided
 *      inside apply_score_mutation under the CALLER's auth context, so these
 *      tests always send a real end-user JWT.
 *   2. PostgREST + RLS + SQL GRANTs, the door a hostile browser tab would try
 *      instead. `authenticated` holds SELECT only; every denial here is
 *      verified twice — once on the API response, once by reading the row back
 *      with service credentials. PostgREST reports most RLS denials as an
 *      empty 200, so "no error" alone would pass against a wide-open table.
 *
 * The service client appears ONLY to build fixtures and to establish ground
 * truth. It is never a stand-in for a caller.
 *
 * All acting happens in `beforeAll`, and each `it` asserts on a captured
 * result. Revision numbers are order-dependent by design (every committed
 * mutation bumps events.scoring_revision by exactly 1), so pinning the order
 * in one place keeps every exact-value assertion deterministic even if a run
 * filters or reorders individual tests.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  buildScoringFixture,
  createAccount,
  scoreRequest,
  LEAGUE_ID,
  type ScoringFixture,
  type TestAccount,
} from '../helpers/fixture.ts'
import {
  anonClient,
  callFunction,
  stackIsUp,
  userClient,
  type FunctionResponse,
} from '../helpers/stack.ts'

type Body = Record<string, unknown>
type Call = FunctionResponse<Body>

/** A structurally valid JWT that is expired and signed with nothing real. */
function forgedJwt(): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  return [
    b64({ alg: 'HS256', typ: 'JWT' }),
    b64({
      sub: '00000000-0000-4000-8000-0000000000ff',
      role: 'authenticated',
      aud: 'authenticated',
      iss: 'supabase',
      iat: now - 7200,
      exp: now - 3600,
    }),
    Buffer.from('not-a-real-signature').toString('base64url'),
  ].join('.')
}

/**
 * The auth admin API and PostgREST both time out intermittently when several
 * suites hammer the same local stack. Setup is not what these tests assert, so
 * it retries; every assertion below still runs exactly once.
 */
async function retry<T>(what: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(2_000 * i)
    try {
      return await fn()
    } catch (err) {
      last = err
    }
  }
  throw new Error(`setup: ${what} failed after ${attempts} attempts — ${String(last)}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Issue one submit-score call, replaying the IDENTICAL body (same idempotency
 * key) while the stack answers 5xx or the socket dies. Every outcome these
 * tests assert on is a 2xx or 4xx, so a 5xx is infrastructure, never an
 * authorization decision. Replaying the same key is safe by construction
 * (§12.5): the worst case is a 'duplicate' receipt, which `performSetup`
 * treats as a reason to start over rather than assert on.
 */
async function submitOnce(body: unknown, token?: string): Promise<Call> {
  let last: Call | null = null
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(2_000 * attempt)
    try {
      last = await callFunction<Body>('submit-score', body, token)
    } catch (err) {
      last = { status: 599, body: { message: String(err) } }
    }
    if (last.status < 500) return last
  }
  return last as Call
}

/** Readiness probe with retries: the shared stack can stall under load. */
async function waitForStack(attempts = 4): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await stackIsUp()) return true
  }
  return false
}

interface Postgrestish<T> {
  data: T | null
  error: { code?: string; message: string } | null
}

/**
 * Await a read that is expected to succeed, retrying only on PostgreSQL's
 * statement-timeout cancellation (57014). Concurrent suites make the shared
 * local stack cancel the occasional query; treating that as "no rows" would
 * quietly turn a ground-truth assertion into a tautology, so it is retried
 * and any other error is raised loudly.
 */
async function groundTruth<T>(
  label: string,
  run: () => PromiseLike<Postgrestish<T>>,
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await run()
    if (!res.error) return res.data as T
    if (res.error.code !== '57014') {
      throw new Error(`${label}: ${JSON.stringify(res.error)}`)
    }
  }
  throw new Error(`${label}: statement timeout after 4 attempts`)
}

/** Raw scores of one event as seen through a given end-user JWT. */
function scoresVisibleTo(
  eventId: string,
  accessToken: string,
): Promise<{ id: string }[]> {
  return groundTruth('read individual_hole_scores', () =>
    userClient(accessToken)
      .from('individual_hole_scores')
      .select('id')
      .eq('event_id', eventId),
  ).then((rows) => (rows ?? []) as { id: string }[])
}

/** Scores actually stored for an event, read with service credentials. */
function storedScores(
  f: ScoringFixture,
  where: { entryId?: string; holeId?: string } = {},
): Promise<{ id: string }[]> {
  return groundTruth('read stored scores', () => {
    let q = f.service
      .from('individual_hole_scores')
      .select('id')
      .eq('event_id', f.eventId)
    if (where.entryId) q = q.eq('event_entry_id', where.entryId)
    if (where.holeId) q = q.eq('event_hole_id', where.holeId)
    return q
  }).then((rows) => (rows ?? []) as { id: string }[])
}

async function revisionOf(f: ScoringFixture): Promise<number> {
  const row = await groundTruth<{ scoring_revision: number }>('read scoring_revision', () =>
    f.service.from('events').select('scoring_revision').eq('id', f.eventId).single(),
  )
  return row.scoring_revision
}

async function ledgerCount(f: ScoringFixture): Promise<number> {
  const rows = await groundTruth<unknown[]>('read score_mutations', () =>
    f.service.from('score_mutations').select('idempotency_key').eq('event_id', f.eventId),
  )
  return rows.length
}

interface Capture {
  fx: ScoringFixture
  closedFx: ScoringFixture
  stranger: TestAccount
  tempPassword: TestAccount
  /** submit-score results, keyed by scenario, in the order they were issued. */
  calls: Record<string, Call>
  /** events.scoring_revision sampled at named points in that same order. */
  revisions: Record<string, number>
  /** score_mutations row counts for the event, sampled at those same points. */
  ledger: Record<string, number>
  /** The committed score row the direct-table attacks target. */
  targetScoreId: string
}

/**
 * Drive every scenario once, against fixtures created for this attempt only.
 *
 * Every expected outcome here is a 2xx or 4xx. A 5xx means the shared local
 * stack buckled (other suites hammer it concurrently), never an authorization
 * decision — so `performSetup` reports that as transient and the caller
 * retries from brand-new fixtures. Retrying whole fixtures rather than
 * individual calls keeps the revision arithmetic exact: a fresh event always
 * starts at scoring_revision 0.
 */
async function performSetup(): Promise<Capture> {
  const calls: Record<string, Call> = {}
  const revisions: Record<string, number> = {}
  const ledger: Record<string, number> = {}

  const fx = await retry('open fixture', () => buildScoringFixture())
  const closedFx = await retry('locked fixture', () =>
    buildScoringFixture({ leaveClosed: true }),
  )
  const stranger = await retry('stranger account', () =>
    createAccount(fx.service, { displayName: 'Stranger' }),
  )

  const submit = (
    entryIndex: number,
    holeIndex: number,
    token?: string,
  ): Promise<Call> =>
    submitOnce(
      scoreRequest(fx, {
        target: {
          kind: 'individual',
          entryId: fx.entries[entryIndex].entryId,
          holeId: fx.holes[holeIndex].id,
        },
      }),
      token,
    )

  // ── Allowed writers, one per entry/hole so every score is a FIRST write
  //    (baseRevision 0 -> score revision 1) and only the event revision moves.
  calls.director = await submit(1, 0, fx.director.accessToken)
  calls.scorer = await submit(2, 1, fx.scorer.accessToken)
  calls.playerSelf = await submit(0, 2, fx.player.accessToken)

  revisions.afterAllowed = await revisionOf(fx)
  ledger.afterAllowed = await ledgerCount(fx)

  // ── Denied writers. Each aims at an untouched entry/hole so a leak would
  //    leave a visible row rather than silently overwriting something.
  calls.playerOther = await submit(1, 3, fx.player.accessToken)
  calls.outsider = await submit(2, 4, fx.outsider.accessToken)
  calls.noJwt = await submit(3, 6)
  calls.badJwt = await submit(3, 7, forgedJwt())

  // ── must_change_password (FR-AUTH-003). This account is a full event
  //    director, so the password flag is the ONLY possible reason to fail.
  const tempPassword = await retry('temp-password account', () =>
    createAccount(fx.service, {
      mustChangePassword: true,
      displayName: 'Temp Password Director',
    }),
  )
  const membership = await fx.service
    .from('league_memberships')
    .insert({
      league_id: LEAGUE_ID,
      profile_id: tempPassword.profileId,
      member_status: 'active',
    })
    .select('id')
  if (membership.error) throw new Error(membership.error.message)
  const role = await fx.service
    .from('role_assignments')
    .insert({
      league_id: LEAGUE_ID,
      event_id: fx.eventId,
      profile_id: tempPassword.profileId,
      role: 'event_director',
    })
    .select('id')
  if (role.error) throw new Error(role.error.message)

  calls.tempPasswordBlocked = await submit(3, 5, tempPassword.accessToken)

  revisions.afterDenials = await revisionOf(fx)
  ledger.afterDenials = await ledgerCount(fx)

  // Clearing the flag is exactly what complete-activation does. The SAME
  // token and the SAME target now succeed, which is what proves the rejection
  // above was the password gate and not a missing role.
  const cleared = await fx.service
    .from('profiles')
    .update({ must_change_password: false })
    .eq('id', tempPassword.profileId)
    .select('id')
    .single()
  if (cleared.error) throw new Error(cleared.error.message)
  calls.tempPasswordAllowed = await submit(3, 5, tempPassword.accessToken)

  revisions.final = await revisionOf(fx)
  ledger.final = await ledgerCount(fx)

  // ── Locked event: status 'published', so scoring is not open.
  calls.closedEvent = await submitOnce(
    scoreRequest(closedFx),
    closedFx.director.accessToken,
  )
  revisions.closedEvent = await revisionOf(closedFx)

  const broken = Object.entries(calls).find(([, r]) => r.status >= 500)
  if (broken) {
    throw new Error(
      `stack returned ${broken[1].status} for "${broken[0]}" — ${JSON.stringify(broken[1].body)}`,
    )
  }
  // A replayed key that answered 'duplicate' means the first attempt did commit
  // after all. The receipt is still correct, but the *status* would no longer
  // be the one this suite asserts, so start over with clean fixtures instead of
  // relaxing the assertion.
  const replayed = Object.entries(calls).find(([, r]) => r.body.status === 'duplicate')
  if (replayed) {
    throw new Error(`transient replay produced a duplicate receipt for "${replayed[0]}"`)
  }

  // Anchor for the direct-table attacks: the player's own committed score.
  const score = await fx.service
    .from('individual_hole_scores')
    .select('id')
    .eq('event_entry_id', fx.entries[0].entryId)
    .eq('event_hole_id', fx.holes[2].id)
    .single()
  if (score.error) throw new Error(`target score missing: ${score.error.message}`)

  return {
    fx,
    closedFx,
    stranger,
    tempPassword,
    calls,
    revisions,
    ledger,
    targetScoreId: score.data.id as string,
  }
}

describe('RLS and authorization boundary', () => {
  let fx: ScoringFixture
  let closedFx: ScoringFixture
  /** Authenticated, but in no league at all: the "wrong tournament" attacker. */
  let stranger: TestAccount
  let calls: Record<string, Call>
  let revisions: Record<string, number>
  let ledger: Record<string, number>
  let targetScoreId: string

  beforeAll(async () => {
    expect(
      await waitForStack(),
      'local Supabase stack must be running (`npm run backend:start`)',
    ).toBe(true)

    const captured = await retry('authorization scenarios', performSetup, 4)
    fx = captured.fx
    closedFx = captured.closedFx
    stranger = captured.stranger
    calls = captured.calls
    revisions = captured.revisions
    ledger = captured.ledger
    targetScoreId = captured.targetScoreId
  }, 900_000)

  // =========================================================================
  // Write path: submit-score (spec §7.2, §12.4, §25)
  // =========================================================================
  describe('write path via submit-score', () => {
    it('spec 2.2: event director may score any entry in the event', () => {
      expect(calls.director.status, JSON.stringify(calls.director.body)).toBe(200)
      expect(calls.director.body.status).toBe('committed')
      // First write to this hole: the hole's own revision starts at 1 while
      // the event revision counts every committed mutation.
      expect(calls.director.body.scoreRevision).toBe(1)
      expect(calls.director.body.eventRevision).toBe(1)
      expect(calls.director.body.errorCode).toBeNull()
    })

    it('spec 25: assigned marker may score an entry that is not their own', () => {
      expect(calls.scorer.status, JSON.stringify(calls.scorer.body)).toBe(200)
      expect(calls.scorer.body.status).toBe('committed')
      expect(calls.scorer.body.scoreRevision).toBe(1)
      expect(calls.scorer.body.eventRevision).toBe(2)
    })

    it('spec 25: a player may score their OWN entry with no marker grant', () => {
      expect(calls.playerSelf.status, JSON.stringify(calls.playerSelf.body)).toBe(200)
      expect(calls.playerSelf.body.status).toBe('committed')
      expect(calls.playerSelf.body.scoreRevision).toBe(1)
      expect(calls.playerSelf.body.eventRevision).toBe(3)
    })

    it('spec 25: a player scoring ANOTHER entry is rejected NOT_ASSIGNED', async () => {
      expect(calls.playerOther.status, JSON.stringify(calls.playerOther.body)).toBe(403)
      expect(calls.playerOther.body.status).toBe('rejected')
      expect(calls.playerOther.body.errorCode).toBe('NOT_ASSIGNED')

      expect(
        await storedScores(fx, {
          entryId: fx.entries[1].entryId,
          holeId: fx.holes[3].id,
        }),
      ).toHaveLength(0)
    }, 180_000)

    it('spec 2.2: a league member with no role and no permission is rejected NOT_ASSIGNED', async () => {
      expect(calls.outsider.status, JSON.stringify(calls.outsider.body)).toBe(403)
      expect(calls.outsider.body.status).toBe('rejected')
      expect(calls.outsider.body.errorCode).toBe('NOT_ASSIGNED')

      expect(
        await storedScores(fx, {
          entryId: fx.entries[2].entryId,
          holeId: fx.holes[4].id,
        }),
      ).toHaveLength(0)
    }, 180_000)

    it('spec 12.4: a request with no JWT is rejected 401 AUTH_REQUIRED', async () => {
      expect(calls.noJwt.status, JSON.stringify(calls.noJwt.body)).toBe(401)
      expect(calls.noJwt.body.status).toBe('rejected')
      expect(calls.noJwt.body.errorCode).toBe('AUTH_REQUIRED')

      expect(await storedScores(fx, { holeId: fx.holes[6].id })).toHaveLength(0)
    }, 180_000)

    it('spec 12.4: an expired, forged bearer token is rejected 401 and writes nothing', async () => {
      expect(calls.badJwt.status, JSON.stringify(calls.badJwt.body)).toBe(401)
      // The gateway's verify_jwt check fires before the function runs, so this
      // 401 carries the platform's `{code: 'UNAUTHORIZED_*'}` envelope rather
      // than the §12.3 `{status:'rejected', errorCode:'AUTH_REQUIRED'}` one.
      // Both are auth denials; normalize so the assertion still pins a code
      // instead of accepting any 401 body at all.
      const denial =
        (calls.badJwt.body.errorCode as string | undefined) ??
        (calls.badJwt.body.code as string | undefined)
      expect(denial, JSON.stringify(calls.badJwt.body)).toMatch(
        /^(AUTH_REQUIRED|UNAUTHORIZED)/,
      )
      expect(calls.badJwt.body.status).not.toBe('committed')

      expect(await storedScores(fx, { holeId: fx.holes[7].id })).toHaveLength(0)
    }, 180_000)

    it('FR-AUTH-003: must_change_password blocks scoring, not merely login', () => {
      // The caller holds a valid session AND an event_director assignment, so
      // the password flag is the only variable left.
      expect(
        calls.tempPasswordBlocked.status,
        JSON.stringify(calls.tempPasswordBlocked.body),
      ).toBe(401)
      expect(calls.tempPasswordBlocked.body.status).toBe('rejected')
      expect(calls.tempPasswordBlocked.body.errorCode).toBe('AUTH_REQUIRED')
      expect(calls.tempPasswordBlocked.body.detail).toBe('password change required')

      // Same token, same target, flag cleared -> committed. Without this the
      // test above could be passing for the wrong reason.
      expect(
        calls.tempPasswordAllowed.status,
        JSON.stringify(calls.tempPasswordAllowed.body),
      ).toBe(200)
      expect(calls.tempPasswordAllowed.body.status).toBe('committed')
      expect(calls.tempPasswordAllowed.body.scoreRevision).toBe(1)
      expect(calls.tempPasswordAllowed.body.eventRevision).toBe(4)
    })

    it('spec 7.2: a director cannot score an event that is not scoring_open', async () => {
      expect(calls.closedEvent.status, JSON.stringify(calls.closedEvent.body)).toBe(409)
      expect(calls.closedEvent.body.status).toBe('rejected')
      expect(calls.closedEvent.body.errorCode).toBe('EVENT_LOCKED')

      expect(revisions.closedEvent).toBe(0)
      expect(await storedScores(closedFx)).toHaveLength(0)
    }, 180_000)

    it('spec 7.2: denied writes move neither the event revision nor the audit ledger', () => {
      // Five rejected calls happened between these two samples. If any of them
      // had partially applied, the revision or the append-only ledger would
      // have moved — that is the tell for a bypassed authorization check.
      expect(revisions.afterAllowed).toBe(3)
      expect(revisions.afterDenials).toBe(3)
      expect(ledger.afterAllowed).toBe(3)
      expect(ledger.afterDenials).toBe(3)
      // One more committed mutation after the flag was cleared.
      expect(revisions.final).toBe(4)
      expect(ledger.final).toBe(4)
    })
  })

  // =========================================================================
  // Direct table access: PostgREST + RLS + GRANTs (spec §14.3)
  // =========================================================================
  describe('direct table access', () => {
    it('spec 14.3: anon cannot SELECT profiles — usernames are not enumerable', async () => {
      const res = await anonClient().from('profiles').select('id, username')

      expect(res.data ?? []).toHaveLength(0)
      expect(res.error, 'anon must not read the profile directory').not.toBeNull()
      expect(res.error?.code).toBe('42501')

      // Also prove the table is genuinely populated, so the empty result above
      // cannot be an artifact of an empty table.
      const truth = await groundTruth<unknown[]>('read profiles', () =>
        fx.service.from('profiles').select('id').eq('id', fx.director.profileId),
      )
      expect(truth).toHaveLength(1)
    }, 180_000)

    it('spec 14.3: an authenticated stranger sees only their own profile row', async () => {
      const visible = await groundTruth<{ id: string; username: string }[]>(
        'read profiles as stranger',
        () => userClient(stranger.accessToken).from('profiles').select('id, username'),
      )

      // profiles_select_self is the only policy that can match: no league
      // membership means the league-admin policy cannot apply.
      expect(visible).toHaveLength(1)
      expect(visible[0].id).toBe(stranger.profileId)
      const ids = visible.map((r) => r.id)
      expect(ids).not.toContain(fx.director.profileId)
      expect(ids).not.toContain(fx.player.profileId)
    }, 180_000)

    it('spec 14.3: anon INSERT into individual_hole_scores is denied', async () => {
      const forgedId = randomUUID()
      const res = await anonClient()
        .from('individual_hole_scores')
        .insert({
          id: forgedId,
          event_id: fx.eventId,
          round_id: fx.roundId,
          event_entry_id: fx.entries[1].entryId,
          event_hole_id: fx.holes[8].id,
          score_status: 'complete',
          gross_strokes: 2,
          revision: 1,
        })
        .select('id')

      expect(res.error, 'anon must not be able to insert raw scores').not.toBeNull()
      expect(res.error?.code).toBe('42501')

      expect(await storedScores(fx, { holeId: fx.holes[8].id })).toHaveLength(0)
    }, 180_000)

    it('spec 14.3: a non-member authenticated user cannot SELECT this event\'s scores', async () => {
      // PostgREST surfaces this RLS denial as an empty 200, so the assertion
      // pairs it with a positive control.
      expect(await scoresVisibleTo(fx.eventId, stranger.accessToken)).toHaveLength(0)

      // Positive control: the director's OWN JWT sees all four rows, proving
      // the empty result is row-level filtering and not a missing GRANT or an
      // empty table.
      expect(
        await scoresVisibleTo(fx.eventId, fx.director.accessToken),
      ).toHaveLength(4)
    }, 180_000)

    it('spec 14.3: raw score visibility is scoped per role for this event', async () => {
      // Marker on every entry in the round -> all four rows.
      expect(await scoresVisibleTo(fx.eventId, fx.scorer.accessToken)).toHaveLength(4)
      // Entry owner -> only the single row on their own entry.
      expect(await scoresVisibleTo(fx.eventId, fx.player.accessToken)).toHaveLength(1)
      // League member with no role and no permission -> nothing.
      expect(await scoresVisibleTo(fx.eventId, fx.outsider.accessToken)).toHaveLength(0)
    }, 180_000)

    it('spec 7.2: direct authenticated DML on individual_hole_scores is denied', async () => {
      // The single most important boundary in the app: a browser that can
      // UPDATE a score row directly bypasses idempotency, base-revision
      // checking, the conflict ledger, and the projection rebuild entirely.
      const director = userClient(fx.director.accessToken)

      const updated = await director
        .from('individual_hole_scores')
        .update({ gross_strokes: 25, revision: 99 })
        .eq('id', targetScoreId)
        .select('id')
      expect(updated.error, 'direct score UPDATE must be refused').not.toBeNull()
      expect(updated.error?.code).toBe('42501')
      expect(updated.data ?? []).toHaveLength(0)

      const inserted = await director
        .from('individual_hole_scores')
        .insert({
          id: randomUUID(),
          event_id: fx.eventId,
          round_id: fx.roundId,
          event_entry_id: fx.entries[1].entryId,
          event_hole_id: fx.holes[9].id,
          score_status: 'complete',
          gross_strokes: 3,
          revision: 1,
        })
        .select('id')
      expect(inserted.error, 'direct score INSERT must be refused').not.toBeNull()
      expect(inserted.error?.code).toBe('42501')

      const deleted = await director
        .from('individual_hole_scores')
        .delete()
        .eq('id', targetScoreId)
        .select('id')
      expect(deleted.error, 'direct score DELETE must be refused').not.toBeNull()
      expect(deleted.error?.code).toBe('42501')

      // Ground truth: the row is exactly what apply_score_mutation wrote.
      const truth = await groundTruth<{
        gross_strokes: number
        revision: number
        score_status: string
      }>('read target score', () =>
        fx.service
          .from('individual_hole_scores')
          .select('gross_strokes, revision, score_status')
          .eq('id', targetScoreId)
          .single(),
      )
      expect(truth.gross_strokes).toBe(4)
      expect(truth.revision).toBe(1)
      expect(truth.score_status).toBe('complete')

      expect(await storedScores(fx), 'no forged score row may exist').toHaveLength(4)
    }, 180_000)

    it('spec 7.2: direct authenticated UPDATE of events.scoring_revision is denied', async () => {
      // Forging the revision counter would let a client replay stale writes or
      // strand every device on a revision the server never produced.
      const res = await userClient(fx.director.accessToken)
        .from('events')
        .update({ scoring_revision: 999 })
        .eq('id', fx.eventId)
        .select('id')

      expect(res.error, 'the revision counter must be server-owned').not.toBeNull()
      expect(res.error?.code).toBe('42501')
      expect(res.data ?? []).toHaveLength(0)

      expect(await revisionOf(fx)).toBe(4)
    }, 180_000)

    it('spec 11.7: direct authenticated INSERT into score_mutations is denied', async () => {
      // score_mutations is the append-only audit ledger; a forgeable entry
      // destroys the provenance of every score.
      const forgedKey = randomUUID()
      const res = await userClient(fx.director.accessToken)
        .from('score_mutations')
        .insert({
          idempotency_key: forgedKey,
          event_id: fx.eventId,
          round_id: fx.roundId,
          target_kind: 'individual',
          event_entry_id: fx.entries[0].entryId,
          event_hole_id: fx.holes[2].id,
          base_revision: 0,
          new_value: { status: 'complete', grossStrokes: 2, notes: null },
          actor_profile_id: fx.player.profileId,
          result: 'committed',
          event_revision: 99,
        })
        .select('idempotency_key')

      expect(res.error, 'the audit ledger must not accept client writes').not.toBeNull()
      expect(res.error?.code).toBe('42501')

      const forged = await groundTruth<unknown[]>('read forged mutation', () =>
        fx.service
          .from('score_mutations')
          .select('idempotency_key')
          .eq('idempotency_key', forgedKey),
      )
      expect(forged).toHaveLength(0)
      expect(await ledgerCount(fx)).toBe(4)
    }, 180_000)

    it('spec 14.3: projections are service-role only — no client INSERT or UPDATE', async () => {
      const director = userClient(fx.director.accessToken)
      const FORGED_REVISION = 4242

      const projInsert = await director
        .from('competition_projections')
        .insert({
          competition_id: fx.competitions.grossId,
          event_revision: FORGED_REVISION,
          engine_version: 'forged',
          projection_hash: 'forged',
        })
        .select('competition_id')
      expect(projInsert.error).not.toBeNull()
      expect(projInsert.error?.code).toBe('42501')

      const projUpdate = await director
        .from('competition_projections')
        .update({ engine_version: 'forged' })
        .eq('competition_id', fx.competitions.grossId)
        .select('competition_id')
      expect(projUpdate.error).not.toBeNull()
      expect(projUpdate.error?.code).toBe('42501')

      const entity = await groundTruth<{ id: string }>('read competition entity', () =>
        fx.service
          .from('competition_entities')
          .select('id')
          .eq('competition_id', fx.competitions.grossId)
          .limit(1)
          .single(),
      )

      const rowInsert = await director
        .from('leaderboard_rows')
        .insert({
          competition_id: fx.competitions.grossId,
          event_revision: FORGED_REVISION,
          entity_id: entity.id,
          rank: 1,
          display_primary: 'HACKED',
        })
        .select('competition_id')
      expect(rowInsert.error).not.toBeNull()
      expect(rowInsert.error?.code).toBe('42501')

      const rowUpdate = await director
        .from('leaderboard_rows')
        .update({ rank: 1, display_primary: 'HACKED' })
        .eq('competition_id', fx.competitions.grossId)
        .select('competition_id')
      expect(rowUpdate.error).not.toBeNull()
      expect(rowUpdate.error?.code).toBe('42501')

      // anon is denied at the GRANT level too — it never even reaches RLS.
      const anonUpdate = await anonClient()
        .from('leaderboard_rows')
        .update({ display_primary: 'HACKED' })
        .eq('competition_id', fx.competitions.grossId)
        .select('competition_id')
      expect(anonUpdate.error).not.toBeNull()
      expect(anonUpdate.error?.code).toBe('42501')

      // Ground truth: only the publisher's own revisions exist and no row
      // carries the forged marker.
      const projections = await groundTruth<
        { event_revision: number; engine_version: string }[]
      >('read competition_projections', () =>
        fx.service
          .from('competition_projections')
          .select('event_revision, engine_version')
          .eq('competition_id', fx.competitions.grossId),
      )
      expect(projections.some((p) => p.event_revision === FORGED_REVISION)).toBe(false)
      expect(projections.some((p) => p.engine_version === 'forged')).toBe(false)

      const rows = await groundTruth<
        { event_revision: number; display_primary: string | null }[]
      >('read leaderboard_rows', () =>
        fx.service
          .from('leaderboard_rows')
          .select('event_revision, display_primary')
          .eq('competition_id', fx.competitions.grossId),
      )
      expect(rows.some((r) => r.event_revision === FORGED_REVISION)).toBe(false)
      expect(rows.some((r) => r.display_primary === 'HACKED')).toBe(false)
      // The publisher did run: four committed mutations produced revision 4.
      expect(rows.some((r) => r.event_revision === 4)).toBe(true)
    }, 180_000)
  })
})
