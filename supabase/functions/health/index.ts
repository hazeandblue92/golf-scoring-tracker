/**
 * health Edge Function (spec §12.2, §17.2).
 *
 * Reports ok / degraded / unavailable. Never exposes secrets, SQL versions
 * beyond a safe schema number, or league data. Unauthenticated callers get
 * the limited public summary; authenticated callers get the full body.
 */

import {
  CORS_HEADERS,
  json,
  newCorrelationId,
  readEdgeEnv,
  requireUser,
} from '../_shared/http.ts'
import { ENGINE_VERSION } from '../../../packages/scoring/src/index.ts'

Deno.serve(async (req: Request) => {
  const correlationId = newCorrelationId()
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  let dbOk = false
  let authOk = false
  try {
    const { createClient } = await import('npm:@supabase/supabase-js@2')
    const env = readEdgeEnv()
    const service = createClient(env.supabaseUrl, env.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { error } = await service
      .from('leagues')
      .select('id', { count: 'exact', head: true })
    dbOk = !error
    const { error: authError } = await service.auth.admin.listUsers({
      page: 1,
      perPage: 1,
    })
    authOk = !authError
  } catch {
    dbOk = false
    authOk = false
  }

  const status = dbOk && authOk ? 'ok' : 'degraded'
  const caller = await requireUser(req, correlationId)

  if (caller instanceof Response) {
    // Limited public summary (§17.2).
    return json(200, { status })
  }

  return json(200, {
    status,
    appVersion: Deno.env.get('RELEASE_VERSION') ?? 'dev',
    edgeVersion: Deno.env.get('RELEASE_VERSION') ?? 'dev',
    engineVersion: ENGINE_VERSION,
    schemaVersion: 20,
    authOk,
    dbOk,
    correlationId,
  })
})
