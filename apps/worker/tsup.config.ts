import { defineConfig } from 'tsup';

// Workspace packages ship as TypeScript source, so they are bundled into dist/.
// Every other node_modules import (including transitive ones such as @prisma/client,
// which is CommonJS) stays external and is resolved at runtime.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  skipNodeModulesBundle: true,
  noExternal: [/^@signals\//],
});
