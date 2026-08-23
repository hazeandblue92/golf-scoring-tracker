#!/usr/bin/env node

/**
 * One-time first-owner bootstrap for a fresh or explicitly selected league.
 *
 * The service-role key is read only from the process environment. The
 * temporary credential is generated locally, displayed exactly once in the
 * operator's terminal, and never sent to PostgreSQL, stored in application
 * tables, written to audit data, or included in an error message.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const INTERNAL_EMAIL_PATTERN = /^[0-9a-f]{32}@users[.]invalid$/
const BOOTSTRAP_MARKER = 'initial_owner_bootstrap'

const VALUE_OPTIONS = new Set([
  '--username',
  '--display-name',
  '--league-id',
  '--league-name',
  '--league-slug',
  '--timezone',
  '--locale',
  '--recover-user-id',
])

export const USAGE = `Usage:
  npm run bootstrap:owner -- \\
    --username <username> \\
    --display-name <name> \\
    --league-name <name> \\
    --league-slug <slug> \\
    --timezone <IANA timezone> \\
    [--locale en-US] --confirm

Attach to one existing active league instead of creating a league:
  npm run bootstrap:owner -- --username <username> --display-name <name> \\
    --league-id <uuid> --confirm

Recover only a script-marked orphan Auth user left by an interrupted attempt:
  add --recover-user-id <uuid> to either form

Required environment (never pass these values as command arguments):
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY`

function optionKey(option) {
  return option.slice(2).replaceAll(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
}

export function parseBootstrapArgs(argv) {
  const parsed = { confirm: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') return { help: true }
    if (argument === '--confirm') {
      parsed.confirm = true
      continue
    }
    if (!VALUE_OPTIONS.has(argument)) {
      throw new Error(`Unknown option: ${argument}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}`)
    }
    const key = optionKey(argument)
    if (parsed[key] !== undefined) throw new Error(`Duplicate option: ${argument}`)
    parsed[key] = value
    index += 1
  }

  if (parsed.confirm !== true) {
    throw new Error('Refusing to bootstrap without the explicit --confirm flag')
  }

  const username = parsed.username?.trim().toLowerCase()
  const displayName = parsed.displayName?.trim()
  if (!username || !USERNAME_PATTERN.test(username)) {
    throw new Error('Username must be 3-32 lowercase letters, digits, periods, underscores, or hyphens')
  }
  if (!displayName || displayName.length > 80) {
    throw new Error('Display name must be 1-80 characters')
  }

  const leagueId = parsed.leagueId?.trim()
  const recoverUserId = parsed.recoverUserId?.trim()
  if (leagueId && !UUID_PATTERN.test(leagueId)) throw new Error('League id must be a UUID')
  if (recoverUserId && !UUID_PATTERN.test(recoverUserId)) {
    throw new Error('Recovery user id must be a UUID')
  }

  const creationOptions = [parsed.leagueName, parsed.leagueSlug, parsed.timezone]
  if (leagueId) {
    if (creationOptions.some((value) => value !== undefined) || parsed.locale !== undefined) {
      throw new Error('League creation options cannot be combined with --league-id')
    }
  } else {
    const leagueName = parsed.leagueName?.trim()
    const leagueSlug = parsed.leagueSlug?.trim().toLowerCase()
    const timezone = parsed.timezone?.trim()
    const locale = parsed.locale?.trim() ?? 'en-US'
    if (!leagueName || leagueName.length > 120) {
      throw new Error('League name must be 1-120 characters')
    }
    if (!leagueSlug || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(leagueSlug)) {
      throw new Error('League slug must be 3-63 lowercase letters, digits, or internal hyphens')
    }
    if (!timezone) throw new Error('Timezone is required when creating a league')
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) {
      throw new Error('Locale is invalid')
    }
    parsed.leagueName = leagueName
    parsed.leagueSlug = leagueSlug
    parsed.timezone = timezone
    parsed.locale = locale
  }

  return {
    username,
    displayName,
    leagueId: leagueId ?? null,
    leagueName: parsed.leagueName ?? null,
    leagueSlug: parsed.leagueSlug ?? null,
    timezone: parsed.timezone ?? null,
    locale: parsed.locale ?? null,
    recoverUserId: recoverUserId ?? null,
  }
}

export function validateSupabaseUrl(rawUrl) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('SUPABASE_URL must be a valid URL')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('SUPABASE_URL must not contain credentials, a query, or a fragment')
  }
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('SUPABASE_URL must use HTTPS (HTTP is allowed only for the local stack)')
  }
  return url.toString().replace(/\/$/, '')
}

export function generateTemporaryPassword() {
  // 18 random bytes become 24 base64url characters, exceeding §14.1's
  // 16-character minimum without punctuation that is awkward to relay.
  return randomBytes(18).toString('base64url')
}

function safeCode(error) {
  if (!error || typeof error !== 'object') return 'unknown'
  const candidate = error.code ?? error.status
  return typeof candidate === 'string' || typeof candidate === 'number'
    ? String(candidate).replaceAll(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
    : 'unknown'
}

function failOperation(label, error) {
  throw new Error(`${label} failed (code ${safeCode(error)})`)
}

async function ensureBootstrapAvailable(client, options) {
  const owner = await client
    .from('role_assignments')
    .select('id')
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle()
  if (owner.error) failOperation('Bootstrap preflight', owner.error)
  if (owner.data) throw new Error('Bootstrap is closed because an owner grant already exists')

  if (options.leagueId) {
    const league = await client
      .from('leagues')
      .select('id,status')
      .eq('id', options.leagueId)
      .maybeSingle()
    if (league.error) failOperation('League preflight', league.error)
    if (!league.data || league.data.status !== 'active') {
      throw new Error('The selected active league was not found')
    }
  } else {
    const league = await client.from('leagues').select('id').limit(1).maybeSingle()
    if (league.error) failOperation('League preflight', league.error)
    if (league.data) {
      throw new Error('A league already exists; use --league-id to attach it explicitly')
    }
  }
}

function showCredential(output, { profileId, username, temporaryPassword }) {
  output.write([
    'One-time bootstrap credential (usable only after completion):',
    `  Auth user id: ${profileId}`,
    `  Username: ${username}`,
    `  Temporary password: ${temporaryPassword}`,
    '',
    'Do not redirect, save, or screenshot this output. Give the credential only to the owner.',
    '',
  ].join('\n'))
}

async function createOrRecoverAuthUser(client, options, temporaryPassword) {
  if (options.recoverUserId) {
    const existing = await client.auth.admin.getUserById(options.recoverUserId)
    const user = existing.data?.user
    if (existing.error || !user) failOperation('Recovery lookup', existing.error)
    if (!INTERNAL_EMAIL_PATTERN.test(user.email ?? '') || user.app_metadata?.[BOOTSTRAP_MARKER] !== true) {
      throw new Error('Recovery is limited to an orphan Auth user marked by this bootstrap script')
    }
    const reset = await client.auth.admin.updateUserById(user.id, {
      password: temporaryPassword,
      email_confirm: true,
    })
    if (reset.error || !reset.data.user) failOperation('Recovery credential reset', reset.error)
    return { user: reset.data.user, createdHere: false }
  }

  const internalEmail = `${randomUUID().replaceAll('-', '')}@users.invalid`
  const created = await client.auth.admin.createUser({
    email: internalEmail,
    password: temporaryPassword,
    email_confirm: true,
    app_metadata: { [BOOTSTRAP_MARKER]: true },
  })
  if (created.error || !created.data.user) failOperation('Auth user creation', created.error)
  return { user: created.data.user, createdHere: true }
}

async function clearBootstrapMarker(client, user) {
  const { [BOOTSTRAP_MARKER]: _marker, ...appMetadata } = user.app_metadata ?? {}
  return client.auth.admin.updateUserById(user.id, { app_metadata: appMetadata })
}

export async function runBootstrap(
  argv = process.argv.slice(2),
  env = process.env,
  dependencies = {},
) {
  const output = dependencies.stdout ?? process.stdout
  const errorOutput = dependencies.stderr ?? process.stderr
  const options = parseBootstrapArgs(argv)
  if (options.help) {
    output.write(`${USAGE}\n`)
    return
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  }
  const supabaseUrl = validateSupabaseUrl(env.SUPABASE_URL)
  const client = dependencies.client ?? createClient(
    supabaseUrl,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  await ensureBootstrapAvailable(client, options)

  const temporaryPassword = dependencies.generateTemporaryPassword?.() ?? generateTemporaryPassword()
  let authUser
  let createdHere = false
  let databaseCommitted = false

  try {
    const prepared = await createOrRecoverAuthUser(client, options, temporaryPassword)
    authUser = prepared.user
    createdHere = prepared.createdHere

    // Display before the cross-system commit. If the process is interrupted
    // after PostgreSQL commits, the first owner still possesses the only copy.
    showCredential(output, {
      profileId: authUser.id,
      username: options.username,
      temporaryPassword,
    })

    const result = await client.rpc('bootstrap_initial_owner', {
      p_profile_id: authUser.id,
      p_username: options.username,
      p_display_name: options.displayName,
      p_existing_league_id: options.leagueId,
      p_league_name: options.leagueName,
      p_league_slug: options.leagueSlug,
      p_timezone: options.timezone,
      p_locale: options.locale,
    })
    if (result.error || result.data?.status !== 'bootstrapped') {
      failOperation('Atomic application bootstrap', result.error)
    }
    databaseCommitted = true

    const markerClear = await clearBootstrapMarker(client, authUser)
    if (markerClear.error) {
      errorOutput.write('Bootstrap completed, but cleanup of the harmless recovery marker failed.\n')
    }

    output.write([
      'Bootstrap complete.',
      `League id: ${result.data.leagueId}`,
      'Sign in now, replace the temporary password, accept the privacy notice, then enroll MFA.',
      '',
    ].join('\n'))
  } catch (error) {
    if (createdHere && authUser && !databaseCommitted) {
      const cleanup = await client.auth.admin.deleteUser(authUser.id)
      if (cleanup.error) {
        errorOutput.write(`Bootstrap failed and Auth cleanup also failed (code ${safeCode(cleanup.error)}).\n`)
        errorOutput.write(`Recover the marked orphan with --recover-user-id ${authUser.id}.\n`)
      }
    }
    throw error
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  runBootstrap().catch((error) => {
    process.stderr.write(`Bootstrap failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
    process.exitCode = 1
  })
}
