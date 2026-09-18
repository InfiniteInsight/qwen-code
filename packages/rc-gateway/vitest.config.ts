import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Raise the per-test ceiling above vitest's 5s default (matching
    // packages/core and packages/cli): the integration tests spin up a real
    // gateway via setup() and blow 5s purely under full-suite CI contention,
    // not from any logic fault. Assertions still fail instantly; only the
    // timeout ceiling grows.
    testTimeout: 15000,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
