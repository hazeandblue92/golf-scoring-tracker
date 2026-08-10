import { defineConfig, devices } from '@playwright/test';

const publishableKey =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev --workspace apps/web -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/sign-in',
    reuseExistingServer: !process.env.CI,
    env: {
      VITE_SUPABASE_URL: process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321',
      VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey,
      VITE_RELEASE_VERSION: '0.1.0',
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
});
