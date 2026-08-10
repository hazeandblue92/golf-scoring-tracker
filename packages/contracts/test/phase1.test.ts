import { describe, expect, it } from 'vitest'

import {
  attestScorecardRequestSchema,
  publishEventRequestSchema,
  resolveScoreConflictRequestSchema,
  saveEventDraftRequestSchema,
} from '../src/index.ts'

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`

describe('Phase 1 organizer contracts', () => {
  it('accepts one complete individual-gross draft request', () => {
    const parsed = saveEventDraftRequestSchema.safeParse({
      leagueId: id('1'),
      seasonId: id('2'),
      name: 'Opening Day',
      timezone: 'America/Detroit',
      startsAt: '2026-09-12T09:00:00-04:00',
      endsAt: null,
      visibility: 'league',
      teeSetId: id('3'),
      participantIds: [id('4'), id('5')],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.scorerProfileIds).toEqual([])
      expect(parsed.data.competitionPreset).toBe('individual_gross')
      expect(parsed.data.teams).toEqual([])
    }
  })

  it('accepts a complete two-person throwdown and rejects duplicate assignments', () => {
    const request = {
      leagueId: id('1'), seasonId: id('2'), name: 'Two-Person Throwdown',
      timezone: 'UTC', startsAt: '2026-09-12T13:00:00Z', endsAt: null,
      visibility: 'league' as const, teeSetId: id('3'),
      participantIds: [id('4'), id('5'), id('6'), id('7')],
      competitionPreset: 'two_person_throwdown' as const,
      teams: [
        { name: 'North', participantIds: [id('4'), id('5')] },
        { name: 'South', participantIds: [id('6'), id('7')] },
      ],
    }
    expect(saveEventDraftRequestSchema.safeParse(request).success).toBe(true)
    expect(saveEventDraftRequestSchema.safeParse({
      ...request,
      teams: [
        { name: 'North', participantIds: [id('4'), id('5')] },
        { name: 'South', participantIds: [id('5'), id('7')] },
      ],
    }).success).toBe(false)

    expect(saveEventDraftRequestSchema.safeParse({
      ...request,
      participantIds: [...request.participantIds, id('8'), id('9')],
      teams: [
        ...request.teams,
        { name: 'West', participantIds: [id('8'), id('9')] },
      ],
    }).success).toBe(false)
  })

  it('accepts complete three- and four-player scramble teams', () => {
    const common = {
      leagueId: id('1'), seasonId: id('2'), name: 'Scramble Day',
      timezone: 'UTC', startsAt: '2026-09-12T13:00:00Z', endsAt: null,
      visibility: 'league' as const, teeSetId: id('3'),
    }
    const threePlayer = {
      ...common,
      participantIds: [id('4'), id('5'), id('6'), id('7'), id('8'), id('9')],
      competitionPreset: 'three_player_scramble' as const,
      teams: [
        { name: 'North', participantIds: [id('4'), id('5'), id('6')] },
        { name: 'South', participantIds: [id('7'), id('8'), id('9')] },
      ],
    }
    expect(saveEventDraftRequestSchema.safeParse(threePlayer).success).toBe(true)

    const fourPlayer = {
      ...common,
      participantIds: [id('4'), id('5'), id('6'), id('7'), id('8'), id('9'), id('10'), id('11')],
      competitionPreset: 'four_player_scramble' as const,
      teams: [
        { name: 'East', participantIds: [id('4'), id('5'), id('6'), id('7')] },
        { name: 'West', participantIds: [id('8'), id('9'), id('10'), id('11')] },
      ],
    }
    expect(saveEventDraftRequestSchema.safeParse(fourPlayer).success).toBe(true)
    expect(saveEventDraftRequestSchema.safeParse({
      ...fourPlayer,
      teams: [
        { name: 'East', participantIds: [id('4'), id('5'), id('6')] },
        { name: 'West', participantIds: [id('7'), id('8'), id('9'), id('10')] },
      ],
    }).success).toBe(false)
  })

  it('rejects duplicate participant ids before setup reaches the server', () => {
    const duplicate = id('4')
    const parsed = saveEventDraftRequestSchema.safeParse({
      leagueId: id('1'), seasonId: id('2'), name: 'Opening Day',
      timezone: 'UTC', startsAt: '2026-09-12T13:00:00Z', endsAt: null,
      visibility: 'league', teeSetId: id('3'),
      participantIds: [duplicate, duplicate], scorerProfileIds: [],
    })
    expect(parsed.success).toBe(false)
  })

  it('defaults publish to a published-but-closed event', () => {
    const parsed = publishEventRequestSchema.parse({ eventId: id('8') })
    expect(parsed.openScoring).toBe(false)
  })

  it('requires a valid numeric shape for manual conflict resolution', () => {
    const invalid = resolveScoreConflictRequestSchema.safeParse({
      conflictId: id('9'),
      choice: 'manual',
      reason: 'Committee reviewed both cards',
      manualValue: { status: 'complete', grossStrokes: null, notes: null },
    })
    expect(invalid.success).toBe(false)

    const valid = resolveScoreConflictRequestSchema.safeParse({
      conflictId: id('9'),
      choice: 'manual',
      reason: 'Committee reviewed both cards',
      manualValue: { status: 'complete', grossStrokes: 5, notes: null },
    })
    expect(valid.success).toBe(true)
  })

  it('requires a reason for a director scorecard override', () => {
    expect(attestScorecardRequestSchema.safeParse({
      roundId: id('1'), targetKind: 'individual', targetId: id('2'),
      attestationType: 'director_override', reason: null,
    }).success).toBe(false)
    expect(attestScorecardRequestSchema.safeParse({
      roundId: id('1'), targetKind: 'individual', targetId: id('2'),
      attestationType: 'marker',
    }).success).toBe(true)
  })
})
