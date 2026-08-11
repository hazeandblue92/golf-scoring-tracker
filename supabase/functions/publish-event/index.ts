/** Publish immutable event snapshots and optionally open scoring (spec §12.2). */

import { publishEventRequestSchema } from '../../../packages/contracts/src/index.ts'
import { buildProjections } from '../_shared/projection-orchestrator.ts'
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
  const parsed = publishEventRequestSchema.safeParse(await readJsonBody(req))
  if (!parsed.success) {
    return rejected(400, 'SNAPSHOT_INVALID', correlationId,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  }

  const service = serviceClient()
  const { data: scrambleCompetitions, error: competitionError } = await service
    .from('competitions')
    .select('id')
    .eq('event_id', parsed.data.eventId)
    .eq('format', 'scramble')
    .limit(1)
  if (competitionError) {
    return rejected(500, 'SERVICE_UNAVAILABLE', correlationId, competitionError.message)
  }
  const rpcName = (scrambleCompetitions ?? []).length > 0
    ? 'publish_phase3_scramble_event'
    : 'publish_phase2_event'
  const { data, error } = await service.rpc(rpcName, {
    p_actor: caller.userId,
    p_event_id: parsed.data.eventId,
    p_open_scoring: parsed.data.openScoring,
  })
  if (error) {
    const denied = error.code === '42501'
    return rejected(denied ? 403 : 409, denied ? 'NOT_ASSIGNED' : 'SNAPSHOT_INVALID',
      correlationId, error.message)
  }

  // Revision zero is still a real projection: it gives the freshly published
  // event a complete, provisional leaderboard before the first score arrives.
  const snapshot = await loadScoringSnapshot(service, parsed.data.eventId)
  const payload = buildProjections(snapshot)
  const { data: projection, error: projectionError } = await service.rpc(
    'publish_projections',
    {
      p_event_id: parsed.data.eventId,
      p_revision: snapshot.event.scoring_revision,
      p_result: payload,
    },
  )
  if (projectionError) {
    return rejected(500, 'PROJECTION_STALE', correlationId, projectionError.message)
  }
  return json(200, {
    ...(data as Record<string, unknown>),
    projectionStatus: (projection as { status?: string })?.status ?? 'unknown',
    correlationId,
  })
})
