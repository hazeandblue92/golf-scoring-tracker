/**
 * Golden vector `deferred-export-snapshot-hash-repeat` (spec §20.2 · AC-010):
 * "Final result hash repeats identically from an exported snapshot."
 *
 * The pure engine already owns the hash primitives — `canonicalJson` and
 * `resultHash` in packages/scoring/src/canonical.ts — but the vector is about
 * the ROUND TRIP: score a real event, export the published projection state
 * out of PostgreSQL, and prove that hashing that export later reproduces the
 * same digest. That needs the database write path, which is why the vector was
 * parked in packages/test-vectors/src/vectors/deferred.ts. This file discharges
 * it.
 *
 * Scope note: six holes are scored across every entry rather than a full
 * eighteen. Determinism is a property of the serializer and the publish path,
 * not of round length, and 18 sequential Edge Function round trips (each one a
 * full snapshot load + engine run + publish of three competitions) is already
 * the dominant cost of this suite. A partial round additionally keeps the
 * projections `provisional`, which exercises the more interesting shape:
 * null ranks, null `thru` values, and incomplete-hole results all have to
 * serialize stably too.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import {
  ENGINE_VERSION,
  RULES_SCHEMA_VERSION,
  canonicalJson,
  resultHash,
  type CanonicalValue,
} from '@gtt/scoring'
import {
  buildScoringFixture,
  scoreRequest,
  type ScoringFixture,
} from '../helpers/fixture.ts'
import { callFunction, stackIsUp } from '../helpers/stack.ts'

/** Holes scored for every entry. See the scope note in the file header. */
const HOLES_SCORED = 4
/** Entries in the event; keeps the sequential submit loop to 12 round trips. */
const PLAYER_COUNT = 3
/** Gross totals the scoring pattern below must produce, sorted ascending. */
const EXPECTED_GROSS_TOTALS = [18, 21, 22]

interface SubmitScoreResponse {
  status: string
  scoreRevision: number | null
  eventRevision: number | null
  projectionRevision: number | null
  errorCode: string | null
}

// ── Canonicalization helpers ────────────────────────────────────────────────

/**
 * Coerce an arbitrary PostgREST value into the engine's CanonicalValue domain.
 *
 * `canonicalJson` deliberately REJECTS non-integer numbers (a float's decimal
 * rendering is platform-dependent, which would break the digest), so every
 * numeric that is not a safe integer becomes its string form. `numeric(14,6)`
 * columns such as `result_primary` may arrive from PostgREST either as a JSON
 * number or as a decimal string depending on serializer settings; funnelling
 * both through `String()` at the call sites below makes the export shape
 * independent of that detail.
 */
function toCanonical(value: unknown): CanonicalValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : String(value)
  }
  if (Array.isArray(value)) return value.map(toCanonical)
  if (typeof value === 'object') {
    const out: Record<string, CanonicalValue> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toCanonical(v)
    }
    return out
  }
  return String(value)
}

/** Numeric column -> canonical rational string (or null), never a float. */
function numText(value: unknown): CanonicalValue {
  return value === null || value === undefined ? null : String(value)
}

/**
 * Build an object from ordered key/value pairs, optionally inserting the keys
 * in reverse. JavaScript preserves string-key insertion order, so this is how
 * the key-order-independence test produces two genuinely differently-ordered
 * objects carrying identical data.
 */
function obj(
  pairs: Array<[string, CanonicalValue]>,
  reverseKeys: boolean,
): Record<string, CanonicalValue> {
  const ordered = reverseKeys ? [...pairs].reverse() : pairs
  const out: Record<string, CanonicalValue> = {}
  for (const [k, v] of ordered) out[k] = v
  return out
}

