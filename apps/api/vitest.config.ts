import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'api',
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Test files share one database schema: run them sequentially in a single fork.
    // (fileParallelism is a root-level option and is ignored inside `projects`.)
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
