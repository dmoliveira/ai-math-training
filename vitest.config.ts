import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/app.ts', 'src/math/**/*.ts', 'src/state/**/*.ts', 'src/storage/**/*.ts', 'src/sprint/**/*.ts'],
      thresholds: {
        statements: 60,
        branches: 55,
        functions: 75,
        lines: 65,
      },
    },
  },
})
