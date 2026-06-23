import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Lattice } from '../../src/lattice.js';
import { dispatchConnectorsRoute } from '../../src/gui/connectors-routes.js';
import { getConnectorByToolkit } from '../../src/connectors/registry.js';
import type { Connector, ConnectedModelDef, ExternalRecord } from '../../src/connectors/types.js';

/**
 * 4.3 — connectors GUI routes (SQLite, fake connector). Exercises the connect →
 * sync → refresh → disconnect HTTP surface without the real Composio SDK and
 * without touching the machine-local credential store.
 */

const MODELS: ConnectedModelDef[] = [
  {
    model: 'thing',
    table: 'demo_things',
    naturalKey: 'tid',
    definition: {
      columns: { tid: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      primaryKey: 'tid',
      source: {
        connector: 'fake',
        toolkit: 'demo',
        model: 'thing',
        naturalKey: 'tid',
        defaultVisibility: 'private',
      },
      render: () => '',
      outputFile: 'd.md',
    },
  },
];

class FakeConnector implements Connector {
  readonly connector = 'fake';
  things: ExternalRecord[] = [{ id: 'T1', row: { tid: 'T1', name: 'one' } }];
  revoked: string[] = [];
  toolkits() {
    return ['demo'];
  }
  models() {
    return MODELS;
  }
  async authorize() {
    return { redirectUrl: 'https://auth.example/go', pendingId: 'pend-1' };
  }
  async completeAuth() {
    return { connectionId: 'conn-1' };
  }
  async disconnect(id: string) {
    this.revoked.push(id);
  }
  async *listChanges(): AsyncIterable<ExternalRecord> {
    yield* this.things;
  }
}

function fakeReq(method: string, url: string, jsonBody?: unknown): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': 'application/json' };
  req.setEncoding = (() => req) as IncomingMessage['setEncoding'];
  queueMicrotask(() => {
    if (jsonBody !== undefined) req.emit('data', JSON.stringify(jsonBody));
    req.emit('end');
  });
  return req;
}

function fakeRes(): { res: ServerResponse; done: Promise<{ status: number; body: unknown }> } {
  let resolveDone!: (v: { status: number; body: unknown }) => void;
  const done = new Promise<{ status: number; body: unknown }>((r) => (resolveDone = r));
  let status = 200;
  const res = {
    writeHead(s: number) {
      status = s;
      return res;
    },
    end(payload?: string) {
      resolveDone({ status, body: payload ? JSON.parse(payload) : null });
    },
  } as unknown as ServerResponse;
  return { res, done };
}

