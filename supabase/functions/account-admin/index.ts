/**
 * account-admin Edge Function (spec §12.2, §3.1, §4.1 FR-AUTH-002/004/005/008,
 * §14.1 zero-email account design).
 *
 * POST { action: 'create' | 'disable' | 'reactivate' | 'reset', ... } with an
 * authenticated owner/league_admin session.
 *
 * All identity operations happen server-side through the GoTrue admin API
 * with the service-role key; internal @users.invalid email identifiers are
 * implementation details and are never returned or logged. Temporary
 * passwords are returned exactly ONCE for out-of-band delivery (§3.1) and
 * are never stored or written to the audit trail.
 */

import { createClient } from 'npm:@supabase/supabase-js@2'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import {
  bearerToken,
  decodeJwtPayload,
  errorJson,
  gatePost,
  json,
  randomSecret,
  readEdgeEnv,
  readJsonBody,
} from '../_shared/auth-http.ts'

// §12.5: account-admin has a substantially lower limit than score mutation.
const ADMIN_MAX_CALLS = 20
const ADMIN_WINDOW = '10 minutes'

const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/
const TEMP_PASSWORD_LENGTH = 24 // §14.1 requires at least 16.
// Effectively-permanent GoTrue ban for disabled accounts (~100 years).
const DISABLE_BAN_DURATION = '876000h'

interface ActionRequest {
  action?: unknown
  username?: unknown
  displayName?: unknown
  profileId?: unknown
}

/** Random opaque internal auth identifier under the reserved .invalid TLD. */
function internalEmail(): string {
  return crypto.randomUUID().replace(/-/g, '') + '@users.invalid'
}

/**
 * Revoke every session of a user by id (admin). supabase-js exposes
 * admin.signOut(jwt) only for a caller-held JWT, so the GoTrue admin
 * logout-by-user-id endpoint is called directly.
 */
async function adminSignOutAllSessions(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
): Promise<void> {
  const response = await fetch(
    `${supabaseUrl}/auth/v1/admin/users/${userId}/logout`,
    {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
      },
    },
  )
  if (!response.ok && response.status !== 404) {
    console.warn('account-admin: admin logout returned', response.status)
  }
  // Drain the body so the connection can be reused.
  await response.body?.cancel()
}

async function appendAudit(
  service: SupabaseClient,
  entry: {
    actorProfileId: string
    action: string
    leagueId: string | null
    targetId: string
    afterJson?: Record<string, unknown>
  },
): Promise<void> {
  const { error } = await service.from('audit_events').insert({
    actor_profile_id: entry.actorProfileId,
    action: entry.action,
    scope_league_id: entry.leagueId,
    target_type: 'profile',
    target_id: entry.targetId,
    after_json: entry.afterJson ?? null,
  })
  if (error) {
    console.error('account-admin: audit append failed', error.code)
  }
}

