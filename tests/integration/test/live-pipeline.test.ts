/**
 * End-to-end live scoring pipeline (spec §7.2, §12.3).
 *
 * One submitted score has to travel the whole chain — apply_score_mutation →
 * consistent snapshot → shared scoring engine → publish_projections →
 * competition_projections / leaderboard_rows / hole_results /
 * event_revision_feed — before a phone can render a leaderboard. Other suites
 * prove one link each; this file proves the chain.
 *
 * The failure mode it exists to catch is silent. submit-score keeps the raw
 * score durable when publishing fails, downgrading its receipt to
 * `queued_projection` and moving on. A snapshot read that throws — a column the
 * snapshot selects but the schema lacks, exactly the event_teams.playing_handicap
 * regression migration 14 repaired — therefore produces a green write path and
 * a leaderboard frozen at revision 0. Nothing short of asserting the published
 * rows detects it.
 *
 * One fixture, one 18-hole round, scored once in beforeAll: the early
 * revisions carry the single-score assertions and the final revision carries
 * the full-round ones.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildScoringFixture,
  scoreRequest,
  type ScoringFixture,
} from '../helpers/fixture.ts'
import { callFunction, stackIsUp } from '../helpers/stack.ts'

interface SubmitScoreBody {
  status: string
  scoreRevision: number | null
  eventRevision: number | null
  projectionRevision: number | null
  errorCode: string | null
  correlationId: string
  /** Present only when the projection publish did not land. */
  projectionStatus?: string
  detail?: string
}

interface Submission {
  body: SubmitScoreBody
  /** 1 when the first attempt published; >1 after transport/projection repair. */
  attempts: number
}

const HOLE_COUNT = 18
const PAR_TOTAL = 72
const ENTRY_COUNT = 4
const FINAL_REVISION = HOLE_COUNT * ENTRY_COUNT

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Spec §9.5 stroke allocation, restated here on purpose.
 *
 * Importing the engine's own allocator would make this test agree with the
 * implementation by construction; an end-to-end test has to pin the published
 * numbers to the SPEC. For N holes and Playing Handicap H > 0:
 * base = floor(H / N), remainder = H mod N, and the `remainder` lowest stroke
 * indexes take one extra stroke.
 */
function strokesReceived(
  playingHandicap: number,
  holeCount: number,
  strokeIndex: number,
): number {
  if (playingHandicap === 0) return 0
  if (playingHandicap < 0) throw new RangeError('this fixture uses receiving handicaps only')
  const base = Math.floor(playingHandicap / holeCount)
  const remainder = playingHandicap % holeCount
  return base + (strokeIndex <= remainder ? 1 : 0)
}

/**
 * Strokes over par each entry posts, by hole ordinal. Chosen so the four gross
 * totals are distinct AND the net order is a different permutation — the only
 * arrangement where a "net silently ignores handicaps" bug cannot hide behind
 * coincidentally identical rankings. Fixture handicaps are 4 / 12 / 18 / 25.
 */
const OVER_PAR: ReadonlyArray<(ordinal: number) => number> = [
  (o) => (o <= 4 ? 1 : 0), //  +4  → gross 76, net 72
  (o) => (o <= 8 ? 1 : 0), //  +8  → gross 80, net 68
  (o) => (o <= 16 ? 1 : 0), // +16 → gross 88, net 70
  (o) => (o <= 6 ? 2 : 1), //  +24 → gross 96, net 71
]

const EXPECTED_GROSS = [76, 80, 88, 96]
const EXPECTED_NET = [72, 68, 70, 71]
/** Gross order is 0,1,2,3; net order is 1,2,3,0 — a genuinely different board. */
const EXPECTED_GROSS_RANK = [1, 2, 3, 4]
const EXPECTED_NET_RANK = [4, 1, 2, 3]

/** The local stack is shared; a single probe can lose to a slow neighbour. */
async function waitForStack(attempts = 4): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await stackIsUp()) return true
    await sleep(2_000)
  }
  return false
}

