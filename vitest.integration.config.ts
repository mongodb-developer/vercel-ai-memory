import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 180_000,

    // Integration tests — require Atlas connection
    include: ['tests/integration/**/*.test.ts'],

    // Run test files sequentially — shared singleton client must not be
    // torn down by one file while another is still running
    fileParallelism: false,

    // Global setup: bootstrap once, wait for vector indexes, teardown at end
    globalSetup: ['tests/helpers/global-setup.ts'],

    reporters: ['verbose'],
  },
})
