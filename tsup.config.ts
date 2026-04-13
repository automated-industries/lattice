import { defineConfig } from 'tsup';

export default defineConfig([
  // -------------------------------------------------------------------------
  // Library — ESM + CJS dual format with TypeScript declarations
  // -------------------------------------------------------------------------
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: false,
    clean: true,
    target: 'node18',
    outDir: 'dist',
  },

  // -------------------------------------------------------------------------
  // CLI — single ESM bundle, shebang injected at top
  // -------------------------------------------------------------------------
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: false,
    target: 'node18',
    outDir: 'dist',
    banner: { js: '#!/usr/bin/env node' },
  },

  // -------------------------------------------------------------------------
  // PostgresAdapter worker — must be a standalone CJS file alongside the
  // bundled library at `dist/postgres-worker.js` because synckit loads it
  // via `new Worker(workerPath)` and PostgresAdapter resolves the path with
  // `path.join(__dirname, 'postgres-worker.js')` — and after bundling,
  // `__dirname` is `dist/` (the location of `dist/index.js`), not
  // `dist/db/`. CJS so the worker can `require('pg')` and `require('synckit')`
  // from the consumer app's node_modules at runtime (these are
  // optionalDependencies of latticesql).
  // -------------------------------------------------------------------------
  {
    entry: { 'postgres-worker': 'src/db/postgres-worker.ts' },
    format: ['cjs'],
    dts: false,
    splitting: false,
    sourcemap: false,
    target: 'node18',
    outDir: 'dist',
    // .cjs extension is REQUIRED. The published package.json has
    // `"type": "module"`, so a `.js` file is treated as ESM and Node
    // refuses to run our CJS-built worker (`require is not defined`).
    // The .cjs extension forces CJS treatment regardless of `type`.
    outExtension: () => ({ js: '.cjs' }),
    external: ['pg', 'synckit'],
  },
]);
