import { describe, it, expect } from 'vitest';
import {
  resolveVerifiedAsset,
  parsePkgTeamIdentifier,
  installerTrustError,
} from '../../desktop/update-verify.js';

function fetchReturning(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

const MANIFEST = 'https://example.test/latest.json';

describe('resolveVerifiedAsset — fails closed', () => {
  it('returns the checksum + size for a described artifact', async () => {
    const fetchFn = fetchReturning(200, {
      assets: { darwin: { name: 'Lattice.dmg', sha256: 'abc123', sizeBytes: 42 } },
    });
    await expect(resolveVerifiedAsset(fetchFn, MANIFEST, 'Lattice.dmg')).resolves.toEqual({
      sha: 'abc123',
      size: 42,
    });
  });

  it('THROWS when the manifest is unreachable (does not skip verification)', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(resolveVerifiedAsset(fetchFn, MANIFEST, 'Lattice.dmg')).rejects.toThrow(
      /unreachable — refusing/,
    );
  });

  it('THROWS on a non-2xx manifest response', async () => {
    await expect(
      resolveVerifiedAsset(fetchReturning(503, {}), MANIFEST, 'Lattice.dmg'),
    ).rejects.toThrow(/unavailable.*refusing/);
  });

  it('THROWS when the manifest does not list the artifact (the pre-fix null-sha path)', async () => {
    const fetchFn = fetchReturning(200, {
      assets: { darwin: { name: 'Lattice.dmg', sha256: 'abc', sizeBytes: 1 } },
    });
    await expect(resolveVerifiedAsset(fetchFn, MANIFEST, 'Lattice.pkg')).rejects.toThrow(
      /does not list Lattice\.pkg.*refusing/,
    );
  });

  it('THROWS when the listed artifact has no checksum', async () => {
    const fetchFn = fetchReturning(200, {
      assets: { 'darwin-pkg': { name: 'Lattice.pkg', sizeBytes: 5 } },
    });
    await expect(resolveVerifiedAsset(fetchFn, MANIFEST, 'Lattice.pkg')).rejects.toThrow(
      /no checksum.*refusing/,
    );
  });
});

describe('parsePkgTeamIdentifier', () => {
  it('extracts the 10-char team id from pkgutil output', () => {
    const out =
      'Package "Lattice.pkg":\n   Status: signed\n   1. Developer ID Installer: Example Co (AB12CD34EF)\n';
    expect(parsePkgTeamIdentifier(out)).toBe('AB12CD34EF');
  });
  it('returns null when no team id is present', () => {
    expect(parsePkgTeamIdentifier('Status: no signature')).toBeNull();
  });

  it('anchors to the leaf signing line and takes the trailing team id', () => {
    // The team id always trails the CN. A parenthesized token embedded in the org name —
    // or anywhere else in the printed chain — must not be picked instead, since this
    // value is what the installer identity is pinned on.
    const out =
      'Package "Lattice.pkg":\n' +
      '   Status: signed by a developer certificate\n' +
      '   Certificate Chain:\n' +
      '    1. Developer ID Installer: Acme (SUBSID1234) LLC (REALTEAM01)\n' +
      '    2. Developer ID Certification Authority\n';
    expect(parsePkgTeamIdentifier(out)).toBe('REALTEAM01');
  });
});

describe('installerTrustError — installer-path parity', () => {
  it('accepts a notarized installer whose team matches the running app', () => {
    expect(
      installerTrustError({
        gatekeeperAccepted: true,
        runningTeam: 'TEAM123456',
        installerTeam: 'TEAM123456',
      }),
    ).toBeNull();
  });
  it('refuses when Gatekeeper rejects the installer', () => {
    expect(
      installerTrustError({
        gatekeeperAccepted: false,
        runningTeam: 'TEAM123456',
        installerTeam: 'TEAM123456',
      }),
    ).toMatch(/not notarized/);
  });
  it('refuses a validly-signed installer with a DIFFERENT identity', () => {
    expect(
      installerTrustError({
        gatekeeperAccepted: true,
        runningTeam: 'TEAM123456',
        installerTeam: 'OTHER99999',
      }),
    ).toMatch(/different signing identity/);
  });
  it('refuses when the running team is known but the installer is unsigned', () => {
    expect(
      installerTrustError({
        gatekeeperAccepted: true,
        runningTeam: 'TEAM123456',
        installerTeam: null,
      }),
    ).toMatch(/unsigned or its identity/);
  });
});
