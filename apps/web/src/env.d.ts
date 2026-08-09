/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL (public web variable, spec §13.5). */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase publishable (anon) key (public web variable, spec §13.5). */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
