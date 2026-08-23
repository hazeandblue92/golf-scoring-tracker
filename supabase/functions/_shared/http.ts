/**
 * Shared HTTP helpers for the scoring Edge Functions (spec §12.1, §12.4).
 *
 * Auth-specific helpers live in `auth-http.ts`; the primitives shared by both
 * families (CORS, JSON, method gate, env) are re-exported from here so a
 * function only imports one module.
 */

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { createSupabaseContext } from 'npm:@supabase/server@1.4.1'
import {
  CORS_HEADERS,
  decodeJwtPayload,
  json,
  readEdgeEnv,
} from './auth-http.ts'

export {
  bearerToken,
  CORS_HEADERS,
  errorJson,
  gatePost,
  json,
  readEdgeEnv,
  readJsonBody,
  sha256Hex,
} from './auth-http.ts'

/** Every response carries a correlation ID (spec §17.1 observability). */
export function newCorrelationId(): string {
  return crypto.randomUUID()
}

export interface ErrorEnvelope {
  status: 'rejected'
  errorCode: string
  detail?: string
  correlationId: string
}

export function rejected(
  httpStatus: number,
  errorCode: string,
  correlationId: string,
  detail?: string,
): Response {
  const body: ErrorEnvelope = { status: 'rejected', errorCode, correlationId }
  if (detail !== undefined) body.detail = detail
  return json(httpStatus, body)
}

/** Service-role client. Server-side only — never reachable from a browser. */
export function serviceClient(): SupabaseClient {
  const env = readEdgeEnv()
  return createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export interface AuthedCaller {
  client: SupabaseClient
  userId: string
  token: string
}

/**
 * Build a client bound to the CALLER's JWT so PostgreSQL sees their auth
 * context and RLS/`auth.uid()` apply (spec §7.2: apply_score_mutation runs
 * under the caller's identity, never the service role).
 *
 * Returns a Response to short-circuit when unauthenticated.
 */
export async function requireUser(
  req: Request,
  correlationId: string,
): Promise<AuthedCaller | Response> {
  const header = req.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) {
    return rejected(401, 'AUTH_REQUIRED', correlationId, 'missing bearer token')
  }
  const token = match[1].trim()
  let context
  try {
    const result = await createSupabaseContext(req, { auth: 'user' })
    if (result.error) {
      return rejected(401, 'AUTH_REQUIRED', correlationId, 'invalid session')
    }
    context = result.data
  } catch {
    return rejected(401, 'AUTH_REQUIRED', correlationId, 'invalid session')
  }
  if (!context?.userClaims?.id) {
    return rejected(401, 'AUTH_REQUIRED', correlationId, 'invalid session')
  }
  // Without generated database types supabase-js infers the row as `never`,
  // so name the shape here rather than reaching into an untyped result.
  const { data: profile, error: profileError } = await context.supabase
    .from('profiles')
    .select('status,must_change_password')
    .eq('id', context.userClaims.id)
    .maybeSingle<{ status: string; must_change_password: boolean }>()
  if (profileError || !profile || profile.status !== 'active') {
    return rejected(401, 'AUTH_REQUIRED', correlationId, 'inactive session')
  }
  if (profile.must_change_password) {
    return rejected(
      401,
      'AUTH_REQUIRED',
      correlationId,
      'password change required',
    )
  }
  return {
    client: context.supabase as SupabaseClient,
    userId: context.userClaims.id,
    token,
  }
}

/**
 * Privileged organizer workflows require a session that has completed its
 * verified TOTP challenge (FR-AUTH-005, §14.2). Call only after requireUser,
 * which has already authenticated the token and checked the active profile.
 */
export function requireMfa(
  caller: AuthedCaller,
  correlationId: string,
): Response | null {
  if (decodeJwtPayload(caller.token)['aal'] === 'aal2') return null
  return rejected(
    403,
    'MFA_REQUIRED',
    correlationId,
    'Enroll or verify your authenticator in More → Account security, then try again',
  )
}

export function corsPreflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }
  return null
}
