/**
 * Golden vector `deferred-idempotency-retry-x5` (spec §20.2, §7.2, §12.5,
 * AC-REL-001): "Same offline idempotency key retried five times produces one
 * mutation."
 *
 * This is the load-bearing guarantee behind the offline outbox. A device that
 * loses its connection mid-flush cannot know whether the server saw the write,
 * so it retries. If each retry created a mutation, the score would be applied
 * five times, `events.scoring_revision` would jump by five, every other device
 * would be told its snapshot is stale four times over, and the audit ledger
 * would claim five edits that never happened. The assertions below therefore
 * pin exact revision numbers and exact row counts scoped to this event — a
 * "did it return 200" test would pass against every one of those failures.
 *
 * Isolation: two fixtures. The revision-independent cases share one event but
 * write disjoint (entry, hole) targets and each reads its own revision baseline
 * from the database, so their arithmetic is exact regardless of what ran
 * before. The concurrency race gets its own event.
 */

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildScoringFixture,
  scoreRequest,
  type ScoringFixture,
} from '../helpers/fixture.ts'
import { callFunction, stackIsUp } from '../helpers/stack.ts'

// This suite shares one local stack with the rest of the integration layer, so
// a hook can sit behind another suite's projection publishes. Generous budgets
// buy patience for a busy stack; they never relax an assertion.
const HOOK_TIMEOUT = 240_000
const TEST_TIMEOUT = 120_000

interface SubmitScoreBody {
  status?: string
  scoreRevision?: number | null
  eventRevision?: number | null
  projectionRevision?: number | null
  errorCode?: string | null
  correlationId?: string
  detail?: string
}

interface MutationRow {
  idempotency_key: string
  result: string
  base_revision: number
  event_revision: number | null
  new_value: { status: string; grossStrokes: number | null; notes: string | null }
  actor_profile_id: string
  event_entry_id: string | null
  event_hole_id: string
}

type Call = { status: number; body: SubmitScoreBody }

/**
 * A request that never reached submit-score: a dropped connection, a Kong 5xx,
 * or an evicted Deno isolate. submit-score stamps a correlationId on every
 * response it produces — including its own 500s — so the absence of one is a
 * reliable "the product never ran" signal. Only these are re-driven, and only
 * by restarting a whole scenario on a virgin target; an application-level
 * failure is always surfaced.
 */
class InfrastructureFailure extends Error {}

async function submit(payload: Record<string, unknown>, accessToken: string): Promise<Call> {
  let res: Call
  try {
    res = await callFunction<SubmitScoreBody>('submit-score', payload, accessToken)
  } catch (err) {
    throw new InfrastructureFailure(`submit-score transport failure — ${String(err)}`)
  }
  if (res.status >= 500 && typeof res.body?.correlationId !== 'string') {
    throw new InfrastructureFailure(
      `submit-score gateway failure ${res.status} — ${JSON.stringify(res.body)}`,
    )
  }
  return res
}

/** Re-drive a whole scenario on a virgin target when the stack, not the product, failed. */
async function withInfrastructureRetry<T>(
  attempts: number,
  run: (attempt: number) => Promise<T>,
): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await run(attempt)
    } catch (err) {
      if (!(err instanceof InfrastructureFailure)) throw err
      last = err
    }
  }
  throw last
}

/** Current authoritative revision of a fixture's event. */
async function readEventRevision(fx: ScoringFixture): Promise<number> {
  const { data, error } = await fx.service
    .from('events')
    .select('scoring_revision')
    .eq('id', fx.eventId)
    .single()
  if (error) throw new Error(`read events.scoring_revision — ${error.message}`)
  return (data as { scoring_revision: number }).scoring_revision
}

const MUTATION_COLUMNS =
  'idempotency_key, result, base_revision, event_revision, new_value, actor_profile_id, event_entry_id, event_hole_id'

/**
 * Ledger rows for one idempotency key, scoped by event_id as well as the key so
 * a suite running against this shared database can never contribute a row here.
 */
async function readMutationsByKey(
  fx: ScoringFixture,
  idempotencyKey: string,
): Promise<MutationRow[]> {
  const { data, error } = await fx.service
    .from('score_mutations')
    .select(MUTATION_COLUMNS)
    .eq('event_id', fx.eventId)
    .eq('idempotency_key', idempotencyKey)
  if (error) throw new Error(`read score_mutations by key — ${error.message}`)
  return (data ?? []) as MutationRow[]
}

