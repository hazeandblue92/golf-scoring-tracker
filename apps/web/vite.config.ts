import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Spec §10.1 — service-worker HTTP cache rules:
 *
 *   "Never cache authenticated API responses in the service-worker HTTP
 *    cache; store normalized permitted snapshots in IndexedDB."
 *
 * Deny-list pattern for Supabase URLs. Every Supabase endpoint (Auth,
 * PostgREST/RPC, Edge Functions, Realtime, Storage) serves authenticated,
 * per-user responses and MUST NEVER match any runtimeCaching route. The
 * offline copy of permitted event data lives in IndexedDB instead
 * (see src/lib/offline/db.ts), never in the Workbox cache.
 */
const SUPABASE_URL_DENYLIST = /(^|\.)supabase\.(co|in|net|red)$/i;

/**
 * Placeholder route pattern for the public, unauthenticated event snapshot
 * and leaderboard projection GET endpoints (spec §10.1: "Network-first for
 * event snapshots and leaderboards, falling back to the last cached
 * response"). The concrete paths are wired up when those read routes land.
 */
const EVENT_PROJECTION_ROUTES =
  /^\/(?:events\/[^/]+\/(?:snapshot|leaderboards?)(?:\/|$)|api\/projections\b)/;

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/@supabase/')) return 'supabase';
          if (id.includes('/node_modules/dexie/')) return 'offline-db';
          if (id.includes('/node_modules/@tanstack/')) return 'query';
          if (id.includes('/node_modules/react-router/')) return 'router';
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/')) return 'react';
          return undefined;
        },
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      // Spec §10.1: service-worker updates use a visible "Update available"
      // prompt; NEVER auto-reload during score entry.
      registerType: 'prompt',
      manifest: {
        name: 'Golf Tournament Tracker',
        short_name: 'GT Tracker',
        display: 'standalone',
        start_url: '/',
        theme_color: '#073d2e',
        background_color: '#f4f3ed',
      },
      workbox: {
        // Deep links MUST survive deployment and refresh (spec §5.1).
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            // Network-first for event snapshot / leaderboard projection GET
            // routes only. The Supabase deny-list guard is defense in depth:
            // authenticated API responses are NEVER cached by the service
            // worker (spec §10.1), even if route patterns later overlap.
            urlPattern: ({ url, request }) =>
              request.method === 'GET' &&
              !SUPABASE_URL_DENYLIST.test(url.hostname) &&
              EVENT_PROJECTION_ROUTES.test(url.pathname),
            handler: 'NetworkFirst',
            method: 'GET',
            options: {
              cacheName: 'gtt-event-projections',
              networkTimeoutSeconds: 5,
            },
          },
          // Do NOT add a runtimeCaching entry that matches any Supabase host
          // (SUPABASE_URL_DENYLIST above). No cache-first or network-first
          // handler may ever store authenticated API responses.
        ],
      },
    }),
  ],
});
