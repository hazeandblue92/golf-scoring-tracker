import { describe, expect, it } from 'vitest'

import { buildProjections } from '../../../supabase/functions/_shared/projection-orchestrator.ts'
import type {
  ScoringSnapshot,
  SnapshotCompetition,
  SnapshotCompetitionEntity,
  SnapshotEntry,
} from '../../../supabase/functions/_shared/snapshot.ts'

const handicap = {
  profile: 'none',
  allowance: 1,
  rounding: 'half_up_toward_positive_infinity',
  matchNormalizeFromLowest: false,
  allocation: 'stroke_index',
} as const

const commonRules = {
  schemaVersion: 1,
  metric: 'gross',
  holeScope: [1],
  handicap,
  ties: { mode: 'tied', sequence: [] },
  incomplete: { live: 'provisional', final: 'no_return' },
  visibility: 'league',
} as const

function snapshot(): ScoringSnapshot {
  return {
    event: { id: 'event', status: 'scoring_open', scoring_revision: 7 },
    rounds: [{ id: 'r1', round_number: 1 }],
    holes: [{
      id: 'h1',
      round_id: 'r1',
      hole_ordinal: 1,
      par: 4,
      stroke_index: 1,
    }],
    entries: [],
    teams: [],
    teamMembers: [],
    competitions: [],
    competitionRounds: [],
    competitionEntities: [],
    flights: [],
    groups: [],
    groupMembers: [],
    matches: [],
    individualScores: [],
    teamScores: [],
  }
}

function entry(
  id: string,
  overrides: Partial<SnapshotEntry> = {},
): SnapshotEntry {
  return {
    id,
    event_id: 'event',
    participant_id: `participant-${id}`,
    status: 'active',
    course_handicap_unrounded: 0,
    playing_handicap: 0,
    flight_id: null,
    effective_from_round_id: null,
    replaces_entry_id: null,
    ...overrides,
  }
}

function competition(
  id: string,
  rulesJson: unknown,
  overrides: Partial<SnapshotCompetition> = {},
): SnapshotCompetition {
  const rules = rulesJson as { format: string; metric: string }
  return {
    id,
    event_id: 'event',
    name: id,
    format: rules.format,
    metric: rules.metric,
    status: 'scoring_open',
    rules_schema_version: 1,
    rules_json: rulesJson,
    engine_version: 'test',
    ...overrides,
  }
}

function entity(
  id: string,
  competitionId: string,
  entryId: string,
): SnapshotCompetitionEntity {
  return {
    id,
    competition_id: competitionId,
    event_entry_id: entryId,
    event_team_id: null,
    eligibility_status: 'eligible',
    flight_id: null,
  }
}

function link(competitionId: string, roundId = 'r1') {
  return {
    competition_id: competitionId,
    round_id: roundId,
    round_number: 1,
    hole_scope: null,
    weight: 1,
  }
}

function completeScore(entryId: string, holeId: string, gross: number) {
  return {
    event_entry_id: entryId,
    event_hole_id: holeId,
    gross_strokes: gross,
    score_status: 'complete',
    revision: 1,
  }
}

