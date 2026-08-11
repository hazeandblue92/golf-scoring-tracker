/**
 * Mid-event substitutions (spec §8.14, §11.3).
 *
 * "Substitute mid-event: new entry with effective round; historical round
 * remains attributed." / "deleted rows are never used to rewrite history."
 *
 * So two things must both be true, and they pull in opposite directions: the
 * SLOT must carry one continuous total across the handover, while the round
 * the original player actually played stays attributed to them. A model that
 * edited the entry's participant would satisfy the first and destroy the
 * second.
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

describe('mid-event substitution (§8.14)', () => {
  let fx: ScoringFixture
  let roundTwoId: string
  let roundTwoHoles: Array<{ id: string }>
  let competitionId: string
  let originalEntryId: string
  let substituteEntryId: string
  let slotEntityId: string

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    fx = await buildScoringFixture({ playerCount: 2 })
    originalEntryId = fx.entries[0].entryId

    // ── Second round ──────────────────────────────────────────────────────
    roundTwoId = randomUUID()
    const round = await fx.service.from('rounds').insert({
      id: roundTwoId, event_id: fx.eventId, round_number: 2,
      name: 'Round 2', hole_count: 18, status: 'scheduled',
    })
    if (round.error) throw round.error

    const snapshotId = randomUUID()
    const snap = await fx.service.from('event_tee_snapshots').insert({
      id: snapshotId, round_id: roundTwoId, source_tee_set_id: TEE_SET_BLUE,
      course_name: 'GTT Dev Course', layout_name: 'Championship 18', tee_name: 'Blue',
      course_rating: 71.4, slope_rating: 128, par: 72, hole_count: 18,
      snapshot_version: 1, snapshot_hash: `sub-${snapshotId.slice(0, 8)}`,
      created_at: new Date().toISOString(),
    })
    if (snap.error) throw snap.error

    const holeRows = PARS.map((par, i) => ({
      id: randomUUID(), round_id: roundTwoId, event_tee_snapshot_id: snapshotId,
      hole_ordinal: i + 1, label: String(i + 1), par, stroke_index: STROKE_INDEXES[i],
    }))
    const holes = await fx.service.from('event_holes').insert(holeRows)
    if (holes.error) throw holes.error
    roundTwoHoles = holeRows.map((h) => ({ id: h.id }))

    // ── The substitute: a NEW participant and a NEW entry ─────────────────
    const substituteParticipantId = randomUUID()
    const participant = await fx.service.from('participants').insert({
      id: substituteParticipantId, league_id: LEAGUE_ID, profile_id: null,
      display_name: 'Substitute Player', sort_name: 'substitute, player',
      status: 'active',
    })
    if (participant.error) throw participant.error

    substituteEntryId = randomUUID()
    const entry = await fx.service.from('event_entries').insert({
      id: substituteEntryId,
      event_id: fx.eventId,
      participant_id: substituteParticipantId,
      status: 'active',
      handicap_source: 'manual_verified',
      handicap_value: 4,
      course_handicap_unrounded: 4,
      playing_handicap: 4,
      allowance: 1,
      effective_from_round_id: roundTwoId,
      replaces_entry_id: originalEntryId,
      substitution_reason: 'Original player withdrew after round 1',
    })
    if (entry.error) throw entry.error

    // ── Two-round total competition ───────────────────────────────────────
    competitionId = randomUUID()
    const comp = await fx.service.from('competitions').insert({
      id: competitionId, event_id: fx.eventId, name: 'Two-round total',
      format: 'individual_stroke', metric: 'gross', status: 'scoring_open',
      rules_schema_version: 1,
      rules_json: {
        format: 'individual_stroke', schemaVersion: 1, metric: 'gross',
        holeScope: Array.from({ length: 18 }, (_, i) => i + 1),
        handicap: {
          profile: 'none', allowance: 1,
          rounding: 'half_up_toward_positive_infinity',
          matchNormalizeFromLowest: false, allocation: 'stroke_index',
        },
        // Both slots finish on 162. Countback therefore has to follow the
        // substitute's round-two hole results back to the original slot.
        ties: { mode: 'countback', sequence: ['last_9'] },
        incomplete: { live: 'provisional', final: 'no_return' },
        visibility: 'league',
        multiRound: { aggregation: 'sum' },
      },
      engine_version: 'test', sort_order: 30,
    })
    if (comp.error) throw comp.error

    const links = await fx.service.from('competition_rounds').insert([
      { competition_id: competitionId, round_id: fx.roundId, hole_scope: null, weight: 1 },
      { competition_id: competitionId, round_id: roundTwoId, hole_scope: null, weight: 1 },
    ])
    if (links.error) throw links.error

    slotEntityId = randomUUID()
    // Every row carries an explicit id: PostgREST batches must share the same
    // column set, so one row omitting `id` sends null for all of them.
    const ents = await fx.service.from('competition_entities').insert([
      { id: slotEntityId, competition_id: competitionId, event_entry_id: originalEntryId, eligibility_status: 'eligible' },
      { id: randomUUID(), competition_id: competitionId, event_entry_id: substituteEntryId, eligibility_status: 'eligible' },
      { id: randomUUID(), competition_id: competitionId, event_entry_id: fx.entries[1].entryId, eligibility_status: 'eligible' },
    ])
    if (ents.error) throw ents.error

    // Round 1: the ORIGINAL player scores 4s (72). Round 2: the SUBSTITUTE
    // scores 5s (90). The other entrant scores 5s (90) then 4s (72), tying
    // the substituted slot on 162 but winning the declared last-nine countback.
    const score = async (roundId: string, entryId: string, holeId: string, gross: number) => {
      const res = await callFunction<{ status: string }>(
        'submit-score',
        {
          idempotencyKey: randomUUID(), eventId: fx.eventId, roundId,
          target: { kind: 'individual', entryId, holeId },
          baseRevision: 0,
          value: { status: 'complete', grossStrokes: gross, notes: null },
          clientRecordedAt: new Date().toISOString(), clientRelease: '0.1.0',
        },
        fx.director.accessToken,
      )
      expect(res.status, JSON.stringify(res.body)).toBe(200)
    }

    for (let i = 0; i < 18; i += 1) {
      await score(fx.roundId, originalEntryId, fx.holes[i].id, 4)
      await score(fx.roundId, fx.entries[1].entryId, fx.holes[i].id, 5)
      await score(roundTwoId, substituteEntryId, roundTwoHoles[i].id, 5)
      await score(roundTwoId, fx.entries[1].entryId, roundTwoHoles[i].id, 4)
    }
  }, 300_000)

  async function latestRows() {
    const newest = await fx.service
      .from('leaderboard_rows')
      .select('event_revision')
      .eq('competition_id', competitionId)
      .order('event_revision', { ascending: false })
      .limit(1)
      .maybeSingle()
    const { data } = await fx.service
      .from('leaderboard_rows')
      .select('entity_id, result_primary, rank, detail_json')
      .eq('competition_id', competitionId)
      .eq('event_revision', Number(newest.data?.event_revision ?? -1))
    return data ?? []
  }

  it('carries one continuous total across the handover', async () => {
    const rows = await latestRows()

    // The slot totals 72 (original, round 1) + 90 (substitute, round 2) = 162,
    // and appears ONCE — not as two half-finished entrants.
    const slot = rows.find((r) => r.entity_id === slotEntityId)
    expect(slot, 'the replaced entry holds the slot').toBeDefined()
    expect(Number(slot?.result_primary)).toBe(162)
    expect((slot?.detail_json as { roundsCounted?: number })?.roundsCounted).toBe(2)

    // The substitute does not also appear as a separate one-round entrant.
    const substituteEntity = rows.find(
      (r) => r.entity_id !== slotEntityId && Number(r.result_primary) === 90,
    )
    expect(substituteEntity).toBeUndefined()

    // The continuing player is unaffected: 90 + 72 = 162. Both rows remain;
    // the substitute itself is the only entity collapsed into its slot.
    expect(rows.filter((r) => Number(r.result_primary) === 162)).toHaveLength(2)
    expect(Number(slot?.rank)).toBe(2)
  })

  it('maps substitute hole values to the original slot for pipeline countback', async () => {
    const rows = await latestRows()
    const slot = rows.find((row) => row.entity_id === slotEntityId)
    const continuing = rows.find((row) => row.entity_id !== slotEntityId)

    // Both aggregate to 162, but the continuing player shoots 36 over the
    // final nine versus the substitute's 45. Without the countback-only slot
    // mapping, those final-nine values live under the substitute entity and
    // the original slot incorrectly remains tied.
    expect(Number(slot?.result_primary)).toBe(162)
    expect(Number(continuing?.result_primary)).toBe(162)
    expect(Number(continuing?.rank)).toBe(1)
    expect(Number(slot?.rank)).toBe(2)
  })

  it('leaves round one attributed to the player who actually played it', async () => {
    // History is the point of §8.14: the original entry keeps its own scores,
    // and nothing was reassigned to the substitute.
    const { data: originalScores } = await fx.service
      .from('individual_hole_scores')
      .select('gross_strokes')
      .eq('event_entry_id', originalEntryId)
      .eq('round_id', fx.roundId)

    expect(originalScores).toHaveLength(18)
    expect(originalScores?.every((s) => s.gross_strokes === 4)).toBe(true)

    const { data: substituteScores } = await fx.service
      .from('individual_hole_scores')
      .select('gross_strokes, round_id')
      .eq('event_entry_id', substituteEntryId)

    // The substitute owns round two only; it never acquires round one.
    expect(substituteScores).toHaveLength(18)
    expect(substituteScores?.every((s) => s.round_id === roundTwoId)).toBe(true)
    expect(substituteScores?.every((s) => s.gross_strokes === 5)).toBe(true)

    // And the outgoing entry still names its own participant.
    const { data: entry } = await fx.service
      .from('event_entries')
      .select('participant_id, replaces_entry_id')
      .eq('id', originalEntryId)
      .maybeSingle()
    expect(entry?.participant_id).toBe(fx.entries[0].participantId)
    expect(entry?.replaces_entry_id).toBeNull()
  })

  it('finalizes against the four effective entry-round cards, not six historical rows', async () => {
    const cards = [
      { roundId: fx.roundId, entryId: originalEntryId },
      { roundId: roundTwoId, entryId: substituteEntryId },
      { roundId: fx.roundId, entryId: fx.entries[1].entryId },
      { roundId: roundTwoId, entryId: fx.entries[1].entryId },
    ]
    for (const card of cards) {
      const attested = await callFunction<{ status: string }>(
        'attest-scorecard',
        {
          roundId: card.roundId,
          targetKind: 'individual',
          targetId: card.entryId,
          attestationType: 'director_override',
          reason: 'Integration finalization proof',
        },
        fx.director.accessToken,
      )
      expect(attested.status, JSON.stringify(attested.body)).toBe(200)
      expect(attested.body.status).toBe('attested')
    }

    const finalized = await callFunction<{
      status: string
      missingScoreOverrides?: number
      attestationOverrides?: number
    }>(
      'finalize-competition',
      { competitionId, overrideReason: null },
      fx.director.accessToken,
    )
    expect(finalized.status, JSON.stringify(finalized.body)).toBe(200)
    expect(finalized.body).toMatchObject({
      status: 'finalized',
      missingScoreOverrides: 0,
      attestationOverrides: 0,
    })
  })
})
