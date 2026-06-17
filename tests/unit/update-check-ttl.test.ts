import { describe, it, expect, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkForUpdate } from '../../src/update-check.js';

// Use a throwaway package name so the cache lands in ~/.<pkg> and never touches
// the real `latticesql` update-check cache. Cleaned up after each test.
function freshPkg(): string {
  return `lattice-ttltest-${Math.random().toString(36).slice(2)}`;
}
const pkgs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const p of pkgs.splice(0))
    rmSync(join(homedir(), `.${p}`), { recursive: true, force: true });
});

function mockFetch(version: string): ReturnType<typeof vi.fn> {
  const fn = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ version }) }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('checkForUpdate ttl/force', () => {
  it('returns the latest version when newer and caches it', async () => {
    const pkg = freshPkg();
    pkgs.push(pkg);
    const fetchFn = mockFetch('2.0.0');
    expect(await checkForUpdate(pkg, '1.0.0')).toBe('2.0.0');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('serves from cache within the default ttl (no second fetch)', async () => {
    const pkg = freshPkg();
    pkgs.push(pkg);
    const fetchFn = mockFetch('2.0.0');
    await checkForUpdate(pkg, '1.0.0'); // populates cache
    const again = await checkForUpdate(pkg, '1.0.0'); // should hit cache
    expect(again).toBe('2.0.0');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('force:true bypasses the cache and refetches', async () => {
    const pkg = freshPkg();
    pkgs.push(pkg);
    const fetchFn = mockFetch('2.0.0');
    await checkForUpdate(pkg, '1.0.0');
    await checkForUpdate(pkg, '1.0.0', { force: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('ttlMs:0 expires the cache so the GUI poll always refetches', async () => {
    const pkg = freshPkg();
    pkgs.push(pkg);
    const fetchFn = mockFetch('2.0.0');
    await checkForUpdate(pkg, '1.0.0');
    await checkForUpdate(pkg, '1.0.0', { ttlMs: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('returns null when already on the latest', async () => {
    const pkg = freshPkg();
    pkgs.push(pkg);
    mockFetch('1.0.0');
    expect(await checkForUpdate(pkg, '1.0.0')).toBeNull();
  });
});
