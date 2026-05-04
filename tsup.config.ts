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
    // pg is an optionalDependency. It MUST be external — bundling it would
    // pull pg's native deps into our tarball and break under ESM consumers.
    // External keeps Node resolving it from the consumer's node_modules at
    // runtime, which works in both ESM and CJS contexts.
    external: ['pg'],
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
]);