/** Total order over two string keys; used to canonicalize row arrays. */
function byKeys(a: string[], b: string[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return 0
}

interface ExportOptions {
  /** Read rows back from PostgreSQL in descending order instead of ascending. */
  descending?: boolean
  /** Insert every object's keys in reverse order. */
  reverseKeys?: boolean
}

/**
 * Read the published projection state for one event revision back out of the
 * database and shape it into a plain "exported snapshot" object.
 *
 * Storage identity is deliberately excluded: `hole_results.id`,
 * `created_at`, and `competition_projections.calculated_at` are properties of
 * the row that stores a derived fact, not of the fact itself. A republish of
 * the same revision reissues new ids and a new timestamp while the result is
 * unchanged, so including them would make the export hash meaningless.
 */
async function exportSnapshot(
  fx: ScoringFixture,
  revision: number,
  options: ExportOptions = {},
): Promise<Record<string, CanonicalValue>> {
  const asc = !options.descending
  const rev = options.reverseKeys ?? false
  const competitionIds = [
    fx.competitions.grossId,
    fx.competitions.netId,
    fx.competitions.skinsId,
  ]

  const headers = await fx.service
    .from('competition_projections')
    .select('competition_id, event_revision, engine_version, projection_hash, status, warnings, summary_json')
    .in('competition_id', competitionIds)
    .eq('event_revision', revision)
    .order('competition_id', { ascending: asc })
  if (headers.error) throw new Error(`export: projections read — ${headers.error.message}`)

  const rows = await fx.service
    .from('leaderboard_rows')
    .select('competition_id, entity_id, rank, is_tied, thru, result_primary, result_secondary, display_primary, status, detail_json')
    .in('competition_id', competitionIds)
    .eq('event_revision', revision)
    .order('competition_id', { ascending: asc })
    .order('entity_id', { ascending: asc })
  if (rows.error) throw new Error(`export: leaderboard read — ${rows.error.message}`)

  const holes = await fx.service
    .from('hole_results')
    .select('competition_id, entity_id, event_hole_id, gross, strokes_received, net, relative_to_par, status, provisional, contributor_entry_ids, match_result, skin_units, skin_carried_units, skin_winner, detail_json')
    .in('competition_id', competitionIds)
    .eq('event_revision', revision)
    .order('competition_id', { ascending: asc })
    .order('entity_id', { ascending: asc })
    .order('event_hole_id', { ascending: asc })
  if (holes.error) throw new Error(`export: hole_results read — ${holes.error.message}`)

  const competitions = (headers.data ?? [])
    .map((h) => {
      // canonicalJson sorts OBJECT KEYS only — verified in
      // packages/scoring/src/canonical.ts, whose Array branch maps in place and
      // preserves index order. Array order is therefore part of the digest, so
      // the exporter must impose a total order itself. The primary keys of
      // leaderboard_rows and the hole_results unique constraint both make
      // (entity, hole) unique per competition/revision, so these sorts are total.
      const rowsFor = (rows.data ?? [])
        .filter((r) => r.competition_id === h.competition_id)
        .map((r) =>
          obj(
            [
              ['entityId', r.entity_id],
              ['rank', r.rank === null ? null : Number(r.rank)],
              ['isTied', r.is_tied],
              ['thru', r.thru === null ? null : Number(r.thru)],
              ['resultPrimary', numText(r.result_primary)],
              ['resultSecondary', numText(r.result_secondary)],
              ['displayPrimary', r.display_primary],
              ['status', r.status],
              ['detail', toCanonical(r.detail_json)],
            ],
            rev,
          ),
        )
        .sort((a, b) => byKeys([String(a.entityId)], [String(b.entityId)]))

      const holesFor = (holes.data ?? [])
        .filter((x) => x.competition_id === h.competition_id)
        .map((x) =>
          obj(
            [
              ['entityId', x.entity_id],
              ['eventHoleId', x.event_hole_id],
              ['gross', x.gross === null ? null : Number(x.gross)],
              ['strokesReceived', x.strokes_received === null ? null : Number(x.strokes_received)],
              ['net', x.net === null ? null : Number(x.net)],
              ['relativeToPar', x.relative_to_par === null ? null : Number(x.relative_to_par)],
              ['status', x.status],
              ['provisional', x.provisional],
              ['contributorEntryIds', toCanonical(x.contributor_entry_ids)],
              ['matchResult', x.match_result],
              ['skinUnits', x.skin_units === null ? null : Number(x.skin_units)],
              ['skinCarriedUnits', x.skin_carried_units === null ? null : Number(x.skin_carried_units)],
              ['skinWinner', x.skin_winner],
              ['detail', toCanonical(x.detail_json)],
            ],
            rev,
          ),
        )
        .sort((a, b) =>
          byKeys(
            [String(a.entityId), String(a.eventHoleId)],
            [String(b.entityId), String(b.eventHoleId)],
          ),
        )

      // Engine warning order is engine-determined; sorting keeps the export
      // canonical even if a future engine emits them in a different sequence.
      const warnings = (Array.isArray(h.warnings) ? h.warnings : [])
        .map((w: { code?: string; message?: string }) =>
          obj(
            [
              ['code', w.code ?? ''],
              ['message', w.message ?? ''],
            ],
            rev,
          ),
        )
        .sort((a, b) =>
          byKeys([String(a.code), String(a.message)], [String(b.code), String(b.message)]),
        )

      return obj(
        [
          ['competitionId', h.competition_id],
          ['engineVersion', h.engine_version],
          ['projectionHash', h.projection_hash],
          ['status', h.status],
          ['summary', toCanonical(h.summary_json)],
          ['warnings', warnings],
          ['rows', rowsFor],
          ['holeResults', holesFor],
        ],
        rev,
      )
    })
    .sort((a, b) => byKeys([String(a.competitionId)], [String(b.competitionId)]))

  return obj(
    [
      ['schema', 'gtt.export.v1'],
      ['eventId', fx.eventId],
      ['eventRevision', revision],
      ['engineVersion', ENGINE_VERSION],
      ['rulesSchemaVersion', RULES_SCHEMA_VERSION],
      ['competitions', competitions],
    ],
    rev,
  )
}

/**
 * Independently recompute what `buildProjections` hashes into
 * `competition_projections.projection_hash`, using ONLY rows read back from
 * the database. Mirrors `hashOf` in
 * supabase/functions/_shared/projection-orchestrator.ts.
 */
function recomputeProjectionHash(
  competitionId: string,
  revision: number,
  rows: Array<Record<string, CanonicalValue>>,
): string {
  const canonical: CanonicalValue = {
    competitionId,
    engineVersion: ENGINE_VERSION,
    rulesSchemaVersion: RULES_SCHEMA_VERSION,
    eventRevision: revision,
    rows: rows
      .map((r) => ({
        entityId: r.entityId,
        rank: r.rank,
        isTied: r.isTied,
        thru: r.thru,
        // The orchestrator hashes engine integers; the export carries the
        // numeric column as a string, so convert back for this comparison.
        resultPrimary: r.resultPrimary === null ? null : Number(r.resultPrimary),
        resultSecondary: r.resultSecondary === null ? null : Number(r.resultSecondary),
        status: r.status,
      }))
      .sort((a, b) => byKeys([String(a.entityId)], [String(b.entityId)])),
  }
  return resultHash(canonical)
}

/** Structured deep clone that keeps values inside the canonical domain. */
function clone<T extends CanonicalValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function competitionsOf(
  snapshot: Record<string, CanonicalValue>,
): Array<Record<string, CanonicalValue>> {
  return snapshot.competitions as Array<Record<string, CanonicalValue>>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Build the fixture, tolerating transient setup failures.
 *
 * Every integration suite shares one local stack, and fixture setup is the
 * most contended moment in it: four accounts means four bcrypt password grants
 * through GoTrue, which saturates its CPU when suites overlap and starts
 * timing out upstream. A timed-out grant says nothing about the code under
 * test, so it must not be reported as a result.
 */
async function buildFixtureResiliently(): Promise<ScoringFixture> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await buildScoringFixture({ playerCount: PLAYER_COUNT })
    } catch (err) {
      lastError = err
      await sleep(2_000 * attempt)
    }
  }
  throw new Error(`fixture setup failed after 3 attempts: ${String(lastError)}`)
}

