import { defineConfig, devices } from '@playwright/test';

const publishableKey =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // Every project drives the SAME local Supabase stack and creates real
  // accounts, leagues, and events through it. `fullyParallel: false` only
  // serializes within a file — separate files and the four browser projects
  // still fan out across workers, which races on that shared database and
  // multiplies load on one container set until requests fail outright. These
  // are shared-backend journey tests, so they are serial everywhere, not just
  // in CI.
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // Exercise the shipped PWA rather than Vite's development server. The
    // production preview installs the service worker, so offline reloads test
    // the real precache/navigation-fallback behavior.
    command: 'npm run build --workspace apps/web && npm run preview --workspace apps/web -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/sign-in',
    // Never reuse a developer's Vite server: that build has no production
    // service worker and would turn the offline journey into a false failure.
    reuseExistingServer: false,
    env: {
      VITE_SUPABASE_URL: process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321',
      VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey,
      VITE_RELEASE_VERSION: '0.1.0',
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
});
