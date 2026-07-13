import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Regression guard for the desktop bulk-ingest heap OOM.
 *
 * The compiled desktop runtime does NOT inherit the CLI's default V8 heap
 * sizing — unflagged, it ships a conservative old-space limit (a few hundred
 * MB) and a folder ingest of large documents dies with V8's "Ineffective
 * mark-compacts near heap limit" abort while the machine still has gigabytes
 * free. The heap ceiling must be baked in at build time via `--v8-flags`;
 * there is no runtime escape hatch in the packaged app. This test fails loudly
 * if any desktop build script loses the flag.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

const DESKTOP_SCRIPTS = [
  'desktop:dev',
  'desktop:build:mac',
  'desktop:build:mac:pkg',
  'desktop:build:win',
];
const HEAP_FLAG = '--v8-flags=--max-old-space-size=4096';

describe('desktop build scripts bake in the V8 heap ceiling', () => {
  for (const name of DESKTOP_SCRIPTS) {
    it(`"${name}" passes ${HEAP_FLAG} to deno desktop`, () => {
      const script = pkg.scripts?.[name];
      expect(script, `${name} must exist in package.json scripts`).toBeTruthy();
      expect(
        script,
        `${name} must carry ${HEAP_FLAG} — without it the packaged runtime's default heap OOMs on bulk document ingest`,
      ).toContain(HEAP_FLAG);
    });
  }
});
