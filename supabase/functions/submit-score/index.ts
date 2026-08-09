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
  let lastPublishStatus = 'stale'

  for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
    let snapshot
    try {
      snapshot = await loadScoringSnapshot(service, request.eventId)
    } catch (err) {
      // The score is durable; projections can be repaired later.
      console.error(
        JSON.stringify({ correlationId, stage: 'snapshot', message: String(err) }),
      )
      break
    }

    const payload = buildProjections(snapshot)
    const { data: published, error: publishError } = await service.rpc(
      'publish_projections',
      {
        p_event_id: request.eventId,
        p_revision: snapshot.event.scoring_revision,
        p_result: payload,
      },
    )

    if (publishError) {
      console.error(
        JSON.stringify({ correlationId, stage: 'publish', message: publishError.message }),
      )
      break
    }

    const pub = published as { status: string; event_revision?: number }
    lastPublishStatus = pub.status
    if (pub.status === 'published') {
      projectionRevision = pub.event_revision ?? snapshot.event.scoring_revision
      break
    }
    // 'stale': a newer mutation landed mid-calculation — recompute (§7.2).
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
    ...(projectionRevision === null ? { projectionStatus: lastPublishStatus } : {}),
  })
})
