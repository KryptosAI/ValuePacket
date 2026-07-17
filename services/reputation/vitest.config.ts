import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    minWorkers: 1,
    maxWorkers: 2,
    fileParallelism: false,
    testTimeout: 60000,
    include: ['test/**/*.test.ts'],
  },
});
