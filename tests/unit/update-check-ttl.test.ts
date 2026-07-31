import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkForUpdate } from '../../src/update-check.js';

// The cache is resolved from the home directory alone — no environment override
// reaches it — so run against the home a test process inherits, every case here
// writes into the developer's own `~/.lattice`, and leaves its file there
// whenever a run is cut short between the write and the cleanup. Each case gets a
// home of its own instead. `homedir()` reads the variable at call time, so the
// assertions below still name the directory the code under test actually used.
const homes: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-update-ttl-'));
  homes.push(dir);
  // POSIX reads HOME, Windows USERPROFILE.
  vi.stubEnv('HOME', dir);
  vi.stubEnv('USERPROFILE', dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const d of homes.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A name no real package answers to, so nothing here can consult a real one. */
const PKG = 'lattice-ttltest';

function mockFetch(version: string): ReturnType<typeof vi.fn> {
  const fn = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ version }) }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('checkForUpdate ttl/force', () => {
  it('returns the latest version when newer and caches it', async () => {
    const fetchFn = mockFetch('2.0.0');
    expect(await checkForUpdate(PKG, '1.0.0')).toBe('2.0.0');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('serves from cache within the default ttl (no second fetch)', async () => {
    const fetchFn = mockFetch('2.0.0');
    await checkForUpdate(PKG, '1.0.0'); // populates cache
    const again = await checkForUpdate(PKG, '1.0.0'); // should hit cache
    expect(again).toBe('2.0.0');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('force:true bypasses the cache and refetches', async () => {
    const fetchFn = mockFetch('2.0.0');
    await checkForUpdate(PKG, '1.0.0');
    await checkForUpdate(PKG, '1.0.0', { force: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('ttlMs:0 expires the cache so the GUI poll always refetches', async () => {
    const fetchFn = mockFetch('2.0.0');
    await checkForUpdate(PKG, '1.0.0');
    await checkForUpdate(PKG, '1.0.0', { ttlMs: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('returns null when already on the latest', async () => {
    mockFetch('1.0.0');
    expect(await checkForUpdate(PKG, '1.0.0')).toBeNull();
  });

  it('throws for a registry that answered with something other than an answer', async () => {
    // A 403 from a corporate proxy, or a 404 from a mirror that does not carry
    // the package, is not "you are on the newest version" — it is "nobody
    // knows". Resolving both to null made the two indistinguishable to every
    // caller, and the caller that reports to a person then reports the wrong one.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 403 })),
    );
    await expect(checkForUpdate(PKG, '1.0.0')).rejects.toThrow(/403/);
  });

  it('caches under ~/.lattice (the shared home), not a separate ~/.<pkg> dir', async () => {
    mockFetch('2.0.0');
    await checkForUpdate(PKG, '1.0.0');
    expect(existsSync(join(homedir(), '.lattice', `update-check-${PKG}.json`))).toBe(true);
    expect(existsSync(join(homedir(), `.${PKG}`))).toBe(false);
  });
});
