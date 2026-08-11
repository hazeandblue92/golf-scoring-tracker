/**
 * Organizer workflow contracts (spec §§5.2, 12.2, 22).
 *
 * Phase 2 extends the launch request with a preset and explicit two-person
 * teams while keeping old Phase 1 clients valid through defaults.
 */

import { z } from 'zod'

const uuidArray = z.array(z.uuid()).min(1).superRefine((values, ctx) => {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: 'custom', message: 'IDs must be unique' })
  }
})

export const saveEventDraftRequestSchema = z.strictObject({
  eventId: z.uuid().optional(),
  leagueId: z.uuid(),
  seasonId: z.uuid(),
  name: z.string().trim().min(3).max(100),
  timezone: z.string().trim().min(1).max(100),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).nullable(),
  visibility: z.enum(['league', 'public', 'organizers']),
  teeSetId: z.uuid(),
  participantIds: uuidArray,
  scorerProfileIds: z.array(z.uuid()).default([]),
  competitionPreset: z
    .enum([
      'individual_gross',
      'two_person_throwdown',
      'three_player_scramble',
      'four_player_scramble',
    ])
    .default('individual_gross'),
  teams: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(80),
        participantIds: z.array(z.uuid()).min(2).max(4).superRefine((ids, ctx) => {
          if (new Set(ids).size !== ids.length) {
            ctx.addIssue({ code: 'custom', message: 'Team members must be unique' })
          }
        }),
      }),
    )
    .default([]),
}).superRefine((value, ctx) => {
  if (value.competitionPreset === 'individual_gross') {
    if (value.teams.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['teams'],
        message: 'Individual gross events cannot include teams',
      })
    }
    return
  }

  const teamSize = value.competitionPreset === 'two_person_throwdown'
    ? 2
    : value.competitionPreset === 'three_player_scramble'
      ? 3
      : 4

  if (value.teams.length < 2) {
    ctx.addIssue({
      code: 'custom',
      path: ['teams'],
      message: 'Team events require at least two teams',
    })
  }

  if (value.teams.some((team) => team.participantIds.length !== teamSize)) {
    ctx.addIssue({
      code: 'custom',
      path: ['teams'],
      message: `Every team must contain exactly ${teamSize} participants`,
    })
  }

  if (value.competitionPreset === 'two_person_throwdown') {
    if (value.participantIds.length % 4 !== 0 || value.teams.length % 2 !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['teams'],
        message: 'Two-person throwdowns require two teams (four players) in every group',
      })
    }
  } else if (value.participantIds.length % teamSize !== 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['teams'],
      message: `Scramble fields must divide into complete ${teamSize}-player teams`,
    })
  }

  const selected = new Set(value.participantIds)
  const assigned = value.teams.flatMap((team) => team.participantIds)
  if (
    assigned.length !== value.participantIds.length ||
    new Set(assigned).size !== assigned.length ||
    assigned.some((participantId) => !selected.has(participantId))
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['teams'],
      message: 'Every selected participant must belong to exactly one team',
    })
  }

  const names = value.teams.map((team) => team.name.toLowerCase())
  if (new Set(names).size !== names.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['teams'],
      message: 'Team names must be unique',
    })
  }
})

export type SaveEventDraftRequest = z.infer<typeof saveEventDraftRequestSchema>

export const publishEventRequestSchema = z.strictObject({
  eventId: z.uuid(),
  openScoring: z.boolean().default(false),
})

export type PublishEventRequest = z.infer<typeof publishEventRequestSchema>

export const resolveScoreConflictRequestSchema = z
  .strictObject({
    conflictId: z.uuid(),
    choice: z.enum(['local', 'server', 'manual']),
    manualValue: z
      .strictObject({
        status: z.enum([
          'complete',
          'picked_up',
          'conceded',
          'not_played',
          'no_score',
          'withdrawn',
          'disqualified',
        ]),
        grossStrokes: z.number().int().min(1).max(25).nullable(),
        notes: z.string().max(500).nullable(),
      })
      .optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .superRefine((value, ctx) => {
    if (value.choice === 'manual' && value.manualValue === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['manualValue'],
        message: 'manualValue is required for a manual resolution',
      })
    }
    const manual = value.manualValue
    if (manual !== undefined) {
      const numeric = manual.status === 'complete'
      if (numeric !== (manual.grossStrokes !== null)) {
        ctx.addIssue({
          code: 'custom',
          path: ['manualValue', 'grossStrokes'],
          message: 'grossStrokes is required exactly when status is complete',
        })
      }
    }
  })

export type ResolveScoreConflictRequest = z.infer<
  typeof resolveScoreConflictRequestSchema
>

export const finalizeCompetitionRequestSchema = z.strictObject({
  competitionId: z.uuid(),
  overrideReason: z.string().trim().min(3).max(500).nullable().default(null),
})

export type FinalizeCompetitionRequest = z.infer<
  typeof finalizeCompetitionRequestSchema
>

export const reopenCompetitionRequestSchema = z.strictObject({
  competitionId: z.uuid(),
  reason: z.string().trim().min(3).max(500),
})

export type ReopenCompetitionRequest = z.infer<
  typeof reopenCompetitionRequestSchema
>

export const exportLeagueRequestSchema = z.strictObject({
  leagueId: z.uuid(),
  eventId: z.uuid().optional(),
})

export type ExportLeagueRequest = z.infer<typeof exportLeagueRequestSchema>
