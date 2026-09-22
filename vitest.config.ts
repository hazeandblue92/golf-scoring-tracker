import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'apps/web',
      'packages/scoring',
      'packages/contracts',
      'packages/test-vectors',
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/scoring/src/**'],
      thresholds: {
        // Spec §20.3: every scoring formula/state machine must exercise all branches.
        'packages/scoring/src/**': { branches: 100, perFile: true },
        branches: 95,
        lines: 85,
      },
    },
  },
})
