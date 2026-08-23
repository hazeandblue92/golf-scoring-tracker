/**
 * MFA-gated terminal match workflow (§8.6).
 *
 * PostgreSQL commits the match fact, event revision, and audit row together.
 * Projection publication follows that durable commit; if another publisher
 * owns the event lease or calculation fails, the receipt says
 * `queued_projection` and the elected repair path publishes the newest state.
 */

import {
  setMatchResultRequestSchema,
  setMatchResultResponseSchema,
} from '../../../packages/contracts/src/index.ts'
import { buildProjections } from '../_shared/projection-orchestrator.ts'
import {
  PROJECTION_REPAIR_MAX_ATTEMPTS,
  PROJECTION_REPAIR_RETRY_MS,
  projectionClaimNeedsBackgroundRepair,
  projectionPublicationNeedsRepair,
} from '../_shared/projection-repair-policy.ts'
import { loadScoringSnapshot } from '../_shared/snapshot.ts'
import {
  corsPreflight,
  json,
  newCorrelationId,
  readJsonBody,
  rejected,
  requireMfa,
  requireUser,
  serviceClient,
} from '../_shared/http.ts'

const MAX_PUBLISH_ATTEMPTS = 3

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void
}

type ServiceClient = ReturnType<typeof serviceClient>
type ProjectionClaim = {
  status: 'claimed' | 'wait' | 'pending' | 'unavailable'
  leaseToken: string
}

async function claimProjectionPublish(
  service: ServiceClient,
  eventId: string,
  revision: number,
  existingToken?: string,
): Promise<ProjectionClaim> {
  const leaseToken = existingToken ?? crypto.randomUUID()
  const { data, error } = await service.rpc('claim_projection_publish', {
    p_event_id: eventId,
    p_revision: revision,
    p_lease_token: leaseToken,
  })
  if (error || !['claimed', 'wait', 'pending'].includes(String(data))) {
    return { status: 'unavailable', leaseToken }
  }
  return {
    status: data as 'claimed' | 'wait' | 'pending',
    leaseToken,
  }
}

async function renewProjectionPublishLease(
  service: ServiceClient,
  eventId: string,
  leaseToken: string,
): Promise<boolean> {
  const { data, error } = await service.rpc('renew_projection_publish_lease', {
    p_event_id: eventId,
    p_lease_token: leaseToken,
  })
  return !error && data === true
}

async function releaseProjectionPublish(
  service: ServiceClient,
  eventId: string,
  revision: number,
  leaseToken: string,
): Promise<boolean> {
  const { data, error } = await service.rpc('release_projection_publish', {
    p_event_id: eventId,
    p_revision: revision,
    p_lease_token: leaseToken,
  })
  return !error && data === true
}

async function projectionsAreCurrent(
  service: ServiceClient,
  eventId: string,
): Promise<boolean> {
  const { data, error } = await service.rpc('event_projections_current', {
    p_event_id: eventId,
  })
  return !error && data === true
}

async function publishLatestProjections(
  service: ServiceClient,
  eventId: string,
  correlationId: string,
  leaseToken: string,
): Promise<number | null> {
  for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
    try {
      const snapshot = await loadScoringSnapshot(service, eventId)
      const payload = buildProjections(snapshot)
      if (!await renewProjectionPublishLease(service, eventId, leaseToken)) {
        return null
      }
      const { data, error } = await service.rpc('publish_projections', {
        p_event_id: eventId,
        p_revision: snapshot.event.scoring_revision,
        p_result: payload,
      })
      if (error) {
        console.error(JSON.stringify({
          correlationId,
          stage: 'match-projection-publish',
          message: error.message,
        }))
        return null
      }
      const published = data as { status?: string; event_revision?: number } | null
      if (published?.status === 'published') {
        return published.event_revision ?? snapshot.event.scoring_revision
      }
    } catch (error) {
      console.error(JSON.stringify({
        correlationId,
        stage: 'match-projection-build',
        message: String(error),
      }))
      return null
    }
  }
  return null
}

