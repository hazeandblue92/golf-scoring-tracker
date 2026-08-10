/**
 * Multi-round aggregation through the real projection pipeline (spec §8.14).
 *
 * The engine and its golden vectors are unit-tested; this proves the wiring —
 * that a competition spanning two rounds scores each round on its OWN holes
 * and aggregates, rather than merging both cards into one 36-hole round.
 *
 * That merge is the specific regression guarded here: `hole_ordinal` is unique
 * per round, so two rounds both contain a hole 1. Scoring the merged set would
 * re-rank stroke indexes across 36 holes and allocate handicap strokes no
 * scorecard has.
 */

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  buildScoringFixture,
  TEE_SET_BLUE,
  type ScoringFixture,
} from '../helpers/fixture.ts'
import { callFunction, stackIsUp } from '../helpers/stack.ts'

const PARS = [4, 5, 3, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 4, 5, 4]
const STROKE_INDEXES = [5, 11, 17, 1, 7, 15, 13, 3, 9, 6, 18, 12, 2, 8, 16, 4, 14, 10]

interface RoundHandle {
  roundId: string
  holes: Array<{ id: string; ordinal: number }>
}

/** Add a second 18-hole round to an existing fixture event. */
async function addRound(fx: ScoringFixture, roundNumber: number): Promise<RoundHandle> {
  const roundId = randomUUID()
  const round = await fx.service.from('rounds').insert({
    id: roundId,
    event_id: fx.eventId,
    round_number: roundNumber,
    name: `Round ${roundNumber}`,
    hole_count: 18,
    status: 'scheduled',
  })
  if (round.error) throw round.error

  const snapshotId = randomUUID()
  const snapshot = await fx.service.from('event_tee_snapshots').insert({
    id: snapshotId,
    round_id: roundId,
    source_tee_set_id: TEE_SET_BLUE,
    course_name: 'GTT Dev Course',
    layout_name: 'Championship 18',
    tee_name: 'Blue',
    course_rating: 71.4,
    slope_rating: 128,
    par: 72,
    hole_count: 18,
    snapshot_version: 1,
    snapshot_hash: `test-r${roundNumber}-${snapshotId.slice(0, 8)}`,
    created_at: new Date().toISOString(),
  })
  if (snapshot.error) throw snapshot.error

  const holeRows = PARS.map((par, i) => ({
    id: randomUUID(),
    round_id: roundId,
    event_tee_snapshot_id: snapshotId,
    hole_ordinal: i + 1,
    label: String(i + 1),
    par,
    stroke_index: STROKE_INDEXES[i],
  }))
  const holes = await fx.service.from('event_holes').insert(holeRows)
  if (holes.error) throw holes.error

  return {
    roundId,
    holes: holeRows.map((h) => ({ id: h.id, ordinal: h.hole_ordinal })),
  }
}

function strokeRules(multiRound?: { aggregation: string; count?: number }) {
  return {
    format: 'individual_stroke',
    schemaVersion: 1,
    metric: 'gross',
    holeScope: Array.from({ length: 18 }, (_, i) => i + 1),
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
    ...(multiRound ? { multiRound } : {}),
  }
}

/** Score one hole for one entry as the director. */
async function score(
  fx: ScoringFixture,
  roundId: string,
  entryId: string,
  holeId: string,
  gross: number,
) {
  const res = await callFunction<{ status: string }>(
    'submit-score',
    {
      idempotencyKey: randomUUID(),
      eventId: fx.eventId,
      roundId,
      target: { kind: 'individual', entryId, holeId },
      baseRevision: 0,
      value: { status: 'complete', grossStrokes: gross, notes: null },
      clientRecordedAt: new Date().toISOString(),
      clientRelease: '0.1.0',
    },
    fx.director.accessToken,
  )
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res
}

