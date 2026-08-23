/** Shared crash-recovery policy for authoritative projection publishers. */

export const PROJECTION_REPAIR_RETRY_MS = 1_000

// renew_projection_publish_lease grants 60 seconds. The fallback must remain
// alive past that deadline so a crashed publisher cannot strand raw facts.
export const PROJECTION_REPAIR_MAX_ATTEMPTS = 75

export type ProjectionPublishClaimStatus =
  | 'claimed'
  | 'wait'
  | 'pending'
  | 'unavailable'

export function projectionClaimNeedsBackgroundRepair(
  status: ProjectionPublishClaimStatus,
): boolean {
  return status !== 'claimed'
}

export function projectionPublicationNeedsRepair(
  pending: boolean,
  publishedRevision: number | null,
): boolean {
  return pending || publishedRevision === null
}
