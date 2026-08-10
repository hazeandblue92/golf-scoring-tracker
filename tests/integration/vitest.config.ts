import { defineConfig } from 'vitest/config'

/**
 * Integration / database / security test layers (spec §20.1).
 *
 * Deliberately NOT part of the root `vitest run` projects list: these require
 * a running local stack (`supabase start`). `npm run test:integration` runs
 * them. Suites share one database, so each builds its own isolated event —
 * but they still run single-file to keep revision assertions deterministic.
 */
export default defineConfig({
  test: {
    name: 'integration',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
})
