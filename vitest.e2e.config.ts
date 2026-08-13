import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/real-codex.e2e.ts'],
    pool: 'forks',
    testTimeout: 900_000,
  },
})
