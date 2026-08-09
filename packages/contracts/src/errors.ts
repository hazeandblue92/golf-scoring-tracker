/**
 * Stable error codes (spec §12.4).
 *
 * Codes are the programmatic contract; user-facing text is localized and
 * presentational only and MUST NOT be used for program logic.
 */

import { z } from 'zod'

export const ERROR_CODES = [
  'AUTH_REQUIRED',
  'MFA_REQUIRED',
  'NOT_ASSIGNED',
  'EVENT_LOCKED',
  'SCORE_INVALID',
  'BASE_REVISION_STALE',
  'SNAPSHOT_INVALID',
  'PROJECTION_STALE',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
] as const

export const errorCodeSchema = z.enum(ERROR_CODES)

export type ErrorCode = z.infer<typeof errorCodeSchema>
