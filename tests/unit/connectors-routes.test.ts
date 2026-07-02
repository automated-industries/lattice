import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Lattice } from '../../src/lattice.js';
import { dispatchConnectorsRoute } from '../../src/gui/connectors-routes.js';
import { getConnectorByToolkit } from '../../src/connectors/registry.js';
import type { Connector, ConnectedModelDef, ExternalRecord } from '../../src/connectors/types.js';

/**
 * 4.3 — connectors GUI routes (SQLite, fake connector). Exercises the connect →
 * sync → refresh → disconnect HTTP surface without any real SDK and without
 * touching the machine-local credential store. The fake connector exposes a
 * credential `connect()` (like the Jira connector), so the route's duck-typed
 * capability check engages.
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

const CREDS_BODY = { site: 'https://x.atlassian.net', email: 'a@x.com', token: 'tok' };

const ICON = 'data:image/svg+xml;base64,PHN2Zy8+';

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
  presentation() {
    return { label: 'Demo', icon: ICON };
  }
  // Credential connect form metadata (data-driven by the generic route).
  credentialFields() {
    return [
      { key: 'site', label: 'Site URL', type: 'text' as const, required: true },
      { key: 'email', label: 'Email', type: 'text' as const, required: true },
      { key: 'token', label: 'API token', type: 'password' as const, required: true },
    ];
  }
  helpUrl() {
    return 'https://example.com/help';
  }
  authorize() {
    return Promise.resolve({ redirectUrl: 'https://auth.example/go', pendingId: 'pend-1' });
  }
  completeAuth() {
    return Promise.resolve({ connectionId: 'conn-1' });
  }
  // Credential connect (validated + stored by a real connector); fixed handle here,
  // but it validates the `site` is a URL like a real credential connector would.
  connect(creds: Record<string, string>) {
    if (!/^https?:\/\//i.test(creds.site ?? '')) {
      return Promise.reject(new Error('site must be a full URL'));
    }
    return Promise.resolve({ connectionId: 'conn-1', displayName: 'Demo' });
  }
  disconnect(id: string) {
    this.revoked.push(id);
    return Promise.resolve();
  }
  async *listChanges(): AsyncIterable<ExternalRecord> {
    yield* this.things;
  }
}

/** A second credential connector on a distinct toolkit — exercises multi-connector routing. */
class SecondConnector implements Connector {
  readonly connector = 'second';
  toolkits() {
    return ['widget'];
  }
  models() {
    return MODELS;
  }
  presentation() {
    return { label: 'Widget', icon: ICON };
  }
  credentialFields() {
    return [{ key: 'apiKey', label: 'API key', type: 'text' as const, required: true }];
  }
  authorize() {
    return Promise.resolve({ redirectUrl: 'https://auth.example/go' });
  }
  completeAuth() {
    return Promise.resolve({ connectionId: 'w1' });
  }
  connect() {
    return Promise.resolve({ connectionId: 'w1', displayName: 'Widget' });
  }
  disconnect() {
    return Promise.resolve();
  }
  async *listChanges(): AsyncIterable<ExternalRecord> {
    yield { id: 'W1', row: { tid: 'W1', name: 'w' } };
  }
}

