/**
 * Asking whether a newer version exists, without a server and without installing.
 *
 * The whole reason this returns a record instead of a version string is one
 * distinction, and it is the distinction that gets lost every time somebody
 * reaches for the simpler shape: a registry that could not be reached produces
 * exactly the same `null` as a copy that is already current. Reading the first as
 * the second tells an operator they are up to date when nobody has any idea
 * whether they are — and a release then stays invisible for as long as the
 * network problem lasts.
 *
 * So `checked` is asserted in both directions here, and the copy's install
 * context is asserted alongside the version, because "there is a newer version"
 * is only half an answer to somebody who cannot install it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { checkForNewerVersion } from '../../src/ops/update.js';
import type { InstallContext } from '../../src/update-context.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A copy an ordinary package install could upgrade in place. */
const GLOBAL: InstallContext = {
  kind: 'global',
  installable: true,
  cwd: '/nowhere',
  packageRoot: '/nowhere/lib/node_modules/latticesql',
  reason: 'global install',
};

/** A copy that must never be installed over. */
const CHECKOUT: InstallContext = {
  kind: 'linked-dev',
  installable: false,
  cwd: '/nowhere',
  packageRoot: '/nowhere/checkout',
  reason: 'running from a git checkout — auto-update disabled (dev build)',
};

/** The packaged application, which no package install can touch. */
const DESKTOP: InstallContext = {
  kind: 'desktop',
  installable: false,
  cwd: '/nowhere',
  packageRoot: null,
  reason: 'packaged desktop application — updated by its own installer',
};

describe('checkForNewerVersion', () => {
  it('reports the newer version together with what this copy could do about it', async () => {
    const found = await checkForNewerVersion({
      currentVersion: '1.0.0',
      context: GLOBAL,
      check: () => Promise.resolve('2.0.0'),
    });

    expect(found).toEqual({
      current: '1.0.0',
      latest: '2.0.0',
      kind: 'global',
      installable: true,
      reason: 'global install',
      checked: true,
      error: null,
    });
  });

  it('says a checkout cannot take the update it just found', async () => {
    // Both halves matter: reporting the version without the context sends
    // somebody to run an install that would fight their working tree.
    const found = await checkForNewerVersion({
      currentVersion: '1.0.0',
      context: CHECKOUT,
      check: () => Promise.resolve('2.0.0'),
    });

    expect(found.latest).toBe('2.0.0');
    expect(found.installable).toBe(false);
    expect(found.reason).toMatch(/checkout/);
  });

  it('distinguishes "nothing newer" from "could not ask"', async () => {
    const current = await checkForNewerVersion({
      currentVersion: '1.0.0',
      context: GLOBAL,
      check: () => Promise.resolve(null),
    });
    const offline = await checkForNewerVersion({
      currentVersion: '1.0.0',
      context: GLOBAL,
      check: () => Promise.reject(new Error('registry unreachable')),
    });

    // Identical on `latest`, which is exactly why `latest` alone cannot be the
    // answer. Only `checked` tells them apart.
    expect(current.latest).toBeNull();
    expect(offline.latest).toBeNull();
    expect(current.checked).toBe(true);
    expect(current.error).toBeNull();
    expect(offline.checked).toBe(false);
    expect(offline.error).toBe('registry unreachable');
  });

  it('does not throw when the source is unreachable', async () => {
    // An unreachable registry is the thing the caller asked about, so it comes
    // back as an answer. A throw would make a start-up banner or a health check
    // into something that has to be wrapped to be safe.
    await expect(
      checkForNewerVersion({
        currentVersion: '1.0.0',
        context: GLOBAL,
        check: () => Promise.reject(new Error('boom')),
      }),
    ).resolves.toMatchObject({ checked: false });
  });

  it('reads a registry that answered but did not answer as unchecked', async () => {
    // The failure that survives every "handles network errors" test: the request
    // succeeded and the reply was a 403 from a proxy or a 404 from a mirror. That
    // used to arrive as the same null a current copy produces, so a fleet
    // inventory recorded every machine as up to date having learned nothing.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 403 } as Response)),
    );

    const found = await checkForNewerVersion({
      currentVersion: '1.0.0',
      context: GLOBAL,
      packageName: `lattice-optest-${Math.random().toString(36).slice(2)}`,
    });

    expect(found.checked).toBe(false);
    expect(found.latest).toBeNull();
    expect(found.error).toMatch(/403/);
  });

  it('asks the desktop release channel for a desktop copy, not the package registry', async () => {
    // The two channels advance separately — a version publishes to the registry
    // the moment it is released, while the desktop artifacts appear only once
    // their build finishes, and that build can fail on its own. Asking the
    // registry on a desktop copy's behalf therefore reports a version that
    // surface cannot install, which is worse than reporting nothing.
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL | string) => {
        asked.push(url.toString());
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: '2.0.0' }),
        } as Response);
      }),
    );

    const found = await checkForNewerVersion({
      currentVersion: '1.0.0',
      context: DESKTOP,
      releaseManifestUrl: 'https://releases.invalid/download/',
    });

    expect(asked).toEqual(['https://releases.invalid/download/latest.json']);
    expect(asked.join()).not.toMatch(/registry\.npmjs\.org/);
    expect(found).toMatchObject({ latest: '2.0.0', kind: 'desktop', checked: true });
  });

  it('reports a desktop release channel that could not be read as unchecked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 404 } as Response)),
    );

    const found = await checkForNewerVersion({
      currentVersion: '1.0.0',
      context: DESKTOP,
      releaseManifestUrl: 'https://releases.invalid/download/',
    });

    expect(found.checked).toBe(false);
    expect(found.latest).toBeNull();
  });

  it('forces a fresh check by default rather than trusting a cached answer', async () => {
    // The default matters: the caller of this is usually somebody who already
    // knows a release exists and wants to see it now.
    let forced: boolean | null = null;
    await checkForNewerVersion({
      currentVersion: '1.0.0',
      context: GLOBAL,
      check: (f) => {
        forced = f;
        return Promise.resolve(null);
      },
    });
    expect(forced).toBe(true);
  });
});