/**
 * Build the fixture, tolerating a saturated shared stack.
 *
 * Every integration suite writes to one local database, so a fixture insert can
 * lose to a neighbour's load and come back as a gateway timeout. That says
 * nothing about the code under test; each attempt builds a brand-new isolated
 * event, so a retry is clean.
 */
async function buildFixture(attempts = 5): Promise<ScoringFixture> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await buildScoringFixture({ playerCount: ENTRY_COUNT })
    } catch (err) {
      lastError = err
      if (attempt < attempts) await sleep(10_000 * attempt)
    }
  }
  throw lastError
}

/** competition_entities.id is what projections key on, not the entry id. */
async function entityIdsByEntryIndex(
  fx: ScoringFixture,
  competitionId: string,
): Promise<string[]> {
  const { data, error } = await fx.service
    .from('competition_entities')
    .select('id, event_entry_id')
    .eq('competition_id', competitionId)
  if (error) throw new Error(`competition_entities read failed: ${error.message}`)
  const byEntry = new Map<string, string>(
    (data ?? []).map((row) => [row.event_entry_id as string, row.id as string]),
  )
  return fx.entries.map((entry) => {
    const entityId = byEntry.get(entry.entryId)
    if (!entityId) throw new Error(`no competition entity for entry ${entry.entryId}`)
    return entityId
  })
}

/**
 * Infrastructure failures that say nothing about the write path and must be
 * replayed rather than asserted on.
 *
 * The local stack is shared by every integration suite. Its Edge Runtime serves
 * all functions from one isolate under the `per_worker` policy and cancels
 * in-flight requests when that isolate exhausts its CPU budget (5xx from the
 * gateway). Separately, submit-score verifies the caller by calling GoTrue, and
 * `requireUser` reports ANY failure of that call — including the auth service
 * timing out under load — as 401 AUTH_REQUIRED / 'invalid session', which is
 * indistinguishable at the wire from a genuinely bad token.
 *
 * Every other 4xx is a real contract answer (NOT_ASSIGNED, EVENT_LOCKED,
 * SCORE_INVALID, and AUTH_REQUIRED for a password change) and is never retried
 * away. Sessions here are minted seconds earlier against jwt_expiry = 3600, so
 * a genuine expiry is impossible inside one run.
 */
function isInfrastructureFailure(status: number, body: SubmitScoreBody): boolean {
  if (status >= 500) return true
  return (
    status === 401 &&
    body?.errorCode === 'AUTH_REQUIRED' &&
    body?.detail === 'invalid session'
  )
}

/**
 * Post one hole score, replaying the SAME idempotency key after an
 * infrastructure failure exactly as a device outbox does (spec §12.5).
 *
 * Replaying the key is the contract-defined recovery: if the first attempt
 * durably committed, the replay returns the original receipt as 'duplicate';
 * if it never landed, the replay commits normally.
 */
async function submitScore(
  fx: ScoringFixture,
  entryIndex: number,
  holeIndex: number,
  grossStrokes: number,
): Promise<Submission> {
  const hole = fx.holes[holeIndex]
  const request = scoreRequest(fx, {
    target: {
      kind: 'individual',
      entryId: fx.entries[entryIndex].entryId,
      holeId: hole.id,
    },
    // Each (entry, hole) pair owns its own score row, so the first write to any
    // hole always bases on revision 0 (spec §10.4).
    baseRevision: 0,
    value: { status: 'complete', grossStrokes, notes: null },
  })

  const MAX_ATTEMPTS = 8
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let status: number
    let body: SubmitScoreBody
    try {
      const res = await callFunction<SubmitScoreBody>(
        'submit-score',
        request,
        fx.director.accessToken,
      )
      status = res.status
      body = res.body
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err
      await sleep(3_000 * attempt)
      continue
    }
    if (status === 200) {
      if (body.projectionRevision !== null || attempt === MAX_ATTEMPTS) {
        return { body, attempts: attempt }
      }
      // The mutation is durable but its projection did not land. Replaying the
      // SAME idempotency key returns the original receipt and retries only the
      // replaceable projection pipeline (§7.2, §12.3, AC-REL-003).
      await sleep(1_000 * attempt)
      continue
    }
    if (!isInfrastructureFailure(status, body) || attempt === MAX_ATTEMPTS) {
      throw new Error(
        `submit-score entry ${entryIndex} hole ${hole.ordinal} → HTTP ${status}: ` +
          JSON.stringify(body),
      )
    }
    await sleep(3_000 * attempt)
  }
  throw new Error('unreachable')
}

