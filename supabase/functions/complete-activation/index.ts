/**
 * complete-activation Edge Function (spec §14.1, §3.1, §12.2, FR-AUTH-003).
 *
 * POST { newPassword } with the authenticated TEMPORARY session's
 * Authorization header. Updates the user's password through Auth, THEN clears
 * profiles.must_change_password only after the password update succeeds.
 *
 * Partial-failure ordering (§14.1): if the flag update fails after the
 * password update, the new password may already work while the user remains
 * in the activation state; this call is idempotent, so the client simply
 * retries until the flag is cleared. Score and privileged functions reject
 * any user whose flag remains true.
 *
 * Passphrase policy (§18.1: no cognitive puzzles): minimum length only —
 * 12+ characters, passphrase-friendly, no composition rules.
 */

import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  bearerToken,
  errorJson,
  gatePost,
  json,
  readEdgeEnv,
  readJsonBody,
} from '../_shared/auth-http.ts'

const MIN_PASSPHRASE_LENGTH = 12

Deno.serve(async (req) => {
  const gate = gatePost(req)
  if (gate) return gate

  const env = readEdgeEnv()

  const token = bearerToken(req)
  if (!token) {
    return errorJson(401, 'AUTH_REQUIRED', 'Sign in to continue')
  }

  const service = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Verify the temporary session. Any valid session for this user is
  // acceptable: activation is idempotent and re-running it is harmless.
  const { data: userData, error: userError } = await service.auth.getUser(token)
  const user = userData?.user
  if (userError || !user) {
    return errorJson(401, 'AUTH_REQUIRED', 'Sign in to continue')
  }

  const body = (await readJsonBody(req)) as { newPassword?: unknown } | null
  const newPassword = body?.newPassword
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSPHRASE_LENGTH) {
    return errorJson(
      400,
      'PASSWORD_TOO_SHORT',
      `Choose a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters`,
    )
  }

  // 1) Update the password through Auth first (§14.1 ordering).
  const { error: passwordError } = await service.auth.admin.updateUserById(
    user.id,
    { password: newPassword },
  )
  if (passwordError) {
    console.error('complete-activation: password update failed')
    return errorJson(503, 'SERVICE_UNAVAILABLE', 'Please try again shortly')
  }

  // 2) Only after success, clear the activation flag.
  const { error: flagError } = await service
    .from('profiles')
    .update({ must_change_password: false })
    .eq('id', user.id)
  if (flagError) {
    // Safe partial failure: the new password may already work, but the user
    // stays in activation until an idempotent retry clears the flag.
    console.error('complete-activation: flag clear failed', flagError.code)
    return errorJson(503, 'SERVICE_UNAVAILABLE', 'Please retry activation')
  }

  // 3) Revoke every OTHER session so the temporary credential state cannot
  //    linger elsewhere (§3.1); the current session stays valid.
  const { error: signOutError } = await service.auth.admin.signOut(
    token,
    'others',
  )
  if (signOutError) {
    // Non-fatal: activation succeeded; other sessions expire naturally.
    console.warn('complete-activation: sign-out of other sessions failed')
  }

  // 4) Audit the activation (no secrets, §11.8).
  const { error: auditError } = await service.from('audit_events').insert({
    actor_profile_id: user.id,
    action: 'account.activation_completed',
    target_type: 'profile',
    target_id: user.id,
  })
  if (auditError) {
    console.error('complete-activation: audit append failed', auditError.code)
  }

  return json(200, { status: 'activated', mustChangePassword: false })
})
