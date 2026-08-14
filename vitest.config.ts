import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    pool: 'forks',
    server: {
      deps: {
        inline: [/@deepseek-ai\/dsh-client-ui-/, /katex/],
      },
    },
  },
})
