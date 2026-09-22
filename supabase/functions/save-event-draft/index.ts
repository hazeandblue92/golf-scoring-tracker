/** Save an individual, two-person, or Phase 3 scramble event draft (spec §5.2). */

import { saveEventDraftRequestSchema } from '../../../packages/contracts/src/index.ts'
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

  const parsed = saveEventDraftRequestSchema.safeParse(await readJsonBody(req))
  if (!parsed.success) {
    return rejected(400, 'SNAPSHOT_INVALID', correlationId,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  }
  const body = parsed.data
  const { data, error } = await serviceClient().rpc('save_event_draft_with_groups', {
    p_actor: caller.userId,
    p_body: body,
  })
  if (error) {
    const denied = error.code === '42501'
    return rejected(denied ? 403 : 409, denied ? 'NOT_ASSIGNED' : 'SNAPSHOT_INVALID',
      correlationId, error.message)
  }
  return json(200, { ...(data as Record<string, unknown>), correlationId })
})
