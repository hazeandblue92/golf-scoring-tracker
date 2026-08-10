/** Phase 4 operations and recovery API contracts (spec §§17–20). */

import { z } from 'zod'

export const appErrorCodes = [
  'GLOBAL_ERROR',
  'RENDER_BOUNDARY',
  'UNHANDLED_REJECTION',
] as const

export const appRouteFamilies = [
  '/',
  '/activate',
  '/admin/events/:eventId/audit',
  '/admin/events/:eventId/scoring',
  '/admin/events/:eventId/setup',
  '/admin/operations',
  '/dashboard',
  '/events/:eventId',
  '/events/:eventId/leaderboards/:competitionId',
  '/events/:eventId/matches/:competitionId',
  '/events/:eventId/rules',
  '/events/:eventId/score',
  '/events/:eventId/scorecard/:entityId',
  '/events/:eventId/skins/:competitionId',
  '/league/:leagueId',
  '/league/:leagueId/courses',
  '/league/:leagueId/players',
  '/league/:leagueId/seasons',
  '/offline',
  '/privacy',
  '/settings',
  '/sign-in',
  '/unknown',
] as const

export const reportAppErrorRequestSchema = z.strictObject({
  errorCode: z.enum(appErrorCodes),
  routeFamily: z.enum(appRouteFamilies),
  correlationId: z.uuid().optional(),
  severity: z.enum(['warning', 'error', 'critical']),
})

export type ReportAppErrorRequest = z.infer<typeof reportAppErrorRequestSchema>

export const rebuildProjectionsRequestSchema = z.strictObject({
  eventId: z.uuid(),
})

export type RebuildProjectionsRequest = z.infer<typeof rebuildProjectionsRequestSchema>
