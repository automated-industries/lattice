import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Regression guard for the v1.13.8 packaging bug.
 *
 * v1.13.8 shipped `src/gui/realtime.ts` with a top-level `import pg from 'pg'`,
 * and `tsup.config.ts` did not list `pg` in the CLI build's `external` array.
 * tsup happily inlined pg's CommonJS internals (`require('events')`, native
 * binding shims) into the ESM CLI bundle (`dist/cli.js`), which then crashed
 * at first import on every `lattice gui` boot — even for SQLite-only users
 * who never construct a RealtimeBroker.
 *
 * v1.13.9 fixes this two ways and these tests cover both:
 *
 *   1. `src/gui/realtime.ts` switches to a type-only `import type pg from 'pg'`
 *      plus a runtime `createRequire(import.meta.url)('pg')` lazy-load.
 *   2. `tsup.config.ts` lists `pg` in `external` on the CLI build, mirroring
 *      the library build, so a future regression that re-adds a static
 *      import still can't pull pg into the bundle.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');

function readRepoFile(...segments: string[]): string {
  return readFileSync(resolve(REPO_ROOT, ...segments), 'utf8');
}

describe('CLI bundling regression (1.13.8 → 1.13.9)', () => {
  it('src/gui/realtime.ts never statically imports the pg runtime symbol', () => {
    const source = readRepoFile('src/gui/realtime.ts');
    // Type-only imports (`import type pg from 'pg'`) are erased at compile
    // time and do NOT cause the bundler to inline the module. Match a
    // value import specifically — the `type` keyword must NOT appear
    // between `import` and the binding.
    const staticValueImport = /^\s*import\s+(?!type\b)[^;]*?from\s+['"]pg['"]/m;
    expect(source).not.toMatch(staticValueImport);

    // Sanity: the file must reach pg some other way, so the realtime
    // broker still has a Client to construct. If a refactor removes pg
    // entirely the lazy-load arm is dead code and this assertion fails
    // loudly — preferable to silently shipping a broken broker.
    expect(source).toMatch(/requireFromHere\(['"]pg['"]\)|createRequire/);
  });

  it('tsup.config.ts lists pg as external for BOTH library and CLI builds', () => {
    const source = readRepoFile('tsup.config.ts');
    // We expect two `external: [...]` arrays — one per build entry — and
    // both must contain 'pg'. A blanket regex over the whole file is
    // sufficient because the only other thing `external` could refer to
    // here is the same kind of build option.
    const externalArrays = source.match(/external:\s*\[[^\]]*\]/g) ?? [];
    expect(externalArrays.length).toBeGreaterThanOrEqual(2);
    for (const arr of externalArrays) {
      expect(arr).toMatch(/['"]pg['"]/);
    }
  });

  it('dist/cli.js does not contain inlined pg internals (when built)', () => {
    // CI runs `npm test` BEFORE `npm run build`, so dist/cli.js usually
    // isn't on disk at this point. Local `npm run build && npm test`
    // hits this path and gives the strongest possible guarantee —
    // tsup actually externalized pg. Skip cleanly when the file is
    // absent; the two assertions above already cover the source-of-truth.
    const cliPath = resolve(REPO_ROOT, 'dist/cli.js');
    if (!existsSync(cliPath)) return;
    const bundle = readFileSync(cliPath, 'utf8');
    // Markers that only appear when pg's source is inlined into a bundle.
    // pg-types, pg-protocol, pg-pool are subpackages pg uses internally;
    // they are never authored in this repo, so any match means pg got
    // pulled in via tsup. require('events') is the specific CJS shim
    // call the v1.13.8 bug surfaced through.
    expect(bundle).not.toMatch(/pg-types|pg-protocol|pg-pool|pgpass/);
    expect(bundle).not.toMatch(/require\s*\(\s*['"]events['"]\s*\)/);
  });
});
