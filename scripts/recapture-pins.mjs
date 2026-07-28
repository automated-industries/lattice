#!/usr/bin/env node
/**
 * Recapture the byte pins for the composed client bundle.
 *
 * tests/unit/app-js-composition.test.ts and app-css-composition.test.ts assert an
 * exact length + sha256 of the composed client JS/CSS. Any client change fails them
 * BY DESIGN — the pin is how an unreviewed bundle change gets caught.
 *
 * Running this from plain node does not work: the client modules import each other
 * with extensionless / .js specifiers that only resolve under the test runner's
 * resolver. So this script drives the computation through vitest itself by writing a
 * throwaway spec, running it, and removing it again.
 *
 *   node scripts/recapture-pins.mjs
 *
 * It prints JS_LEN / JS_SHA / CSS_LEN / CSS_SHA. Update the two constants in each
 * composition test and, per the files' own convention, append a short comment saying
 * what changed.
 */
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = join(root, 'tests', 'unit', '__pin-recapture.tmp.test.ts');

// NOTE: no backticks anywhere in the emitted spec body — the client modules are
// authored as template literals and a stray backtick terminates the string.
const body = [
  "import { describe, it } from 'vitest';",
  "import { createHash } from 'node:crypto';",
  "import { appJs } from '../../src/gui/app/script.js';",
  "import { css } from '../../src/gui/app/css.js';",
  '',
  "const norm = (s: string) => s.replace(/\\r\\n/g, '\\n');",
  '',
  "describe('pin recapture', () => {",
  "  it('prints pins', () => {",
  '    const j = norm(appJs);',
  '    const c = norm(css);',
  "    const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');",
  "    console.log('PINS_BEGIN');",
  "    console.log('JS_LEN=' + j.length);",
  "    console.log('JS_SHA=' + sha(j));",
  "    console.log('CSS_LEN=' + c.length);",
  "    console.log('CSS_SHA=' + sha(c));",
  "    console.log('PINS_END');",
  '  });',
  '});',
  '',
].join('\n');

writeFileSync(spec, body);
try {
  const out = execFileSync(
    'npx',
    [
      'vitest',
      'run',
      '--silent=false',
      '--reporter=basic',
      'tests/unit/__pin-recapture.tmp.test.ts',
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
  );
  const lines = out.split('\n').map((l) => l.trim());
  const start = lines.indexOf('PINS_BEGIN');
  const end = lines.indexOf('PINS_END');
  if (start === -1 || end === -1) {
    process.stderr.write(out);
    throw new Error('pin markers not found in vitest output');
  }
  console.log(lines.slice(start + 1, end).join('\n'));
} finally {
  if (existsSync(spec)) rmSync(spec);
}
