/**
 * username-login Edge Function (spec §14.1, §12.2, §12.5, FR-AUTH-001).
 *
 * Public endpoint: POST { username, password }.
 *
 * Resolves the username to the opaque internal auth identifier with
 * service-only access, then performs a password grant against Supabase Auth
 * using a SEPARATE client configured with the public publishable key.
 *
 * Non-negotiables (§14.1):
 *   - ONE nondisclosing error for unknown username OR wrong password.
 *   - The internal email, the profile lookup row, and the password are never
 *     returned and never logged.
 *   - No client-callable username-to-email lookup exists anywhere.
 *   - Rate-limited FIRST by sha256(client network) + normalized username.
 */

import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  clientNetworkKey,
  errorJson,
  gatePost,
  json,
  readEdgeEnv,
  readJsonBody,
  sha256Hex,
} from '../_shared/auth-http.ts'

const LOGIN_MAX_ATTEMPTS = 10
const LOGIN_WINDOW = '5 minutes'

/** The single nondisclosing failure shape (§14.1). */
function invalidCredentials(): Response {
  return errorJson(401, 'AUTH_REQUIRED', 'Invalid username or password')
}

Deno.serve(async (req) => {
  const gate = gatePost(req)
  if (gate) return gate

  const env = readEdgeEnv()

  const body = (await readJsonBody(req)) as
    | { username?: unknown; password?: unknown }
    | null
  const rawUsername = body?.username
  const password = body?.password
  if (
    typeof rawUsername !== 'string' ||
    typeof password !== 'string' ||
    rawUsername.length === 0 ||
    password.length === 0
  ) {
    // Malformed input gets the same nondisclosing shape: nothing about which
    // part failed is revealed.
    return invalidCredentials()
  }

  // Normalize per §3.1: trim, lowercase (usernames are citext / lowercase).
  const username = rawUsername.trim().toLowerCase()

  const service = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // 1) Rate limit FIRST (§12.5, §14.1): privacy-preserving client-network
  //    hash + normalized username. Raw IPs are never stored.
  const networkHash = await sha256Hex(clientNetworkKey(req))
  const bucket = `login:${networkHash}:${username}`
  const { data: allowed, error: rateError } = await service.rpc(
    'consume_rate_limit',
    { p_bucket: bucket, p_max: LOGIN_MAX_ATTEMPTS, p_window: LOGIN_WINDOW },
  )
  if (rateError) {
    console.error('username-login: rate limit check failed', rateError.code)
    return errorJson(503, 'SERVICE_UNAVAILABLE', 'Please try again shortly')
  }
  if (allowed !== true) {
    return errorJson(429, 'RATE_LIMITED', 'Too many attempts. Try again later.')
  }

  // 2) Service-only username resolution. The lookup row is never returned.
  const { data: profile, error: profileError } = await service
    .from('profiles')
    .select('id, status, must_change_password, display_name')
    .eq('username', username)
    .maybeSingle()
  if (profileError) {
    console.error('username-login: profile lookup failed', profileError.code)
    return errorJson(503, 'SERVICE_UNAVAILABLE', 'Please try again shortly')
  }
  if (!profile) {
    // Unknown username: identical shape to wrong password (§14.1).
    return invalidCredentials()
  }
  if (profile.status !== 'active') {
    // Disabled accounts lose new access immediately (FR-AUTH-008). Same
    // nondisclosing response body, but a distinct internal audit trail.
    console.warn('username-login: sign-in attempt on disabled profile')
    await service.from('audit_events').insert({
      actor_profile_id: null,
      action: 'auth.login_rejected_disabled',
      target_type: 'profile',
      target_id: profile.id,
    })
    return invalidCredentials()
  }

  // 3) Resolve the opaque internal identifier (never exposed or logged).
  const { data: userData, error: userError } = await service.auth.admin
    .getUserById(profile.id)
  const internalEmail = userData?.user?.email
  if (userError || !internalEmail) {
    console.error('username-login: auth user resolution failed')
    return invalidCredentials()
  }

  // 4) Password grant on a SEPARATE client built with the PUBLISHABLE key
  //    (§14.1): the session is minted exactly as a normal client sign-in.
  const authClient = createClient(env.supabaseUrl, env.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: signIn, error: signInError } = await authClient.auth
    .signInWithPassword({ email: internalEmail, password })
  if (signInError || !signIn?.session) {
    // Wrong password: identical shape to unknown username. Do not log the
    // error object (it may embed the email used for the grant).
    return invalidCredentials()
  }

  const session = signIn.session
  return json(200, {
    session: {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      expires_at: session.expires_at,
      token_type: session.token_type,
    },
    mustChangePassword: profile.must_change_password,
    displayName: profile.display_name,
    profileId: profile.id,
  })
})