/** Ledger rows for one target hole, oldest first. */
async function readMutationsForHole(
  fx: ScoringFixture,
  entryId: string,
  holeId: string,
): Promise<MutationRow[]> {
  const { data, error } = await fx.service
    .from('score_mutations')
    .select(MUTATION_COLUMNS)
    .eq('event_id', fx.eventId)
    .eq('event_entry_id', entryId)
    .eq('event_hole_id', holeId)
    .order('event_revision', { ascending: true })
  if (error) throw new Error(`read score_mutations for hole — ${error.message}`)
  return (data ?? []) as MutationRow[]
}

async function readHoleScore(fx: ScoringFixture, entryId: string, holeId: string) {
  const { data, error } = await fx.service
    .from('individual_hole_scores')
    .select('id, revision, gross_strokes, score_status, entered_by')
    .eq('event_entry_id', entryId)
    .eq('event_hole_id', holeId)
  if (error) throw new Error(`read individual_hole_scores — ${error.message}`)
  return (data ?? []) as {
    id: string
    revision: number
    gross_strokes: number | null
    score_status: string
    entered_by: string | null
  }[]
}

/** Shared event for the cases that measure revisions against their own baseline. */
let shared: ScoringFixture
/** Separate event reserved for the concurrent-flush race. */
let racy: ScoringFixture

beforeAll(async () => {
  // The readiness probe competes with other suites for the same gateway, so a
  // single slow response is not evidence the stack is down.
  let up = false
  for (let attempt = 0; attempt < 6 && !up; attempt++) up = await stackIsUp()
  expect(up, 'local Supabase stack must be running (`npm run backend:start`)').toBe(true)

  // Built one at a time: buildScoringFixture already provisions four auth users
  // in parallel, and GoTrue on this shared stack times out when piled on.
  shared = await withInfrastructureRetry(3, async () => {
    try {
      return await buildScoringFixture()
    } catch (err) {
      throw new InfrastructureFailure(String(err))
    }
  })
  racy = await withInfrastructureRetry(3, async () => {
    try {
      return await buildScoringFixture()
    } catch (err) {
      throw new InfrastructureFailure(String(err))
    }
  })
}, HOOK_TIMEOUT)

