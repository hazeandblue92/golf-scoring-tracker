import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | undefined;

export interface SupabaseEnv {
  url: string;
  publishableKey: string;
}

/**
 * Validated public Supabase environment (spec §13.5). Throws with the exact
 * missing variable names so misconfiguration is diagnosable, never silent.
 */
export function getSupabaseEnv(): SupabaseEnv {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  const missing: string[] = [];
  if (url === undefined || url === '') {
    missing.push('VITE_SUPABASE_URL');
  }
  if (publishableKey === undefined || publishableKey === '') {
    missing.push('VITE_SUPABASE_PUBLISHABLE_KEY');
  }
  if (missing.length > 0 || url === undefined || publishableKey === undefined) {
    throw new Error(
      `Supabase client is not configured. Missing environment variable(s): ${missing.join(
        ', ',
      )}. Define them in apps/web/.env.local or the deployment environment (spec §13.5).`,
    );
  }
  return { url, publishableKey };
}

/**
 * URL of an Edge Function (spec §12.2): {VITE_SUPABASE_URL}/functions/v1/<name>.
 */
export function functionUrl(name: string): string {
  const { url } = getSupabaseEnv();
  return `${url.replace(/\/$/, '')}/functions/v1/${name}`;
}

/**
 * Lazily initialized Supabase client. The environment is validated only
 * when the client is first requested — importing this module never throws,
 * so the shell (and screens that never touch the network) load without
 * configuration.
 *
 * Public web variables per spec §13.5: Supabase URL and publishable key.
 */
export function getSupabaseClient(): SupabaseClient {
  if (client === undefined) {
    const { url, publishableKey } = getSupabaseEnv();
    client = createClient(url, publishableKey);
  }
  return client;
}
