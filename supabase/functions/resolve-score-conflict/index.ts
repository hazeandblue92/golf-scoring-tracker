/** Resolve an explicit score conflict without last-write-wins (spec §10.4). */

import { resolveScoreConflictRequestSchema } from '../../../packages/contracts/src/index.ts'
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

Deno.serve(async (req: Request) => {
  const correlationId = newCorrelationId()
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') {
    return rejected(405, 'SERVICE_UNAVAILABLE', correlationId, 'Method not allowed')
  }
  const caller = await requireUser(req, correlationId)
  if (caller instanceof Response) return caller
  const parsed = resolveScoreConflictRequestSchema.safeParse(await readJsonBody(req))
  if (!parsed.success) {
    return rejected(400, 'SCORE_INVALID', correlationId,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  }

  const service = serviceClient()
  const { data: conflict, error } = await service
    .from('score_conflicts')
    .select('*')
    .eq('id', parsed.data.conflictId)
    .single()
  if (error || !conflict) {
    return rejected(404, 'SNAPSHOT_INVALID', correlationId, 'conflict not found')
  }
  if (conflict.status !== 'open') {
    return json(200, { status: 'duplicate', conflictId: parsed.data.conflictId, correlationId })
  }

  let value: { status: string; grossStrokes: number | null; notes: string | null }
  if (parsed.data.choice === 'local') {
    value = conflict.local_payload as typeof value
  } else if (parsed.data.choice === 'manual') {
    value = parsed.data.manualValue!
  } else {
    value = conflict.server_payload as typeof value
  }

  if (parsed.data.choice !== 'server') {
    const { data: mutation, error: mutationError } = await caller.client.rpc(
      'apply_score_mutation',
      {
        p_idempotency_key: crypto.randomUUID(),
        p_event_id: conflict.event_id,
        p_round_id: conflict.round_id,
        p_target_kind: conflict.target_kind,
        p_entry_id: conflict.event_entry_id,
        p_team_id: conflict.event_team_id,
        p_hole_id: conflict.event_hole_id,
        p_base_revision: conflict.server_revision ?? 0,
        p_status: value.status,
        p_gross_strokes: value.grossStrokes,
        p_notes: value.notes ?? null,
        p_client_recorded_at: new Date().toISOString(),
        p_device_id_hash: null,
      },
    )
    const outcome = mutation as { status?: string; detail?: string }
    if (mutationError || !['committed', 'duplicate'].includes(outcome?.status ?? '')) {
      return rejected(409, 'BASE_REVISION_STALE', correlationId,
        mutationError?.message ?? outcome?.detail ?? 'score changed again; review the latest conflict')
    }
  }

  const { data: marked, error: markError } = await service.rpc(
    'mark_score_conflict_resolved',
    {
      p_actor: caller.userId,
      p_conflict_id: parsed.data.conflictId,
      p_choice: parsed.data.choice,
      p_value: value,
      p_reason: parsed.data.reason,
    },
  )
  if (markError) {
    const denied = markError.code === '42501'
    return rejected(denied ? 403 : 409, denied ? 'NOT_ASSIGNED' : 'BASE_REVISION_STALE',
      correlationId, markError.message)
  }

  if (parsed.data.choice !== 'server') {
    try {
      const snapshot = await loadScoringSnapshot(service, conflict.event_id as string)
      await service.rpc('publish_projections', {
        p_event_id: conflict.event_id,
        p_revision: snapshot.event.scoring_revision,
        p_result: buildProjections(snapshot),
      })
    } catch (projectionError) {
      console.error(JSON.stringify({ correlationId, stage: 'projection', message: String(projectionError) }))
    }
  }
  return json(200, { ...(marked as Record<string, unknown>), correlationId })
})
