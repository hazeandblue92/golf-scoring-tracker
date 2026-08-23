import { describe, expect, it } from 'vitest'

import {
  PROJECTION_REPAIR_MAX_ATTEMPTS,
  PROJECTION_REPAIR_RETRY_MS,
  projectionClaimNeedsBackgroundRepair,
  projectionPublicationNeedsRepair,
} from '../../../supabase/functions/_shared/projection-repair-policy.ts'

describe('projection repair policy', () => {
  it('repairs an isolated failed publish as well as pending concurrent work', () => {
    expect(projectionPublicationNeedsRepair(false, null)).toBe(true)
    expect(projectionPublicationNeedsRepair(true, 7)).toBe(true)
    expect(projectionPublicationNeedsRepair(false, 7)).toBe(false)
  })

  it('outlives the full renewed database lease before giving up', () => {
    expect(PROJECTION_REPAIR_RETRY_MS * PROJECTION_REPAIR_MAX_ATTEMPTS)
      .toBeGreaterThan(60_000)
  })

  it('keeps a fallback worker for elected, non-elected, and transient claims', () => {
    expect(projectionClaimNeedsBackgroundRepair('wait')).toBe(true)
    expect(projectionClaimNeedsBackgroundRepair('pending')).toBe(true)
    expect(projectionClaimNeedsBackgroundRepair('unavailable')).toBe(true)
    expect(projectionClaimNeedsBackgroundRepair('claimed')).toBe(false)
  })
})
