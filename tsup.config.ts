import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

// Inject the package version at BUILD time so the bundled CLI/GUI never falls
// back to "unknown". Reading package.json via `import.meta.url` at runtime fails
// once the code is bundled + installed under node_modules — that produced the
// "vunknown" version chip in published builds. Resolved here against the repo
// root (where this config lives) so it is always correct in the tarball.
const pkgVersion = (
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
const versionDefine = { __LATTICE_VERSION__: JSON.stringify(pkgVersion) };

export default defineConfig([
  // -------------------------------------------------------------------------
  // Library — ESM + CJS dual format with TypeScript declarations
  // -------------------------------------------------------------------------
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    define: versionDefine,
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
    external: [
      'pg',
      'sharp',
      'jsdom',
      '@mozilla/readability',
      'file-type',
      '@anthropic-ai/sdk',
      'mammoth',
      'fflate',
      'word-extractor',
      'unpdf',
    ],
  },

  // -------------------------------------------------------------------------
  // CLI — single ESM bundle, shebang injected at top
  // -------------------------------------------------------------------------
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    define: versionDefine,
    dts: false,
    splitting: false,
    sourcemap: false,
    target: 'node18',
    outDir: 'dist',
    banner: { js: '#!/usr/bin/env node' },
    // pg is an optionalDependency. v1.13.8 omitted this and tsup happily
    // inlined pg's CJS internals (`require('events')`, native binding
    // shims) into the ESM CLI bundle, breaking every `lattice gui` boot
    // — even on SQLite-only configs that never reach the realtime broker.
    // v1.13.9 keeps pg external on both the library AND CLI builds so a
    // future regression can't re-bundle it accidentally. The runtime
    // loader in `src/db/postgres.ts` + `src/gui/realtime.ts` resolves pg
    // from the consumer's node_modules via createRequire at call time.
    external: [
      'pg',
      'sharp',
      'jsdom',
      '@mozilla/readability',
      'file-type',
      '@anthropic-ai/sdk',
      'mammoth',
      'fflate',
      'word-extractor',
      'unpdf',
    ],
  },
]);