describe('live scoring pipeline · score → engine → leaderboard (spec §7.2, §12.3)', () => {
  let fx: ScoringFixture
  let submissions: Submission[]
  let grossEntities: string[]
  let netEntities: string[]
  let skinsEntities: string[]

  beforeAll(async () => {
    expect(
      await waitForStack(),
      'local Supabase stack must be running (`npm run backend:start`)',
    ).toBe(true)

    fx = await buildFixture()
    // The expected net totals below are only meaningful against these exact
    // frozen handicaps, so the fixture's contract is asserted before it is used.
    expect(fx.entries.map((e) => e.playingHandicap)).toEqual([4, 12, 18, 25])
    expect(fx.holes).toHaveLength(HOLE_COUNT)
    expect(fx.holes.reduce((sum, h) => sum + h.par, 0)).toBe(PAR_TOTAL)

    // Hole-major order: mutation (ordinal - 1) * 4 + entryIndex + 1, so the
    // revision each assertion pins is arithmetic, not observation.
    const holesByOrdinal = [...fx.holes].sort((a, b) => a.ordinal - b.ordinal)
    submissions = []
    for (const hole of holesByOrdinal) {
      const holeIndex = fx.holes.findIndex((h) => h.id === hole.id)
      for (let entryIndex = 0; entryIndex < fx.entries.length; entryIndex++) {
        const gross = hole.par + OVER_PAR[entryIndex](hole.ordinal)
        submissions.push(await submitScore(fx, entryIndex, holeIndex, gross))
      }
    }

    ;[grossEntities, netEntities, skinsEntities] = await Promise.all([
      entityIdsByEntryIndex(fx, fx.competitions.grossId),
      entityIdsByEntryIndex(fx, fx.competitions.netId),
      entityIdsByEntryIndex(fx, fx.competitions.skinsId),
    ])
  }, 1_200_000)

  // ── The single score: did the projection pipeline actually run? ───────────

  it('spec §12.3 · the first score commits with projectionRevision === eventRevision', () => {
    const first = submissions[0].body

    // `queued_projection` means the raw score is durable but the projection
    // pipeline silently failed — the snapshot read threw, the engine threw, or
    // the publish never stopped being stale. That degradation is invisible to
    // the writer and is exactly the regression this file guards, so the status
    // is asserted explicitly rather than through a "not rejected" check.
    expect(first.status, JSON.stringify(first)).toBe('committed')
    expect(first.status).not.toBe('queued_projection')
    expect(first).not.toHaveProperty('projectionStatus')
    expect(first.errorCode).toBeNull()

    expect(first.scoreRevision).toBe(1)
    expect(first.eventRevision).toBe(1)
    expect(first.projectionRevision).toBe(1)
    expect(first.projectionRevision).toBe(first.eventRevision)
  })

  it('spec §7.2 · that one score publishes a projection for all three competitions', async () => {
    const { data, error } = await fx.service
      .from('competition_projections')
      .select('competition_id, event_revision, status, warnings, engine_version')
      .in('competition_id', [
        fx.competitions.grossId,
        fx.competitions.netId,
        fx.competitions.skinsId,
      ])
      .eq('event_revision', 1)
    expect(error?.message ?? null).toBeNull()

    const rows = data ?? []
    expect(rows).toHaveLength(3)
    expect([...rows.map((r) => r.competition_id as string)].sort()).toEqual(
      [fx.competitions.grossId, fx.competitions.netId, fx.competitions.skinsId].sort(),
    )
    for (const row of rows) {
      // status 'error' is how the orchestrator reports RULES_INVALID or a thrown
      // engine call: the row still exists but carries no leaderboard, so row
      // presence on its own would be a worthless assertion.
      expect(row.status, `competition ${row.competition_id}`).toBe('live')
      expect(row.warnings, `competition ${row.competition_id}`).toEqual([])
      expect(row.engine_version).toBeTruthy()
    }
  })

  it('spec §7.3 · gross leaderboard at revision 1 shows thru 1 and leaves empty cards unranked', async () => {
    const { data } = await fx.service
      .from('leaderboard_rows')
      .select('entity_id, rank, is_tied, thru, result_primary, status')
      .eq('competition_id', fx.competitions.grossId)
      .eq('event_revision', 1)

    const rows = data ?? []
    expect(rows).toHaveLength(ENTRY_COUNT)

    const scored = rows.find((r) => r.entity_id === grossEntities[0])
    expect(scored, 'the scored entry must have a leaderboard row').toBeDefined()
    // Hole 1 is a par 4 played in 5 by entry 0.
    expect(Number(scored!.result_primary)).toBe(5)
    expect(scored!.thru).toBe(1)
    expect(scored!.rank).toBe(1)
    expect(scored!.status).toBe('provisional')

    // A card with no scores has no computable total, so §7.3 keeps it visible
    // but unranked rather than ranking it last on a coerced zero.
    for (const entityId of grossEntities.slice(1)) {
      const row = rows.find((r) => r.entity_id === entityId)
      expect(row, `entity ${entityId} must still appear`).toBeDefined()
      expect(row!.thru).toBe(0)
      expect(row!.rank).toBeNull()
      expect(row!.result_primary).toBeNull()
    }
  })

  it('spec §7.3 · thru counts completed holes as the round progresses', async () => {
    // Mutation 5 is entry 0's second hole under hole-major ordering.
    const second = submissions[4].body
    expect(second.eventRevision).toBe(5)
    expect(second.projectionRevision).toBe(5)

    const { data } = await fx.service
      .from('leaderboard_rows')
      .select('thru, result_primary')
      .eq('competition_id', fx.competitions.grossId)
      .eq('event_revision', 5)
      .eq('entity_id', grossEntities[0])
      .single()

    expect(data?.thru).toBe(2)
    // Hole 1 (par 4) in 5, hole 2 (par 5) in 6.
    expect(Number(data?.result_primary)).toBe(11)
  })

  // ── The full round ────────────────────────────────────────────────────────

  it('spec §10.4 · all 72 holes commit, each advancing the event revision by exactly one', async () => {
    expect(submissions).toHaveLength(FINAL_REVISION)

    submissions.forEach(({ body: res, attempts }, i) => {
      // A first-attempt write must be a fresh commit; only a replayed request
      // (transport failure, same idempotency key) may answer 'duplicate'.
      const allowed = attempts === 1 ? ['committed'] : ['committed', 'duplicate']
      expect(allowed, `mutation ${i + 1}: ${JSON.stringify(res)}`).toContain(res.status)
      // First write to each hole's own score row.
      expect(res.scoreRevision, `mutation ${i + 1}`).toBe(1)
      expect(res.eventRevision, `mutation ${i + 1}`).toBe(i + 1)
      // Republished on every single write: a projection that fell behind even
      // once shows up here as a lower — or null — projectionRevision.
      expect(res.projectionRevision, `mutation ${i + 1}`).toBe(i + 1)
    })

    const { data: event } = await fx.service
      .from('events')
      .select('scoring_revision')
      .eq('id', fx.eventId)
      .single()
    expect(Number(event?.scoring_revision)).toBe(FINAL_REVISION)

    const { count } = await fx.service
      .from('score_mutations')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', fx.eventId)
      .eq('result', 'committed')
    expect(count).toBe(FINAL_REVISION)
  })

  it('spec §8.1 · final gross leaderboard ranks every entry exactly once, lowest total first', async () => {
    // Cross-check the scoring plan's arithmetic so a typo in OVER_PAR fails
    // here rather than quietly weakening the rank assertions below.
    fx.entries.forEach((_, i) => {
      const total = fx.holes.reduce((sum, h) => sum + h.par + OVER_PAR[i](h.ordinal), 0)
      expect(total, `entry ${i} planned gross`).toBe(EXPECTED_GROSS[i])
    })

    const { data } = await fx.service
      .from('leaderboard_rows')
      .select(
        'entity_id, rank, is_tied, thru, result_primary, result_secondary, display_primary, status, detail_json',
      )
      .eq('competition_id', fx.competitions.grossId)
      .eq('event_revision', FINAL_REVISION)

    const rows = data ?? []
    expect(rows).toHaveLength(ENTRY_COUNT)
    // Exactly once each: a duplicated or dropped entity is a projection bug the
    // UI renders as a phantom player or a missing one.
    expect(new Set(rows.map((r) => r.entity_id as string)).size).toBe(ENTRY_COUNT)

    fx.entries.forEach((entry, i) => {
      const row = rows.find((r) => r.entity_id === grossEntities[i])
      expect(row, `entry ${i} (${entry.displayName}) must appear`).toBeDefined()
      expect(Number(row!.result_primary), `entry ${i} gross total`).toBe(EXPECTED_GROSS[i])
      expect(row!.rank, `entry ${i} gross rank`).toBe(EXPECTED_GROSS_RANK[i])
      expect(row!.is_tied).toBe(false)
      expect(row!.thru).toBe(HOLE_COUNT)
      expect(row!.status).toBe('complete')
      expect(row!.display_primary).toBe(`+${EXPECTED_GROSS[i] - PAR_TOTAL}`)
      // The gross board still carries the net total for display; if handicaps
      // never reached the engine this secondary value collapses onto gross.
      expect(Number(row!.result_secondary), `entry ${i} net on the gross row`).toBe(
        EXPECTED_NET[i],
      )
      expect(row!.detail_json).toEqual({
        grossTotal: EXPECTED_GROSS[i],
        netTotal: EXPECTED_NET[i],
      })
    })

    const ordered = [...rows].sort((a, b) => (a.rank as number) - (b.rank as number))
    expect(ordered.map((r) => Number(r.result_primary))).toEqual(
      [...EXPECTED_GROSS].sort((a, b) => a - b),
    )
    expect(ordered[0].rank).toBe(1)
    expect(Number(ordered[0].result_primary)).toBe(Math.min(...EXPECTED_GROSS))
    expect(ordered[0].entity_id).toBe(grossEntities[0])
  })

  it('spec §8.2 · net leaderboard subtracts allocated strokes and reorders the field', async () => {
    const { data } = await fx.service
      .from('leaderboard_rows')
      .select('entity_id, rank, thru, result_primary, result_secondary, display_primary, status')
      .eq('competition_id', fx.competitions.netId)
      .eq('event_revision', FINAL_REVISION)

    const rows = data ?? []
    expect(rows).toHaveLength(ENTRY_COUNT)

    fx.entries.forEach((entry, i) => {
      const row = rows.find((r) => r.entity_id === netEntities[i])
      expect(row, `entry ${i} must appear on the net board`).toBeDefined()
      // Over a full round the allocated strokes sum to exactly the Playing
      // Handicap (§9.5), so the net total is gross minus the frozen handicap.
      expect(Number(row!.result_primary), `entry ${i} net total`).toBe(
        EXPECTED_GROSS[i] - entry.playingHandicap,
      )
      expect(Number(row!.result_primary)).toBe(EXPECTED_NET[i])
      expect(Number(row!.result_secondary), `entry ${i} gross on the net row`).toBe(
        EXPECTED_GROSS[i],
      )
      expect(row!.rank, `entry ${i} net rank`).toBe(EXPECTED_NET_RANK[i])
      expect(row!.thru).toBe(HOLE_COUNT)
      expect(row!.status).toBe('complete')
      const rel = EXPECTED_NET[i] - PAR_TOTAL
      expect(row!.display_primary).toBe(rel === 0 ? 'E' : rel > 0 ? `+${rel}` : String(rel))
    })

    // Identical gross and net boards would mean the handicaps never reached the
    // engine. Every entry carries a nonzero handicap, so every result AND the
    // ordering must differ.
    const { data: grossData } = await fx.service
      .from('leaderboard_rows')
      .select('entity_id, rank, result_primary')
      .eq('competition_id', fx.competitions.grossId)
      .eq('event_revision', FINAL_REVISION)

    fx.entries.forEach((entry, i) => {
      const grossRow = (grossData ?? []).find((r) => r.entity_id === grossEntities[i])!
      const netRow = rows.find((r) => r.entity_id === netEntities[i])!
      expect(
        Number(netRow.result_primary),
        `entry ${i} net must sit exactly one handicap below gross`,
      ).toBe(Number(grossRow.result_primary) - entry.playingHandicap)
      expect(Number(netRow.result_primary)).not.toBe(Number(grossRow.result_primary))
    })

    const grossLeaderIndex = grossEntities.indexOf(
      (grossData ?? []).find((r) => r.rank === 1)!.entity_id as string,
    )
    const netLeaderIndex = netEntities.indexOf(
      rows.find((r) => r.rank === 1)!.entity_id as string,
    )
    expect(grossLeaderIndex).toBe(0)
    expect(netLeaderIndex).toBe(1)
    expect(netLeaderIndex).not.toBe(grossLeaderIndex)
  })

  it('spec §9.5 · per-hole projections carry the allocated strokes and the net score', async () => {
    const { data } = await fx.service
      .from('hole_results')
      .select(
        'entity_id, event_hole_id, gross, strokes_received, net, relative_to_par, status, provisional',
      )
      .eq('competition_id', fx.competitions.netId)
      .eq('event_revision', FINAL_REVISION)

    const rows = data ?? []
    expect(rows).toHaveLength(HOLE_COUNT * ENTRY_COUNT)

    const byKey = new Map(
      rows.map((r) => [`${r.entity_id}|${r.event_hole_id}`, r]),
    )
    const mismatches: string[] = []
    fx.entries.forEach((entry, i) => {
      for (const hole of fx.holes) {
        const row = byKey.get(`${netEntities[i]}|${hole.id}`)
        if (!row) {
          mismatches.push(`entry ${i} hole ${hole.ordinal}: missing hole result`)
          continue
        }
        const expectedGross = hole.par + OVER_PAR[i](hole.ordinal)
        const expectedSr = strokesReceived(entry.playingHandicap, HOLE_COUNT, hole.strokeIndex)
        const expectedNet = expectedGross - expectedSr
        const actual = {
          gross: row.gross,
          sr: row.strokes_received,
          net: row.net,
          // A net competition reports each hole relative to par in net terms.
          rel: row.relative_to_par,
          status: row.status,
          provisional: row.provisional,
        }
        const expected = {
          gross: expectedGross,
          sr: expectedSr,
          net: expectedNet,
          rel: expectedNet - hole.par,
          status: 'complete',
          provisional: false,
        }
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          mismatches.push(
            `entry ${i} (hcp ${entry.playingHandicap}) hole ${hole.ordinal} ` +
              `si ${hole.strokeIndex}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
          )
        }
      }
    })
    expect(mismatches).toEqual([])

    // Allocation across a full round must hand out exactly the Playing Handicap.
    fx.entries.forEach((entry, i) => {
      const total = rows
        .filter((r) => r.entity_id === netEntities[i])
        .reduce((sum, r) => sum + Number(r.strokes_received), 0)
      expect(total, `entry ${i} total strokes received`).toBe(entry.playingHandicap)
    })
  })

  it('spec §8.7 · skins publishes a resolved outcome for every hole and conserves units', async () => {
    const { data } = await fx.service
      .from('hole_results')
      .select(
        'entity_id, event_hole_id, skin_units, skin_carried_units, skin_winner, provisional, detail_json',
      )
      .eq('competition_id', fx.competitions.skinsId)
      .eq('event_revision', FINAL_REVISION)

    const rows = data ?? []
    // Skins resolve the hole, not the entity: one outcome row per hole.
    expect(rows).toHaveLength(HOLE_COUNT)
    expect(new Set(rows.map((r) => r.event_hole_id as string))).toEqual(
      new Set(fx.holes.map((h) => h.id)),
    )

    for (const row of rows) {
      // A complete card leaves no hole unknowable, so a 'provisional' outcome
      // here would mean the skins population never saw the finished scores.
      expect(row.provisional).toBe(false)
      expect(['won', 'carried', 'expired', 'split']).toContain(
        (row.detail_json as { outcome?: string } | null)?.outcome,
      )
      expect(typeof row.skin_winner).toBe('boolean')
      expect(Number.isInteger(row.skin_units)).toBe(true)
      expect(Number(row.skin_carried_units)).toBeGreaterThanOrEqual(0)
      if (row.skin_winner === true) {
        // A won hole takes the carried pool plus this hole's own unit.
        expect(Number(row.skin_units)).toBe(Number(row.skin_carried_units) + 1)
      } else {
        expect(Number(row.skin_units)).toBe(0)
      }
      expect(skinsEntities).toContain(row.entity_id as string)
    }

    const { data: skinRows } = await fx.service
      .from('leaderboard_rows')
      .select('entity_id, rank, thru, result_primary')
      .eq('competition_id', fx.competitions.skinsId)
      .eq('event_revision', FINAL_REVISION)

    const totals = skinRows ?? []
    expect(totals).toHaveLength(ENTRY_COUNT)
    for (const row of totals) {
      // Skins are an unranked unit tally, never a stroke-play board.
      expect(row.rank).toBeNull()
      expect(row.thru).toBeNull()
      expect(Number(row.result_primary)).toBeGreaterThanOrEqual(0)
    }

    // Units are conserved: everything credited to a player was awarded on a
    // hole, and one unit per hole caps what the pool can ever pay out.
    const awarded = rows.reduce((sum, r) => sum + Number(r.skin_units), 0)
    const credited = totals.reduce((sum, r) => sum + Number(r.result_primary), 0)
    expect(credited).toBe(awarded)
    expect(awarded).toBeLessThanOrEqual(HOLE_COUNT)
  })

  it('spec §10.5 · the revision feed announces the publish for all three competitions', async () => {
    const { data } = await fx.service
      .from('event_revision_feed')
      .select('score_revision, projection_revision, changed_competition_ids')
      .eq('event_id', fx.eventId)
      .order('published_at', { ascending: false })
      .order('id', { ascending: true })

    const feed = data ?? []
    // publish_projections trims this table to the newest 20 rows per event.
    expect(feed.length).toBe(20)

    const newest = feed[0]
    expect(Number(newest.projection_revision)).toBe(FINAL_REVISION)
    expect(Number(newest.score_revision)).toBe(FINAL_REVISION)
    expect([...(newest.changed_competition_ids as string[])].sort()).toEqual(
      [fx.competitions.grossId, fx.competitions.netId, fx.competitions.skinsId].sort(),
    )
  })
})