Deno.serve(async (req) => {
  const gate = gatePost(req)
  if (gate) return gate

  const env = readEdgeEnv()

  const token = bearerToken(req)
  if (!token) return errorJson(401, 'AUTH_REQUIRED', 'Sign in to continue')

  const service = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // requireUser: verify the caller's JWT.
  const { data: userData, error: userError } = await service.auth.getUser(token)
  const caller = userData?.user
  if (userError || !caller) {
    return errorJson(401, 'AUTH_REQUIRED', 'Sign in to continue')
  }
  const { data: callerProfile, error: callerProfileError } = await service
    .from('profiles')
    .select('status')
    .eq('id', caller.id)
    .maybeSingle()
  if (callerProfileError || callerProfile?.status !== 'active') {
    return errorJson(401, 'AUTH_REQUIRED', 'Sign in to continue')
  }

  // Authorize: an active (revoked_at null) owner or league_admin role,
  // checked server-side against role_assignments (§2.2: never inferred from
  // client-side flags or user metadata).
  const { data: roles, error: rolesError } = await service
    .from('role_assignments')
    .select('league_id, role')
    .eq('profile_id', caller.id)
    .is('revoked_at', null)
    .in('role', ['owner', 'league_admin'])
  if (rolesError) {
    console.error('account-admin: role lookup failed', rolesError.code)
    return errorJson(503, 'SERVICE_UNAVAILABLE', 'Please try again shortly')
  }
  if (!roles || roles.length === 0) {
    return errorJson(403, 'NOT_ASSIGNED', 'Organizer role required')
  }
  const leagueId = roles[0].league_id as string

  // MFA gate (FR-AUTH-005): enrollment alone is insufficient. The current
  // session must have completed its verified TOTP challenge and carry aal2.
  const aal = decodeJwtPayload(token)['aal']
  if (aal !== 'aal2') {
    return errorJson(
      403,
      'MFA_REQUIRED',
      'Enroll or verify your authenticator before administrative actions',
    )
  }

  // §12.5: substantially lower rate limit for account administration.
  const { data: allowed, error: rateError } = await service.rpc(
    'consume_rate_limit',
    {
      p_bucket: `account-admin:${caller.id}`,
      p_max: ADMIN_MAX_CALLS,
      p_window: ADMIN_WINDOW,
    },
  )
  if (rateError) {
    console.error('account-admin: rate limit check failed', rateError.code)
    return errorJson(503, 'SERVICE_UNAVAILABLE', 'Please try again shortly')
  }
  if (allowed !== true) {
    return errorJson(429, 'RATE_LIMITED', 'Too many administrative requests')
  }

  const body = (await readJsonBody(req)) as ActionRequest | null
  const action = body?.action

  if (action === 'create') {
    const rawUsername = body?.username
    const rawDisplayName = body?.displayName
    if (typeof rawUsername !== 'string' || typeof rawDisplayName !== 'string') {
      return errorJson(400, 'INVALID_REQUEST', 'username and displayName are required')
    }
    const username = rawUsername.trim().toLowerCase()
    const displayName = rawDisplayName.trim()
    if (!USERNAME_PATTERN.test(username)) {
      return errorJson(
        400,
        'USERNAME_INVALID',
        'Usernames are 3-32 characters: lowercase letters, digits, period, underscore, hyphen',
      )
    }
    if (displayName.length === 0 || displayName.length > 80) {
      return errorJson(400, 'INVALID_REQUEST', 'displayName must be 1-80 characters')
    }

    // Fast-path conflict check (citext: case-insensitive unique).
    const { data: existing, error: existingError } = await service
      .from('profiles')
      .select('id')
      .eq('username', username)
      .maybeSingle()
    if (existingError) {
      console.error('account-admin: username check failed', existingError.code)
      return errorJson(503, 'SERVICE_UNAVAILABLE', 'Please try again shortly')
    }
    if (existing) {
      return json(409, {
        status: 'rejected',
        error_code: 'USERNAME_TAKEN',
        message: 'That username is already in use',
      })
    }

    // §14.1: opaque internal identifier, confirmed, with a cryptographically
    // random temporary password of at least 16 characters. No email is sent.
    const temporaryPassword = randomSecret(TEMP_PASSWORD_LENGTH)
    const { data: created, error: createError } = await service.auth.admin
      .createUser({
        email: internalEmail(),
        password: temporaryPassword,
        email_confirm: true,
      })
    const newUser = created?.user
    if (createError || !newUser) {
      console.error('account-admin: auth user creation failed')
      return errorJson(503, 'SERVICE_UNAVAILABLE', 'Please try again shortly')
    }

    const { error: profileError } = await service.from('profiles').insert({
      id: newUser.id,
      username,
      display_name: displayName,
      must_change_password: true,
    })
    if (profileError) {
      // Roll back the orphan auth user so the username/email pair cannot leak
      // into a half-created state.
      await service.auth.admin.deleteUser(newUser.id)
      if (profileError.code === '23505') {
        return json(409, {
          status: 'rejected',
          error_code: 'USERNAME_TAKEN',
          message: 'That username is already in use',
        })
      }
      console.error('account-admin: profile insert failed', profileError.code)
      return errorJson(503, 'SERVICE_UNAVAILABLE', 'Please try again shortly')
    }

    // Membership in the single supported league (§11.2).
    const { error: membershipError } = await service
      .from('league_memberships')
      .insert({ league_id: leagueId, profile_id: newUser.id })
    if (membershipError) {
      console.error(
        'account-admin: league membership insert failed',
        membershipError.code,
      )
      return errorJson(503, 'SERVICE_UNAVAILABLE', 'Please try again shortly')
    }

    await appendAudit(service, {
      actorProfileId: caller.id,
      action: 'account.created',
      leagueId,
      targetId: newUser.id,
      afterJson: { username, display_name: displayName },
    })

    // The temporary password is returned exactly once for out-of-band
    // delivery (§3.1). It is never stored or logged.
    return json(200, {
      status: 'created',
      profileId: newUser.id,
      username,
      temporaryPassword,
    })
  }

  // The remaining actions target an existing profile.
  const profileId = body?.profileId
  if (
    action !== 'disable' && action !== 'reactivate' && action !== 'reset'
  ) {
    return errorJson(400, 'INVALID_REQUEST', 'Unknown action')
  }
  if (typeof profileId !== 'string') {
    return errorJson(400, 'INVALID_REQUEST', 'profileId is required')
  }

  const { data: target, error: targetError } = await service
    .from('profiles')
    .select('id, username, status')
    .eq('id', profileId)
    .maybeSingle()
  if (targetError) {
    console.error('account-admin: target lookup failed', targetError.code)
    return errorJson(503, 'SERVICE_UNAVAILABLE', 'Please try again shortly')
  }
  if (!target) {
    return errorJson(404, 'INVALID_REQUEST', 'Unknown profile')
  }

  if (action === 'disable') {
    // FR-AUTH-008: disabled accounts lose new access immediately; historical
    // score attribution remains (the profile row is retained, never deleted).
    const { error: statusError } = await service
      .from('profiles')
      .update({ status: 'disabled' })
      .eq('id', target.id)
    if (statusError) {
      console.error('account-admin: disable status failed', statusError.code)
      return errorJson(503, 'SERVICE_UNAVAILABLE', 'Please try again shortly')
    }
    const { error: banError } = await service.auth.admin.updateUserById(
      target.id,
      { ban_duration: DISABLE_BAN_DURATION },
    )
    if (banError) {
      console.error('account-admin: ban failed')
      return errorJson(503, 'SERVICE_UNAVAILABLE', 'Please try again shortly')
    }
    await adminSignOutAllSessions(env.supabaseUrl, env.serviceRoleKey, target.id)
    await appendAudit(service, {
      actorProfileId: caller.id,
      action: 'account.disabled',
      leagueId,
      targetId: target.id,
    })
    return json(200, { status: 'disabled', profileId: target.id })
  }

  if (action === 'reactivate') {
    const { error: unbanError } = await service.auth.admin.updateUserById(
      target.id,
      { ban_duration: 'none' },
    )
    if (unbanError) {
      console.error('account-admin: unban failed')
      return errorJson(503, 'SERVICE_UNAVAILABLE', 'Please try again shortly')
    }
    const { error: statusError } = await service
      .from('profiles')
      .update({ status: 'active' })
      .eq('id', target.id)
    if (statusError) {
      console.error('account-admin: reactivate status failed', statusError.code)
      return errorJson(503, 'SERVICE_UNAVAILABLE', 'Please try again shortly')
    }
    await appendAudit(service, {
      actorProfileId: caller.id,
      action: 'account.reactivated',
      leagueId,
      targetId: target.id,
    })
    return json(200, { status: 'reactivated', profileId: target.id })
  }

  // action === 'reset' (FR-AUTH-004): new temporary password, invalidate all
  // existing sessions, and force a change on next sign-in. Organizer-mediated
  // and audited (§14.1).
  const temporaryPassword = randomSecret(TEMP_PASSWORD_LENGTH)
  const { error: resetError } = await service.auth.admin.updateUserById(
    target.id,
    { password: temporaryPassword },
  )
  if (resetError) {
    console.error('account-admin: password reset failed')
    return errorJson(503, 'SERVICE_UNAVAILABLE', 'Please try again shortly')
  }
  const { error: flagError } = await service
    .from('profiles')
    .update({ must_change_password: true })
    .eq('id', target.id)
  if (flagError) {
    console.error('account-admin: reset flag failed', flagError.code)
    return errorJson(503, 'SERVICE_UNAVAILABLE', 'Please try again shortly')
  }
  await adminSignOutAllSessions(env.supabaseUrl, env.serviceRoleKey, target.id)
  await appendAudit(service, {
    actorProfileId: caller.id,
    action: 'account.password_reset',
    leagueId,
    targetId: target.id,
  })
  return json(200, {
    status: 'reset',
    profileId: target.id,
    temporaryPassword,
  })
})
