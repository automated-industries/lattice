/**
 * Every source file must be readable by a text scanner.
 *
 * A single NUL byte is what every text tool uses to decide a file is binary, and
 * a file judged binary stops contributing matches. `grep -I` skips it outright;
 * a recursive scan over the directory returns every other file's hits and none
 * of its own, with a zero exit status and no warning. A scan reporting "no
 * matches" then looks identical to a scan that was never allowed to look.
 *
 * That matters because the checks run over this repository before it is
 * published are text scans. A file a scanner refuses to read is a file those
 * checks silently do not cover, however carefully they are written — and the one
 * that had a NUL in it was among the largest modules in the tree, holding the
 * audit, undo and secret-masking write paths.
 *
 * The byte was not something review would catch: it was a literal NUL typed
 * inside a template literal, joining a table name and a row id into one map key.
 * It renders as nothing at all. Writing the same character as a unicode escape
 * produces an identical string at runtime and leaves the file plain text.
 *
 * Which tools skip it is platform-dependent, and that is the trap: GNU grep (so,
 * Linux and CI) treats the file as binary, as does any scanner run with the
 * skip-binary flag; the BSD grep macOS ships reads it happily, and `git grep`
 * only samples the first 8 KB so it never notices. A check written against a Mac
 * shell would therefore pass while the scan that matters, on CI, quietly skipped
 * the file. So the byte itself is what is asserted here — deterministically, on
 * every platform — and the scanner behaviour is proved separately against a
 * scanner first shown to be capable of skipping.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');

/** Tracked files a text scan is expected to cover, that are actually on disk. */
function scannedFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--', 'src', 'tests', 'docs', 'scripts', '*.md', '*.json', '*.yml'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split('\0')
    .filter((f) => f !== '')
    .filter((f) => existsSync(join(repoRoot, f)));
}

describe('a text scan can actually read this repository', () => {
  it('no tracked source, test or doc carries a NUL byte', () => {
    const files = scannedFiles();
    expect(files.length, 'the file list is not empty').toBeGreaterThan(100);

    const withNul = files.filter((f) => readFileSync(join(repoRoot, f)).includes(0));
    expect(
      withNul,
      'a NUL byte makes text scanners classify the whole file as binary and skip it, so the ' +
        'pre-publish scans silently do not cover these files. Write control characters as a ' +
        'unicode escape instead of a literal byte — the runtime string is identical.',
    ).toEqual([]);
  });

  it('a skip-binary scanner reads every one of those files', () => {
    // Prove the scanner CAN skip before trusting it to report: a file holding a
    // NUL must be skipped by it. Without this probe the assertion below passes
    // for free on a platform whose grep reads binary files anyway (macOS), which
    // is exactly how a check like this becomes a false green.
    const probeDir = mkdtempSync(join(tmpdir(), 'lattice-grep-probe-'));
    try {
      const probe = join(probeDir, 'probe.txt');
      // The NUL is built as a byte rather than written as an escape, so no editor
      // or tool along the way can turn it back into a literal one in THIS file.
      writeFileSync(
        probe,
        Buffer.concat([Buffer.from('findme'), Buffer.from([0]), Buffer.from('findme\n')]),
      );
      const skipsBinary = ((): boolean => {
        try {
          execFileSync('grep', ['-I', '-c', 'findme', probe], { stdio: 'pipe' });
          return false;
        } catch {
          return true;
        }
      })();
      if (!skipsBinary) {
        // This platform's grep reads binary files. It cannot demonstrate the
        // consequence, and saying so is better than a silent pass — the NUL
        // assertion above is the gate that holds everywhere.
        expect(readFileSync(probe).includes(0), 'the probe really did contain a NUL').toBe(true);
        return;
      }
      const unreadable = scannedFiles().filter((f) => {
        try {
          execFileSync('grep', ['-I', '-c', '', f], { cwd: repoRoot, stdio: 'pipe' });
          return false;
        } catch {
          return true;
        }
      });
      expect(unreadable, 'files a skip-binary scanner refuses to read').toEqual([]);
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  });
});
