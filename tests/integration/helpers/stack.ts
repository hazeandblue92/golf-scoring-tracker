/**
 * Local-stack connection helpers for the integration/database test layers
 * (spec §20.1).
 *
 * These tests run against `supabase start` on the developer machine or in CI.
 * The keys below are the FIXED, PUBLIC development keys that the Supabase CLI
 * mints for every local stack — they are not secrets and grant nothing outside
 * 127.0.0.1. Real deployments read them from the environment.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'

export const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ??
  'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'

export const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz'

/** Full-privilege client. Test setup only — never a stand-in for a caller. */
export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

/** Anonymous client: exactly what an unauthenticated browser gets. */
export function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

/**
 * Client bound to a real end-user JWT, so PostgREST and PostgreSQL see the
 * `authenticated` role and `auth.uid()` — the context RLS is written against.
 */
export function userClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export interface FunctionResponse<T = unknown> {
  status: number
  body: T
}

/** Invoke an Edge Function over HTTP exactly as a device would. */
export async function callFunction<T = unknown>(
  name: string,
  body: unknown,
  accessToken?: string,
): Promise<FunctionResponse<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: PUBLISHABLE_KEY,
  }
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`

  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    // Non-JSON body (a crash page or empty response) surfaces verbatim so the
    // assertion failure shows what actually came back.
  }
  return { status: res.status, body: parsed as T }
}

/** True when the local stack is reachable; used to fail fast with a clear message. */
export async function stackIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      headers: { apikey: PUBLISHABLE_KEY },
      // Generous: the first fetch inside a fresh vitest worker pays several
      // seconds of undici/module cold start. This is a readiness probe, not a
      // latency assertion.
      signal: AbortSignal.timeout(30_000),
    })
    return res.ok
  } catch {
    return false
  }
}
