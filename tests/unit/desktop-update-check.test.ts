import { describe, it, expect, afterEach, vi } from 'vitest';
import { checkManifestForUpdate } from '../../src/update-check.js';

// The desktop update probe reads the release manifest (latest.json) the bundled
// binary updater applies from. It is a pure READ — no download, no relaunch — so
// a long-open desktop window can surface "update available" without disruption.
const BASE = 'https://example.test/releases/latest/download/';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubManifest(body: unknown, ok = true): ReturnType<typeof vi.fn> {
  const fn = vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(body) }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('checkManifestForUpdate', () => {
  it('fetches <baseUrl>latest.json', async () => {
    const fn = stubManifest({ version: '4.3.8' });
    await checkManifestForUpdate(BASE, '4.3.0');
    expect(fn).toHaveBeenCalledTimes(1);
    const arg = fn.mock.calls[0]?.[0] as URL;
    expect(String(arg)).toBe(`${BASE}latest.json`);
  });

  it('returns the manifest version when it is newer', async () => {
    stubManifest({ version: '4.3.8' });
    expect(await checkManifestForUpdate(BASE, '4.3.0')).toBe('4.3.8');
  });

  it('returns null when already on the manifest version', async () => {
    stubManifest({ version: '4.3.8' });
    expect(await checkManifestForUpdate(BASE, '4.3.8')).toBeNull();
  });

  it('returns null when the local version is newer than the manifest', async () => {
    stubManifest({ version: '4.3.0' });
    expect(await checkManifestForUpdate(BASE, '4.3.8')).toBeNull();
  });

  it('returns null on a non-ok response', async () => {
    stubManifest({ version: '4.3.8' }, false);
    expect(await checkManifestForUpdate(BASE, '4.3.0')).toBeNull();
  });

  it('returns null on a network error (never throws)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    await expect(checkManifestForUpdate(BASE, '4.3.0')).resolves.toBeNull();
  });

  it('returns null on a malformed manifest (missing version)', async () => {
    stubManifest({ notVersion: true });
    expect(await checkManifestForUpdate(BASE, '4.3.0')).toBeNull();
  });

  it('returns null on an invalid version string', async () => {
    stubManifest({ version: 'not-a-version' });
    expect(await checkManifestForUpdate(BASE, '4.3.0')).toBeNull();
  });

  it('returns null when JSON parsing throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.reject(new Error('bad json')),
        }),
      ),
    );
    await expect(checkManifestForUpdate(BASE, '4.3.0')).resolves.toBeNull();
  });
});