describe('projection orchestrator boundary hardening', () => {
  it('partitions group skins into independent pools and carries', () => {
    const state = snapshot()
    const competitionId = 'group-skins'
    const rules = {
      ...commonRules,
      format: 'skins',
      skins: {
        population: 'group',
        carryMode: 'no_carry',
        unitsPerHole: 1,
        finalCarry: 'expire',
      },
    }
    state.competitions = [competition(competitionId, rules)]
    state.competitionRounds = [link(competitionId)]
    state.entries = ['e1', 'e2', 'e3', 'e4'].map((id) => entry(id))
    state.competitionEntities = state.entries.map((candidate) =>
      entity(`ce-${candidate.id}`, competitionId, candidate.id)
    )
    state.teamMembers = [
      { event_team_id: 'team-g1', event_entry_id: 'e1' },
      { event_team_id: 'team-g1', event_entry_id: 'e2' },
    ]
    state.groups = [
      { id: 'g1', round_id: 'r1', start_hole_ordinal: 1 },
      { id: 'g2', round_id: 'r1', start_hole_ordinal: 1 },
    ]
    state.groupMembers = [
      // The launch preset freezes tee groups as two event teams. Group skins
      // must expand that team target back to its individual card holders.
      { group_id: 'g1', event_entry_id: null, event_team_id: 'team-g1' },
      { group_id: 'g2', event_entry_id: 'e3', event_team_id: null },
      { group_id: 'g2', event_entry_id: 'e4', event_team_id: null },
    ]
    state.individualScores = [
      completeScore('e1', 'h1', 3),
      completeScore('e2', 'h1', 4),
      completeScore('e3', 'h1', 2),
      completeScore('e4', 'h1', 5),
    ]

    const projected = buildProjections(state).competitions[0]!
    const resultByEntity = new Map(
      projected.rows.map((row) => [row.entityId, row.resultPrimary]),
    )
    expect(resultByEntity).toEqual(new Map([
      ['ce-e1', 1],
      ['ce-e2', 0],
      ['ce-e3', 1],
      ['ce-e4', 0],
    ]))
    expect(projected.holeResults.filter((hole) => hole.skinWinner)).toHaveLength(2)
    expect(projected.warnings.map((warning) => warning.code))
      .not.toContain('SKINS_GROUP_POPULATION_UNSUPPORTED')
  })

  it.each([
    ['flight', 'SKINS_FLIGHT_NOT_ASSIGNED'],
    ['group', 'SKINS_GROUP_NOT_ASSIGNED'],
  ] as const)(
    'keeps %s skins provisional when the frozen population has no assignments',
    (population, warningCode) => {
      const state = snapshot()
      const competitionId = `${population}-skins-unassigned`
      const rules = {
        ...commonRules,
        format: 'skins',
        skins: {
          population,
          carryMode: 'no_carry',
          unitsPerHole: 1,
          finalCarry: 'expire',
        },
      }
      state.competitions = [competition(competitionId, rules)]
      state.competitionRounds = [link(competitionId)]
      state.entries = [entry('a'), entry('b')]
      state.competitionEntities = [
        entity('entity-a', competitionId, 'a'),
        entity('entity-b', competitionId, 'b'),
      ]
      state.individualScores = [
        completeScore('a', 'h1', 3),
        completeScore('b', 'h1', 5),
      ]

      const projected = buildProjections(state, {
        finalCompetitionId: competitionId,
      }).competitions[0]!
      expect(projected.status).toBe('live')
      expect(projected.summary).toMatchObject({ provisional: true })
      expect(projected.warnings).toContainEqual(expect.objectContaining({
        code: warningCode,
      }))
    },
  )

  it('collapses a one-round substitute into the original competition slot', () => {
    const state = snapshot()
    const competitionId = 'one-round-substitution'
    const rules = { ...commonRules, format: 'individual_stroke' }
    state.competitions = [competition(competitionId, rules)]
    state.competitionRounds = [link(competitionId)]
    state.entries = [
      entry('original'),
      entry('substitute', {
        effective_from_round_id: 'r1',
        replaces_entry_id: 'original',
      }),
    ]
    state.competitionEntities = [
      entity('slot', competitionId, 'original'),
      entity('substitute-entity', competitionId, 'substitute'),
    ]
    state.individualScores = [
      completeScore('original', 'h1', 9),
      completeScore('substitute', 'h1', 4),
    ]

    const projected = buildProjections(state).competitions[0]!
    expect(projected.rows).toHaveLength(1)
    expect(projected.rows[0]).toMatchObject({
      entityId: 'slot',
      resultPrimary: 4,
      status: 'complete',
    })
  })

  it('rejects a rules schema identity that disagrees with the engine', () => {
    const state = snapshot()
    const competitionId = 'schema-mismatch'
    const rules = { ...commonRules, format: 'individual_stroke' }
    state.competitions = [
      competition(competitionId, rules, { rules_schema_version: 2 }),
    ]

    const projected = buildProjections(state).competitions[0]!
    expect(projected.status).toBe('error')
    expect(projected.warnings).toContainEqual(expect.objectContaining({
      code: 'RULES_COLUMN_MISMATCH',
    }))
  })

  it('rejects a competition with no declared round scope', () => {
    const state = snapshot()
    const competitionId = 'missing-round-scope'
    const rules = { ...commonRules, format: 'individual_stroke' }
    state.competitions = [competition(competitionId, rules)]
    state.entries = [entry('a')]
    state.competitionEntities = [entity('entity-a', competitionId, 'a')]
    state.individualScores = [completeScore('a', 'h1', 4)]

    const projected = buildProjections(state).competitions[0]!
    expect(projected.status).toBe('error')
    expect(projected.rows).toEqual([])
    expect(projected.warnings).toContainEqual(expect.objectContaining({
      code: 'RULES_INVALID',
      message: expect.stringContaining('competition_rounds'),
    }))
  })

  it('uses course ordinals for a scoped shotgun match play order', () => {
    const state = snapshot()
    state.holes = [
      { id: 'h10', round_id: 'r1', hole_ordinal: 10, par: 4, stroke_index: 1 },
      { id: 'h11', round_id: 'r1', hole_ordinal: 11, par: 4, stroke_index: 2 },
    ]
    const competitionId = 'shotgun-match'
    const rules = {
      ...commonRules,
      format: 'match',
      holeScope: [10, 11],
    }
    state.competitions = [competition(competitionId, rules)]
    state.competitionRounds = [link(competitionId)]
    state.entries = [entry('a'), entry('b')]
    state.competitionEntities = [
      entity('side-a', competitionId, 'a'),
      entity('side-b', competitionId, 'b'),
    ]
    state.groups = [{ id: 'shotgun', round_id: 'r1', start_hole_ordinal: 11 }]
    state.groupMembers = [
      { group_id: 'shotgun', event_entry_id: 'a', event_team_id: null },
      { group_id: 'shotgun', event_entry_id: 'b', event_team_id: null },
    ]
    state.matches = [{
      id: 'match',
      competition_id: competitionId,
      round_id: 'r1',
      side_a_entity_id: 'side-a',
      side_b_entity_id: 'side-b',
      bracket_position: 1,
      status: 'complete',
      winner_entity_id: 'side-a',
      concession_by: null,
    }]
    state.individualScores = [
      completeScore('a', 'h10', 3),
      completeScore('b', 'h10', 5),
      completeScore('a', 'h11', 3),
      completeScore('b', 'h11', 5),
    ]

    const projected = buildProjections(state).competitions[0]!
    expect(projected.holeResults.map((hole) => hole.eventHoleId))
      .toEqual(['h11', 'h11', 'h10', 'h10'])
  })

  it('keeps an unfinished match non-final without inventing a winner', () => {
    const state = snapshot()
    const competitionId = 'unfinished-match'
    const rules = { ...commonRules, format: 'match' }
    state.competitions = [competition(competitionId, rules)]
    state.competitionRounds = [link(competitionId)]
    state.entries = [entry('a'), entry('b')]
    state.competitionEntities = [
      entity('side-a', competitionId, 'a'),
      entity('side-b', competitionId, 'b'),
    ]
    state.groups = [{ id: 'group', round_id: 'r1', start_hole_ordinal: 1 }]
    state.groupMembers = [
      { group_id: 'group', event_entry_id: 'a', event_team_id: null },
      { group_id: 'group', event_entry_id: 'b', event_team_id: null },
    ]
    state.matches = [{
      id: 'match',
      competition_id: competitionId,
      round_id: 'r1',
      side_a_entity_id: 'side-a',
      side_b_entity_id: 'side-b',
      bracket_position: 1,
      status: 'scheduled',
      winner_entity_id: null,
      concession_by: null,
    }]

    const projected = buildProjections(state, {
      finalCompetitionId: competitionId,
    }).competitions[0]!
    expect(projected.status).toBe('live')
    expect(projected.rows).toHaveLength(2)
    expect(projected.rows.every((row) =>
      row.status === 'provisional' && row.resultPrimary === 0
    )).toBe(true)
    expect(projected.rows.every((row) =>
      (row.detail as { outcome?: string }).outcome === 'in_progress'
    )).toBe(true)
    expect(projected.holeResults).toEqual([])
  })

  it('keeps a one-sided bracket unresolved until a walkover is recorded', () => {
    const state = snapshot()
    const competitionId = 'one-sided-scheduled'
    const rules = { ...commonRules, format: 'match' }
    state.competitions = [competition(competitionId, rules)]
    state.competitionRounds = [link(competitionId)]
    state.entries = [entry('a')]
    state.competitionEntities = [entity('side-a', competitionId, 'a')]
    state.matches = [{
      id: 'bye',
      competition_id: competitionId,
      round_id: 'r1',
      side_a_entity_id: 'side-a',
      side_b_entity_id: null,
      bracket_position: 1,
      status: 'scheduled',
      winner_entity_id: null,
      concession_by: null,
    }]

    const projected = buildProjections(state, {
      finalCompetitionId: competitionId,
    }).competitions[0]!
    expect(projected.status).toBe('live')
    expect(projected.rows).toEqual([])
    expect(projected.warnings).toContainEqual(expect.objectContaining({
      code: 'MATCH_OPEN_BRACKET_SLOT',
    }))
  })

  it('publishes the sole present side only after an authoritative walkover', () => {
    const state = snapshot()
    const competitionId = 'one-sided-walkover'
    const rules = { ...commonRules, format: 'match' }
    state.competitions = [competition(competitionId, rules)]
    state.competitionRounds = [link(competitionId)]
    state.entries = [entry('a')]
    state.competitionEntities = [entity('side-a', competitionId, 'a')]
    state.matches = [{
      id: 'bye',
      competition_id: competitionId,
      round_id: 'r1',
      side_a_entity_id: 'side-a',
      side_b_entity_id: null,
      bracket_position: 1,
      status: 'walkover',
      winner_entity_id: 'side-a',
      concession_by: null,
    }]

    const projected = buildProjections(state, {
      finalCompetitionId: competitionId,
    }).competitions[0]!
    expect(projected.status).toBe('final')
    expect(projected.rows).toEqual([
      expect.objectContaining({
        entityId: 'side-a',
        status: 'complete',
        displayPrimary: 'Walkover',
        detail: expect.objectContaining({
          matchId: 'bye',
          opponentEntityId: null,
          matchPoints: 2,
          outcome: 'won',
          lifecycleStatus: 'walkover',
        }),
      }),
    ])
  })

  it('keeps a sudden-death carry non-final without awarding the pool', () => {
    const state = snapshot()
    const competitionId = 'sudden-death-skins'
    const rules = {
      ...commonRules,
      format: 'skins',
      skins: {
        population: 'field',
        carryMode: 'carry_forward',
        unitsPerHole: 1,
        finalCarry: 'sudden_death',
      },
    }
    state.competitions = [competition(competitionId, rules)]
    state.competitionRounds = [link(competitionId)]
    state.entries = [entry('a'), entry('b')]
    state.competitionEntities = [
      entity('entity-a', competitionId, 'a'),
      entity('entity-b', competitionId, 'b'),
    ]
    state.individualScores = [
      completeScore('a', 'h1', 4),
      completeScore('b', 'h1', 4),
    ]

    const projected = buildProjections(state, {
      finalCompetitionId: competitionId,
    }).competitions[0]!
    expect(projected.status).toBe('live')
    expect(projected.rows.every((row) =>
      row.status === 'provisional' && row.resultPrimary === 0
    )).toBe(true)
    expect(projected.holeResults.every((hole) => hole.skinWinner === false))
      .toBe(true)
    expect(projected.warnings).toContainEqual(expect.objectContaining({
      code: 'SKINS_SUDDEN_DEATH_PENDING',
    }))
  })

  it('does not rebuild an already-finalized competition', () => {
    const state = snapshot()
    const rules = { ...commonRules, format: 'individual_stroke' }
    state.competitions = [
      competition('sealed', rules, { status: 'finalized' }),
    ]

    expect(buildProjections(state).competitions).toEqual([])
  })
})
