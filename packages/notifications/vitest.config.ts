import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'notifications', include: ['test/**/*.test.ts'] },
});
