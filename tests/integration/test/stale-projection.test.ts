/**
 * Golden vector `deferred-stale-projection` (spec §20.2, §7.2):
 * "Stale projection cannot overwrite a newer revision."
 *
 * `public.publish_projections` is the ONLY writer of the derived tables and it
 * is service-role only. These tests drive it directly with the service client
 * (as the projection publisher does), because the guarantee under test —
 * an older computation never lands — lives in the function, not in the Edge
 * Function that calls it.
 *
 * Ordering note: the `it` blocks in `publish_projections` run sequentially and
 * deliberately build on each other's state (revision 1 is published, then
 * republished). vitest.config.ts pins `sequence.concurrent: false`, so this is
 * guaranteed, and every query below is scoped to this fixture's own event and
 * competitions so parallel suites cannot perturb it.
 */

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildScoringFixture, scoreRequest, type ScoringFixture } from '../helpers/fixture.ts'
import { anonClient, callFunction, stackIsUp, userClient } from '../helpers/stack.ts'

/** Shape returned by public.publish_projections (migration 11). */
interface PublishResult {
  status: 'published' | 'stale' | 'rejected'
  error_code?: string
  current_revision?: number
  calculated_revision?: number
  event_revision?: number
  competitions?: number
}

interface CompetitionPayload {
  competitionId: string
  engineVersion: string
  projectionHash: string
  status: string
  warnings: unknown[]
  summary: Record<string, unknown>
  rows: unknown[]
  holeResults: unknown[]
}

/**
 * Retry test SETUP only. Nothing under assertion is retried — this exists so a
 * saturated shared local stack reports as slow rather than as a spec failure.
 * The final error is rethrown verbatim so a genuinely broken harness still
 * surfaces its real message.
 */
async function withRetries<T>(
  what: string,
  attempts: number,
  fn: () => Promise<T>,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      // Back off: the usual cause is a container mid-restart, which needs
      // seconds, not milliseconds.
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)))
    }
  }
  throw new Error(`${what} failed after ${attempts} attempts — ${String(lastError)}`)
}

/**
 * Postgres/PostgREST failures that mean "the shared stack is overloaded", not
 * "the code is wrong": statement timeouts (57014) and dropped or refused
 * connections (class 08). A statement timeout aborts and rolls back its whole
 * transaction, so re-running the call is safe — it cannot leave half a publish
 * behind.
 */
function isTransient(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  const code = error.code ?? ''
  return code === '57014' || code.startsWith('08') ||
    /statement timeout|canceling statement|fetch failed|terminating connection|socket hang up|ECONNRESET/i
      .test(error.message ?? '')
}

interface Postgrestish<T> { data: T | null; error: { code?: string; message: string } | null }

/**
 * Run a service-role query, retrying ONLY transport-level failures. A call that
 * completes and returns an unexpected result is never retried — that result is
 * the thing under test.
 */
async function q<T>(label: string, run: () => PromiseLike<Postgrestish<T>>): Promise<T | null> {
  let lastError: { code?: string; message: string } | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await run()
    if (!error) return data
    lastError = error
    if (!isTransient(error)) break
    await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)))
  }
  throw new Error(`${label} failed — ${lastError?.code ?? '?'} ${lastError?.message}`)
}

