import { describe, expect, it } from 'vitest'

import {
  rebuildProjectionsRequestSchema,
  reportAppErrorRequestSchema,
} from '../src/phase4.ts'

const EVENT_ID = '5f0f6f5e-1111-4a2b-8c3d-9e8f7a6b5c4d'

describe('Phase 4 operations contracts', () => {

  it('accepts sanitized error aggregates without free-text payloads', () => {
    expect(reportAppErrorRequestSchema.safeParse({
      errorCode: 'RENDER_BOUNDARY',
      routeFamily: '/events/:eventId/score',
      correlationId: EVENT_ID,
      severity: 'error',
    }).success).toBe(true)
  })

  it('rejects free text, unknown fields, and unsafe route values', () => {
    expect(reportAppErrorRequestSchema.safeParse({
      errorCode: 'Something broke for Jane Golfer',
      routeFamily: '/events/real-event-id/score?token=secret',
      severity: 'error',
      stack: 'private stack text',
    }).success).toBe(false)
    expect(reportAppErrorRequestSchema.safeParse({
      errorCode: 'UNBOUNDED_NEW_CODE',
      routeFamily: '/unknown',
      severity: 'error',
    }).success).toBe(false)
  })

  it('requires a UUID for projection repair', () => {
    expect(rebuildProjectionsRequestSchema.safeParse({ eventId: EVENT_ID }).success).toBe(true)
    expect(rebuildProjectionsRequestSchema.safeParse({ eventId: 'latest' }).success).toBe(false)
  })
})
