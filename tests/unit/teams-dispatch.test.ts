import { describe, expect, it, vi } from 'vitest';
import { TeamsClient, type TeamConnection } from '../../src/teams/client.js';
import type { Lattice } from '../../src/lattice.js';

/**
 * Dispatcher regression harness — every TeamsClient method that touches
 * the cloud must route based on URL scheme. `https://...` keeps the HTTP
 * path (fetch). `postgres(ql)://...` short-circuits to the direct-Postgres
 * helpers and must NEVER hit `fetch`.
 *
 * The direct helpers all open a fresh `Lattice(cloudUrl)` connection. We
 * can't easily mock that without running a real Postgres, so this test
 * only asserts the "no fetch on postgres:// URLs" half — the opposite
 * direction is exercised by the existing teams-gui integration tests
 * which run against the HTTP team-cloud server.
 */
describe('TeamsClient dispatcher routing', () => {
  function makeStubLocal(): Lattice {
    // The methods that short-circuit before touching local don't read
    // it at all. The ones that do (drainOutbox, pullChanges) query the
    // outbox; we return empty so the dispatcher's short-circuit is the
    // only thing observable.
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

  it('drainOutbox short-circuits to a no-op for postgres:// cloud URLs (no fetch)', async () => {
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
    const result = await client.drainOutbox(conn);
    expect(result).toEqual({ pushed: 0, failed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('pullChanges short-circuits to a no-op for postgres:// cloud URLs (no fetch)', async () => {
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
    expect(result).toEqual({ applied: 0, last_seq: 0, dlq_count: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('shareObject requires inviterUserId for postgres:// URLs (clear error message)', async () => {
    const client = new TeamsClient(makeStubLocal());
    await expect(
      client.shareObject(POSTGRES_URL, 'stub-token', 'team-id', 'tbl', {
        columns: {},
        primaryKey: 'id',
        schemaVersion: 1,
      }),
    ).rejects.toThrow(/inviterUserId is required/);
  });
});