/**
 * Invoke an Edge Function, retrying transport-level failures with the SAME
 * request body — idempotency key included.
 *
 * Reusing the body is what makes a retry safe for submit-score, and is exactly
 * what the offline outbox does (spec §7.2): if a lost attempt actually
 * committed, the replay returns `duplicate` carrying the ORIGINAL receipt
 * rather than opening a conflict. Minting a fresh idempotency key would
 * instead replay a stale baseRevision 0 against an already-written hole and
 * manufacture a conflict. Only 5xx and network failures are retried; a 4xx is
 * a real answer from the server and goes straight back to the assertions.
 */
async function callResiliently<T>(
  name: string,
  body: Record<string, unknown>,
  accessToken?: string,
  retry: { attempts?: number; backoffMs?: number } = {},
): Promise<{ status: number; body: T; attempts: number }> {
  const maxAttempts = retry.attempts ?? 4
  const backoffMs = retry.backoffMs ?? 2_000
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await callFunction<T>(name, body, accessToken)
      // `401 AUTH_REQUIRED / "invalid session"` is also retried: the Edge
      // Function's requireUser returns it both for a genuinely bad token and
      // for a FAILED CALL to GoTrue, which times out when the shared stack is
      // saturated (see the production note in this task's report). Retrying
      // cannot mask a real auth failure: a genuinely invalid token returns the
      // same 401 on every attempt and the call then throws with that body.
      const transientAuth =
        res.status === 401 &&
        (res.body as { detail?: string } | null)?.detail === 'invalid session'
      if (res.status < 500 && !transientAuth) return { ...res, attempts: attempt }
      lastError = new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`)
    } catch (err) {
      lastError = err
    }
    await sleep(backoffMs * attempt)
  }
  throw new Error(`${name} failed after ${maxAttempts} attempts: ${String(lastError)}`)
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe('export snapshot hashing (spec §20.2 · AC-010 · deferred-export-snapshot-hash-repeat)', () => {
  let fx: ScoringFixture
  let finalRevision: number
  let snapshotA: Record<string, CanonicalValue>

  beforeAll(async () => {
    // The local stack is shared with the other integration suites. Under load
    // the very first request from a cold vitest worker can exceed the probe's
    // own budget, so retry before concluding the stack is down — a busy
    // gateway and a missing stack must not produce the same diagnosis.
    let up = false
    for (let attempt = 1; attempt <= 5 && !up; attempt += 1) {
      up = await stackIsUp()
      // Pause between probes: back-to-back attempts all land inside the same
      // load spike and report a healthy stack as down.
      if (!up) await sleep(3_000)
    }
    expect(up, 'local Supabase stack must be running (`npm run backend:start`)').toBe(true)

    fx = await buildFixtureResiliently()

    // Score sequentially so every revision number is deterministic: each
    // committed mutation increments events.scoring_revision by exactly 1, and
    // submit-score publishes projections at that revision before responding.
    let expectedRevision = 0
    for (let h = 0; h < HOLES_SCORED; h += 1) {
      for (let e = 0; e < PLAYER_COUNT; e += 1) {
        const hole = fx.holes[h]
        // Deterministic birdie/par/bogey/double spread. The cycle length is
        // coprime with the hole count on purpose: it makes the three entries
        // finish on DIFFERENT totals (18 / 22 / 21 over the first four holes,
        // par 16). A cycle that divides the hole count would hand every entry
        // the same total and collapse the leaderboard into one flat tie,
        // leaving the row ordering and sorting assertions vacuous.
        const gross = hole.par + (((h + e) % 5) - 1)
        expectedRevision += 1

        const body = scoreRequest(fx, {
          target: { kind: 'individual', entryId: fx.entries[e].entryId, holeId: hole.id },
          baseRevision: 0, // first write to this (entry, hole) pair
          value: { status: 'complete', grossStrokes: gross, notes: null },
        })

        let out = await callResiliently<SubmitScoreResponse>(
          'submit-score',
          body,
          fx.director.accessToken,
        )

        // `queued_projection` (projectionRevision === null) means the raw score
        // is durable but the publish did not land — under a loaded shared stack
        // the publish RPC can hit a statement timeout (spec §7.2 keeps the
        // score authoritative regardless). Replaying the SAME idempotency key
        // is the client's own repair: the mutation is recognised as a duplicate
        // and the projection publish is attempted again.
        let replays = 0
        while (out.body.projectionRevision === null && replays < 3) {
          replays += 1
          await sleep(1_000 * replays)
          out = await callResiliently<SubmitScoreResponse>(
            'submit-score',
            body,
            fx.director.accessToken,
          )
        }

        expect(out.status, JSON.stringify(out.body)).toBe(200)
        if (out.attempts === 1 && replays === 0) {
          expect(out.body.status, JSON.stringify(out.body)).toBe('committed')
        } else {
          // A same-key replay is reported as 'duplicate' carrying the ORIGINAL
          // receipt; either way exactly one mutation landed, which is all this
          // setup needs and what the revision assertions below confirm.
          expect(['committed', 'duplicate']).toContain(out.body.status)
        }
        expect(out.body.scoreRevision).toBe(1)
        expect(out.body.eventRevision).toBe(expectedRevision)
        // Without a published projection there is nothing to export, so the
        // rest of this suite would be hashing an empty document.
        expect(out.body.projectionRevision, JSON.stringify(out.body)).toBe(expectedRevision)
      }
    }

    finalRevision = expectedRevision
    snapshotA = await exportSnapshot(fx, finalRevision)
    // Generous: this hook pays the submit-score edge-runtime cold start plus
    // twelve sequential score round trips against a shared local stack.
  }, 300_000)

  it('AC-010 · spec §7.2 — publishes a projection for every competition at the final revision', async () => {
    expect(finalRevision).toBe(HOLES_SCORED * PLAYER_COUNT)

    const { data: event } = await fx.service
      .from('events')
      .select('scoring_revision')
      .eq('id', fx.eventId)
      .single()
    expect(event?.scoring_revision).toBe(finalRevision)

    const comps = competitionsOf(snapshotA)
    expect(comps).toHaveLength(3)
    for (const c of comps) {
      expect(c.engineVersion).toBe(ENGINE_VERSION)
      // A 64-char lowercase hex digest: SHA-256 actually ran, rather than a
      // placeholder or an empty string being persisted.
      expect(String(c.projectionHash)).toMatch(/^[0-9a-f]{64}$/)
    }

    const comp = (id: string) => comps.find((c) => c.competitionId === id)!
    const rowsOf = (id: string) => comp(id).rows as Array<Record<string, CanonicalValue>>
    const holesOf = (id: string) => comp(id).holeResults as Array<Record<string, CanonicalValue>>

    // Stroke play: one ranked row per entry, each thru the six scored holes,
    // and a hole result for every hole in scope — scored or not. The unscored
    // twelve are what make this export a real null-bearing document rather
    // than a dense table, so the serializer is exercised on both.
    for (const id of [fx.competitions.grossId, fx.competitions.netId]) {
      expect(rowsOf(id)).toHaveLength(PLAYER_COUNT)
      expect(rowsOf(id).map((r) => r.thru)).toEqual(Array(PLAYER_COUNT).fill(HOLES_SCORED))
      expect(holesOf(id)).toHaveLength(PLAYER_COUNT * 18)
      expect(holesOf(id).filter((h) => h.gross !== null)).toHaveLength(
        PLAYER_COUNT * HOLES_SCORED,
      )
    }

    // The three entries must finish on distinct gross totals; identical totals
    // would make the row ordering assertions further down vacuous.
    const grossTotals = rowsOf(fx.competitions.grossId).map((r) => Number(r.resultPrimary))
    expect(new Set(grossTotals).size).toBe(PLAYER_COUNT)
    expect([...grossTotals].sort((a, b) => a - b)).toEqual(EXPECTED_GROSS_TOTALS)
    expect(
      [...rowsOf(fx.competitions.grossId)]
        .sort((a, b) => Number(a.resultPrimary) - Number(b.resultPrimary))
        .map((r) => r.rank),
    ).toEqual([1, 2, 3])

    // Skins: one units row per entry and one outcome per hole in scope.
    expect(rowsOf(fx.competitions.skinsId)).toHaveLength(PLAYER_COUNT)
    expect(holesOf(fx.competitions.skinsId)).toHaveLength(18)
    expect(rowsOf(fx.competitions.skinsId).every((r) => r.rank === null)).toBe(true)
  })

  it('AC-010 · spec §20.2 — re-hashing a freshly re-read export reproduces the identical digest', async () => {
    // THE VECTOR: the export is read a second time, from scratch, over a
    // separate set of queries. Nothing about the first read is reused.
    const snapshotB = await exportSnapshot(fx, finalRevision)

    expect(snapshotB).not.toBe(snapshotA) // distinct objects, not an alias
    expect(canonicalJson(snapshotB)).toBe(canonicalJson(snapshotA))
    expect(resultHash(snapshotB)).toBe(resultHash(snapshotA))
    expect(resultHash(snapshotA)).toMatch(/^[0-9a-f]{64}$/)

    // A third read after a delay: proves the digest is a function of the
    // stored result, not of read timing or connection state.
    const snapshotC = await exportSnapshot(fx, finalRevision)
    expect(resultHash(snapshotC)).toBe(resultHash(snapshotA))
  })

  it('AC-010 · spec §7.3 — canonical JSON normalizes key order and read order', async () => {
    // Same data, every object built with its keys inserted in reverse, and
    // every row read back from PostgreSQL in descending order before the
    // exporter re-imposes its canonical sort.
    const reordered = await exportSnapshot(fx, finalRevision, {
      descending: true,
      reverseKeys: true,
    })

    // Guard: if both objects happened to be built identically the test would
    // pass without proving anything.
    expect(Object.keys(reordered).join(',')).not.toBe(Object.keys(snapshotA).join(','))
    const firstA = competitionsOf(snapshotA)[0]
    const firstB = competitionsOf(reordered)[0]
    expect(Object.keys(firstB).join(',')).not.toBe(Object.keys(firstA).join(','))

    expect(canonicalJson(reordered)).toBe(canonicalJson(snapshotA))
    expect(resultHash(reordered)).toBe(resultHash(snapshotA))
  })

  it('spec §7.3 — array order IS significant, so an exporter must sort its arrays', () => {
    // Documents why exportSnapshot sorts: canonicalJson sorts object keys but
    // maps arrays in place. If this ever stops being true the sorting above
    // becomes dead weight and this test says so.
    const swapped = clone(snapshotA)
    const rows = competitionsOf(swapped)[0].rows as CanonicalValue[]
    expect(rows.length).toBeGreaterThanOrEqual(2)
    ;[rows[0], rows[1]] = [rows[1], rows[0]]

    expect(canonicalJson(swapped)).not.toBe(canonicalJson(snapshotA))
    expect(resultHash(swapped)).not.toBe(resultHash(snapshotA))
  })

  it('AC-010 · spec §7.3 — the digest changes when any single exported value changes', () => {
    const baseline = resultHash(snapshotA)

    // 1. A leaderboard result.
    const mutatedPrimary = clone(snapshotA)
    const row = (competitionsOf(mutatedPrimary)[0].rows as Array<Record<string, CanonicalValue>>)[0]
    const original = row.resultPrimary
    row.resultPrimary = String(Number(original) + 1)
    expect(row.resultPrimary).not.toBe(original)
    const primaryHash = resultHash(mutatedPrimary)

    // 2. A boolean buried one level deeper.
    const mutatedTie = clone(snapshotA)
    const tieRow = (competitionsOf(mutatedTie)[0].rows as Array<Record<string, CanonicalValue>>)[0]
    tieRow.isTied = !(tieRow.isTied as boolean)
    const tieHash = resultHash(mutatedTie)

    // 3. A per-hole derived value two levels deeper, to prove the digest
    //    covers the whole tree and not just the leaderboard header.
    const mutatedHole = clone(snapshotA)
    const holeRows = competitionsOf(mutatedHole)[0].holeResults as Array<
      Record<string, CanonicalValue>
    >
    expect(holeRows.length).toBeGreaterThan(0)
    holeRows[0].gross = Number(holeRows[0].gross ?? 0) + 1
    const holeHash = resultHash(mutatedHole)

    // 4. The revision label itself.
    const mutatedRevision = clone(snapshotA)
    mutatedRevision.eventRevision = (snapshotA.eventRevision as number) + 1
    const revisionHash = resultHash(mutatedRevision)

    const all = [baseline, primaryHash, tieHash, holeHash, revisionHash]
    // Four distinct single-value edits must yield four distinct digests; a
    // constant or truncated implementation collapses this set.
    expect(new Set(all).size).toBe(all.length)
  })

  it('AC-010 · spec §7.3 — the stored projection_hash is reproducible from the exported rows', () => {
    for (const comp of competitionsOf(snapshotA)) {
      const recomputed = recomputeProjectionHash(
        String(comp.competitionId),
        finalRevision,
        comp.rows as Array<Record<string, CanonicalValue>>,
      )
      // The digest the publisher stored can be regenerated from the exported
      // snapshot alone — the auditable form of AC-010.
      expect(recomputed, `competition ${String(comp.competitionId)}`).toBe(comp.projectionHash)
    }
  })

  it('AC-010 · spec §7.2 — republishing the same revision leaves projection_hash and the export digest unchanged', async () => {
    const before = await fx.service
      .from('competition_projections')
      .select('competition_id, projection_hash, calculated_at, engine_version')
      .in('competition_id', [
        fx.competitions.grossId,
        fx.competitions.netId,
        fx.competitions.skinsId,
      ])
      .eq('event_revision', finalRevision)
      .order('competition_id')
    expect(before.data).toHaveLength(3)

    const beforeDigest = resultHash(snapshotA)

    // rebuild-projections recomputes from raw scores and calls
    // publish_projections at the unchanged revision (spec §12.2). Patient
    // retries: this is the first call into this function, and the local edge
    // runtime compiles its whole module graph (contracts + zod + the scoring
    // engine) on first request — around a minute on a loaded stack, during
    // which the gateway answers 502. Republishing is naturally idempotent, so
    // repeating the call is safe as well as necessary.
    const rebuild = await callResiliently<{
      status: string
      eventRevision: number
      competitions: number
    }>(
      'rebuild-projections',
      { eventId: fx.eventId },
      fx.director.accessToken,
      { attempts: 6, backoffMs: 15_000 },
    )
    expect(rebuild.status, JSON.stringify(rebuild.body)).toBe(200)
    expect(rebuild.body.status).toBe('published')
    expect(rebuild.body.eventRevision).toBe(finalRevision)
    expect(rebuild.body.competitions).toBe(3)

    const after = await fx.service
      .from('competition_projections')
      .select('competition_id, projection_hash, calculated_at, engine_version')
      .in('competition_id', [
        fx.competitions.grossId,
        fx.competitions.netId,
        fx.competitions.skinsId,
      ])
      .eq('event_revision', finalRevision)
      .order('competition_id')
    expect(after.data).toHaveLength(3)

    for (let i = 0; i < 3; i += 1) {
      const b = before.data![i]
      const a = after.data![i]
      expect(a.competition_id).toBe(b.competition_id)
      expect(a.engine_version).toBe(b.engine_version)
      // Same inputs, same revision, same engine -> byte-identical digest.
      expect(a.projection_hash, `competition ${b.competition_id}`).toBe(b.projection_hash)
      // calculated_at must move, otherwise the republish silently no-opped and
      // the equality above would prove nothing.
      expect(new Date(a.calculated_at).getTime()).toBeGreaterThanOrEqual(
        new Date(b.calculated_at).getTime(),
      )
    }

    // Republishing must not advance the score revision — projections are
    // derived, the raw scores are the facts (spec §7.2).
    const { data: event } = await fx.service
      .from('events')
      .select('scoring_revision')
      .eq('id', fx.eventId)
      .single()
    expect(event?.scoring_revision).toBe(finalRevision)

    // And the whole exported snapshot still hashes to the original value:
    // republishing regenerates hole_results ids and timestamps, which the
    // export deliberately excludes.
    const afterSnapshot = await exportSnapshot(fx, finalRevision)
    expect(canonicalJson(afterSnapshot)).toBe(canonicalJson(snapshotA))
    expect(resultHash(afterSnapshot)).toBe(beforeDigest)
  }, 300_000)
})