/** A connector with no credential `connect()` — exercises the capability guard. */
const oauthOnly: Connector = {
  connector: 'oauthy',
  toolkits: () => ['demo'],
  models: () => MODELS,
  presentation: () => ({ label: 'OAuthy' }),
  authorize: () => Promise.resolve({ redirectUrl: 'https://auth.example/go' }),
  completeAuth: () => Promise.resolve({ connectionId: 'x' }),
  disconnect: () => Promise.resolve(),
  // eslint-disable-next-line require-yield
  listChanges: async function* () {
    return;
  },
};

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

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  async function call(
    method: string,
    url: string,
    body?: unknown,
    connectedBy = 'u1',
    connectors: Connector[] = [fake],
  ): Promise<{ status: number; body: unknown; handled: boolean }> {
    const req = fakeReq(method, url, body);
    const { res, done } = fakeRes();
    const handled = await dispatchConnectorsRoute(req, res, {
      db: db!,
      connectors,
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

  it('GET /api/connectors lists this member’s connectors + toolkit descriptors', async () => {
    await open();
    const r = await call('GET', '/api/connectors');
    expect(r.handled).toBe(true);
    const body = r.body as {
      toolkits: {
        toolkit: string;
        label: string;
        icon?: string;
        credentialFields?: unknown[];
        helpUrl?: string;
      }[];
      connectors: unknown[];
    };
    expect(body.connectors).toEqual([]);
    expect(body.toolkits).toHaveLength(1);
    expect(body.toolkits[0]).toMatchObject({
      toolkit: 'demo',
      label: 'Demo',
      icon: ICON,
      helpUrl: 'https://example.com/help',
    });
    expect(body.toolkits[0]?.credentialFields).toHaveLength(3);
  });

  it('GET /api/connectors lists every connector’s toolkit with its presentation + fields', async () => {
    await open();
    const r = await call('GET', '/api/connectors', undefined, 'u1', [fake, new SecondConnector()]);
    const body = r.body as {
      toolkits: { toolkit: string; label: string; credentialFields?: unknown[] }[];
    };
    const tks = body.toolkits.map((t) => t.toolkit).sort();
    expect(tks).toEqual(['demo', 'widget']);
    const widget = body.toolkits.find((t) => t.toolkit === 'widget');
    expect(widget).toMatchObject({ label: 'Widget' });
    expect(widget?.credentialFields).toHaveLength(1);
  });

  it('connect validates credentials, creates the connector + runs an initial sync', async () => {
    await open();
    const r = await call('POST', '/api/connectors/demo/connect', CREDS_BODY);
    expect(r.status).toBe(200);
    const body = r.body as { connectorId: string; result: { upserted: Record<string, number> } };
    expect(body.connectorId).toBeTruthy();
    expect(body.result.upserted).toEqual({ demo_things: 1 });
    // Keys are namespaced by connectorId so members can't collide on a shared PK.
    expect(await db!.get('demo_things', `${body.connectorId}:T1`)).toMatchObject({
      tid: `${body.connectorId}:T1`,
      name: 'one',
    });
    expect(await getConnectorByToolkit(db!, 'demo', 'u1')).not.toBeNull();
  });

  it('connect rejects missing credentials with 400', async () => {
    await open();
    const r = await call('POST', '/api/connectors/demo/connect', {
      site: '',
      email: '',
      token: '',
    });
    expect(r.status).toBe(400);
  });

  it('connect rejects a non-URL site with 422 (the connector validates the value)', async () => {
    await open();
    const r = await call('POST', '/api/connectors/demo/connect', {
      ...CREDS_BODY,
      site: 'not-a-url',
    });
    expect(r.status).toBe(422);
  });

  it('connect on a connector without credential support returns 400', async () => {
    await open();
    const r = await call('POST', '/api/connectors/demo/connect', CREDS_BODY, 'u1', [oauthOnly]);
    expect(r.status).toBe(400);
  });

  it('connect is generic — a second toolkit connects via its own declared fields', async () => {
    await open();
    const connectors: Connector[] = [fake, new SecondConnector()];
    const r = await call(
      'POST',
      '/api/connectors/widget/connect',
      { apiKey: 'abc' },
      'u1',
      connectors,
    );
    expect(r.status).toBe(200);
    const body = r.body as { connectorId: string; result: { upserted: Record<string, number> } };
    expect(body.connectorId).toBeTruthy();
    expect(body.result.upserted).toEqual({ demo_things: 1 });
    expect(await getConnectorByToolkit(db!, 'widget', 'u1')).not.toBeNull();
  });

  it('connect on the second toolkit rejects its own missing required field with 400', async () => {
    await open();
    const connectors: Connector[] = [fake, new SecondConnector()];
    const r = await call(
      'POST',
      '/api/connectors/widget/connect',
      { apiKey: '' },
      'u1',
      connectors,
    );
    expect(r.status).toBe(400);
  });

  it('an unknown toolkit is not handled (falls through to 404)', async () => {
    await open();
    const r = await call('POST', '/api/connectors/nope/connect', CREDS_BODY);
    expect(r.handled).toBe(false);
  });

  it('refresh re-syncs the connected toolkit', async () => {
    await open();
    await call('POST', '/api/connectors/demo/connect', CREDS_BODY);
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
    await call('POST', '/api/connectors/demo/connect', CREDS_BODY);
    expect(await db!.query('demo_things', {})).toHaveLength(1);
    const r = await call('DELETE', '/api/connectors/demo', {});
    expect(r.status).toBe(200);
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

  it('sync-if-stale aggregates across all connectors', async () => {
    await open();
    const connectors: Connector[] = [fake, new SecondConnector()];
    // Nothing connected yet → both loop, both report zero, aggregated.
    const r = await call('POST', '/api/connectors/sync-if-stale', undefined, 'u1', connectors);
    expect(r.body).toMatchObject({ synced: 0, failed: 0 });
  });

  it('returns false for a non-connectors path', async () => {
    await open();
    const r = await call('GET', '/api/something-else');
    expect(r.handled).toBe(false);
  });

  it('scopes connectors per identity: member B cannot see/refresh/disconnect member A’s', async () => {
    await open();
    const a = (await call('POST', '/api/connectors/demo/connect', CREDS_BODY, 'alice')).body as {
      connectorId: string;
    };
    const bList = (await call('GET', '/api/connectors', undefined, 'bob')).body as {
      connectors: unknown[];
    };
    expect(bList.connectors).toHaveLength(0);
    const bRefresh = await call(
      'POST',
      '/api/connectors/demo/refresh',
      { connectorId: a.connectorId },
      'bob',
    );
    expect(bRefresh.status).toBe(404);
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

  it('connect is idempotent — re-running reuses the same connector (no duplicate)', async () => {
    await open();
    const first = (await call('POST', '/api/connectors/demo/connect', CREDS_BODY)).body as {
      connectorId: string;
    };
    const second = (await call('POST', '/api/connectors/demo/connect', CREDS_BODY)).body as {
      connectorId: string;
    };
    expect(second.connectorId).toBe(first.connectorId);
    const list = (await call('GET', '/api/connectors')).body as { connectors: unknown[] };
    expect(list.connectors).toHaveLength(1);
  });
});
