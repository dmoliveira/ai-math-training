import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/math/**/*.ts', 'src/state/**/*.ts', 'src/storage/**/*.ts'],
    },
  },
})
