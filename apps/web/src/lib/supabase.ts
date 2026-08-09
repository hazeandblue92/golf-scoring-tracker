import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | undefined;

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

    client = createClient(url, publishableKey);
  }
  return client;
}
