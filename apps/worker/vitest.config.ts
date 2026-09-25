import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'worker',
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Test files share one database schema: run them sequentially in a single fork.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
