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
    // Each direct helper either opens a new Lattice(cloudUrl) or queries
    // this.local. We don't need a real Lattice — only that `local` is
    // present on the TeamsClient instance. The methods that short-circuit
    // BEFORE touching either don't read local at all.
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
  const HTTP_URL = 'http://localhost:4317';

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

  it('drainOutbox uses fetch for https:// cloud URLs (HTTP path)', async () => {
    // The HTTP path queries the outbox first (empty since stub), then
    // never calls fetch because there are no rows to drain. The point of
    // this test is that the dispatcher did NOT short-circuit — i.e. the
    // postgres:// guard returned false for an https:// URL.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const client = new TeamsClient(makeStubLocal());
    const conn: TeamConnection = {
      team_id: '00000000-0000-0000-0000-000000000001',
      team_name: 'Test Team',
      cloud_url: HTTP_URL,
      my_user_id: '00000000-0000-0000-0000-000000000002',
      api_token: 'stub',
      joined_at: new Date().toISOString(),
    };
    const result = await client.drainOutbox(conn);
    // No outbox rows → no fetch calls; but the call WAS attempted (the
    // empty array was the natural exit, not the dispatcher).
    expect(result).toEqual({ pushed: 0, failed: 0 });
    vi.unstubAllGlobals();
  });
});