describe('connectors routes (SQLite)', () => {
  let db: Lattice | undefined;
  const fake = new FakeConnector();

  beforeAll(() => {
    process.env.COMPOSIO_API_KEY = 'test-key'; // so apiKeySet reads true without the store
  });
  afterAll(() => {
    delete process.env.COMPOSIO_API_KEY;
  });
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  async function call(
    method: string,
    url: string,
    body?: unknown,
    connectedBy = 'u1',
  ): Promise<{ status: number; body: unknown; handled: boolean }> {
    const req = fakeReq(method, url, body);
    const { res, done } = fakeRes();
    const handled = await dispatchConnectorsRoute(req, res, {
      db: db!,
      connector: fake,
      outputDir: '/tmp/does-not-matter',
      connectedBy,
    });
    if (!handled) return { status: 0, body: null, handled: false };
    return { ...(await done), handled: true };
  }

  async function open(): Promise<void> {
    db = new Lattice(':memory:');
    await db.init();
  }

  it('GET /api/connectors lists connectors + key state', async () => {
    await open();
    const r = await call('GET', '/api/connectors');
    expect(r.handled).toBe(true);
    expect(r.body).toMatchObject({ apiKeySet: true, toolkits: ['demo'], connectors: [] });
  });

  it('authorize returns a redirect URL', async () => {
    await open();
    const r = await call('POST', '/api/connectors/demo/authorize');
    expect(r.body).toMatchObject({ redirectUrl: 'https://auth.example/go', pendingId: 'pend-1' });
  });

  it('finalize creates the connector + runs an initial sync', async () => {
    await open();
    const r = await call('POST', '/api/connectors/demo/finalize');
    expect(r.status).toBe(200);
    const body = r.body as { connectorId: string; result: { upserted: Record<string, number> } };
    expect(body.connectorId).toBeTruthy();
    expect(body.result.upserted).toEqual({ demo_things: 1 });
    // the connected row landed
    expect(await db!.get('demo_things', 'T1')).toMatchObject({ tid: 'T1', name: 'one' });
    // and a registry row exists
    expect(await getConnectorByToolkit(db!, 'demo', 'u1')).not.toBeNull();
  });

  it('refresh re-syncs the connected toolkit', async () => {
    await open();
    await call('POST', '/api/connectors/demo/finalize');
    fake.things = [
      { id: 'T1', row: { tid: 'T1', name: 'one' } },
      { id: 'T2', row: { tid: 'T2', name: 'two' } },
    ];
    const r = await call('POST', '/api/connectors/demo/refresh', {});
    const body = r.body as { result: { upserted: Record<string, number> } };
    expect(body.result.upserted).toEqual({ demo_things: 2 });
    expect(await db!.query('demo_things', {})).toHaveLength(2);
  });

  it('models lists the connected data types', async () => {
    await open();
    const r = await call('GET', '/api/connectors/demo/models');
    expect(r.body).toMatchObject({
      models: [{ model: 'thing', table: 'demo_things', defaultVisibility: 'private' }],
    });
  });

  it('DELETE disconnects + tears down', async () => {
    await open();
    fake.things = [{ id: 'T1', row: { tid: 'T1', name: 'one' } }];
    fake.revoked = [];
    await call('POST', '/api/connectors/demo/finalize');
    expect(await db!.query('demo_things', {})).toHaveLength(1);
    const r = await call('DELETE', '/api/connectors/demo', {});
    expect(r.status).toBe(200);
    // hidden from live reads (deleted_at filtered), but soft-deleted (recoverable)
    const live = await db!.query('demo_things', { filters: [{ col: 'deleted_at', op: 'isNull' }] });
    expect(live).toHaveLength(0);
    expect((await db!.query('demo_things', {}))[0]?.deleted_at).toBeTruthy();
    expect(fake.revoked).toEqual(['conn-1']);
  });

  it('sync-if-stale runs and reports a count', async () => {
    await open();
    const r = await call('POST', '/api/connectors/sync-if-stale');
    expect(r.body).toMatchObject({ synced: 0 });
  });

  it('returns false for a non-connectors path', async () => {
    await open();
    const r = await call('GET', '/api/something-else');
    expect(r.handled).toBe(false);
  });

  it('scopes connectors per identity: member B cannot see/refresh/disconnect member A’s', async () => {
    await open();
    // A connects.
    const a = (await call('POST', '/api/connectors/demo/finalize', undefined, 'alice')).body as {
      connectorId: string;
    };
    // B lists — sees none of A's connectors.
    const bList = (await call('GET', '/api/connectors', undefined, 'bob')).body as {
      connectors: unknown[];
    };
    expect(bList.connectors).toHaveLength(0);
    // B tries to refresh A's connector by id → 404 (app-layer ownership check).
    const bRefresh = await call(
      'POST',
      '/api/connectors/demo/refresh',
      { connectorId: a.connectorId },
      'bob',
    );
    expect(bRefresh.status).toBe(404);
    // B tries to disconnect A's connector by id → 404; A's data survives.
    const bDelete = await call(
      'DELETE',
      '/api/connectors/demo',
      { connectorId: a.connectorId },
      'bob',
    );
    expect(bDelete.status).toBe(404);
    expect(
      await db!.query('demo_things', { filters: [{ col: 'deleted_at', op: 'isNull' }] }),
    ).toHaveLength(1);
  });

  it('finalize is idempotent — re-running reuses the same connector (no duplicate)', async () => {
    await open();
    const first = (await call('POST', '/api/connectors/demo/finalize')).body as {
      connectorId: string;
    };
    const second = (await call('POST', '/api/connectors/demo/finalize')).body as {
      connectorId: string;
    };
    expect(second.connectorId).toBe(first.connectorId);
    const list = (await call('GET', '/api/connectors')).body as { connectors: unknown[] };
    expect(list.connectors).toHaveLength(1);
  });
});
