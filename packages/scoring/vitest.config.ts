import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'scoring',
    include: ['test/**/*.test.ts'],
  },
})
