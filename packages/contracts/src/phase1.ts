/**
 * Phase 1 organizer workflow contracts (spec §§5.2, 12.2, 22).
 *
 * These are deliberately limited to the launch format: one 9- or 18-hole
 * individual gross competition. Later phases extend the discriminated
 * workflow without weakening these strict request boundaries.
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

export const exportLeagueRequestSchema = z.strictObject({
  leagueId: z.uuid(),
  eventId: z.uuid().optional(),
})

export type ExportLeagueRequest = z.infer<typeof exportLeagueRequestSchema>