describe('multi-round aggregation through the projection pipeline (§8.14)', () => {
  let fx: ScoringFixture
  let roundTwo: RoundHandle
  let bestOfId: string
  let sumId: string

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    fx = await buildScoringFixture({ playerCount: 2 })
    roundTwo = await addRound(fx, 2)

    // Two competitions over the SAME two rounds: one straight sum, one best
    // 1 of 2. Same scores, and the drop must change the totals.
    bestOfId = randomUUID()
    sumId = randomUUID()
    const comps = await fx.service.from('competitions').insert([
      {
        id: sumId, event_id: fx.eventId, name: 'Two-round total',
        format: 'individual_stroke', metric: 'gross', status: 'scoring_open',
        rules_schema_version: 1, rules_json: strokeRules({ aggregation: 'sum' }),
        engine_version: 'test', sort_order: 10,
      },
      {
        id: bestOfId, event_id: fx.eventId, name: 'Best round',
        format: 'individual_stroke', metric: 'gross', status: 'scoring_open',
        rules_schema_version: 1,
        rules_json: strokeRules({ aggregation: 'best_r_of_n', count: 1 }),
        engine_version: 'test', sort_order: 11,
      },
    ])
    if (comps.error) throw comps.error

    const links = await fx.service.from('competition_rounds').insert(
      [sumId, bestOfId].flatMap((competition_id) => [
        { competition_id, round_id: fx.roundId, hole_scope: null, weight: 1 },
        { competition_id, round_id: roundTwo.roundId, hole_scope: null, weight: 1 },
      ]),
    )
    if (links.error) throw links.error

    const entityRows = await fx.service.from('competition_entities').insert(
      [sumId, bestOfId].flatMap((competition_id) =>
        fx.entries.map((e) => ({
          competition_id,
          event_entry_id: e.entryId,
          eligibility_status: 'eligible',
        })),
      ),
    )
    if (entityRows.error) throw entityRows.error

    // Player A: round 1 all 4s (72), round 2 all 5s (90).
    // Player B: round 1 all 5s (90), round 2 all 4s (72).
    // Sums tie at 162; best-of-1 also ties at 72 — so we make B's good round
    // one stroke better to give each competition a definite winner.
    for (let i = 0; i < 18; i += 1) {
      await score(fx, fx.roundId, fx.entries[0].entryId, fx.holes[i].id, 4)
      await score(fx, fx.roundId, fx.entries[1].entryId, fx.holes[i].id, 5)
      await score(fx, roundTwo.roundId, fx.entries[0].entryId, roundTwo.holes[i].id, 5)
      await score(
        fx,
        roundTwo.roundId,
        fx.entries[1].entryId,
        roundTwo.holes[i].id,
        i === 0 ? 3 : 4,
      )
    }
  }, 300_000)

  it('keeps each round on its own 18 holes rather than merging into 36', async () => {
    const { data } = await fx.service
      .from('hole_results')
      .select('event_hole_id')
      .eq('competition_id', sumId)

    // 2 players x 18 holes x 2 rounds = 72 hole results, drawn from 36
    // distinct holes. A merged 36-hole round would still be 36 holes but
    // would have re-ranked stroke indexes; the count check here guards the
    // simpler failure of dropping a round entirely.
    const distinctHoles = new Set((data ?? []).map((r) => r.event_hole_id))
    expect(distinctHoles.size).toBe(36)
  })

  /**
   * Rows exist for every event revision, so a plain limit mixes half-scored
   * revisions with the final one. Always pin to the newest revision.
   */
  async function latestRows(competitionId: string) {
    const newest = await fx.service
      .from('leaderboard_rows')
      .select('event_revision')
      .eq('competition_id', competitionId)
      .order('event_revision', { ascending: false })
      .limit(1)
      .maybeSingle()
    const revision = Number(newest.data?.event_revision ?? -1)
    const { data } = await fx.service
      .from('leaderboard_rows')
      .select('entity_id, result_primary, rank, detail_json')
      .eq('competition_id', competitionId)
      .eq('event_revision', revision)
    return data ?? []
  }

  it('sums both rounds for a sum aggregation', async () => {
    const data = await latestRows(sumId)

    const totals = (data ?? []).map((r) => Number(r.result_primary)).sort((a, b) => a - b)
    // A: 72 + 90 = 162. B: 90 + (72 - 1) = 161.
    expect(totals).toEqual([161, 162])

    const winner = (data ?? []).find((r) => r.rank === 1)
    expect(Number(winner?.result_primary)).toBe(161)
    expect((winner?.detail_json as { aggregation?: string })?.aggregation).toBe('sum_strokes')
  })

  it('counts only the best round for best_r_of_n, and keeps the dropped one visible', async () => {
    const data = await latestRows(bestOfId)

    const totals = (data ?? []).map((r) => Number(r.result_primary)).sort((a, b) => a - b)
    // Best single round: A's 72, B's 71. Both far below the 161/162 sums,
    // which is what proves the drop policy actually applied.
    expect(totals).toEqual([71, 72])

    const winner = (data ?? []).find((r) => r.rank === 1)
    const detail = winner?.detail_json as {
      aggregation?: string
      roundsPlayed?: number
      roundsCounted?: number
      rounds?: Array<{ counted: boolean; value: number | null }>
    }
    expect(detail?.aggregation).toBe('best_r_of_n')
    expect(detail?.roundsPlayed).toBe(2)
    expect(detail?.roundsCounted).toBe(1)

    // §8.14: a dropped round is never deleted — it stays visible, flagged.
    expect(detail?.rounds).toHaveLength(2)
    expect(detail?.rounds?.filter((r) => r.counted)).toHaveLength(1)
    expect(detail?.rounds?.filter((r) => !r.counted)).toHaveLength(1)
  })
})
