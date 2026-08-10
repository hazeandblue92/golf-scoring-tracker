/**
 * rebuild-projections Edge Function (spec §12.2, §17.6 "projection stuck").
 *
 * Repairs stale or missing projections without touching raw score facts,
 * which remain authoritative. Director or operator only.
 */

import { rebuildProjectionsRequestSchema } from '../../../packages/contracts/src/index.ts'
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

  const parsed = rebuildProjectionsRequestSchema.safeParse(await readJsonBody(req))
  if (!parsed.success) {
    return rejected(400, 'SCORE_INVALID', correlationId, 'a valid eventId is required')
  }
  const { eventId } = parsed.data

  // Authorization: the caller must hold an active director/admin/owner grant
  // for this event's league or the event itself. role_assignments is readable
  // under RLS only within the caller's scope (§14.3), so an empty result is a
  // denial rather than an error.
  const service = serviceClient()
  const { data: eventRow, error: eventError } = await service
    .from('events')
    .select('id, league_id')
    .eq('id', eventId)
    .single()
  if (eventError || !eventRow) {
    return rejected(404, 'SNAPSHOT_INVALID', correlationId, 'unknown event')
  }

  const { data: grants } = await service
    .from('role_assignments')
    .select('role, event_id')
    .eq('profile_id', caller.userId)
    .eq('league_id', eventRow.league_id)
    .is('revoked_at', null)

  const authorized = (grants ?? []).some(
    (g: { role: string; event_id: string | null }) =>
      g.role === 'owner' ||
      g.role === 'league_admin' ||
      (g.role === 'event_director' && (g.event_id === null || g.event_id === eventId)),
  )
  if (!authorized) {
    return rejected(403, 'NOT_ASSIGNED', correlationId, 'director or admin role required')
  }

  const snapshot = await loadScoringSnapshot(service, eventId)
  const payload = buildProjections(snapshot)
  const { data: published, error: publishError } = await service.rpc(
    'publish_projections',
    {
      p_event_id: eventId,
      p_revision: snapshot.event.scoring_revision,
      p_result: payload,
    },
  )
  if (publishError) {
    return rejected(500, 'SERVICE_UNAVAILABLE', correlationId, publishError.message)
  }

  const pub = published as { status: string; event_revision?: number }
  return json(200, {
    status: pub.status,
    eventRevision: pub.event_revision ?? snapshot.event.scoring_revision,
    competitions: payload.competitions.length,
    correlationId,
  })
})
