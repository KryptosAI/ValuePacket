import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Keep local/agent test runs from saturating the laptop.
    minWorkers: 1,
    maxWorkers: 2,
    // Multiple test files share a local anvil on tcp:8547 — never run files in parallel.
    fileParallelism: false,
    testTimeout: 60000,
    include: ['test/**/*.test.ts'],
  },
});
