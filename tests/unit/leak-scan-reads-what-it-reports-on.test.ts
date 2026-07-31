import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The pre-publish term scan has to have READ what it calls clean.
 *
 * One source file in this repo defeats that. `src/gui/app/modules/chart-lib.ts`
 * carries a vendored charting library as a ~275,000-character base64 run on a
 * single line. It is text, so the scanner opens it, reads it, matches nothing,
 * and reports the file as clean — while roughly 200KB of library source sits
 * inside it that no term scan and no human reviewer has ever read. The scan was
 * not failing loudly; it was succeeding about content it could not see.
 *
 * These tests run the REAL guard as its own process (the same `bash
 * scripts/check-generic.sh` the publish step runs) against fixture trees, so
 * they exercise the shipped script rather than a description of it. A term
 * hidden inside an encoded payload must fail the guard, an equivalent clean
 * payload must pass it, and this repo's own tree must be clean under the
 * stronger scan.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const script = join(repoRoot, 'scripts', 'check-generic.sh');

interface Run {
  status: number;
  out: string;
}

function runGuard(...targets: string[]): Run {
  const r = spawnSync('bash', [script, ...targets], { encoding: 'utf8', cwd: repoRoot });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/**
 * The banned phrase, assembled at runtime.
 *
 * Deliberate: this file lives inside the tree the guard scans, so writing the
 * phrase out literally would make the repo fail its own check. Building it from
 * parts keeps the fixture honest without planting the string in the source.
 */
const BANNED = ['INTERNAL', 'ONLY'].join(' ');

/** A source file shaped exactly like the vendored-library one: a base64 run in a string. */
function writeEncodedModule(dir: string, plaintext: string): string {
  // Long enough to read as an embedded artifact rather than an ordinary token.
  const padded = plaintext.repeat(8);
  const b64 = Buffer.from(padded, 'utf8').toString('base64');
  expect(b64.length, 'the fixture payload is a long encoded run').toBeGreaterThan(200);
  const file = join(dir, 'vendored-lib.ts');
  writeFileSync(file, `export const vendoredJs = 'window.__VENDOR__="${b64}";';\n`, 'utf8');
  return file;
}

const scratch: string[] = [];
function tempTree(): string {
  const d = mkdtempSync(join(tmpdir(), 'lattice-leak-scan-'));
  scratch.push(d);
  return d;
}

afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

describe('the term scan reads what it reports on', () => {
  it('a banned term encoded into a source file is invisible to a plain text scan', () => {
    const dir = tempTree();
    const file = writeEncodedModule(dir, `function boot(){/* ${BANNED} build */}`);
    // This is the whole point: the phrase IS in the shipped file, and reading
    // the file as text does not find it. Nothing about the file looks wrong.
    const grep = spawnSync('grep', ['-rIn', '-F', BANNED, file], { encoding: 'utf8' });
    expect(grep.status, 'a plain text scan of the file finds nothing').toBe(1);
    expect(grep.stdout).toBe('');
  });

  it('the guard decodes the payload and fails on the term hidden inside it', () => {
    const dir = tempTree();
    writeEncodedModule(dir, `function boot(){/* ${BANNED} build */}`);

    const r = runGuard(dir);

    expect(r.status, 'the guard rejects the tree').toBe(1);
    expect(r.out, 'and says the term was inside an encoded payload').toContain(
      'inside the encoded payload',
    );
    expect(r.out).toContain('vendored-lib.ts');
    expect(r.out, 'it did not just pass silently').not.toContain('check:generic passed');
  });

  it('an equivalent clean payload passes — the check is the content, not the encoding', () => {
    const dir = tempTree();
    writeEncodedModule(dir, 'function boot(){/* ordinary vendored build */}');

    const r = runGuard(dir);

    expect(r.status, 'encoding something is not itself the violation').toBe(0);
    expect(r.out, 'and it says it decoded before clearing it').toContain('encoded payload');
  });

  it('a file the scan cannot read as text is named rather than skipped', () => {
    const dir = tempTree();
    mkdirSync(join(dir, 'nested'));
    // A byte a text scan chokes on: `grep -I` classifies the file as binary and
    // moves on without a word, which is the silent half of the same defect.
    writeFileSync(join(dir, 'nested', 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x41]));

    const r = runGuard(dir);

    expect(r.status, 'an unreadable file in the scanned tree is a violation').toBe(1);
    expect(r.out).toContain('not readable as text');
    expect(r.out).toContain('blob.bin');
  });

  it("this repo's own tree is clean under the stronger scan", () => {
    const r = runGuard();
    expect(r.out, 'the payloads were decoded, not skipped').toMatch(
      /scanned [1-9][0-9]* encoded payload\(s\) by decoding them first/,
    );
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('check:generic passed');
  });
});
