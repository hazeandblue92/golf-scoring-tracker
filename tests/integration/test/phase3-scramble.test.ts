import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  percent,
  rational,
  scrambleTeamHandicap,
  type Rational,
} from '../../../packages/scoring/src/index.ts'
import { createAccount, LEAGUE_ID, SEASON_ID, TEE_SET_BLUE } from '../helpers/fixture.ts'
import { callFunction, serviceClient, stackIsUp } from '../helpers/stack.ts'

const PLAYERS = Array.from(
  { length: 8 },
  (_, index) => `00000000-0000-4000-8000-${String(201 + index).padStart(12, '0')}`,
)

const SCENARIOS = [
  {
    preset: 'three_player_scramble',
    teamSize: 3,
    players: PLAYERS.slice(0, 6),
    weights: [percent(30), percent(20), percent(10)],
  },
  {
    preset: 'four_player_scramble',
    teamSize: 4,
    players: PLAYERS,
    weights: [percent(25), percent(20), percent(15), percent(10)],
  },
] as const

describe('Phase 3 three- and four-player scramble workflow', () => {
  const service = serviceClient()
  let owner: Awaited<ReturnType<typeof createAccount>>

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    owner = await createAccount(service, { displayName: 'Phase 3 Scramble Owner' })
    const membership = await service.from('league_memberships').insert({
      league_id: LEAGUE_ID,
      profile_id: owner.profileId,
      member_status: 'active',
    })
    if (membership.error) throw membership.error
    const role = await service.from('role_assignments').insert({
      league_id: LEAGUE_ID,
      profile_id: owner.profileId,
      role: 'owner',
    })
    if (role.error) throw role.error
  }, 60_000)

  for (const scenario of SCENARIOS) {
    it(`freezes and scores a ${scenario.teamSize}-player team-ball event`, async () => {
      const teams = [
        { name: 'Team Alpha', participantIds: scenario.players.slice(0, scenario.teamSize) },
        { name: 'Team Beta', participantIds: scenario.players.slice(scenario.teamSize) },
      ]
      const saved = await callFunction<{
        eventId: string
        roundId: string
        competitionIds: string[]
      }>('save-event-draft', {
        leagueId: LEAGUE_ID,
        seasonId: SEASON_ID,
        name: `${scenario.teamSize}-Player Scramble ${randomUUID().slice(0, 8)}`,
        timezone: 'America/Detroit',
        startsAt: new Date(Date.now() + 172_800_000).toISOString(),
        endsAt: null,
        visibility: 'league',
        teeSetId: TEE_SET_BLUE,
        participantIds: scenario.players,
        scorerProfileIds: [],
        competitionPreset: scenario.preset,
        teams,
      }, owner.accessToken)
      expect(saved.status, JSON.stringify(saved.body)).toBe(200)
      expect(saved.body.competitionIds).toHaveLength(2)

      const published = await callFunction<{
        status: string
        teamSnapshotCount: number
      }>('publish-event', {
        eventId: saved.body.eventId,
        openScoring: true,
      }, owner.accessToken)
      expect(published.status, JSON.stringify(published.body)).toBe(200)
      expect(published.body.status).toBe('scoring_open')
      expect(published.body.teamSnapshotCount).toBe(2)

      const [teamRows, competitionRows, holeRow] = await Promise.all([
        service.from('event_teams')
          .select('id,name,course_handicap_unrounded,playing_handicap,snapshot_hash,event_team_members(position,event_entries(id,participant_id,course_handicap_unrounded))')
          .eq('event_id', saved.body.eventId)
          .order('name'),
        service.from('competitions')
          .select('id,name,format,metric,rules_json,status')
          .eq('event_id', saved.body.eventId)
          .order('sort_order'),
        service.from('event_holes')
          .select('id')
          .eq('round_id', saved.body.roundId)
          .eq('hole_ordinal', 1)
          .single(),
      ])
      if (teamRows.error || competitionRows.error || holeRow.error) {
        throw teamRows.error ?? competitionRows.error ?? holeRow.error
      }
      expect(competitionRows.data?.map((competition) => [competition.format, competition.metric])).toEqual([
        ['scramble', 'gross'],
        ['scramble', 'net'],
      ])
      for (const competition of competitionRows.data ?? []) {
        expect(competition.status).toBe('scoring_open')
        expect(competition.rules_json).toMatchObject({
          format: 'scramble',
          team: {
            teamSize: scenario.teamSize,
            bestK: 1,
            scoreSource: 'team_ball',
            weights: scenario.weights.map((weight) => weight.num / weight.den),
          },
        })
      }

      const normalizedTeams = (teamRows.data ?? []) as unknown as Array<{
        id: string
        name: string
        course_handicap_unrounded: number
        playing_handicap: number
        snapshot_hash: string
        event_team_members: Array<{
          position: number
          event_entries: {
            id: string
            participant_id: string
            course_handicap_unrounded: number
          } | Array<{
            id: string
            participant_id: string
            course_handicap_unrounded: number
          }>
        }>
      }>
      for (const team of normalizedTeams) {
        expect(team.snapshot_hash).toMatch(/^[0-9a-f]{64}$/)
        expect(team.event_team_members).toHaveLength(scenario.teamSize)
        const courseHandicaps: Rational[] = team.event_team_members.map((member) => {
          const entry = Array.isArray(member.event_entries)
            ? member.event_entries[0]!
            : member.event_entries
          return rational(Math.round(Number(entry.course_handicap_unrounded) * 1_000_000), 1_000_000)
        })
        const expected = scrambleTeamHandicap(
          courseHandicaps,
          [...scenario.weights],
          { kind: 'usga_whs_2024' },
        )
        expect(Number(team.course_handicap_unrounded)).toBeCloseTo(
          expected.teamPlayingHandicapUnrounded.num / expected.teamPlayingHandicapUnrounded.den,
          6,
        )
        expect(team.playing_handicap).toBe(expected.teamPlayingHandicap)
      }

      let eventRevision = 0
      for (const [index, team] of normalizedTeams.entries()) {
        const submitted = await callFunction<{ status: string; eventRevision: number }>(
          'submit-score',
          {
            idempotencyKey: randomUUID(),
            eventId: saved.body.eventId,
            roundId: saved.body.roundId,
            target: { kind: 'team', teamId: team.id, holeId: holeRow.data.id },
            baseRevision: 0,
            value: { status: 'complete', grossStrokes: 4 + index, notes: null },
            clientRecordedAt: new Date().toISOString(),
            clientRelease: '0.1.0',
          },
          owner.accessToken,
        )
        expect(submitted.status).toBe(200)
        eventRevision = submitted.body.eventRevision
      }
      expect(eventRevision).toBe(2)

      const [projections, holeResults, individualScores] = await Promise.all([
        service.from('competition_projections')
          .select('competition_id,status,warnings')
          .in('competition_id', saved.body.competitionIds)
          .eq('event_revision', eventRevision),
        service.from('hole_results')
          .select('competition_id,entity_id,gross,strokes_received,net,provisional')
          .in('competition_id', saved.body.competitionIds)
          .eq('event_revision', eventRevision)
          .eq('event_hole_id', holeRow.data.id),
        service.from('individual_hole_scores')
          .select('id')
          .eq('event_id', saved.body.eventId),
      ])
      if (projections.error || holeResults.error || individualScores.error) {
        throw projections.error ?? holeResults.error ?? individualScores.error
      }
      expect(projections.data).toHaveLength(2)
      expect(projections.data?.every((projection) =>
        projection.status === 'live' && Array.isArray(projection.warnings))).toBe(true)
      expect(holeResults.data).toHaveLength(4)
      expect(holeResults.data?.map((result) => result.gross).toSorted()).toEqual([4, 4, 5, 5])
      expect(holeResults.data?.every((result) => result.provisional === false)).toBe(true)
      expect(individualScores.data).toEqual([])

      const attested = await callFunction<{ status: string; scoreRevision: number }>(
        'attest-scorecard',
        {
          roundId: saved.body.roundId,
          targetKind: 'team',
          targetId: normalizedTeams[0]!.id,
          attestationType: 'marker',
          reason: null,
        },
        owner.accessToken,
      )
      expect(attested.status).toBe(200)
      expect(attested.body.status).toBe('attested')
      expect(attested.body.scoreRevision).toBe(1)

      const finalized = await callFunction<{ missingScores: number; unattestedCards: number }>(
        'finalize-competition',
        { competitionId: saved.body.competitionIds[0], overrideReason: null },
        owner.accessToken,
      )
      expect(finalized.status).toBe(409)
      expect(finalized.body.missingScores).toBe(34)
      expect(finalized.body.unattestedCards).toBe(1)
    }, 60_000)
  }
})
