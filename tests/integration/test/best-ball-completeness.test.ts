/**
 * Best Ball finalization completeness (migration 36).
 *
 * Regression: `finalize_phase1_competition` counted resolved member scores per
 * team hole and treated the hole as complete once that reached `team.bestK`.
 * The Two-Person Throwdown sets bestK = 1, so ONE partner's card satisfied the
 * whole team hole and both Best Ball competitions could seal with the other
 * partner's card blank — while a lower pending score would still have changed
 * the counting ball, and while sealing locks those same raw facts away from the
 * four sibling competitions that read them.
 */

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import { buildScoringFixture, type ScoringFixture } from '../helpers/fixture.ts'
import { stackIsUp } from '../helpers/stack.ts'

interface FinalizeResult {
  status: string
  missingScores?: number
  unattestedCards?: number
  openConflicts?: number
}

describe('best ball finalization requires every member card', () => {
  let fx: ScoringFixture
  let competitionId: string
  let teamId: string
  let holeId: string

  /**
   * Finalization returns a hardcoded `missingScores: 0` and exits early when no
   * projection exists at the event's current scoring revision, so a current
   * projection must exist before the completeness count is even reached.
   */
  const ensureCurrentProjection = async (): Promise<void> => {
    const event = await fx.service.from('events')
      .select('scoring_revision').eq('id', fx.eventId).single()
    if (event.error) throw event.error
    const upserted = await fx.service.from('competition_projections').upsert({
      competition_id: competitionId,
      event_revision: event.data.scoring_revision,
      engine_version: 'test',
      projection_hash: 'c'.repeat(64),
      status: 'live',
    }, { onConflict: 'competition_id,event_revision' })
    if (upserted.error) throw upserted.error
  }

  const finalize = async (): Promise<FinalizeResult> => {
    await ensureCurrentProjection()
    const result = await fx.service.rpc('finalize_phase1_competition', {
      p_actor: fx.director.profileId,
      p_competition_id: competitionId,
      p_override_reason: null,
    })
    if (result.error) throw result.error
    const body = result.data as FinalizeResult & { projectionStale?: boolean }
    expect(body.projectionStale, JSON.stringify(body)).not.toBe(true)
    return body
  }

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    fx = await buildScoringFixture({ playerCount: 4 })
    holeId = fx.holes[0]!.id

    teamId = randomUUID()
    const team = await fx.service.from('event_teams').insert({
      id: teamId,
      event_id: fx.eventId,
      name: `Throwdown pair ${teamId.slice(0, 8)}`,
      status: 'active',
      playing_handicap: 0,
    })
    if (team.error) throw team.error

    const members = await fx.service.from('event_team_members').insert([
      { event_team_id: teamId, event_entry_id: fx.entries[0]!.entryId, position: 1 },
      { event_team_id: teamId, event_entry_id: fx.entries[1]!.entryId, position: 2 },
    ])
    if (members.error) throw members.error

    competitionId = randomUUID()
    const competition = await fx.service.from('competitions').insert({
      id: competitionId,
      event_id: fx.eventId,
      name: `Best Ball Gross ${competitionId.slice(0, 8)}`,
      format: 'best_k',
      metric: 'gross',
      status: 'scoring_open',
      rules_schema_version: 1,
      rules_json: {
        format: 'best_k',
        schemaVersion: 1,
        metric: 'gross',
        holeScope: [1],
        handicap: {
          profile: 'none',
          allowance: 1,
          rounding: 'half_up_toward_positive_infinity',
          matchNormalizeFromLowest: false,
          allocation: 'stroke_index',
        },
        // The exact preset shape: one counting card per hole.
        team: { teamSize: 2, bestK: 1, scoreSource: 'individual' },
        ties: { mode: 'tied', sequence: [] },
        incomplete: { live: 'provisional', final: 'no_return' },
        visibility: 'league',
      },
      engine_version: 'test',
    })
    if (competition.error) throw competition.error

    const link = await fx.service.from('competition_rounds').insert({
      competition_id: competitionId,
      round_id: fx.roundId,
      hole_scope: [1],
      weight: 1,
    })
    if (link.error) throw link.error

    const entity = await fx.service.from('competition_entities').insert({
      competition_id: competitionId,
      event_team_id: teamId,
      eligibility_status: 'eligible',
    })
    if (entity.error) throw entity.error
  }, 240_000)

  it('blocks sealing while one partner card is blank', async () => {
    // Only the first partner returns a score on the single in-scope hole.
    const scored = await fx.service.from('individual_hole_scores').insert({
      id: randomUUID(),
      event_id: fx.eventId,
      round_id: fx.roundId,
      event_entry_id: fx.entries[0]!.entryId,
      event_hole_id: holeId,
      gross_strokes: 4,
      score_status: 'complete',
      revision: 1,
      entered_by: fx.director.profileId,
      source: 'import',
    })
    if (scored.error) throw scored.error

    const blocked = await finalize()
    expect(blocked.status).toBe('blocked')
    // Under the old `>= bestK` rule this was 0 and the competition sealed with
    // a blank partner card.
    expect(blocked.missingScores, JSON.stringify(blocked)).toBeGreaterThan(0)
  }, 120_000)

  it('clears the missing-score blocker once the partner card is resolved', async () => {
    const scored = await fx.service.from('individual_hole_scores').insert({
      id: randomUUID(),
      event_id: fx.eventId,
      round_id: fx.roundId,
      event_entry_id: fx.entries[1]!.entryId,
      event_hole_id: holeId,
      gross_strokes: 5,
      score_status: 'complete',
      revision: 1,
      entered_by: fx.director.profileId,
      source: 'import',
    })
    if (scored.error) throw scored.error

    const result = await finalize()
    // Attestations are a separate blocker and are deliberately not satisfied
    // here; this asserts only that the completeness count is now clean.
    expect(result.missingScores, JSON.stringify(result)).toBe(0)
  }, 120_000)

  it('counts a terminal status as resolved, not as a missing score', async () => {
    // A picked-up hole is a resolved fact under the frozen rule: it must not
    // block finalization the way an absent card does (spec §4.5).
    const pickedUp = await fx.service.from('individual_hole_scores')
      .update({ score_status: 'picked_up', gross_strokes: null, revision: 2 })
      .eq('event_entry_id', fx.entries[1]!.entryId)
      .eq('event_hole_id', holeId)
    if (pickedUp.error) throw pickedUp.error

    const result = await finalize()
    expect(result.missingScores, JSON.stringify(result)).toBe(0)
  }, 120_000)
})
