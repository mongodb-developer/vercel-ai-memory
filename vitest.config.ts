import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60_000,    // Atlas operations can take time
    hookTimeout: 180_000,   // Global setup waits for vector indexes (up to 120s)

    // Unit tests — fast, no network
    include: ['tests/unit/**/*.test.ts'],

    reporters: ['verbose'],
  },
})
