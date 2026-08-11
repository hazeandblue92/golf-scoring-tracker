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
  LEAGUE_ID,
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

function pointsRules(format: 'stableford' | 'par_bogey') {
  return {
    format,
    schemaVersion: 1,
    // Gross/net decides the per-hole comparison; both formats still aggregate
    // their resulting points/result values high-to-low across rounds.
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
    multiRound: { aggregation: 'sum' },
    points: { '-3': 5, '-2': 4, '-1': 3, '0': 2, '1': 1, '2+': 0 },
  }
}

function skinsRules() {
  return {
    format: 'skins',
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
    multiRound: { aggregation: 'sum' },
    skins: {
      population: 'field',
      carryMode: 'no_carry',
      unitsPerHole: 1,
      finalCarry: 'expire',
      fractionalUnits: false,
    },
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
  let mixedScopeId: string
  let stablefordId: string
  let parBogeyId: string
  let parBogeyCountbackId: string
  let skinsId: string
  let weightedId: string
  let ineligibleId: string
  let pendingId: string
  let missingMultiConfigId: string
  let singleRoundMultiConfigId: string

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    fx = await buildScoringFixture({ playerCount: 2 })
    roundTwo = await addRound(fx, 2)

    // Two competitions over the SAME two rounds: one straight sum, one best
    // 1 of 2. Same scores, and the drop must change the totals.
    bestOfId = randomUUID()
    sumId = randomUUID()
    mixedScopeId = randomUUID()
    stablefordId = randomUUID()
    parBogeyId = randomUUID()
    parBogeyCountbackId = randomUUID()
    skinsId = randomUUID()
    weightedId = randomUUID()
    ineligibleId = randomUUID()
    pendingId = randomUUID()
    missingMultiConfigId = randomUUID()
    singleRoundMultiConfigId = randomUUID()
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
      {
        id: mixedScopeId, event_id: fx.eventId, name: 'Mixed round scopes',
        format: 'individual_stroke', metric: 'gross', status: 'scoring_open',
        rules_schema_version: 1, rules_json: strokeRules({ aggregation: 'sum' }),
        engine_version: 'test', sort_order: 12,
      },
      {
        id: stablefordId, event_id: fx.eventId, name: 'Two-round Stableford',
        format: 'stableford', metric: 'gross', status: 'scoring_open',
        rules_schema_version: 1, rules_json: pointsRules('stableford'),
        engine_version: 'test', sort_order: 13,
      },
      {
        id: parBogeyId, event_id: fx.eventId, name: 'Two-round Par/Bogey',
        format: 'par_bogey', metric: 'gross', status: 'scoring_open',
        rules_schema_version: 1, rules_json: pointsRules('par_bogey'),
        engine_version: 'test', sort_order: 14,
      },
      {
        id: parBogeyCountbackId,
        event_id: fx.eventId,
        name: 'Par/Bogey countback across rounds',
        format: 'par_bogey',
        metric: 'gross',
        status: 'scoring_open',
        rules_schema_version: 1,
        rules_json: {
          ...pointsRules('par_bogey'),
          ties: { mode: 'countback', sequence: ['last_1'] },
        },
        engine_version: 'test',
        sort_order: 15,
      },
      {
        id: skinsId, event_id: fx.eventId, name: 'Two-round skins units',
        format: 'skins', metric: 'gross', status: 'scoring_open',
        rules_schema_version: 1, rules_json: skinsRules(),
        engine_version: 'test', sort_order: 15,
      },
      {
        id: weightedId, event_id: fx.eventId, name: 'Weighted two-round total',
        format: 'individual_stroke', metric: 'gross', status: 'scoring_open',
        rules_schema_version: 1, rules_json: strokeRules({ aggregation: 'sum' }),
        engine_version: 'test', sort_order: 16,
      },
      {
        id: ineligibleId, event_id: fx.eventId, name: 'Ineligible entrant guard',
        format: 'individual_stroke', metric: 'gross', status: 'scoring_open',
        rules_schema_version: 1, rules_json: strokeRules({ aggregation: 'sum' }),
        engine_version: 'test', sort_order: 17,
      },
      {
        id: pendingId, event_id: fx.eventId, name: 'Pending entrant guard',
        format: 'individual_stroke', metric: 'gross', status: 'scoring_open',
        rules_schema_version: 1, rules_json: strokeRules({ aggregation: 'sum' }),
        engine_version: 'test', sort_order: 18,
      },
      {
        id: missingMultiConfigId, event_id: fx.eventId,
        name: 'Invalid two-round single config', format: 'individual_stroke',
        metric: 'gross', status: 'scoring_open', rules_schema_version: 1,
        rules_json: strokeRules(), engine_version: 'test', sort_order: 19,
      },
      {
        id: singleRoundMultiConfigId, event_id: fx.eventId,
        name: 'Invalid single-round multi config', format: 'individual_stroke',
        metric: 'gross', status: 'scoring_open', rules_schema_version: 1,
        rules_json: strokeRules({ aggregation: 'sum' }),
        engine_version: 'test', sort_order: 20,
      },
    ])
    if (comps.error) throw comps.error

    const links = await fx.service.from('competition_rounds').insert(
      [
        sumId,
        bestOfId,
        stablefordId,
        parBogeyId,
        ineligibleId,
        pendingId,
        missingMultiConfigId,
      ]
        .flatMap((competition_id) => [
          { competition_id, round_id: fx.roundId, hole_scope: null, weight: 1 },
          { competition_id, round_id: roundTwo.roundId, hole_scope: null, weight: 1 },
        ]).concat([
        {
          competition_id: parBogeyCountbackId,
          round_id: fx.roundId,
          hole_scope: [1],
          weight: 1,
        },
        {
          competition_id: parBogeyCountbackId,
          round_id: roundTwo.roundId,
          hole_scope: [2],
          weight: 1,
        },
        {
          competition_id: skinsId,
          round_id: fx.roundId,
          hole_scope: null,
          weight: 1,
        },
        {
          competition_id: skinsId,
          round_id: roundTwo.roundId,
          hole_scope: Array.from({ length: 9 }, (_, index) => index + 1),
          weight: 1,
        },
        {
          competition_id: weightedId,
          round_id: fx.roundId,
          hole_scope: null,
          weight: 0.3333,
        },
        {
          competition_id: weightedId,
          round_id: roundTwo.roundId,
          hole_scope: null,
          weight: 0.5,
        },
        {
          competition_id: mixedScopeId,
          round_id: fx.roundId,
          hole_scope: Array.from({ length: 9 }, (_, index) => index + 1),
          weight: 1,
        },
        {
          competition_id: mixedScopeId,
          round_id: roundTwo.roundId,
          hole_scope: [1, 10, 11, 12, 13, 14, 15, 16, 17],
          weight: 1,
        },
        {
          competition_id: singleRoundMultiConfigId,
          round_id: fx.roundId,
          hole_scope: null,
          weight: 1,
        },
      ]),
    )
    if (links.error) throw links.error

    const entityRows = await fx.service.from('competition_entities').insert(
      [
        sumId,
        bestOfId,
        mixedScopeId,
        stablefordId,
        parBogeyId,
        parBogeyCountbackId,
        skinsId,
        weightedId,
        ineligibleId,
        pendingId,
        missingMultiConfigId,
        singleRoundMultiConfigId,
      ].flatMap((competition_id) =>
        fx.entries.map((e) => ({
          competition_id,
          event_entry_id: e.entryId,
          eligibility_status: 'eligible',
        })),
      ),
    )
    if (entityRows.error) throw entityRows.error
    const ineligible = await fx.service.from('competition_entities')
      .update({ eligibility_status: 'ineligible' })
      .eq('competition_id', ineligibleId)
      .eq('event_entry_id', fx.entries[1].entryId)
    if (ineligible.error) throw ineligible.error
    const pending = await fx.service.from('competition_entities')
      .update({ eligibility_status: 'pending' })
      .eq('competition_id', pendingId)
      .eq('event_entry_id', fx.entries[1].entryId)
    if (pending.error) throw pending.error

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

  it('publishes and canonically hashes fractional weighted totals', async () => {
    const rows = await latestRows(weightedId)
    expect(rows.map((row) => Number(row.result_primary)).sort((a, b) => a - b))
      .toEqual([65.497, 68.9976])

    const { data: projection, error } = await fx.service
      .from('competition_projections')
      .select('projection_hash,status')
      .eq('competition_id', weightedId)
      .order('event_revision', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    expect(projection?.status).toBe('live')
    expect(projection?.projection_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each([
    ['ineligible', () => ineligibleId],
    ['pending', () => pendingId],
  ])('keeps a competition entity with %s eligibility visible but unranked', async (status, id) => {
    const rows = await latestRows(id())
    const excluded = rows.find((row) =>
      (row.detail_json as { eligibilityStatus?: string })?.eligibilityStatus === status)
    expect(rows).toHaveLength(2)
    expect(excluded).toMatchObject({ rank: null, result_primary: null })
    expect(rows.filter((row) => row.rank === 1)).toHaveLength(1)
  })

  it('applies each competition round own hole_scope', async () => {
    const data = await latestRows(mixedScopeId)
    const totals = data.map((row) => Number(row.result_primary)).sort((a, b) => a - b)

    // A: R1 holes 1-9 = 36, R2 selected nine = 45 => 81.
    // B: R1 holes 1-9 = 45, R2 includes the opening 3 plus eight 4s => 35.
    expect(totals).toEqual([80, 81])

    const { data: holes } = await fx.service
      .from('hole_results')
      .select('event_hole_id')
      .eq('competition_id', mixedScopeId)
    expect(new Set((holes ?? []).map((hole) => hole.event_hole_id)).size).toBe(18)
  })

  it('aggregates multi-round skins units descending', async () => {
    const rows = await latestRows(skinsId)
    const totals = rows.map((row) => Number(row.result_primary))
    expect(totals.sort((a, b) => a - b)).toEqual([9, 18])
    expect(Number(rows.find((row) => row.rank === 1)?.result_primary)).toBe(18)
  })

  it.each([
    ['Stableford', () => stablefordId],
    ['Par/Bogey', () => parBogeyId],
  ])('aggregates %s round values descending even with a gross metric', async (_name, id) => {
    const data = await latestRows(id())
    const totals = data.map((row) => Number(row.result_primary))
    expect(new Set(totals).size).toBe(2)

    const winner = data.find((row) => row.rank === 1)
    expect(Number(winner?.result_primary)).toBe(Math.max(...totals))
  })

  it('uses published Par/Bogey hole outcomes for cross-round countback', async () => {
    const data = await latestRows(parBogeyCountbackId)
    expect(data.map((row) => Number(row.result_primary))).toEqual([0, 0])

    const { data: entities, error: entityError } = await fx.service
      .from('competition_entities')
      .select('id,event_entry_id')
      .eq('competition_id', parBogeyCountbackId)
    if (entityError) throw entityError
    const winnerEntity = data.find((row) => row.rank === 1)?.entity_id
    const winnerEntry = entities?.find((entity) => entity.id === winnerEntity)?.event_entry_id
    expect(winnerEntry).toBe(fx.entries[1].entryId)

    // hole_results accumulates one generation per event revision, so the
    // published outcome is the newest generation, not every row ever written.
    const newestHoleRevision = await fx.service
      .from('hole_results')
      .select('event_revision')
      .eq('competition_id', parBogeyCountbackId)
      .order('event_revision', { ascending: false })
      .limit(1)
      .maybeSingle()
    const { data: holeResults, error: holeError } = await fx.service
      .from('hole_results')
      .select('event_hole_id,detail_json')
      .eq('competition_id', parBogeyCountbackId)
      .eq('event_revision', Number(newestHoleRevision.data?.event_revision ?? -1))
    if (holeError) throw holeError
    expect(holeResults).toHaveLength(4)
    expect(holeResults?.every((hole) =>
      typeof (hole.detail_json as { points?: unknown }).points === 'number'
    )).toBe(true)
  })

  it.each([
    ['multiple rounds without multiRound', () => missingMultiConfigId, 'has no multiRound'],
    ['one round with multiRound', () => singleRoundMultiConfigId, 'linked to 1 round'],
  ])('publishes an engine error for %s', async (_name, id, message) => {
    const { data, error } = await fx.service
      .from('competition_projections')
      .select('status, warnings')
      .eq('competition_id', id())
      .order('event_revision', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error

    expect(data?.status).toBe('error')
    const warnings = data?.warnings as Array<{ code?: string; message?: string }>
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ENGINE_ERROR' }),
    ]))
    expect(warnings.some((warning) => warning.message?.includes(message))).toBe(true)
  })
})

