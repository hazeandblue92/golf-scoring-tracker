/**
 * Consistent scoring-snapshot read (spec §7.2 step 4: "Edge Function reads a
 * consistent scoring snapshot for the returned revision").
 *
 * Everything the engine needs to recompute every competition in one event,
 * read in a single pass with the service client. The snapshot carries the
 * event's scoring_revision it was read at; the publisher refuses to publish
 * if the event has moved on (§7.2 step 5).
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

export interface SnapshotHole {
  id: string
  round_id: string
  hole_ordinal: number
  par: number
  stroke_index: number
}

export interface SnapshotEntry {
  id: string
  event_id: string
  participant_id: string
  status: string
  course_handicap_unrounded: number | null
  playing_handicap: number | null
  flight_id: string | null
}

export interface SnapshotTeam {
  id: string
  event_id: string
  name: string
  status: string | null
  playing_handicap: number | null
}

export interface SnapshotCompetition {
  id: string
  event_id: string
  name: string
  format: string
  metric: string
  status: string | null
  rules_schema_version: number
  rules_json: unknown
  engine_version: string | null
}

export interface SnapshotCompetitionEntity {
  id: string
  competition_id: string
  event_entry_id: string | null
  event_team_id: string | null
  eligibility_status: string | null
  flight_id: string | null
}

export interface SnapshotIndividualScore {
  event_entry_id: string
  event_hole_id: string
  gross_strokes: number | null
  score_status: string
  revision: number
}

export interface SnapshotTeamScore {
  event_team_id: string
  event_hole_id: string
  gross_strokes: number | null
  score_status: string
  revision: number
}

/**
 * A match-play pairing (§8.6). Sides are competition_entities, so one row can
 * pair two individuals, two best-ball teams, or two team balls without the
 * projection layer caring which.
 */
export interface SnapshotMatch {
  id: string
  competition_id: string
  round_id: string
  side_a_entity_id: string | null
  side_b_entity_id: string | null
  bracket_position: number | null
  status: string
  winner_entity_id: string | null
  concession_by: string | null
}

export interface ScoringSnapshot {
  event: { id: string; status: string; scoring_revision: number }
  holes: SnapshotHole[]
  entries: SnapshotEntry[]
  teams: SnapshotTeam[]
  teamMembers: Array<{ event_team_id: string; event_entry_id: string }>
  competitions: SnapshotCompetition[]
  competitionRounds: Array<{
    competition_id: string
    round_id: string
    hole_scope: number[] | null
    /** Per-round weight applied by §8.14 aggregation; defaults to 1. */
    weight: number | null
  }>
  competitionEntities: SnapshotCompetitionEntity[]
  matches: SnapshotMatch[]
  individualScores: SnapshotIndividualScore[]
  teamScores: SnapshotTeamScore[]
}

async function selectAll<T>(
  service: SupabaseClient,
  table: string,
  columns: string,
  filter: (q: any) => any,
): Promise<T[]> {
  const { data, error } = await filter(service.from(table).select(columns))
  if (error) throw new Error(`snapshot read failed for ${table}: ${error.message}`)
  return (data ?? []) as T[]
}

export async function loadScoringSnapshot(
  service: SupabaseClient,
  eventId: string,
): Promise<ScoringSnapshot> {
  const { data: eventRow, error: eventError } = await service
    .from('events')
    .select('id, status, scoring_revision')
    .eq('id', eventId)
    .single()
  if (eventError || !eventRow) {
    throw new Error(`snapshot read failed for events: ${eventError?.message ?? 'not found'}`)
  }

  const rounds = await selectAll<{ id: string }>(
    service, 'rounds', 'id', (q) => q.eq('event_id', eventId),
  )
  const roundIds = rounds.map((r) => r.id)

  const [
    holes,
    entries,
    teams,
    competitions,
    competitionRounds,
    individualScores,
    teamScores,
  ] = await Promise.all([
    roundIds.length
      ? selectAll<SnapshotHole>(
          service, 'event_holes', 'id, round_id, hole_ordinal, par, stroke_index',
          (q) => q.in('round_id', roundIds).order('hole_ordinal'),
        )
      : Promise.resolve([]),
    selectAll<SnapshotEntry>(
      service, 'event_entries',
      'id, event_id, participant_id, status, course_handicap_unrounded, playing_handicap, flight_id',
      (q) => q.eq('event_id', eventId),
    ),
    selectAll<SnapshotTeam>(
      service, 'event_teams', 'id, event_id, name, status, playing_handicap',
      (q) => q.eq('event_id', eventId),
    ),
    selectAll<SnapshotCompetition>(
      service, 'competitions',
      'id, event_id, name, format, metric, status, rules_schema_version, rules_json, engine_version',
      (q) => q.eq('event_id', eventId).order('sort_order'),
    ),
    selectAll<{
      competition_id: string
      round_id: string
      hole_scope: number[] | null
      weight: number | null
    }>(
      service, 'competition_rounds', 'competition_id, round_id, hole_scope, weight',
      (q) => (roundIds.length ? q.in('round_id', roundIds) : q.limit(0)),
    ),
    selectAll<SnapshotIndividualScore>(
      service, 'individual_hole_scores',
      'event_entry_id, event_hole_id, gross_strokes, score_status, revision',
      (q) => q.eq('event_id', eventId),
    ),
    selectAll<SnapshotTeamScore>(
      service, 'team_hole_scores',
      'event_team_id, event_hole_id, gross_strokes, score_status, revision',
      (q) => q.eq('event_id', eventId),
    ),
  ])

  const competitionIds = competitions.map((c) => c.id)
  const teamIds = teams.map((t) => t.id)

  const [competitionEntities, teamMembers, matches] = await Promise.all([
    competitionIds.length
      ? selectAll<SnapshotCompetitionEntity>(
          service, 'competition_entities',
          'id, competition_id, event_entry_id, event_team_id, eligibility_status, flight_id',
          (q) => q.in('competition_id', competitionIds),
        )
      : Promise.resolve([]),
    teamIds.length
      ? selectAll<{ event_team_id: string; event_entry_id: string }>(
          service, 'event_team_members', 'event_team_id, event_entry_id',
          (q) => q.in('event_team_id', teamIds),
        )
      : Promise.resolve([]),
    competitionIds.length
      ? selectAll<SnapshotMatch>(
          service, 'matches',
          'id, competition_id, round_id, side_a_entity_id, side_b_entity_id, ' +
            'bracket_position, status, winner_entity_id, concession_by',
          (q) => q.in('competition_id', competitionIds).order('bracket_position'),
        )
      : Promise.resolve([]),
  ])

  return {
    event: {
      id: eventRow.id as string,
      status: eventRow.status as string,
      scoring_revision: Number(eventRow.scoring_revision),
    },
    holes,
    entries,
    teams,
    teamMembers,
    matches,
    competitions,
    competitionRounds,
    competitionEntities,
    individualScores,
    teamScores,
  }
}
