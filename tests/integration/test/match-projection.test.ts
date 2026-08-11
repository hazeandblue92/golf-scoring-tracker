/**
 * Match projection wiring (§8.6).
 *
 * Exercises the real snapshot -> engine -> publish pipeline for three defects
 * that are easy to hide in isolated engine tests:
 *   - matches from another round must not leak into this round's standings;
 *   - four-ball applies relative strokes per player before choosing best net;
 *   - a side whose balls are picked up concedes the hole without a fake score.
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

function matchRules(
  teamScoreSource: 'individual' | 'team_ball' = 'individual',
  multiRound = true,
) {
  return {
    format: 'match',
    schemaVersion: 1,
    metric: 'net',
    holeScope: Array.from({ length: 18 }, (_, index) => index + 1),
    handicap: {
      profile: 'usga_whs_2024',
      allowance: 1,
      rounding: 'half_up_toward_positive_infinity',
      matchNormalizeFromLowest: true,
      allocation: 'stroke_index',
    },
    ties: { mode: 'tied', sequence: [] },
    incomplete: { live: 'provisional', final: 'no_return' },
    visibility: 'league',
    team: { teamSize: 2, bestK: 1, scoreSource: teamScoreSource },
    ...(multiRound ? { multiRound: { aggregation: 'match_points' } } : {}),
  }
}

async function rebuild(fx: ScoringFixture) {
  let response: Awaited<ReturnType<typeof callFunction>> | undefined
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await callFunction(
      'rebuild-projections',
      { eventId: fx.eventId },
      fx.director.accessToken,
    )
    if (response.status === 200) return response
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 5_000 * (attempt + 1)))
    }
  }
  return response
}

describe('match projection pipeline (§8.6)', () => {
  let fx: ScoringFixture
  let competitionId: string
  let teamBallCompetitionId: string
  let missingHandicapCompetitionId: string
  let teamAId: string
  let teamBId: string
  let sideAEntityId: string
  let sideBEntityId: string
  let thirdEntityId: string
  let matchId: string
  let secondMatchId: string
  let otherRoundId: string
  let otherRoundHoles: Array<{ id: string }>

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    fx = await buildScoringFixture({ playerCount: 4 })

    teamAId = randomUUID()
    teamBId = randomUUID()
    const missingTeamId = randomUUID()
    const missingOpponentTeamId = randomUUID()
    const missingParticipantId = randomUUID()
    const missingEntryId = randomUUID()
    const missingParticipant = await fx.service.from('participants').insert({
      id: missingParticipantId,
      league_id: LEAGUE_ID,
      profile_id: null,
      display_name: 'Missing match handicap',
      sort_name: 'handicap, missing match',
      status: 'active',
    })
    if (missingParticipant.error) throw missingParticipant.error
    const missingEntry = await fx.service.from('event_entries').insert({
      id: missingEntryId,
      event_id: fx.eventId,
      participant_id: missingParticipantId,
      status: 'active',
      handicap_source: 'none',
      handicap_value: null,
      course_handicap_unrounded: null,
      playing_handicap: null,
      allowance: 1,
      handicap_profile: 'none',
    })
    if (missingEntry.error) throw missingEntry.error

    const teams = await fx.service.from('event_teams').insert([
      {
        id: teamAId,
        event_id: fx.eventId,
        name: `Match A ${teamAId.slice(0, 8)}`,
        status: 'active',
        course_handicap_unrounded: 0,
        playing_handicap: 0,
        allowance: 1,
      },
      {
        id: teamBId,
        event_id: fx.eventId,
        name: `Match B ${teamBId.slice(0, 8)}`,
        status: 'active',
        course_handicap_unrounded: 0,
        playing_handicap: 0,
        allowance: 1,
      },
      {
        id: missingTeamId,
        event_id: fx.eventId,
        name: `Missing CH ${missingTeamId.slice(0, 8)}`,
        status: 'active',
        course_handicap_unrounded: 0,
        playing_handicap: 0,
        allowance: 1,
      },
      {
        id: missingOpponentTeamId,
        event_id: fx.eventId,
        name: `Missing CH opponents ${missingOpponentTeamId.slice(0, 8)}`,
        status: 'active',
        course_handicap_unrounded: 0,
        playing_handicap: 0,
        allowance: 1,
      },
    ])
    if (teams.error) throw teams.error

    // Deliberately mix low/high handicaps on each side. On hole 1 (SI 5),
    // gross best ball is 4-4, but player-relative net best ball is 4-3 to B.
    const members = await fx.service.from('event_team_members').insert([
      { event_team_id: teamAId, event_entry_id: fx.entries[0].entryId, position: 1 },
      { event_team_id: teamAId, event_entry_id: fx.entries[3].entryId, position: 2 },
      { event_team_id: teamBId, event_entry_id: fx.entries[1].entryId, position: 1 },
      { event_team_id: teamBId, event_entry_id: fx.entries[2].entryId, position: 2 },
      { event_team_id: missingTeamId, event_entry_id: missingEntryId, position: 1 },
      { event_team_id: missingTeamId, event_entry_id: fx.entries[0].entryId, position: 2 },
      {
        event_team_id: missingOpponentTeamId,
        event_entry_id: fx.entries[1].entryId,
        position: 1,
      },
      {
        event_team_id: missingOpponentTeamId,
        event_entry_id: fx.entries[2].entryId,
        position: 2,
      },
    ])
    if (members.error) throw members.error

    competitionId = randomUUID()
    teamBallCompetitionId = randomUUID()
    missingHandicapCompetitionId = randomUUID()
    const competition = await fx.service.from('competitions').insert([
      {
        id: competitionId,
        event_id: fx.eventId,
        name: 'Net four-ball match',
        format: 'match',
        metric: 'net',
        status: 'scoring_open',
        rules_schema_version: 1,
        rules_json: matchRules(),
        engine_version: 'test',
        sort_order: 40,
      },
      {
        id: teamBallCompetitionId,
        event_id: fx.eventId,
        name: 'Frozen team-ball match',
        format: 'match',
        metric: 'net',
        status: 'scoring_open',
        rules_schema_version: 1,
        rules_json: matchRules('team_ball', false),
        engine_version: 'test',
        sort_order: 41,
      },
      {
        id: missingHandicapCompetitionId,
        event_id: fx.eventId,
        name: 'Net match with missing CH',
        format: 'match',
        metric: 'net',
        status: 'scoring_open',
        rules_schema_version: 1,
        rules_json: matchRules('individual', false),
        engine_version: 'test',
        sort_order: 42,
      },
    ])
    if (competition.error) throw competition.error

    sideAEntityId = randomUUID()
    sideBEntityId = randomUUID()
    thirdEntityId = randomUUID()
    const teamBallSideAEntityId = randomUUID()
    const teamBallSideBEntityId = randomUUID()
    const missingSideEntityId = randomUUID()
    const missingOpponentEntityId = randomUUID()
    const entities = await fx.service.from('competition_entities').insert([
      {
        id: sideAEntityId,
        competition_id: competitionId,
        event_team_id: teamAId,
        eligibility_status: 'eligible',
      },
      {
        id: sideBEntityId,
        competition_id: competitionId,
        event_team_id: teamBId,
        eligibility_status: 'eligible',
      },
      {
        // A third valid entity of this competition that is not a match side,
        // so the winner-must-be-a-side constraint has something to point at.
        id: thirdEntityId,
        competition_id: competitionId,
        event_entry_id: fx.entries[0].entryId,
        eligibility_status: 'eligible',
      },
      {
        id: teamBallSideAEntityId,
        competition_id: teamBallCompetitionId,
        event_team_id: teamAId,
        eligibility_status: 'eligible',
      },
      {
        id: teamBallSideBEntityId,
        competition_id: teamBallCompetitionId,
        event_team_id: teamBId,
        eligibility_status: 'eligible',
      },
      {
        id: missingSideEntityId,
        competition_id: missingHandicapCompetitionId,
        event_team_id: missingTeamId,
        eligibility_status: 'eligible',
      },
      {
        id: missingOpponentEntityId,
        competition_id: missingHandicapCompetitionId,
        event_team_id: missingOpponentTeamId,
        eligibility_status: 'eligible',
      },
    ])
    if (entities.error) throw entities.error

    matchId = randomUUID()
    otherRoundId = randomUUID()
    const otherRound = await fx.service.from('rounds').insert({
      id: otherRoundId,
      event_id: fx.eventId,
      round_number: 2,
      name: 'Unlinked match round',
      hole_count: 18,
      status: 'scheduled',
    })
    if (otherRound.error) throw otherRound.error

    const snapshotId = randomUUID()
    const snapshot = await fx.service.from('event_tee_snapshots').insert({
      id: snapshotId,
      round_id: otherRoundId,
      source_tee_set_id: TEE_SET_BLUE,
      course_name: 'GTT Dev Course',
      layout_name: 'Championship 18',
      tee_name: 'Blue',
      course_rating: 71.4,
      slope_rating: 128,
      par: 72,
      hole_count: 18,
      snapshot_version: 1,
      snapshot_hash: `match-r2-${snapshotId.slice(0, 8)}`,
      created_at: new Date().toISOString(),
    })
    if (snapshot.error) throw snapshot.error

    const otherHoleRows = fx.holes.map((hole) => ({
      id: randomUUID(),
      round_id: otherRoundId,
      event_tee_snapshot_id: snapshotId,
      hole_ordinal: hole.ordinal,
      label: String(hole.ordinal),
      par: hole.par,
      stroke_index: hole.strokeIndex,
    }))
    const otherHoles = await fx.service.from('event_holes').insert(otherHoleRows)
    if (otherHoles.error) throw otherHoles.error
    otherRoundHoles = otherHoleRows.map((hole) => ({ id: hole.id }))

    const primaryGroupId = randomUUID()
    const missingGroupId = randomUUID()
    const secondRoundGroupId = randomUUID()
    const groups = await fx.service.from('groups').insert([
      {
        id: primaryGroupId,
        round_id: fx.roundId,
        label: 'Match shotgun group',
        start_hole_ordinal: 10,
        sort_order: 1,
      },
      {
        id: missingGroupId,
        round_id: fx.roundId,
        label: 'Missing handicap match group',
        start_hole_ordinal: 1,
        sort_order: 2,
      },
      {
        id: secondRoundGroupId,
        round_id: otherRoundId,
        label: 'Second match group',
        start_hole_ordinal: 1,
        sort_order: 1,
      },
    ])
    if (groups.error) throw groups.error
    const groupMembers = await fx.service.from('group_members').insert([
      { group_id: primaryGroupId, event_team_id: teamAId, sort_order: 1 },
      { group_id: primaryGroupId, event_team_id: teamBId, sort_order: 2 },
      { group_id: missingGroupId, event_team_id: missingTeamId, sort_order: 1 },
      { group_id: missingGroupId, event_team_id: missingOpponentTeamId, sort_order: 2 },
      { group_id: secondRoundGroupId, event_team_id: teamAId, sort_order: 1 },
      { group_id: secondRoundGroupId, event_team_id: teamBId, sort_order: 2 },
    ])
    if (groupMembers.error) throw groupMembers.error

    const links = await fx.service.from('competition_rounds').insert([
      {
        competition_id: competitionId,
        round_id: fx.roundId,
        hole_scope: null,
        weight: 1,
      },
      {
        competition_id: competitionId,
        round_id: otherRoundId,
        hole_scope: null,
        weight: 1,
      },
      {
        competition_id: teamBallCompetitionId,
        round_id: fx.roundId,
        hole_scope: null,
        weight: 1,
      },
      {
        competition_id: missingHandicapCompetitionId,
        round_id: fx.roundId,
        hole_scope: null,
        weight: 1,
      },
    ])
    if (links.error) throw links.error

    secondMatchId = randomUUID()
    const matches = await fx.service.from('matches').insert([
      {
        id: matchId,
        competition_id: competitionId,
        round_id: fx.roundId,
        side_a_entity_id: sideAEntityId,
        side_b_entity_id: sideBEntityId,
        bracket_position: 1,
        status: 'conceded',
        winner_entity_id: sideBEntityId,
      },
      {
        id: secondMatchId,
        competition_id: competitionId,
        round_id: otherRoundId,
        side_a_entity_id: sideAEntityId,
        side_b_entity_id: sideBEntityId,
        bracket_position: 2,
        status: 'conceded',
        winner_entity_id: sideAEntityId,
      },
      // Every row carries an explicit id: a batch insert sends the union of
      // all row keys, so one row omitting `id` posts an explicit null for the
      // whole batch and defeats the column default.
      {
        id: randomUUID(),
        competition_id: teamBallCompetitionId,
        round_id: fx.roundId,
        side_a_entity_id: teamBallSideAEntityId,
        side_b_entity_id: teamBallSideBEntityId,
        bracket_position: 1,
        status: 'complete',
        winner_entity_id: teamBallSideAEntityId,
      },
      {
        id: randomUUID(),
        competition_id: missingHandicapCompetitionId,
        round_id: fx.roundId,
        side_a_entity_id: missingSideEntityId,
        side_b_entity_id: missingOpponentEntityId,
        bracket_position: 1,
        status: 'scheduled',
        winner_entity_id: null,
      },
    ])
    if (matches.error) throw matches.error

    const scores = await fx.service.from('individual_hole_scores').insert([
      {
        event_id: fx.eventId,
        round_id: fx.roundId,
        event_entry_id: fx.entries[0].entryId,
        event_hole_id: fx.holes[0].id,
        gross_strokes: 4,
        score_status: 'complete',
        revision: 1,
      },
      {
        event_id: fx.eventId,
        round_id: fx.roundId,
        event_entry_id: missingEntryId,
        event_hole_id: fx.holes[0].id,
        gross_strokes: 3,
        score_status: 'complete',
        revision: 1,
      },
      {
        event_id: fx.eventId,
        round_id: fx.roundId,
        event_entry_id: fx.entries[3].entryId,
        event_hole_id: fx.holes[0].id,
        gross_strokes: 5,
        score_status: 'complete',
        revision: 1,
      },
      {
        event_id: fx.eventId,
        round_id: fx.roundId,
        event_entry_id: fx.entries[1].entryId,
        event_hole_id: fx.holes[0].id,
        gross_strokes: 4,
        score_status: 'complete',
        revision: 1,
      },
      {
        event_id: fx.eventId,
        round_id: fx.roundId,
        event_entry_id: fx.entries[2].entryId,
        event_hole_id: fx.holes[0].id,
        gross_strokes: 5,
        score_status: 'complete',
        revision: 1,
      },
      {
        event_id: fx.eventId,
        round_id: fx.roundId,
        event_entry_id: fx.entries[0].entryId,
        event_hole_id: fx.holes[1].id,
        gross_strokes: null,
        score_status: 'picked_up',
        revision: 1,
      },
      {
        event_id: fx.eventId,
        round_id: fx.roundId,
        event_entry_id: fx.entries[3].entryId,
        event_hole_id: fx.holes[1].id,
        gross_strokes: null,
        score_status: 'picked_up',
        revision: 1,
      },
      // Hole three has one completed A ball but its partner is still missing.
      // B's two complete 5s must not lose to A's provisional side 4.
      {
        event_id: fx.eventId,
        round_id: fx.roundId,
        event_entry_id: fx.entries[0].entryId,
        event_hole_id: fx.holes[2].id,
        gross_strokes: 4,
        score_status: 'complete',
        revision: 1,
      },
      ...[fx.entries[1].entryId, fx.entries[2].entryId].map((eventEntryId) => ({
        event_id: fx.eventId,
        round_id: fx.roundId,
        event_entry_id: eventEntryId,
        event_hole_id: fx.holes[2].id,
        gross_strokes: 5,
        score_status: 'complete',
        revision: 1,
      })),
      // The shared frozen group starts on hole 10. This played hole must be
      // evaluated in front of course ordinals 1-9.
      ...[
        { eventEntryId: fx.entries[0].entryId, grossStrokes: 3 },
        { eventEntryId: fx.entries[3].entryId, grossStrokes: 4 },
        { eventEntryId: fx.entries[1].entryId, grossStrokes: 6 },
        { eventEntryId: fx.entries[2].entryId, grossStrokes: 7 },
      ].map(({ eventEntryId, grossStrokes }) => ({
        event_id: fx.eventId,
        round_id: fx.roundId,
        event_entry_id: eventEntryId,
        event_hole_id: fx.holes[9].id,
        gross_strokes: grossStrokes,
        score_status: 'complete',
        revision: 1,
      })),
      // Round two reverses the result: both B balls pick up on each match
      // hole, awarding A a 2-hole win and a deterministic two match points.
      ...[otherRoundHoles[0].id, otherRoundHoles[1].id].flatMap((eventHoleId) => [
        {
          event_id: fx.eventId,
          round_id: otherRoundId,
          event_entry_id: fx.entries[1].entryId,
          event_hole_id: eventHoleId,
          gross_strokes: null,
          score_status: 'picked_up',
          revision: 1,
        },
        {
          event_id: fx.eventId,
          round_id: otherRoundId,
          event_entry_id: fx.entries[2].entryId,
          event_hole_id: eventHoleId,
          gross_strokes: null,
          score_status: 'picked_up',
          revision: 1,
        },
      ]),
    ])
    if (scores.error) throw scores.error

    // These coexist with the individual cards above. The frozen Terms choose
    // team_ball only for the dedicated team-ball competition; the four-ball
    // match must keep using member scores despite these alternate raw facts.
    const teamScores = await fx.service.from('team_hole_scores').insert([
      {
        event_id: fx.eventId,
        round_id: fx.roundId,
        event_team_id: teamAId,
        event_hole_id: fx.holes[0].id,
        gross_strokes: 4,
        score_status: 'complete',
        revision: 1,
      },
      {
        event_id: fx.eventId,
        round_id: fx.roundId,
        event_team_id: teamBId,
        event_hole_id: fx.holes[0].id,
        gross_strokes: 5,
        score_status: 'complete',
        revision: 1,
      },
    ])
    if (teamScores.error) throw teamScores.error

    const response = await rebuild(fx)
    expect(response?.status, JSON.stringify(response?.body)).toBe(200)
  }, 180_000)

  it('uses only the pairing linked to the projected round', async () => {
    const newest = await fx.service
      .from('leaderboard_rows')
      .select('event_revision')
      .eq('competition_id', competitionId)
      .order('event_revision', { ascending: false })
      .limit(1)
      .maybeSingle()
    const { data, error } = await fx.service
      .from('leaderboard_rows')
      .select('entity_id, result_primary, detail_json')
      .eq('competition_id', competitionId)
      .eq('event_revision', Number(newest.data?.event_revision ?? -1))
      .order('entity_id')
    if (error) throw error

    // Two match sides plus the unpaired probe entity — one row per declared
    // entity of this competition, and nothing leaked in from the other round's
    // pairing.
    expect(data).toHaveLength(3)
    const sideA = data?.find((row) => row.entity_id === sideAEntityId)
    const sideB = data?.find((row) => row.entity_id === sideBEntityId)
    expect(Number(sideA?.result_primary)).toBe(2)
    expect(Number(sideB?.result_primary)).toBe(2)

    type MatchRoundDetail = {
      roundId: string
      value: number
      detail?: { matchId?: string; matchPoints?: number; holesUp?: number }
    }
    const rounds = (sideA?.detail_json as { rounds?: MatchRoundDetail[] })?.rounds
    expect(rounds).toHaveLength(2)
    expect(rounds).toEqual(expect.arrayContaining([
      expect.objectContaining({
        roundId: fx.roundId,
        value: 0,
        detail: expect.objectContaining({ matchId, matchPoints: 0, holesUp: -1 }),
      }),
      expect.objectContaining({
        roundId: otherRoundId,
        value: 2,
        detail: expect.objectContaining({
          matchId: secondMatchId,
          matchPoints: 2,
          holesUp: 2,
        }),
      }),
    ]))
  })

  it('allocates player-relative strokes before selecting the best net ball', async () => {
    const { data, error } = await fx.service
      .from('hole_results')
      .select('entity_id, gross, strokes_received, net, match_result, contributor_entry_ids')
      .eq('competition_id', competitionId)
      .eq('event_hole_id', fx.holes[0].id)
    if (error) throw error

    const sideB = data?.find((row) => row.entity_id === sideBEntityId)
    expect(sideB).toMatchObject({
      gross: 4,
      strokes_received: 1,
      net: 3,
      match_result: 'win',
    })
    expect(sideB?.contributor_entry_ids).toEqual([fx.entries[1].entryId])
  })

  it('preserves picked-up status while awarding the conceded hole', async () => {
    const { data, error } = await fx.service
      .from('hole_results')
      .select('entity_id, gross, status, match_result')
      .eq('competition_id', competitionId)
      .eq('event_hole_id', fx.holes[1].id)
    if (error) throw error

    const sideA = data?.find((row) => row.entity_id === sideAEntityId)
    expect(sideA).toMatchObject({
      gross: null,
      status: 'picked_up',
      match_result: 'loss',
    })
  })

  it('keeps a four-ball hole undetermined until every partner ball is resolved', async () => {
    const { data, error } = await fx.service
      .from('hole_results')
      .select('entity_id,gross,status,match_result')
      .eq('competition_id', competitionId)
      .eq('event_hole_id', fx.holes[2].id)
    if (error) throw error

    // A's side has one completed 4 and one ball still missing, so the hole is
    // undetermined and the engine publishes no outcome for it. The failure
    // this guards against is B's two completed 5s losing the hole to A's
    // provisional side score.
    expect(data ?? []).toEqual([])
  })

  it('keeps a net match unresolved when any frozen Course Handicap is missing', async () => {
    const [{ data: projection, error: projectionError }, { data: rows, error: rowsError }] =
      await Promise.all([
        fx.service
          .from('competition_projections')
          .select('status,warnings,summary_json')
          .eq('competition_id', missingHandicapCompetitionId)
          .order('event_revision', { ascending: false })
          .limit(1)
          .single(),
        fx.service
          .from('leaderboard_rows')
          .select('status,result_primary,detail_json')
          .eq('competition_id', missingHandicapCompetitionId),
      ])
    if (projectionError || rowsError) throw projectionError ?? rowsError

    expect(projection.status).toBe('live')
    expect(projection.summary_json).toMatchObject({ provisional: true })
    expect(projection.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MATCH_NET_HANDICAP_MISSING' }),
    ]))
    expect(rows).toHaveLength(2)
    expect(rows?.every((row) => row.status === 'provisional')).toBe(true)
    expect(rows?.every((row) =>
      (row.detail_json as { matchStatus?: string }).matchStatus === 'in_progress'
    )).toBe(true)

    const { data: decidedHoles, error: holeError } = await fx.service
      .from('hole_results')
      .select('match_result')
      .eq('competition_id', missingHandicapCompetitionId)
      .not('match_result', 'is', null)
    if (holeError) throw holeError
    expect(decidedHoles).toEqual([])
  })

  it('rejects competition columns that disagree with frozen rules', async () => {
    // Projection dispatch reads rules_json while workflow dispatch reads the
    // indexed columns, so a match competition labelled individual_stroke would
    // route two different ways. The engine still emits RULES_COLUMN_MISMATCH
    // for restored data, but the row can no longer be created here at all.
    const mismatch = await fx.service.from('competitions').insert({
      id: randomUUID(),
      event_id: fx.eventId,
      name: 'Column and frozen rules mismatch',
      format: 'individual_stroke',
      metric: 'gross',
      status: 'scoring_open',
      rules_schema_version: 1,
      rules_json: matchRules('individual', false),
      engine_version: 'test',
      sort_order: 43,
    })

    expect(mismatch.error?.code).toBe('23514')
  })

  it('rejects a conceded winner that is not either match side', async () => {
    const invalid = await fx.service.from('matches')
      .update({ winner_entity_id: thirdEntityId })
      .eq('id', matchId)

    expect(invalid.error).not.toBeNull()
    expect(invalid.error?.code).toBe('23514')
  })

  it('publishes a scoreless walkover as an authoritative terminal win', async () => {
    const walkover = await fx.service.from('matches')
      .update({ status: 'walkover', winner_entity_id: sideAEntityId })
      .eq('id', secondMatchId)
    if (walkover.error) throw walkover.error

    try {
      const response = await rebuild(fx)
      expect(response?.status, JSON.stringify(response?.body)).toBe(200)

      const { data, error } = await fx.service
        .from('leaderboard_rows')
        .select('entity_id,result_primary,status,detail_json')
        .eq('competition_id', competitionId)
        .eq('entity_id', sideAEntityId)
        .single()
      if (error) throw error

      type RoundDetail = {
        roundId: string
        detail?: { matchStatus?: string; matchPoints?: number; outcome?: string }
      }
      const rounds = (data.detail_json as { rounds?: RoundDetail[] })?.rounds
      expect(Number(data.result_primary)).toBe(2)
      expect(data.status).toBe('complete')
      expect(rounds).toContainEqual(expect.objectContaining({
        roundId: otherRoundId,
        detail: expect.objectContaining({
          matchStatus: 'won',
          matchPoints: 2,
          outcome: 'won',
        }),
      }))
    } finally {
      const restored = await fx.service.from('matches')
        .update({ status: 'conceded', winner_entity_id: sideAEntityId })
        .eq('id', secondMatchId)
      expect(restored.error).toBeNull()
      const response = await rebuild(fx)
      expect(response?.status, JSON.stringify(response?.body)).toBe(200)
    }
  })

  it('blocks finalization while any pairing is still scheduled without closing scoring', async () => {
    const scheduled = await fx.service.from('matches')
      .update({ status: 'scheduled', winner_entity_id: null })
      .eq('id', matchId)
    if (scheduled.error) throw scheduled.error

    try {
      const blocked = await callFunction<{ status: string; matchBlockers?: number }>(
        'finalize-competition',
        { competitionId, overrideReason: null },
        fx.director.accessToken,
      )
      expect(blocked.status, JSON.stringify(blocked.body)).toBe(409)
      expect(blocked.body.status).toBe('blocked')
      expect(blocked.body.matchBlockers).toBeGreaterThan(0)

      const { data: event, error } = await fx.service
        .from('events')
        .select('status')
        .eq('id', fx.eventId)
        .single()
      if (error) throw error
      expect(event.status).toBe('scoring_open')
    } finally {
      const restored = await fx.service.from('matches')
        .update({ status: 'conceded', winner_entity_id: sideBEntityId })
        .eq('id', matchId)
      expect(restored.error).toBeNull()
    }
  })

  it('requires both frozen team-ball cards to be attested before finalization', async () => {
    const blocked = await callFunction<{ status: string; unattestedCards?: number }>(
      'finalize-competition',
      { competitionId: teamBallCompetitionId, overrideReason: null },
      fx.director.accessToken,
    )
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409)
    expect(blocked.body.status).toBe('blocked')
    expect(blocked.body.unattestedCards).toBe(2)

    for (const teamId of [teamAId, teamBId]) {
      const attested = await callFunction<{ status: string }>(
        'attest-scorecard',
        {
          roundId: fx.roundId,
          targetKind: 'team',
          targetId: teamId,
          attestationType: 'director_override',
          reason: 'Integration team-ball match attestation',
        },
        fx.director.accessToken,
      )
      expect(attested.status, JSON.stringify(attested.body)).toBe(200)
      expect(attested.body.status).toBe('attested')
    }

    const finalized = await callFunction<{ status: string; finalResultHash?: string }>(
      'finalize-competition',
      { competitionId: teamBallCompetitionId, overrideReason: null },
      fx.director.accessToken,
    )
    expect(finalized.status, JSON.stringify(finalized.body)).toBe(200)
    expect(finalized.body.status).toBe('finalized')
    expect(finalized.body.finalResultHash).toMatch(/^[0-9a-f]{64}$/)
  })
})