describe('golden vector deferred-idempotency-retry-x5 (spec §20.2, AC-REL-001)', () => {
  const GROSS = 5

  let idempotencyKey: string
  let entryId: string
  let holeId: string
  let responses: Call[] = []
  let revisionBefore: number
  let revisionAfter: number

  beforeAll(async () => {
    entryId = shared.entries[0].entryId

    await withInfrastructureRetry(3, async (attempt) => {
      // A re-drive gets a virgin hole and a virgin key so the vector is always
      // measured on an untouched target, never on the debris of a lost attempt.
      holeId = shared.holes[attempt].id
      idempotencyKey = randomUUID()
      revisionBefore = await readEventRevision(shared)

      // One frozen body, reused verbatim: a retried outbox record is
      // byte-for-byte the same request — same key, same clientRecordedAt.
      const payload = scoreRequest(shared, {
        idempotencyKey,
        target: { kind: 'individual', entryId, holeId },
        baseRevision: 0,
        value: { status: 'complete', grossStrokes: GROSS, notes: null },
      })

      const collected: Call[] = []
      for (let delivery = 0; delivery < 5; delivery++) {
        collected.push(await submit(payload, shared.director.accessToken))
      }
      responses = collected
      revisionAfter = await readEventRevision(shared)
    })
  }, HOOK_TIMEOUT)

  it('AC-REL-001: the first delivery commits at score revision 1', () => {
    const first = responses[0]
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(first.body.status).toBe('committed')
    // First write to an untouched hole: base 0 -> score revision 1 (spec §10.4).
    expect(first.body.scoreRevision).toBe(1)
    expect(first.body.eventRevision).toBe(revisionBefore + 1)
    expect(first.body.errorCode).toBeNull()
    expect(typeof first.body.correlationId).toBe('string')
  })

  it('AC-REL-001: retries 2-5 return `duplicate` carrying the ORIGINAL receipt', () => {
    expect(responses).toHaveLength(5)
    const first = responses[0]

    for (const [index, res] of responses.slice(1).entries()) {
      const label = `retry #${index + 2}: ${JSON.stringify(res.body)}`
      expect(res.status, label).toBe(200)
      expect(res.body.status, label).toBe('duplicate')
      // The retry must hand back the receipt the client would have received had
      // the original response not been lost — the same revisions, not new ones.
      // A device reconciling its outbox against a *different* revision would
      // conclude its own cached snapshot is stale (spec §12.5).
      expect(res.body.scoreRevision, label).toBe(first.body.scoreRevision)
      expect(res.body.eventRevision, label).toBe(first.body.eventRevision)
      expect(res.body.errorCode, label).toBeNull()
    }
  })

  it('AC-REL-001: exactly one score_mutations row exists for the retried key', async () => {
    const rows = await readMutationsByKey(shared, idempotencyKey)

    expect(rows).toHaveLength(1)
    expect(rows[0].result).toBe('committed')
    expect(rows[0].base_revision).toBe(0)
    expect(rows[0].event_revision).toBe(revisionBefore + 1)
    expect(rows[0].actor_profile_id).toBe(shared.director.profileId)
    expect(rows[0].new_value).toEqual({
      status: 'complete',
      grossStrokes: GROSS,
      notes: null,
    })

    // Nothing else touched this target either — no shadow conflict rows.
    expect(await readMutationsForHole(shared, entryId, holeId)).toHaveLength(1)
  }, TEST_TIMEOUT)

  it('AC-REL-001: events.scoring_revision advanced by exactly 1 across five calls', () => {
    // The heart of the vector. Five deliveries of one offline mutation must
    // cost one revision, not five: the revision is the cache key every other
    // device polls and every projection is stamped with (spec §7.2, §10.5).
    expect(revisionAfter - revisionBefore).toBe(1)
  })

  it('spec §7.2: one durable individual_hole_scores row at revision 1', async () => {
    const scores = await readHoleScore(shared, entryId, holeId)

    expect(scores).toHaveLength(1)
    // revision 1, not 5: the retries never re-entered the update path.
    expect(scores[0].revision).toBe(1)
    expect(scores[0].gross_strokes).toBe(GROSS)
    expect(scores[0].score_status).toBe('complete')
    expect(scores[0].entered_by).toBe(shared.director.profileId)
  }, TEST_TIMEOUT)
})

describe('idempotency key reuse with a different payload (spec §12.5)', () => {
  let idempotencyKey: string
  let entryId: string
  let holeId: string
  let baseline: number
  let firstResponse: Call
  let reuseResponse: Call
  let revisionAfterFirst: number
  let revisionAfterReuse: number

  beforeAll(async () => {
    entryId = shared.entries[1].entryId

    await withInfrastructureRetry(2, async (attempt) => {
      // Holes 3..4 — disjoint from the vector suite's pool (0..2).
      holeId = shared.holes[3 + attempt].id
      idempotencyKey = randomUUID()
      baseline = await readEventRevision(shared)

      firstResponse = await submit(
        scoreRequest(shared, {
          idempotencyKey,
          target: { kind: 'individual', entryId, holeId },
          baseRevision: 0,
          value: { status: 'complete', grossStrokes: 4, notes: null },
        }),
        shared.director.accessToken,
      )
      revisionAfterFirst = await readEventRevision(shared)

      // Same key, different value. This is not a retry — it is a client bug or
      // a replay attack. Returning the old receipt would tell the device a 6 was
      // stored when a 4 was; the server must refuse instead.
      reuseResponse = await submit(
        scoreRequest(shared, {
          idempotencyKey,
          target: { kind: 'individual', entryId, holeId },
          baseRevision: 0,
          value: { status: 'complete', grossStrokes: 6, notes: null },
        }),
        shared.director.accessToken,
      )
      revisionAfterReuse = await readEventRevision(shared)
    })
  }, HOOK_TIMEOUT)

  it('spec §12.5: the original write commits', () => {
    expect(firstResponse.status, JSON.stringify(firstResponse.body)).toBe(200)
    expect(firstResponse.body.status).toBe('committed')
    expect(firstResponse.body.scoreRevision).toBe(1)
    expect(firstResponse.body.eventRevision).toBe(baseline + 1)
    expect(revisionAfterFirst).toBe(baseline + 1)
  })

  it('spec §12.5: the mismatched replay is rejected with SCORE_INVALID', () => {
    expect(reuseResponse.status, JSON.stringify(reuseResponse.body)).toBe(400)
    expect(reuseResponse.body.status).toBe('rejected')
    expect(reuseResponse.body.errorCode).toBe('SCORE_INVALID')
    expect(typeof reuseResponse.body.correlationId).toBe('string')
  })

  it('spec §12.5: the rejection leaves exactly one mutation row and the stored score untouched', async () => {
    const rows = await readMutationsByKey(shared, idempotencyKey)
    expect(rows).toHaveLength(1)
    expect(rows[0].result).toBe('committed')
    expect(rows[0].new_value.grossStrokes).toBe(4)

    const scores = await readHoleScore(shared, entryId, holeId)
    expect(scores).toHaveLength(1)
    // The rejected 6 must not have leaked into the durable score...
    expect(scores[0].gross_strokes).toBe(4)
    expect(scores[0].revision).toBe(1)
    // ...and a rejection must not burn an event revision.
    expect(revisionAfterReuse).toBe(baseline + 1)
  }, TEST_TIMEOUT)
})

