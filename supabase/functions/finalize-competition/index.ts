/** Deterministically finalize a Phase 1 competition (spec §12.2). */

import { finalizeCompetitionRequestSchema } from '../../../packages/contracts/src/index.ts'
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

async function publishCurrent(service: ReturnType<typeof serviceClient>, eventId: string) {
  const snapshot = await loadScoringSnapshot(service, eventId)
  const payload = buildProjections(snapshot)
  const { error } = await service.rpc('publish_projections', {
    p_event_id: eventId,
    p_revision: snapshot.event.scoring_revision,
    p_result: payload,
  })
  if (error) throw new Error(error.message)
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
  const parsed = finalizeCompetitionRequestSchema.safeParse(await readJsonBody(req))
  if (!parsed.success) {
    return rejected(400, 'SCORE_INVALID', correlationId,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  }

  const service = serviceClient()
  const { data: competition, error: competitionError } = await service
    .from('competitions')
    .select('event_id')
    .eq('id', parsed.data.competitionId)
    .single()
  if (competitionError || !competition) {
    return rejected(404, 'SNAPSHOT_INVALID', correlationId, 'competition not found')
  }

  try {
    await publishCurrent(service, competition.event_id as string)
  } catch (error) {
    return rejected(409, 'PROJECTION_STALE', correlationId, String(error))
  }

  const { data, error } = await service.rpc('finalize_phase1_competition', {
    p_actor: caller.userId,
    p_competition_id: parsed.data.competitionId,
    p_override_reason: parsed.data.overrideReason,
  })
  if (error) {
    const denied = error.code === '42501'
    return rejected(denied ? 403 : 409, denied ? 'NOT_ASSIGNED' : 'EVENT_LOCKED',
      correlationId, error.message)
  }
  const result = data as { status?: string; eventId?: string }
  if (result.status === 'blocked') {
    return json(409, { ...result, correlationId })
  }
  if (result.eventId) {
    try {
      await publishCurrent(service, result.eventId)
    } catch (error) {
      console.error(JSON.stringify({ correlationId, stage: 'final-projection', message: String(error) }))
    }
  }
  return json(200, { ...result, correlationId })
})
