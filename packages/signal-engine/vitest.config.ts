import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'signal-engine', include: ['test/**/*.test.ts'] },
});