function scheduleProjectionRepair(
  service: ServiceClient,
  eventId: string,
  revision: number,
  correlationId: string,
  waiterToken: string = crypto.randomUUID(),
): void {
  if (typeof EdgeRuntime === 'undefined') return
  EdgeRuntime.waitUntil((async () => {
    for (let attempt = 0; attempt < PROJECTION_REPAIR_MAX_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, PROJECTION_REPAIR_RETRY_MS))
      if (await projectionsAreCurrent(service, eventId)) return
      const claim = await claimProjectionPublish(
        service,
        eventId,
        revision,
        waiterToken,
      )
      if (projectionClaimNeedsBackgroundRepair(claim.status)) continue

      let publishedRevision: number | null = null
      let pending = false
      try {
        publishedRevision = await publishLatestProjections(
          service,
          eventId,
          correlationId,
          claim.leaseToken,
        )
      } finally {
        pending = await releaseProjectionPublish(
          service,
          eventId,
          publishedRevision ?? revision,
          claim.leaseToken,
        )
      }
      if (!pending && publishedRevision !== null &&
        await projectionsAreCurrent(service, eventId)) return
    }
    console.error(JSON.stringify({
      correlationId,
      stage: 'match-projection-repair',
      message: 'projection repair attempts exhausted',
    }))
  })())
}

Deno.serve(async (req: Request) => {
  const correlationId = newCorrelationId()
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') {
    return rejected(405, 'SERVICE_UNAVAILABLE', correlationId, 'Method not allowed')
  }

  const caller = await requireUser(req, correlationId)
  if (caller instanceof Response) return caller
  const mfaGate = requireMfa(caller, correlationId)
  if (mfaGate) return mfaGate

  const parsed = setMatchResultRequestSchema.safeParse(await readJsonBody(req))
  if (!parsed.success) {
    return rejected(
      400,
      'SCORE_INVALID',
      correlationId,
      parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    )
  }

  const service = serviceClient()
  const { data, error } = await service.rpc('set_match_result', {
    p_actor: caller.userId,
    p_match_id: parsed.data.matchId,
    p_status: parsed.data.status,
    p_winner_entity_id: parsed.data.winnerEntityId,
    p_result_summary: parsed.data.resultSummary,
    p_reason: parsed.data.reason,
    p_correlation_id: correlationId,
  })
  if (error) {
    if (error.code === '42501') {
      return rejected(403, 'NOT_ASSIGNED', correlationId, error.message)
    }
    if (error.code === 'P0002') {
      return rejected(404, 'SNAPSHOT_INVALID', correlationId, error.message)
    }
    const locked = /finalized|scoring to be open or closed/i.test(error.message)
    return rejected(
      409,
      locked ? 'EVENT_LOCKED' : 'SCORE_INVALID',
      correlationId,
      error.message,
    )
  }

  const result = data as {
    status?: string
    changed?: boolean
    matchId?: string
    eventId?: string
    competitionId?: string
    matchStatus?: 'complete' | 'conceded' | 'walkover'
    winnerEntityId?: string | null
    eventRevision?: number
  } | null
  if (
    result?.status !== 'saved' ||
    result.matchId === undefined ||
    result.eventId === undefined ||
    result.competitionId === undefined ||
    result.matchStatus === undefined ||
    result.eventRevision === undefined
  ) {
    return rejected(
      500,
      'SERVICE_UNAVAILABLE',
      correlationId,
      'match workflow returned an invalid receipt',
    )
  }

  let projectionRevision: number | null = null
  if (result.changed === false && await projectionsAreCurrent(service, result.eventId)) {
    projectionRevision = result.eventRevision
  } else {
    const claim = await claimProjectionPublish(
      service,
      result.eventId,
      result.eventRevision,
    )
    if (claim.status === 'claimed') {
      let pending = false
      try {
        projectionRevision = await publishLatestProjections(
          service,
          result.eventId,
          correlationId,
          claim.leaseToken,
        )
      } finally {
        pending = await releaseProjectionPublish(
          service,
          result.eventId,
          projectionRevision ?? result.eventRevision,
          claim.leaseToken,
        )
      }
      if (projectionPublicationNeedsRepair(pending, projectionRevision)) {
        scheduleProjectionRepair(
          service,
          result.eventId,
          result.eventRevision,
          correlationId,
        )
      }
    } else if (projectionClaimNeedsBackgroundRepair(claim.status)) {
      scheduleProjectionRepair(
        service,
        result.eventId,
        result.eventRevision,
        correlationId,
        claim.leaseToken,
      )
    }
  }

  const receipt = setMatchResultResponseSchema.parse({
    status: projectionRevision === null ? 'queued_projection' : 'committed',
    changed: result.changed ?? true,
    matchId: result.matchId,
    eventId: result.eventId,
    competitionId: result.competitionId,
    matchStatus: result.matchStatus,
    winnerEntityId: result.winnerEntityId ?? null,
    eventRevision: result.eventRevision,
    projectionRevision,
    correlationId,
  })
  return json(200, receipt)
})
