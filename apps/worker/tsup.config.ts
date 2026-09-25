import { defineConfig } from 'tsup';

// Bundles workspace packages (shipped as TS source) into dist/; npm deps stay external.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: [/^@signals\//],
});
