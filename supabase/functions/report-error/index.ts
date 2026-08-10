/** Sanitized, capped Phase 4 client-error aggregation (spec §17.1). */

import { reportAppErrorRequestSchema } from '../../../packages/contracts/src/index.ts'
import {
  corsPreflight,
  json,
  newCorrelationId,
  readJsonBody,
  rejected,
  serviceClient,
} from '../_shared/http.ts'

Deno.serve(async (req: Request) => {
  const correlationId = newCorrelationId()
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') {
    return rejected(405, 'SERVICE_UNAVAILABLE', correlationId, 'Method not allowed')
  }

  const parsed = reportAppErrorRequestSchema.safeParse(await readJsonBody(req))
  if (!parsed.success) {
    return rejected(400, 'SCORE_INVALID', correlationId, 'invalid sanitized error aggregate')
  }

  const body = parsed.data
  const { error } = await serviceClient().rpc('record_phase4_error', {
    p_error_code: body.errorCode,
    // Release is server-owned so an unauthenticated client cannot manufacture
    // unbounded aggregation buckets.
    p_release: Deno.env.get('RELEASE_VERSION') ?? 'dev',
    p_route_family: body.routeFamily,
    p_correlation_id: body.correlationId ?? null,
    p_severity: body.severity,
  })
  if (error) {
    return rejected(503, 'SERVICE_UNAVAILABLE', correlationId, 'error aggregate unavailable')
  }

  // Do not expose aggregate identifiers/counts to unauthenticated clients.
  return json(202, { status: 'accepted', correlationId })
})
