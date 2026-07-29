// The desktop release pipeline must refuse to publish when the pushed tag does
// not match package.json's version — a mismatched manifest advertises a version
// the shipped binary can't reach, which strands every desktop client in a
// re-download loop it can never finish. That assertion used to live only as
// inline bash in the release workflow, where nothing exercised it; it now lives
// in scripts/assert-release-version.mjs so this suite can pin its semantics.
//
// The pinned contract mirrors the original shell exactly:
//   TAG_VERSION="${GITHUB_REF_NAME#v}"   → strip at most ONE leading "v"
//   [ "$VERSION" != "$TAG_VERSION" ]     → hard fail (exit 1) with ::error::
// and the package.json read is cwd-relative, matching the workflow's
// `node -p "require('./package.json').version"` from the repo root.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..', '..');
const scriptPath = join(repoRoot, 'scripts', 'assert-release-version.mjs');

function makePackageDir(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'assert-release-version-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version }));
  return dir;
}

function runScript(opts: { cwd: string; args?: string[]; env?: Record<string, string> }) {
  const r = spawnSync(process.execPath, [scriptPath, ...(opts.args ?? [])], {
    cwd: opts.cwd,
    env: { ...process.env, TAG: undefined as unknown as string, ...(opts.env ?? {}) },
    encoding: 'utf8',
    timeout: 20000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('scripts/assert-release-version.mjs', () => {
  it('passes (exit 0, prints OK) when the tag matches package.json', () => {
    const dir = makePackageDir('1.2.3');
    const r = runScript({ cwd: dir, args: ['v1.2.3'] });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OK');
    expect(r.stdout).toContain('1.2.3');
  });

  it('fails (non-zero, ::error:: naming both versions) on a mismatch', () => {
    const dir = makePackageDir('1.2.3');
    const r = runScript({ cwd: dir, args: ['v9.9.9'] });
    expect(r.status).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toContain('::error::');
    expect(out).toContain('1.2.3');
    expect(out).toContain('9.9.9');
    expect(out).toContain('refusing to publish');
  });

  it('accepts a bare tag with no v prefix, matching ${GITHUB_REF_NAME#v} semantics', () => {
    // Shell ${x#v} strips the prefix only when present: "1.2.3" stays "1.2.3".
    const dir = makePackageDir('1.2.3');
    const r = runScript({ cwd: dir, args: ['1.2.3'] });
    expect(r.status).toBe(0);
  });

  it('strips at most ONE leading v, matching ${GITHUB_REF_NAME#v} semantics', () => {
    // Shell ${x#v} removes the shortest match: "vv1.2.3" becomes "v1.2.3",
    // which does NOT equal "1.2.3" — the original workflow would refuse, so
    // the script must too.
    const dir = makePackageDir('1.2.3');
    const r = runScript({ cwd: dir, args: ['vv1.2.3'] });
    expect(r.status).toBe(1);
  });

  it('reads the tag from the TAG env var when no argument is given', () => {
    const dir = makePackageDir('4.5.6');
    const ok = runScript({ cwd: dir, env: { TAG: 'v4.5.6' } });
    expect(ok.status).toBe(0);
    const bad = runScript({ cwd: dir, env: { TAG: 'v4.5.7' } });
    expect(bad.status).toBe(1);
  });

  it('fails loudly when no tag is provided at all — never a silent pass', () => {
    const dir = makePackageDir('1.2.3');
    const r = runScript({ cwd: dir });
    expect(r.status).not.toBe(0);
  });

  it('agrees with the real repo: repo-root cwd + v<package.json version> passes', () => {
    // Proves the cwd-relative package.json read matches how the workflow step
    // invokes it from the checkout root.
    const version = (
      JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
    ).version;
    const r = runScript({ cwd: repoRoot, args: ['v' + version] });
    expect(r.status).toBe(0);
    const bad = runScript({ cwd: repoRoot, args: ['v0.0.0-mismatch'] });
    expect(bad.status).toBe(1);
  });

  it('the workflow step calls the script instead of re-implementing the check inline', () => {
    // Regression pin for the extraction itself: if the workflow drifts back to
    // an untested inline comparison (or drops the assertion), this fails.
    const workflow = readFileSync(
      join(repoRoot, '.github', 'workflows', 'desktop-release.yml'),
      'utf8',
    );
    expect(workflow).toContain('scripts/assert-release-version.mjs');
    expect(workflow).not.toMatch(/if \[ "\$VERSION" != "\$TAG_VERSION" \]/);
  });
});
