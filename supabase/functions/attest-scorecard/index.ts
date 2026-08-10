/** Sign the current revision of an individual or team scorecard (spec §5.6). */

import { attestScorecardRequestSchema } from '../../../packages/contracts/src/index.ts'
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
  const parsed = attestScorecardRequestSchema.safeParse(await readJsonBody(req))
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

  const body = parsed.data
  const { data, error } = await serviceClient().rpc('attest_phase2_scorecard', {
    p_actor: caller.userId,
    p_round_id: body.roundId,
    p_target_kind: body.targetKind,
    p_target_id: body.targetId,
    p_attestation_type: body.attestationType,
    p_reason: body.reason,
  })
  if (error) {
    const denied = error.code === '42501'
    return rejected(
      denied ? 403 : 409,
      denied ? 'NOT_ASSIGNED' : 'EVENT_LOCKED',
      correlationId,
      error.message,
    )
  }
  return json(200, { ...(data as Record<string, unknown>), correlationId })
})
