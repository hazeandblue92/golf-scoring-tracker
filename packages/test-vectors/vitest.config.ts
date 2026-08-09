import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'vectors',
    include: ['test/**/*.test.ts'],
  },
})