describe('distinct idempotency keys are distinct mutations (spec §7.2, §10.4)', () => {
  let firstKey: string
  let secondKey: string
  let entryId: string
  let holeId: string
  let baseline: number
  let firstResponse: Call
  let secondResponse: Call
  let revisionAfter: number

  beforeAll(async () => {
    entryId = shared.entries[2].entryId

    await withInfrastructureRetry(2, async (attempt) => {
      // Holes 5..6 — disjoint from the two pools above.
      holeId = shared.holes[5 + attempt].id
      firstKey = randomUUID()
      secondKey = randomUUID()
      baseline = await readEventRevision(shared)

      firstResponse = await submit(
        scoreRequest(shared, {
          idempotencyKey: firstKey,
          target: { kind: 'individual', entryId, holeId },
          baseRevision: 0,
          value: { status: 'complete', grossStrokes: 4, notes: null },
        }),
        shared.director.accessToken,
      )

      // A genuine correction: a new key, and the base revision the client
      // learned from the first receipt. Idempotency must not swallow this.
      secondResponse = await submit(
        scoreRequest(shared, {
          idempotencyKey: secondKey,
          target: { kind: 'individual', entryId, holeId },
          baseRevision: 1,
          value: { status: 'complete', grossStrokes: 7, notes: null },
        }),
        shared.director.accessToken,
      )

      revisionAfter = await readEventRevision(shared)
    })
  }, HOOK_TIMEOUT)

  it('spec §10.4: both writes commit, at score revisions 1 then 2', () => {
    expect(firstResponse.status, JSON.stringify(firstResponse.body)).toBe(200)
    expect(firstResponse.body.status).toBe('committed')
    expect(firstResponse.body.scoreRevision).toBe(1)
    expect(firstResponse.body.eventRevision).toBe(baseline + 1)

    expect(secondResponse.status, JSON.stringify(secondResponse.body)).toBe(200)
    expect(secondResponse.body.status).toBe('committed')
    expect(secondResponse.body.scoreRevision).toBe(2)
    expect(secondResponse.body.eventRevision).toBe(baseline + 2)
  })

  it('spec §7.2: two ledger rows and two revision increments', async () => {
    const rows = await readMutationsForHole(shared, entryId, holeId)

    expect(rows).toHaveLength(2)
    expect([...rows.map((r) => r.idempotency_key)].sort()).toEqual(
      [firstKey, secondKey].sort(),
    )
    expect(rows.every((r) => r.result === 'committed')).toBe(true)
    expect(rows.map((r) => r.event_revision)).toEqual([baseline + 1, baseline + 2])
    // Base revisions 0 then 1: each write named the revision it was editing,
    // which is what makes the second a correction rather than a conflict.
    expect(rows.map((r) => r.base_revision)).toEqual([0, 1])
    expect(revisionAfter).toBe(baseline + 2)
  }, TEST_TIMEOUT)

  it('spec §10.4: the durable score holds the correction at revision 2', async () => {
    const scores = await readHoleScore(shared, entryId, holeId)

    expect(scores).toHaveLength(1)
    expect(scores[0].revision).toBe(2)
    expect(scores[0].gross_strokes).toBe(7)
  }, TEST_TIMEOUT)
})

