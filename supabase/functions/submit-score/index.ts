/**
 * submit-score Edge Function (spec §7.2, §12.3, §12.5).
 *
 * The authoritative write path:
 *   1. Validate the JWT and the request schema.
 *   2. Call apply_score_mutation with the CALLER's auth context — PostgreSQL
 *      owns permissions, event state, value range, idempotency, locking, the
 *      conflict policy, the audit append, and the revision increment.
 *   3. On acceptance, read a consistent snapshot with service credentials,
 *      calculate projections with the shared engine, and publish them only
 *      if the event revision has not moved (retry up to three times).
 *
 * A durable raw score is never lost because projections lag: if publishing
 * stays stale, the response is `queued_projection` and the score stands.
 */

import { submitScoreRequestSchema } from '../../../packages/contracts/src/index.ts'
import { buildProjections } from '../_shared/projection-orchestrator.ts'
import { loadScoringSnapshot } from '../_shared/snapshot.ts'
import {
  corsPreflight,
  json,
  newCorrelationId,
  readJsonBody,
  rejected,
  requireUser,
  serviceClient,
} from '../_shared/http.ts'

const MAX_PUBLISH_ATTEMPTS = 3
const PROJECTION_DEBOUNCE_MS = 650
const PROJECTION_LEASE_MS = 15_000

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
  for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
    let snapshot
    try {
      snapshot = await loadScoringSnapshot(service, eventId)
    } catch (err) {
      console.error(
        JSON.stringify({ correlationId, stage: 'snapshot', message: String(err) }),
      )
      return null
    }

    const payload = buildProjections(snapshot)
    if (!await renewProjectionPublishLease(service, eventId, leaseToken)) {
      return null
    }
    const { data: published, error: publishError } = await service.rpc(
      'publish_projections',
      {
        p_event_id: eventId,
        p_revision: snapshot.event.scoring_revision,
        p_result: payload,
      },
    )

    if (publishError) {
      console.error(
        JSON.stringify({ correlationId, stage: 'publish', message: publishError.message }),
      )
      return null
    }

    const pub = published as { status: string; event_revision?: number }
    if (pub.status === 'published') {
      return pub.event_revision ?? snapshot.event.scoring_revision
    }
  }
  return null
}

function scheduleProjectionRepair(
  service: ServiceClient,
  eventId: string,
  revision: number,
  correlationId: string,
  delayMs = PROJECTION_DEBOUNCE_MS,
  waiterToken?: string,
): void {
  if (typeof EdgeRuntime === 'undefined') return
  EdgeRuntime.waitUntil((async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    if (await projectionsAreCurrent(service, eventId)) return
    const claim = await claimProjectionPublish(
      service,
      eventId,
      revision,
      waiterToken,
    )
    if (claim.status === 'wait') {
      // This caller is the single elected crash fallback. If the current
      // owner never releases, retry just beyond lease expiry.
      scheduleProjectionRepair(
        service,
        eventId,
        revision,
        correlationId,
        PROJECTION_LEASE_MS + PROJECTION_DEBOUNCE_MS,
        claim.leaseToken,
      )
      return
    }
    if (claim.status !== 'claimed') return
    let publishedRevision = revision
    let pending = false
    try {
      publishedRevision = await publishLatestProjections(
        service,
        eventId,
        correlationId,
        claim.leaseToken,
      ) ?? revision
    } finally {
      pending = await releaseProjectionPublish(
        service,
        eventId,
        publishedRevision,
        claim.leaseToken,
      )
    }
    if (pending) {
      scheduleProjectionRepair(service, eventId, publishedRevision, correlationId)
    }
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

  const body = await readJsonBody(req)
  if (body === null) {
    return rejected(400, 'SCORE_INVALID', correlationId, 'malformed JSON body')
  }

  const parsed = submitScoreRequestSchema.safeParse(body)
  if (!parsed.success) {
    return rejected(
      400,
      'SCORE_INVALID',
      correlationId,
      parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    )
  }
  const request = parsed.data
  const target = request.target

  // ── Step 2: durable, idempotent, revision-checked write ──────────────────
  const { data: mutation, error: mutationError } = await caller.client.rpc(
    'apply_score_mutation',
    {
      p_idempotency_key: request.idempotencyKey,
      p_event_id: request.eventId,
      p_round_id: request.roundId,
      p_target_kind: target.kind,
      p_entry_id: target.kind === 'individual' ? target.entryId : null,
      p_team_id: target.kind === 'team' ? target.teamId : null,
      p_hole_id: target.holeId,
      p_base_revision: request.baseRevision,
      p_status: request.value.status,
      p_gross_strokes: request.value.grossStrokes ?? null,
      p_notes: request.value.notes ?? null,
      p_client_recorded_at: request.clientRecordedAt,
      p_device_id_hash: null,
    },
  )

  if (mutationError) {
    return rejected(
      500,
      'SERVICE_UNAVAILABLE',
      correlationId,
      mutationError.message,
    )
  }

  const result = mutation as {
    status: string
    error_code?: string
    detail?: string
    score_revision?: number
    event_revision?: number
    conflict_id?: string
    server_revision?: number
  }

  if (result.status === 'rejected') {
    const code = result.error_code ?? 'SCORE_INVALID'
    const httpStatus = code === 'AUTH_REQUIRED' ? 401
      : code === 'NOT_ASSIGNED' ? 403
      : code === 'EVENT_LOCKED' ? 409
      : 400
    return rejected(httpStatus, code, correlationId, result.detail)
  }

  if (result.status === 'conflict') {
    return json(409, {
      status: 'conflict',
      scoreRevision: result.server_revision ?? null,
      eventRevision: result.event_revision ?? null,
      projectionRevision: null,
      conflictId: result.conflict_id ?? null,
      errorCode: result.error_code ?? 'BASE_REVISION_STALE',
      correlationId,
    })
  }

  // ── Step 3: recompute and publish projections ────────────────────────────
  const service = serviceClient()
  let projectionRevision: number | null = null

  const eventRevision = result.event_revision ?? 0
  const projectionClaim = await claimProjectionPublish(
    service,
    request.eventId,
    eventRevision,
  )
  if (projectionClaim.status === 'claimed') {
    let pending = false
    try {
      projectionRevision = await publishLatestProjections(
        service,
        request.eventId,
        correlationId,
        projectionClaim.leaseToken,
      )
    } finally {
      pending = await releaseProjectionPublish(
        service,
        request.eventId,
        projectionRevision ?? eventRevision,
        projectionClaim.leaseToken,
      )
    }
    if (pending) {
      scheduleProjectionRepair(service, request.eventId, eventRevision, correlationId)
    }
  } else if (projectionClaim.status === 'wait') {
    scheduleProjectionRepair(
      service,
      request.eventId,
      eventRevision,
      correlationId,
      PROJECTION_LEASE_MS + PROJECTION_DEBOUNCE_MS,
      projectionClaim.leaseToken,
    )
  }

  const status =
    result.status === 'duplicate'
      ? 'duplicate'
      : projectionRevision === null
        ? 'queued_projection'
        : 'committed'

  return json(200, {
    status,
    scoreRevision: result.score_revision ?? null,
    eventRevision: result.event_revision ?? null,
    projectionRevision,
    errorCode: null,
    correlationId,
  })
})
