import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectInstallContext,
  installArgsFor,
  installLatest,
  isValidVersion,
} from '../../src/update-context.js';

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function pkgRoot(base: string, sub: string[]): string {
  const root = join(base, ...sub);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'latticesql', version: '1.0.0' }),
  );
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('detectInstallContext', () => {
  it('NEVER installs over a git checkout (linked-dev via .git at package root)', () => {
    const base = tmp('lat-git-');
    const root = pkgRoot(base, ['repo']);
    mkdirSync(join(root, '.git'));
    const ctx = detectInstallContext({
      modulePath: join(root, 'dist', 'cli.js'),
      cwd: tmp('lat-cwd-'),
      env: {},
    });
    expect(ctx.kind).toBe('linked-dev');
    expect(ctx.installable).toBe(false);
    expect(installArgsFor(ctx, '2.0.0')).toBeNull();
  });

  it('treats a symlinked node_modules entry as linked-dev', () => {
    const cwd = tmp('lat-link-');
    mkdirSync(join(cwd, 'node_modules'));
    const target = pkgRoot(tmp('lat-link-target-'), ['p']);
    symlinkSync(target, join(cwd, 'node_modules', 'latticesql'));
    const ctx = detectInstallContext({ modulePath: join(cwd, 'x.js'), cwd, env: {} });
    expect(ctx.kind).toBe('linked-dev');
    expect(ctx.installable).toBe(false);
  });

  it('detects an ephemeral npx run (notify-only)', () => {
    const base = tmp('lat-npx-');
    const root = pkgRoot(base, ['_npx', 'abc', 'node_modules', 'latticesql']);
    const ctx = detectInstallContext({
      modulePath: join(root, 'dist', 'cli.js'),
      cwd: tmp('lat-cwd-'),
      env: {},
    });
    expect(ctx.kind).toBe('npx');
    expect(ctx.installable).toBe(false);
  });

  it('detects a project-local dependency (npm install <pkg>@v in cwd)', () => {
    const cwd = tmp('lat-local-');
    const root = pkgRoot(cwd, ['node_modules', 'latticesql']);
    const ctx = detectInstallContext({
      modulePath: join(root, 'dist', 'cli.js'),
      cwd,
      env: {},
    });
    expect(ctx.kind).toBe('local');
    expect(ctx.installable).toBe(true);
    expect(installArgsFor(ctx, '2.0.0')).toEqual(['install', 'latticesql@2.0.0']);
  });

  it('detects a global install (npm install -g <pkg>@v)', () => {
    const prefix = tmp('lat-global-');
    const root = pkgRoot(prefix, ['lib', 'node_modules', 'latticesql']);
    const ctx = detectInstallContext({
      modulePath: join(root, 'dist', 'cli.js'),
      cwd: tmp('lat-cwd-'),
      execPath: join(prefix, 'bin', 'node'),
      env: {},
    });
    expect(ctx.kind).toBe('global');
    expect(ctx.installable).toBe(true);
    expect(installArgsFor(ctx, '2.0.0')).toEqual(['install', '-g', 'latticesql@2.0.0']);
  });

  it('falls back to unknown (notify-only) when the location is unrecognized', () => {
    const base = tmp('lat-unk-');
    const root = pkgRoot(base, ['somewhere', 'latticesql']);
    const ctx = detectInstallContext({
      modulePath: join(root, 'dist', 'cli.js'),
      cwd: tmp('lat-cwd-'),
      execPath: join(tmp('lat-node-'), 'bin', 'node'),
      env: {},
    });
    expect(ctx.kind).toBe('unknown');
    expect(ctx.installable).toBe(false);
  });
});

describe('isValidVersion / installArgsFor injection guard', () => {
  it('accepts only real semver', () => {
    expect(isValidVersion('1.2.3')).toBe(true);
    expect(isValidVersion('10.20.30-beta.1')).toBe(true);
    expect(isValidVersion('1.2')).toBe(false);
    expect(isValidVersion('latest')).toBe(false);
    expect(isValidVersion('1.2.3; rm -rf /')).toBe(false);
  });

  it('refuses to build an npm argv for a non-semver version', () => {
    const ctx = {
      kind: 'global' as const,
      installable: true,
      cwd: '/x',
      packageRoot: '/x',
      reason: '',
    };
    expect(() => installArgsFor(ctx, '1.2.3 && evil')).toThrow();
  });

  it('installLatest is a no-op for a non-installable context', () => {
    const ctx = {
      kind: 'linked-dev' as const,
      installable: false,
      cwd: '/x',
      packageRoot: '/x',
      reason: '',
    };
    // Must NOT shell out; returns false without throwing.
    expect(installLatest(ctx, '2.0.0', { quiet: true })).toBe(false);
  });
});