describe('publish_projections — deferred-stale-projection (spec §20.2, §7.2)', () => {
  let fx: ScoringFixture
  /** competition_id -> event_entry_id -> competition_entities.id */
  const entityIds = new Map<string, Map<string, string>>()

  /** leaderboard_rows.entity_id has an FK to competition_entities.id. */
  function entityFor(competitionId: string, entryId: string): string {
    const id = entityIds.get(competitionId)?.get(entryId)
    if (!id) throw new Error(`no competition_entities row for ${competitionId}/${entryId}`)
    return id
  }

  /**
   * Minimal well-formed p_result for one competition. `entryCount` controls how
   * many leaderboard rows the payload carries, which is what the delete-then-
   * reinsert republish test measures.
   */
  function competitionPayload(
    competitionId: string,
    opts: { hash: string; entryCount?: number; holeResults?: boolean },
  ): CompetitionPayload {
    const entryCount = opts.entryCount ?? 2
    const rows = fx.entries.slice(0, entryCount).map((entry, i) => ({
      entityId: entityFor(competitionId, entry.entryId),
      rank: i + 1,
      isTied: false,
      thru: 1,
      resultPrimary: 4 + i,
      resultSecondary: null,
      displayPrimary: String(4 + i),
      status: 'provisional',
      detail: {},
    }))
    const holeResults = opts.holeResults
      ? [{
          entityId: entityFor(competitionId, fx.entries[0].entryId),
          eventHoleId: fx.holes[0].id,
          gross: 4,
          strokesReceived: 1,
          net: 3,
          relativeToPar: 0,
          status: 'complete',
          provisional: true,
          detail: {},
        }]
      : []
    return {
      competitionId,
      engineVersion: 'test',
      projectionHash: opts.hash,
      status: 'live',
      warnings: [],
      summary: {},
      rows,
      holeResults,
    }
  }

  async function publish(
    eventId: string,
    revision: number,
    competitions: CompetitionPayload[],
  ): Promise<PublishResult> {
    const data = await q<PublishResult>('publish_projections', () =>
      fx.service.rpc('publish_projections', {
        p_event_id: eventId,
        p_revision: revision,
        p_result: { competitions },
      }))
    return data as PublishResult
  }

  async function countRows(table: string, competitionId: string, revision: number) {
    // `count` rides alongside data/error, so unwrap it into the data slot.
    const count = await q<number>(`count(${table})`, async () => {
      const res = await fx.service
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq('competition_id', competitionId)
        .eq('event_revision', revision)
      return { data: res.count, error: res.error }
    })
    return count ?? -1
  }

  async function eventRevision(): Promise<number> {
    const data = await q<{ scoring_revision: number }>('events.scoring_revision', () =>
      fx.service
        .from('events')
        .select('scoring_revision')
        .eq('id', fx.eventId)
        .single())
    return data?.scoring_revision as number
  }

  /** Read one competition_projections header, retrying transport failures only. */
  async function header(competitionId: string, revision: number, columns: string) {
    return await q<Record<string, unknown>>('competition_projections header', () =>
      fx.service
        .from('competition_projections')
        .select(columns)
        .eq('competition_id', competitionId)
        .eq('event_revision', revision)
        .single())
  }

  beforeAll(async () => {
    // A shared local stack stalls for tens of seconds at a time when sibling
    // suites saturate PostgREST's connection pool, so a single failed probe
    // means "busy", not "down". Poll to a deadline instead; the hook carries an
    // explicit timeout below so this can never hang the run.
    let up = false
    const readyBy = Date.now() + 240_000
    while (!up && Date.now() < readyBy) {
      up = await stackIsUp()
      if (!up) await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    expect(up, 'local Supabase stack must be running (`npm run backend:start`)').toBe(true)

    // Fixture construction touches GoTrue and a dozen tables; under contention
    // from sibling suites it can hit an auth gateway timeout or a Postgres
    // statement timeout. That is infrastructure noise, not a result — retry it.
    // Each attempt builds a brand-new isolated event, so a discarded partial
    // attempt cannot influence anything asserted below.
    fx = await withRetries('buildScoringFixture', 3, () => buildScoringFixture())

    const entities = await q<{ id: string; competition_id: string; event_entry_id: string }[]>(
      'competition_entities lookup',
      () =>
        fx.service
          .from('competition_entities')
          .select('id, competition_id, event_entry_id')
          .in('competition_id', [
            fx.competitions.grossId,
            fx.competitions.netId,
            fx.competitions.skinsId,
          ]),
    )
    for (const row of entities ?? []) {
      const byEntry = entityIds.get(row.competition_id as string) ?? new Map<string, string>()
      byEntry.set(row.event_entry_id as string, row.id as string)
      entityIds.set(row.competition_id as string, byEntry)
    }

    // One committed score moves events.scoring_revision 0 -> 1 through the real
    // write path. Everything below is written against that known revision.
    //
    // The body is built ONCE so a retry replays the same idempotency key: §12.5
    // then guarantees at-most-once, which is exactly why a retry here cannot
    // silently push the revision to 2. A 502/503 from the gateway can also mask
    // a write that DID land, so the event row — not the receipt — is the oracle.
    const seedBody = scoreRequest(fx)
    await withRetries('seed submit-score', 5, async () => {
      const r = await callFunction<Record<string, unknown>>(
        'submit-score',
        seedBody,
        fx.director.accessToken,
      )
      if (r.status === 200) {
        expect(['committed', 'duplicate']).toContain(r.body.status)
        expect(r.body.eventRevision).toBe(1)
        return r
      }
      if ((await eventRevision()) === 1) return r
      throw new Error(`submit-score returned ${r.status}: ${JSON.stringify(r.body)}`)
    })
    expect(await eventRevision()).toBe(1)

    // Establish a KNOWN revision-1 baseline through the publisher's own path.
    // submit-score publishes inline too, but if its gateway hiccuped after the
    // durable write, revision 1 could have no projections at all — and the
    // assertions below are about what a stale publish must not disturb, so that
    // baseline has to be deterministic rather than incidental.
    const baseline = await publish(fx.eventId, 1, [
      competitionPayload(fx.competitions.grossId, { hash: 'baseline', entryCount: 4 }),
      competitionPayload(fx.competitions.netId, { hash: 'baseline', entryCount: 4 }),
    ])
    expect(baseline.status).toBe('published')
    // Generous budget: readiness polling above may wait out a long stack stall.
  }, 420_000)

  it('AC-REL-001 / spec §7.2: a publish calculated at a stale revision is refused and writes nothing', async () => {
    expect(await eventRevision()).toBe(1)

    // A publisher that computed from the revision-0 snapshot and lost the race.
    const result = await publish(fx.eventId, 0, [
      competitionPayload(fx.competitions.grossId, { hash: 'stale-hash', holeResults: true }),
      competitionPayload(fx.competitions.netId, { hash: 'stale-hash' }),
    ])

    expect(result.status).toBe('stale')
    // The function reports both numbers so the caller can retry from the newer
    // snapshot instead of guessing why it was refused.
    expect(result.current_revision).toBe(1)
    expect(result.calculated_revision).toBe(0)

    // The whole point of the vector: the refused computation left no trace.
    expect(await countRows('competition_projections', fx.competitions.grossId, 0)).toBe(0)
    expect(await countRows('competition_projections', fx.competitions.netId, 0)).toBe(0)
    expect(await countRows('leaderboard_rows', fx.competitions.grossId, 0)).toBe(0)
    expect(await countRows('leaderboard_rows', fx.competitions.netId, 0)).toBe(0)
    expect(await countRows('hole_results', fx.competitions.grossId, 0)).toBe(0)

    // ...and did not disturb the newer revision that submit-score published.
    expect(await countRows('competition_projections', fx.competitions.grossId, 1)).toBe(1)

    // A refused publish is not a score mutation; the event revision holds.
    expect(await eventRevision()).toBe(1)
  }, 120_000)

  it('spec §7.2: publishing at the current revision succeeds and reports the competitions it wrote', async () => {
    const result = await publish(fx.eventId, 1, [
      competitionPayload(fx.competitions.grossId, { hash: 'rev1-a', entryCount: 2, holeResults: true }),
      competitionPayload(fx.competitions.netId, { hash: 'rev1-a', entryCount: 3 }),
    ])

    expect(result.status).toBe('published')
    expect(result.event_revision).toBe(1)
    // `competitions` is the count of competition ids the call actually touched.
    expect(result.competitions).toBe(2)

    const head = await header(fx.competitions.grossId, 1, 'engine_version, projection_hash, status')
    expect(head?.projection_hash).toBe('rev1-a')
    expect(head?.engine_version).toBe('test')
    expect(head?.status).toBe('live')

    expect(await countRows('leaderboard_rows', fx.competitions.grossId, 1)).toBe(2)
    expect(await countRows('leaderboard_rows', fx.competitions.netId, 1)).toBe(3)
    expect(await countRows('hole_results', fx.competitions.grossId, 1)).toBe(1)

    const row = await q<Record<string, unknown>>('leaderboard row', () =>
      fx.service
        .from('leaderboard_rows')
        .select('rank, is_tied, thru, result_primary, display_primary, status')
        .eq('competition_id', fx.competitions.grossId)
        .eq('event_revision', 1)
        .eq('entity_id', entityFor(fx.competitions.grossId, fx.entries[0].entryId))
        .single())
    expect(row?.rank).toBe(1)
    expect(row?.is_tied).toBe(false)
    expect(row?.thru).toBe(1)
    expect(Number(row?.result_primary)).toBe(4)
    expect(row?.display_primary).toBe('4')
  }, 120_000)

  it('spec §7.2: republishing the same revision replaces rows rather than duplicating them', async () => {
    // Identical payload twice: the (competition_id, event_revision) header is
    // upserted and the child rows are deleted-then-reinserted, so counts are
    // stable no matter how many times the publisher retries.
    const first = await publish(fx.eventId, 1, [
      competitionPayload(fx.competitions.grossId, { hash: 'rev1-b', entryCount: 2, holeResults: true }),
    ])
    const second = await publish(fx.eventId, 1, [
      competitionPayload(fx.competitions.grossId, { hash: 'rev1-b', entryCount: 2, holeResults: true }),
    ])
    expect(first.status).toBe('published')
    expect(second.status).toBe('published')

    expect(await countRows('competition_projections', fx.competitions.grossId, 1)).toBe(1)
    expect(await countRows('leaderboard_rows', fx.competitions.grossId, 1)).toBe(2)
    expect(await countRows('hole_results', fx.competitions.grossId, 1)).toBe(1)

    // A shrinking payload must not leave orphans behind from the wider one —
    // that is what distinguishes delete+insert from a plain upsert.
    const third = await publish(fx.eventId, 1, [
      competitionPayload(fx.competitions.grossId, { hash: 'rev1-c', entryCount: 1 }),
    ])
    expect(third.status).toBe('published')
    expect(await countRows('leaderboard_rows', fx.competitions.grossId, 1)).toBe(1)
    expect(await countRows('hole_results', fx.competitions.grossId, 1)).toBe(0)

    const head = await header(fx.competitions.grossId, 1, 'projection_hash')
    expect(head?.projection_hash).toBe('rev1-c')

    // Untouched competitions keep the rows they were last published with.
    expect(await countRows('leaderboard_rows', fx.competitions.netId, 1)).toBe(3)
  }, 120_000)

  it('spec §7.2: a publish for an unknown event is rejected with SNAPSHOT_INVALID', async () => {
    const result = await publish(randomUUID(), 1, [
      competitionPayload(fx.competitions.grossId, { hash: 'orphan' }),
    ])

    expect(result.status).toBe('rejected')
    expect(result.error_code).toBe('SNAPSHOT_INVALID')
    // The rejection short-circuits before any competition loop runs.
    expect(await countRows('competition_projections', fx.competitions.grossId, 1)).toBe(1)
  }, 120_000)

  it('spec §12.1 / §14.3: publish_projections is unreachable as an end user (authenticated or anon)', async () => {
    const before = await header(fx.competitions.grossId, 1, 'projection_hash')

    const forgedPayload = {
      p_event_id: fx.eventId,
      p_revision: 1,
      p_result: {
        competitions: [competitionPayload(fx.competitions.grossId, { hash: 'forged-by-browser' })],
      },
    }

    // An event director is the most privileged human in the system and still
    // must not be able to write projections: derived state is server-owned.
    const asDirector = await userClient(fx.director.accessToken)
      .rpc('publish_projections', forgedPayload)
    expect(asDirector.error, 'authenticated must not execute publish_projections').not.toBeNull()
    expect(asDirector.error?.code).toBe('42501')
    expect(asDirector.error?.message).toMatch(/permission denied/i)
    expect(asDirector.data).toBeNull()

    const asAnon = await anonClient().rpc('publish_projections', forgedPayload)
    expect(asAnon.error, 'anon must not execute publish_projections').not.toBeNull()
    expect(asAnon.error?.code).toBe('42501')
    expect(asAnon.error?.message).toMatch(/permission denied/i)
    expect(asAnon.data).toBeNull()

    // Permission was denied before the function body ran: nothing was forged.
    const after = await header(fx.competitions.grossId, 1, 'projection_hash')
    expect(after?.projection_hash).toBe(before?.projection_hash)
    expect(after?.projection_hash).not.toBe('forged-by-browser')
  }, 120_000)

  it('spec §10.5: event_revision_feed gains exactly one row per successful publish', async () => {
    const readFeed = async () =>
      (await q<Array<{
        id: string
        score_revision: number
        projection_revision: number
        changed_competition_ids: string[]
      }>>('event revision feed', () =>
        fx.service
          .from('event_revision_feed')
          .select('id,score_revision,projection_revision,changed_competition_ids')
          .eq('event_id', fx.eventId))) ?? []

    const before = await readFeed()
    const existingIds = new Set(before.map((row) => row.id))

    // Two successful publishes...
    expect((await publish(fx.eventId, 1, [
      competitionPayload(fx.competitions.grossId, { hash: 'feed-1', entryCount: 1 }),
    ])).status).toBe('published')
    expect((await publish(fx.eventId, 1, [
      competitionPayload(fx.competitions.grossId, { hash: 'feed-2', entryCount: 1 }),
      competitionPayload(fx.competitions.skinsId, { hash: 'feed-2', entryCount: 1 }),
    ])).status).toBe('published')

    // ...and two refused ones, which must emit nothing.
    expect((await publish(fx.eventId, 0, [
      competitionPayload(fx.competitions.grossId, { hash: 'feed-stale', entryCount: 1 }),
    ])).status).toBe('stale')
    expect((await publish(randomUUID(), 1, [
      competitionPayload(fx.competitions.grossId, { hash: 'feed-orphan', entryCount: 1 }),
    ])).status).toBe('rejected')

    const added = (await readFeed()).filter((row) => !existingIds.has(row.id))
    expect(added).toHaveLength(2)
    for (const row of added) {
      expect(row.score_revision).toBe(1)
      expect(row.projection_revision).toBe(1)
    }
    // `published_at` uses a transaction timestamp, so it is not a safe
    // insertion-order key when a publisher waited on a lock. Compare the two
    // new receipts by identity and assert both exact announcements instead.
    const announcements = added
      .map((row) => [...row.changed_competition_ids].sort())
      .sort((a, b) => a.join(',').localeCompare(b.join(',')))
    const expected = [
      [fx.competitions.grossId],
      [fx.competitions.grossId, fx.competitions.skinsId].sort(),
    ].sort((a, b) => a.join(',').localeCompare(b.join(',')))
    expect(announcements).toEqual(expected)
  }, 120_000)
})
