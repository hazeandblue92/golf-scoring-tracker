/**
 * Minimal shared HTTP helpers for the auth Edge Functions
 * (username-login, complete-activation, account-admin).
 *
 * Kept deliberately small and dependency-free. If/when a general
 * `_shared/http.ts` lands with the scoring functions, these helpers can be
 * consolidated there.
 *
 * Error contract (spec §12.4): stable machine codes + presentational text.
 */

export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers':
    'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
}

/** JSON response with CORS headers. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  })
}

/** Stable-code error response (spec §12.4). */
export function errorJson(
  status: number,
  errorCode: string,
  message: string,
): Response {
  return json(status, { error_code: errorCode, message })
}

/** Preflight/method gate. Returns a Response to short-circuit, or null. */
export function gatePost(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return errorJson(405, 'SERVICE_UNAVAILABLE', 'Method not allowed')
  }
  return null
}

/** Parse a JSON body; returns null on absent/invalid JSON. */
export async function readJsonBody(req: Request): Promise<unknown | null> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

/** Bearer token from the Authorization header, or null. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1].trim() : null
}

/**
 * First client address from x-forwarded-for (may be empty behind no proxy).
 * Used ONLY as hash input for privacy-preserving rate-limit bucket keys —
 * raw addresses are never stored or logged (spec §14.1, §11.8).
 */
export function clientNetworkKey(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for') ?? ''
  return forwarded.split(',')[0].trim()
}

/** Lowercase hex SHA-256 of a string. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  )
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Cryptographically random secret of `length` characters drawn uniformly
 * from a 64-symbol alphabet (64 divides 256, so simple masking is unbiased).
 * Used for organizer-provisioned temporary passwords (spec §14.1: at least
 * 16 characters).
 */
export function randomSecret(length: number): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += alphabet[byte & 63]
  return out
}

interface EdgeEnv {
  supabaseUrl: string
  publishableKey: string
  serviceRoleKey: string
}

/**
 * Read the runtime configuration injected by the Supabase Edge runtime.
 * Keys are read from the environment only — never embedded in source
 * (spec §13.5). The service-role key exists exclusively server-side.
 */
export function readEdgeEnv(): EdgeEnv {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const publishableKey =
    Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY')
  const serviceRoleKey =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY')
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
    throw new Error('Missing Supabase runtime environment configuration')
  }
  return { supabaseUrl, publishableKey, serviceRoleKey }
}

/**
 * Decode a JWT payload without verification. Only for reading non-security
 * hints (e.g. the `aal` claim) AFTER the token has already been verified by
 * `auth.getUser()`. Never use this as an authentication check by itself.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const payload = token.split('.')[1] ?? ''
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(base64)) as Record<string, unknown>
  } catch {
    return {}
  }
}