describe('concurrent flush of one idempotency key (spec §12.5, AC-REL-001)', () => {
  const GROSS = 3

  let idempotencyKey: string
  let entryId: string
  let holeId: string
  let responses: Call[] = []
  let baseline: number
  let revisionAfter: number

  beforeAll(async () => {
    entryId = racy.entries[0].entryId

    await withInfrastructureRetry(3, async (attempt) => {
      holeId = racy.holes[attempt].id
      idempotencyKey = randomUUID()
      baseline = await readEventRevision(racy)

      // The real offline-outbox flush shape: a device that regains connectivity
      // fires its queued mutations in parallel, and a retry timer can put the
      // same record back on the wire before the first response lands.
      // Sequential retries only exercise the "already in the ledger" lookup;
      // this exercises the race between five in-flight transactions that all
      // read an empty ledger before any of them commits.
      const payload = scoreRequest(racy, {
        idempotencyKey,
        target: { kind: 'individual', entryId, holeId },
        baseRevision: 0,
        value: { status: 'complete', grossStrokes: GROSS, notes: null },
      })

      responses = await Promise.all(
        Array.from({ length: 5 }, () => submit(payload, racy.director.accessToken)),
      )
      revisionAfter = await readEventRevision(racy)
    })
  }, HOOK_TIMEOUT)

  it('AC-REL-001: every concurrent delivery succeeds and reports the same revisions', () => {
    expect(responses).toHaveLength(5)

    for (const [index, res] of responses.entries()) {
      const label = `concurrent #${index + 1}: ${JSON.stringify(res.body)}`
      expect(res.status, label).toBe(200)
      // 'committed' (the winner, or a same-actor identical replay per §10.4),
      // 'duplicate' (the ledger lookup hit), and 'queued_projection' (the write
      // is durable but projection publishing lost its race) are all acceptable
      // *write* outcomes. A conflict, a rejection, or a 500 is not — in
      // particular a primary-key violation on score_mutations would surface
      // here as a 500 rather than being quietly tolerated.
      expect(['committed', 'duplicate', 'queued_projection'], label).toContain(
        res.body.status,
      )
      expect(res.body.errorCode, label).toBeNull()
      // Every caller must learn the same single durable revision, whichever
      // branch served it — otherwise clients disagree about what is stored.
      expect(res.body.scoreRevision, label).toBe(1)
      expect(res.body.eventRevision, label).toBe(baseline + 1)
    }
  })

  it('AC-REL-001: the concurrent flush writes exactly one score_mutations row', async () => {
    const rows = await readMutationsByKey(racy, idempotencyKey)
    expect(rows).toHaveLength(1)
    expect(rows[0].result).toBe('committed')
    expect(rows[0].actor_profile_id).toBe(racy.director.profileId)

    // A losing transaction must not have recorded anything of its own against
    // this target under some other key.
    expect(await readMutationsForHole(racy, entryId, holeId)).toHaveLength(1)
  }, TEST_TIMEOUT)

  it('AC-REL-001: the concurrent flush costs exactly one revision increment', async () => {
    expect(revisionAfter - baseline).toBe(1)

    const scores = await readHoleScore(racy, entryId, holeId)
    expect(scores).toHaveLength(1)
    expect(scores[0].revision).toBe(1)
    expect(scores[0].gross_strokes).toBe(GROSS)
  }, TEST_TIMEOUT)

  it('spec §10.4: no score_conflicts rows were manufactured by the race', async () => {
    const { data, error } = await racy.service
      .from('score_conflicts')
      .select('id, base_revision, server_revision')
      .eq('event_id', racy.eventId)
      .eq('event_hole_id', holeId)
    if (error) throw new Error(`read score_conflicts — ${error.message}`)

    // Identical values from the same actor are a replay, never a conflict
    // needing director resolution — five parallel copies of one offline record
    // must not land five items in a human's conflict queue.
    expect(data ?? []).toHaveLength(0)
  }, TEST_TIMEOUT)
})
