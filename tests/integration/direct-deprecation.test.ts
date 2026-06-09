import { describe, expect, it, vi } from 'vitest';
import {
  TeamsClient,
  DIRECT_CLOUD_DEPRECATION_MESSAGE,
  type TeamConnection,
} from '../../src/teams/client.js';
import type { Lattice } from '../../src/lattice.js';

/**
 * 2.2 deprecates the direct postgres:// team-cloud connection mode (it can't
 * enforce row-level security). NEW connections are rejected with guidance to a
 * hosted Teams server; EXISTING connections keep working; the hosted http(s)://
 * path is unaffected. The PostgresAdapter storage backend is unrelated and
 * untouched — only the team-sync direct path is deprecated.
 */
function makeStubLocal(): Lattice {
  return {
    query: () => Promise.resolve([]),
    get: () => Promise.resolve(null),
    insert: () => Promise.resolve('stub'),
    upsert: () => Promise.resolve('stub'),
    delete: () => Promise.resolve(undefined),
    count: () => Promise.resolve(0),
    defineLate: () => Promise.resolve(undefined),
    getRegisteredColumns: () => ({}),
    getPrimaryKey: () => 'id',
    getRegisteredTableNames: () => [],
    defineWriteHook: () => undefined,
  } as unknown as Lattice;
}

const POSTGRES_URL = 'postgres://stub:stub@example.test:5432/stub';
const HTTPS_URL = 'https://teams.example.test';

describe('direct postgres:// team-cloud deprecation (2.2)', () => {
  it('rejects a NEW direct join (redeemInvite) without even attempting a connection', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const client = new TeamsClient(makeStubLocal());
    await expect(client.redeemInvite(POSTGRES_URL, 'tok', 'e@x.test', 'E')).rejects.toThrow(
      /deprecated/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('rejects a NEW direct workspace (registerCloudOwner)', async () => {
    const client = new TeamsClient(makeStubLocal());
    await expect(
      client.registerCloudOwner({
        label: 'l',
        cloudUrl: POSTGRES_URL,
        teamName: 't',
        email: 'e@x.test',
        displayName: 'E',
      }),
    ).rejects.toThrow(/deprecated/i);
  });

  it('the deprecation message points operators at the hosted http(s) path', () => {
    expect(DIRECT_CLOUD_DEPRECATION_MESSAGE).toMatch(/http\(s\)/);
    expect(DIRECT_CLOUD_DEPRECATION_MESSAGE).toMatch(/row-level security/i);
  });

  it('does NOT block the hosted http(s):// path — the guard is scheme-scoped', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network')));
    vi.stubGlobal('fetch', fetchSpy);
    const client = new TeamsClient(makeStubLocal());
    // An http URL gets PAST the guard and proceeds to fetch (which we fail with
    // a distinct network error), proving the deprecation is postgres://-only.
    const err = await client
      .redeemInvite(HTTPS_URL, 'tok', 'e@x.test', 'E')
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toMatch(/deprecated/i);
    expect(fetchSpy).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('existing direct connections keep working — pullChanges still dispatches to the direct path (no fetch)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const client = new TeamsClient(makeStubLocal());
    const conn: TeamConnection = {
      team_id: '00000000-0000-0000-0000-000000000001',
      team_name: 'Test Team',
      cloud_url: POSTGRES_URL,
      my_user_id: '00000000-0000-0000-0000-000000000002',
      api_token: 'stub',
      joined_at: new Date().toISOString(),
    };
    const result = await client.pullChanges(conn);
    expect(result.applied).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
