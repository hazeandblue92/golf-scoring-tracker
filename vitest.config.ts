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
        // Spec §20.3: scoring formulas/state machines require 100% branch
        // coverage; enforced per-file ratchet lands with the CI workflow.
        branches: 95,
        lines: 85,
      },
    },
  },
})
