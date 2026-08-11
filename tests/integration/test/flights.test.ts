/**
 * Flights / divisions through the projection pipeline (spec §5.2, §8.7).
 *
 * Two things must hold, and the second is the one that would quietly produce
 * wrong money: each flight gets its own rank 1, and a per-flight skins
 * population is a separate POOL — a player must not take a skin off someone in
 * another flight, and carries must not cross the divide.
 */

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import { buildScoringFixture, type ScoringFixture } from '../helpers/fixture.ts'
import { callFunction, stackIsUp } from '../helpers/stack.ts'

function baseRules(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
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
    ...overrides,
  }
}

describe('flights and divisions (§5.2, §8.7)', () => {
  let fx: ScoringFixture
  let flightA: string
  let flightB: string
  let flightedId: string
  let flightSkinsId: string

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    fx = await buildScoringFixture({ playerCount: 4, leaveClosed: true })
    const reopenDraft = await fx.service.from('events')
      .update({ status: 'draft' })
      .eq('id', fx.eventId)
    if (reopenDraft.error) throw reopenDraft.error

    flightA = randomUUID()
    flightB = randomUUID()
    const flights = await fx.service.from('flights').insert([
      { id: flightA, event_id: fx.eventId, name: 'A Flight', sort_order: 1 },
      { id: flightB, event_id: fx.eventId, name: 'B Flight', sort_order: 2 },
    ])
    if (flights.error) throw flights.error

    // Entries 0,1 -> A flight; entries 2,3 -> B flight.
    for (const [index, entry] of fx.entries.entries()) {
      const assign = await fx.service
        .from('event_entries')
        .update({ flight_id: index < 2 ? flightA : flightB })
        .eq('id', entry.entryId)
      if (assign.error) throw assign.error
    }

    flightedId = randomUUID()
    flightSkinsId = randomUUID()
    const comps = await fx.service.from('competitions').insert([
      {
        id: flightedId, event_id: fx.eventId, name: 'Flighted gross',
        format: 'individual_stroke', metric: 'gross', status: 'scoring_open',
        rules_schema_version: 1,
        rules_json: baseRules({
          format: 'individual_stroke',
          metric: 'gross',
          flighting: 'per_flight',
        }),
        engine_version: 'test', sort_order: 20,
      },
      {
        id: flightSkinsId, event_id: fx.eventId, name: 'Flight skins',
        format: 'skins', metric: 'gross', status: 'scoring_open',
        rules_schema_version: 1,
        rules_json: baseRules({
          format: 'skins',
          metric: 'gross',
          skins: {
            population: 'flight',
            carryMode: 'carry_forward',
            unitsPerHole: 1,
            finalCarry: 'expire',
          },
        }),
        engine_version: 'test', sort_order: 21,
      },
    ])
    if (comps.error) throw comps.error

    const links = await fx.service.from('competition_rounds').insert(
      [flightedId, flightSkinsId].map((competition_id) => ({
        competition_id, round_id: fx.roundId, hole_scope: null, weight: 1,
      })),
    )
    if (links.error) throw links.error

    const ents = await fx.service.from('competition_entities').insert(
      [flightedId, flightSkinsId].flatMap((competition_id) =>
        fx.entries.map((e, index) => ({
          competition_id,
          event_entry_id: e.entryId,
          eligibility_status: 'eligible',
          flight_id: index < 2 ? flightA : flightB,
        })),
      ),
    )
    if (ents.error) throw ents.error

    const republish = await fx.service.from('events')
      .update({ status: 'published' })
      .eq('id', fx.eventId)
    if (republish.error) throw republish.error
    const open = await fx.service.from('events')
      .update({ status: 'scoring_open' })
      .eq('id', fx.eventId)
    if (open.error) throw open.error
    const startRound = await fx.service.from('rounds')
      .update({ status: 'in_progress' })
      .eq('id', fx.roundId)
    if (startRound.error) throw startRound.error

    // Gross per hole. A flight plays better than B flight throughout, so a
    // field-wide ranking would put both A players above both B players and
    // give B no rank 1 at all.
    const grossByEntry = [4, 5, 6, 7]
    for (let hole = 0; hole < 18; hole += 1) {
      for (const [index, entry] of fx.entries.entries()) {
        const res = await callFunction<{ status: string }>(
          'submit-score',
          {
            idempotencyKey: randomUUID(),
            eventId: fx.eventId,
            roundId: fx.roundId,
            target: { kind: 'individual', entryId: entry.entryId, holeId: fx.holes[hole].id },
            baseRevision: 0,
            value: { status: 'complete', grossStrokes: grossByEntry[index], notes: null },
            clientRecordedAt: new Date().toISOString(),
            clientRelease: '0.1.0',
          },
          fx.director.accessToken,
        )
        expect(res.status, JSON.stringify(res.body)).toBe(200)
      }
    }
  }, 300_000)

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
      .select('entity_id, result_primary, rank, is_tied, detail_json')
      .eq('competition_id', competitionId)
      .eq('event_revision', revision)
    return data ?? []
  }

  it('gives every flight its own rank 1', async () => {
    const rows = await latestRows(flightedId)
    expect(rows).toHaveLength(4)

    const byFlight = new Map<string, Array<{ rank: number; total: number }>>()
    for (const row of rows) {
      const flightId = (row.detail_json as { flightId?: string })?.flightId as string
      expect(flightId, 'every row carries its flight').toBeDefined()
      byFlight.set(flightId, [
        ...(byFlight.get(flightId) ?? []),
        { rank: Number(row.rank), total: Number(row.result_primary) },
      ])
    }

    expect(byFlight.size).toBe(2)
    for (const [, members] of byFlight) {
      expect(members).toHaveLength(2)
      expect(members.map((m) => m.rank).sort()).toEqual([1, 2])
      // Within a flight the lower gross holds rank 1.
      const winner = members.find((m) => m.rank === 1)
      const other = members.find((m) => m.rank === 2)
      expect(winner!.total).toBeLessThan(other!.total)
    }

    // The decisive check: B flight's rank-1 total (6 x 18 = 108) is WORSE than
    // A flight's rank-2 total (5 x 18 = 90). Field-wide ranking could never
    // produce that, so this proves flighting actually applied.
    const allRank1 = rows.filter((r) => Number(r.rank) === 1).map((r) => Number(r.result_primary))
    expect(allRank1.sort((a, b) => a - b)).toEqual([72, 108])
  })

  it('runs a separate skins pool per flight', async () => {
    const rows = await latestRows(flightSkinsId)

    // Every hole is won outright inside each flight (4 beats 5 in A, 6 beats 7
    // in B), so both flights award all 18 skins to their own low player.
    const winners = rows.filter((r) => Number(r.result_primary) > 0)
    expect(winners).toHaveLength(2)
    for (const winner of winners) {
      expect(Number(winner.result_primary)).toBe(18)
    }

    // Pooling the field would have produced ONE winner taking all 18 — the
    // A-flight player — and nothing for B flight.
    const totalUnits = rows.reduce((sum, r) => sum + Number(r.result_primary ?? 0), 0)
    expect(totalUnits).toBe(36)
  })
})
