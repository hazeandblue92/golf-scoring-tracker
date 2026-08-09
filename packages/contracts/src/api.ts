/**
 * submit-score API contract (spec §12.3) and score value rules (spec §4.5).
 *
 * Strict objects throughout: unknown fields are rejected, not ignored.
 */

import { z } from 'zod'
import { errorCodeSchema } from './errors.ts'

// ── Score values (spec §4.5) ────────────────────────────────────────────────

/** Spec §4.5 hole status values. */
export const holeScoreStatusSchema = z.enum([
  'not_started',
  'complete',
  'picked_up',
  'conceded',
  'not_played',
  'no_score',
  'withdrawn',
  'disqualified',
])

export type HoleScoreStatus = z.infer<typeof holeScoreStatusSchema>

/** Statuses that terminally exclude a numeric gross value (spec §4.5). */
export const NON_NUMERIC_TERMINAL_STATUSES = [
  'picked_up',
  'conceded',
  'not_played',
  'no_score',
  'withdrawn',
  'disqualified',
] as const

/**
 * Spec §4.5: gross range defaults to 1..25 and 0 is invalid; a numeric value
 * and a nonnumeric status are mutually exclusive — grossStrokes is present
 * exactly when status is 'complete'.
 */
export const scoreValueSchema = z
  .strictObject({
    status: holeScoreStatusSchema,
    grossStrokes: z.number().int().min(1).max(25).optional(),
    notes: z.string().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'complete' && value.grossStrokes === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: "status 'complete' requires grossStrokes",
        path: ['grossStrokes'],
      })
    }
    if (value.status !== 'complete' && value.grossStrokes !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `status '${value.status}' forbids grossStrokes`,
        path: ['grossStrokes'],
      })
    }
  })

export type ScoreValue = z.infer<typeof scoreValueSchema>

// ── submit-score request (spec §12.3) ───────────────────────────────────────

export const scoreTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('individual'),
    entryId: z.uuid(),
    holeId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal('team'),
    teamId: z.uuid(),
    holeId: z.uuid(),
  }),
])

export type ScoreTarget = z.infer<typeof scoreTargetSchema>

/** Semver-ish release identifier, e.g. '1.4.0' or '1.4.0-beta.2+build.7'. */
const CLIENT_RELEASE_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export const submitScoreRequestSchema = z.strictObject({
  idempotencyKey: z.uuid(),
  eventId: z.uuid(),
  roundId: z.uuid(),
  target: scoreTargetSchema,
  baseRevision: z.number().int().min(0),
  value: scoreValueSchema,
  /** RFC 3339 / ISO 8601 timestamp; offset or Z accepted. */
  clientRecordedAt: z.iso.datetime({ offset: true }),
  clientRelease: z.string().regex(CLIENT_RELEASE_PATTERN),
})

export type SubmitScoreRequest = z.infer<typeof submitScoreRequestSchema>

// ── submit-score response (spec §12.3) ──────────────────────────────────────

export const submitScoreStatusSchema = z.enum([
  'committed',
  'duplicate',
  'conflict',
  'rejected',
  'queued_projection',
])

export type SubmitScoreStatus = z.infer<typeof submitScoreStatusSchema>

export const submitScoreResponseSchema = z.strictObject({
  status: submitScoreStatusSchema,
  scoreRevision: z.number().int().min(0),
  eventRevision: z.number().int().min(0),
  projectionRevision: z.number().int().min(0).nullable(),
  errorCode: errorCodeSchema.nullable(),
  correlationId: z.string().min(1),
})

export type SubmitScoreResponse = z.infer<typeof submitScoreResponseSchema>
