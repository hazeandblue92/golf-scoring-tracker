/** Reopen one finalized competition through the audited MFA workflow. */

import { reopenCompetitionRequestSchema } from '../../../packages/contracts/src/index.ts'
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

  const parsed = reopenCompetitionRequestSchema.safeParse(await readJsonBody(req))
  if (!parsed.success) {
    return rejected(
      400,
      'SCORE_INVALID',
      correlationId,
      parsed.error.issues.map((issue) =>
        `${issue.path.join('.')}: ${issue.message}`).join('; '),
    )
  }

  const { data, error } = await serviceClient().rpc('reopen_competition', {
    p_actor: caller.userId,
    p_competition_id: parsed.data.competitionId,
    p_reason: parsed.data.reason,
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
