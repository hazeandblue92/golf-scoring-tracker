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

  let lifecycle: Record<string, unknown>
  let replayed = false
  if (error) {
    // The lifecycle transition and the initial projection publish are separate
    // transactions. If a previous attempt transitioned the event and then
    // failed to publish projections, this call cannot transition it again —
    // only a draft can be published — so the naive retry reported a publish
    // failure for an event that is already published and possibly open for
    // scoring. Recover by skipping straight to the projection rebuild.
    const denied = error.code === '42501'
    if (denied) {
      return rejected(403, 'NOT_ASSIGNED', correlationId, error.message)
    }
    const { data: existing } = await service
      .from('events')
      .select('id,league_id,status')
      .eq('id', parsed.data.eventId)
      .maybeSingle()
    const published = existing !== null
      && ['published', 'scoring_open', 'scoring_closed', 'finalized'].includes(existing.status)
    if (!published) {
      return rejected(409, 'SNAPSHOT_INVALID', correlationId, error.message)
    }
    // The RPC carries the authorization check that this path skips, so the
    // director role must be re-verified explicitly before repairing anything.
    const { data: roles } = await service
      .from('role_assignments')
      .select('role,event_id,league_id')
      .eq('profile_id', caller.userId)
      .is('revoked_at', null)
    const authorized = (roles ?? []).some((row) =>
      (['owner', 'league_admin'].includes(row.role) && row.league_id === existing.league_id)
      || (row.role === 'event_director' && row.event_id === existing.id))
    if (!authorized) {
      return rejected(403, 'NOT_ASSIGNED', correlationId, 'event director role required')
    }
    lifecycle = { eventId: existing.id, status: existing.status }
    replayed = true
  } else {
    lifecycle = data as Record<string, unknown>
  }

  // Revision zero is still a real projection: it gives the freshly published
  // event a complete, provisional leaderboard before the first score arrives.
  //
  // A failure here must NOT be reported as a publish failure. The event is
  // published either way, and telling an organizer that publishing failed for
  // an event whose scoring is already open is the more dangerous lie. Report
  // the event as published with projections pending; repair rebuilds them.
  let projectionStatus = 'pending'
  let projectionDetail: string | null = null
  try {
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
    if (projectionError) throw new Error(projectionError.message)
    projectionStatus = (projection as { status?: string })?.status ?? 'unknown'
  } catch (cause) {
    projectionStatus = 'pending'
    projectionDetail = cause instanceof Error ? cause.message : String(cause)
  }

  return json(200, {
    ...lifecycle,
    projectionStatus,
    projectionPending: projectionStatus === 'pending',
    ...(projectionDetail === null ? {} : { projectionDetail }),
    ...(replayed ? { replayed: true } : {}),
    correlationId,
  })
})
