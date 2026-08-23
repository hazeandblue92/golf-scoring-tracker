/** Resolve an explicit score conflict without last-write-wins (spec §10.4). */

import { resolveScoreConflictRequestSchema } from '../../../packages/contracts/src/index.ts'
import { buildProjections } from '../_shared/projection-orchestrator.ts'
import {
  PROJECTION_REPAIR_MAX_ATTEMPTS,
  PROJECTION_REPAIR_RETRY_MS,
  projectionClaimNeedsBackgroundRepair,
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
  return { status: data as ProjectionClaim['status'], leaseToken }
}

async function publishLatestProjection(
  service: ServiceClient,
  eventId: string,
  leaseToken: string,
  correlationId: string,
): Promise<number | null> {
  try {
    const snapshot = await loadScoringSnapshot(service, eventId)
    const renewed = await service.rpc('renew_projection_publish_lease', {
      p_event_id: eventId,
      p_lease_token: leaseToken,
    })
    if (renewed.error || renewed.data !== true) return null
    const { data, error } = await service.rpc('publish_projections', {
      p_event_id: eventId,
      p_revision: snapshot.event.scoring_revision,
      p_result: buildProjections(snapshot),
    })
    const publication = data as { status?: string; event_revision?: number } | null
    if (error || publication?.status !== 'published') return null
    return publication.event_revision ?? snapshot.event.scoring_revision
  } catch (error) {
    console.error(JSON.stringify({
      correlationId,
      stage: 'conflict-projection-repair',
      message: String(error),
    }))
    return null
  }
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

function scheduleProjectionRepair(
  service: ServiceClient,
  eventId: string,
  revision: number,
  correlationId: string,
  waiterToken: string,
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

      let publishedRevision = revision
      let pending = false
      try {
        publishedRevision = await publishLatestProjection(
          service,
          eventId,
          claim.leaseToken,
          correlationId,
        ) ?? revision
      } finally {
        pending = await releaseProjectionPublish(
          service,
          eventId,
          publishedRevision,
          claim.leaseToken,
        )
      }
      if (!pending && await projectionsAreCurrent(service, eventId)) return
    }
    console.error(JSON.stringify({
      correlationId,
      stage: 'conflict-projection-repair',
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
  const parsed = resolveScoreConflictRequestSchema.safeParse(await readJsonBody(req))
  if (!parsed.success) {
    return rejected(400, 'SCORE_INVALID', correlationId,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  }

  const service = serviceClient()
  const { data: resolved, error: resolveError } = await service.rpc(
    'resolve_score_conflict_atomic',
    {
      p_actor: caller.userId,
      p_conflict_id: parsed.data.conflictId,
      p_choice: parsed.data.choice,
      p_manual_value: parsed.data.manualValue ?? null,
      p_reason: parsed.data.reason,
    },
  )
  if (resolveError) {
    const response = resolveError.code === '42501'
      ? { http: 403, code: 'NOT_ASSIGNED' }
      : resolveError.code === 'P0002'
        ? { http: 404, code: 'SNAPSHOT_INVALID' }
        : resolveError.code === '22023'
          ? { http: 400, code: 'SCORE_INVALID' }
          : resolveError.code === '55000'
            ? { http: 409, code: 'EVENT_LOCKED' }
            : { http: 409, code: 'BASE_REVISION_STALE' }
    return rejected(response.http, response.code, correlationId, resolveError.message)
  }

  const result = resolved as {
    status: 'resolved' | 'duplicate'
    eventId: string
    eventRevision: number
    scoreChanged: boolean
  }
  let projectionStatus: 'current' | 'queued' = 'current'
  const projectionRepairNeeded = result.scoreChanged
    || !await projectionsAreCurrent(service, result.eventId)
  if (projectionRepairNeeded) {
    const claim = await claimProjectionPublish(
      service,
      result.eventId,
      result.eventRevision,
    )
    if (claim.status === 'claimed') {
      let publishedRevision = result.eventRevision
      let pending = false
      try {
        publishedRevision = await publishLatestProjection(
          service,
          result.eventId,
          claim.leaseToken,
          correlationId,
        ) ?? result.eventRevision
      } finally {
        pending = await releaseProjectionPublish(
          service,
          result.eventId,
          publishedRevision,
          claim.leaseToken,
        )
      }
      projectionStatus = publishedRevision === result.eventRevision
        && await projectionsAreCurrent(service, result.eventId)
        ? 'current'
        : 'queued'
      if (pending || projectionStatus === 'queued') {
        scheduleProjectionRepair(
          service,
          result.eventId,
          result.eventRevision,
          correlationId,
          crypto.randomUUID(),
        )
      }
    } else if (projectionClaimNeedsBackgroundRepair(claim.status)) {
      projectionStatus = 'queued'
      scheduleProjectionRepair(
        service,
        result.eventId,
        result.eventRevision,
        correlationId,
        claim.leaseToken,
      )
    }
  }
  return json(200, { ...result, projectionStatus, correlationId })
})
