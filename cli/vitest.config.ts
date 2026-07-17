import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Keep local/agent test runs from saturating the laptop.
    minWorkers: 1,
    maxWorkers: 2,
    // Integration test files share anvil port 8545 and
    // contracts/deployments/local.json — they must not run concurrently.
    fileParallelism: false,
    testTimeout: 30000,
    include: ['test/**/*.test.ts'],
  },
});
