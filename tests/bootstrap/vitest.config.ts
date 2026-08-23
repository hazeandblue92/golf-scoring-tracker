import { defineConfig } from 'vitest/config'

/**
 * Destructive, reset-gated bootstrap verification. These files deliberately
 * do not live under the ordinary integration include: each proves a one-time
 * transition and must run only in the matching freshly reset database state.
 */
export default defineConfig({
  test: {
    name: 'bootstrap',
    include: ['*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
})