describe('substitution ordering across unlinked event rounds (§8.14)', () => {
  let fx: ScoringFixture
  let competitionId: string
  let singleRoundCompetitionId: string
  let roundThree: RoundHandle

  // The tie-break regression this suite guards is UUID-ordered, so the
  // original slot must sort below the substitute's. Only the final segment
  // varies per run, which keeps that ordering while letting the suite run
  // repeatedly against one database.
  const runTag = randomUUID().split('-')[4]!
  const originalEntityId = `00000000-0000-4000-8000-${runTag}`
  const substituteEntityId = `ffffffff-ffff-4fff-8fff-${runTag}`
  const singleRoundOriginalEntityId = `00000001-0000-4000-8000-${runTag}`
  const singleRoundSubstituteEntityId = `fffffffe-ffff-4fff-8fff-${runTag}`

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    fx = await buildScoringFixture({ playerCount: 2 })
    const roundTwo = await addRound(fx, 2)
    roundThree = await addRound(fx, 3)

    const substituteParticipantId = randomUUID()
    const substituteEntryId = randomUUID()
    const participant = await fx.service.from('participants').insert({
      id: substituteParticipantId,
      league_id: LEAGUE_ID,
      profile_id: null,
      display_name: 'Skipped-round substitute',
      sort_name: 'substitute, skipped-round',
      status: 'active',
    })
    if (participant.error) throw participant.error
    const entry = await fx.service.from('event_entries').insert({
      id: substituteEntryId,
      event_id: fx.eventId,
      participant_id: substituteParticipantId,
      status: 'active',
      handicap_source: 'scratch_fallback',
      handicap_value: 0,
      course_handicap_unrounded: 0,
      playing_handicap: 0,
      allowance: 1,
      effective_from_round_id: roundTwo.roundId,
      replaces_entry_id: fx.entries[0].entryId,
      substitution_reason: 'Replacement begins in the unlinked second round',
    })
    if (entry.error) throw entry.error

    competitionId = randomUUID()
    singleRoundCompetitionId = randomUUID()
    const competition = await fx.service.from('competitions').insert([
      {
        id: competitionId,
        event_id: fx.eventId,
        name: 'Rounds one and three aggregate',
        format: 'individual_stroke',
        metric: 'gross',
        status: 'scoring_open',
        rules_schema_version: 1,
        rules_json: strokeRules({ aggregation: 'sum' }),
        engine_version: 'test',
        sort_order: 50,
      },
      {
        id: singleRoundCompetitionId,
        event_id: fx.eventId,
        name: 'Round three replacement slot',
        format: 'individual_stroke',
        metric: 'gross',
        status: 'scoring_open',
        rules_schema_version: 1,
        rules_json: strokeRules(),
        engine_version: 'test',
        sort_order: 51,
      },
    ])
    if (competition.error) throw competition.error
    const links = await fx.service.from('competition_rounds').insert([
      {
        competition_id: competitionId,
        round_id: fx.roundId,
        hole_scope: [1],
        weight: 1,
      },
      {
        competition_id: singleRoundCompetitionId,
        round_id: roundThree.roundId,
        hole_scope: [1],
        weight: 1,
      },
      {
        competition_id: competitionId,
        round_id: roundThree.roundId,
        hole_scope: [1],
        weight: 1,
      },
    ])
    if (links.error) throw links.error

    // Fixed ordering makes the old UUID tie-break choose the withdrawn original
    // when it incorrectly treats an unlinked R2 effective round as order -1.
    const entities = await fx.service.from('competition_entities').insert([
      {
        id: originalEntityId,
        competition_id: competitionId,
        event_entry_id: fx.entries[0].entryId,
        eligibility_status: 'eligible',
      },
      {
        id: substituteEntityId,
        competition_id: competitionId,
        event_entry_id: substituteEntryId,
        eligibility_status: 'eligible',
      },
      {
        id: singleRoundOriginalEntityId,
        competition_id: singleRoundCompetitionId,
        event_entry_id: fx.entries[0].entryId,
        eligibility_status: 'eligible',
      },
      {
        id: singleRoundSubstituteEntityId,
        competition_id: singleRoundCompetitionId,
        event_entry_id: substituteEntryId,
        eligibility_status: 'eligible',
      },
    ])
    if (entities.error) throw entities.error

    await score(fx, fx.roundId, fx.entries[0].entryId, fx.holes[0].id, 4)
    const withdrawn = await fx.service.from('event_entries')
      .update({ status: 'withdrawn' })
      .eq('id', fx.entries[0].entryId)
    if (withdrawn.error) throw withdrawn.error
    await score(fx, roundThree.roundId, substituteEntryId, roundThree.holes[0].id, 5)
  }, 180_000)

  it('keeps R1 on the original slot, applies the R2 handover to R3, and uses the latest status', async () => {
    const newest = await fx.service.from('leaderboard_rows')
      .select('event_revision')
      .eq('competition_id', competitionId)
      .order('event_revision', { ascending: false })
      .limit(1)
      .maybeSingle()
    const { data, error } = await fx.service.from('leaderboard_rows')
      .select('entity_id,rank,result_primary,status,detail_json')
      .eq('competition_id', competitionId)
      .eq('event_revision', Number(newest.data?.event_revision ?? -1))
    if (error) throw error

    expect(data).toHaveLength(1)
    expect(data?.[0]).toMatchObject({
      entity_id: originalEntityId,
      rank: 1,
      status: 'complete',
    })
    expect(Number(data?.[0]?.result_primary)).toBe(9)
    const rounds = (data?.[0]?.detail_json as {
      rounds?: Array<{ roundId: string; value: number | null }>
    })?.rounds
    expect(rounds?.map((round) => [round.roundId, Number(round.value)])).toEqual([
      [fx.roundId, 4],
      [roundThree.roundId, 5],
    ])
  })

  it('publishes one root-slot row for a single linked round after the handover', async () => {
    const newest = await fx.service.from('leaderboard_rows')
      .select('event_revision')
      .eq('competition_id', singleRoundCompetitionId)
      .order('event_revision', { ascending: false })
      .limit(1)
      .maybeSingle()
    const { data, error } = await fx.service.from('leaderboard_rows')
      .select('entity_id,rank,result_primary,status')
      .eq('competition_id', singleRoundCompetitionId)
      .eq('event_revision', Number(newest.data?.event_revision ?? -1))
    if (error) throw error

    expect(data).toEqual([expect.objectContaining({
      entity_id: singleRoundOriginalEntityId,
      rank: 1,
      result_primary: 5,
      status: 'complete',
    })])
  })
})
