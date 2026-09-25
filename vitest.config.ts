import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/signal-engine',
      'packages/market-data',
      'packages/config',
      'packages/notifications',
      'apps/api',
      'apps/worker',
    ],
  },
});
