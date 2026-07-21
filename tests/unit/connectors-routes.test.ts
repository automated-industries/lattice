import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Lattice } from '../../src/lattice.js';
import { dispatchConnectorsRoute, connectFailureHint } from '../../src/gui/connectors-routes.js';
import { getConnectorByToolkit, createConnector } from '../../src/connectors/registry.js';
import { genericConnector } from '../../src/connectors/generic/connector.js';
import { setMcpServerUrl, clearMcpConnection } from '../../src/connectors/mcp/oauth.js';
import {
  mcpToolkitFor,
  setMcpSchemaDescriptor,
  clearMcpSchemaDescriptor,
} from '../../src/connectors/mcp/schema-cache.js';
import type {
  McpTransport,
  McpToolCall,
  McpToolInfo,
  McpResourceInfo,
} from '../../src/connectors/mcp/transport.js';
import type { Connector, ConnectedModelDef, ExternalRecord } from '../../src/connectors/types.js';

/** Minimal canned MCP transport for the typed-connector routes tests (no network / SDK). */
class RtFakeTransport implements McpTransport {
  constructor(
    private readonly tools: McpToolInfo[],
    private readonly results: Record<string, unknown>,
  ) {}
  listTools(): Promise<McpToolInfo[]> {
    return Promise.resolve(this.tools);
  }
  callTool(call: McpToolCall): Promise<unknown> {
    return Promise.resolve(this.results[call.tool] ?? {});
  }
  listResources(): Promise<McpResourceInfo[]> {
    return Promise.resolve([]);
  }
  serverInfo(): { name?: string } | undefined {
    return { name: 'partner-api-mcp' };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Like RtFakeTransport but throws once `failAfter` successful callTool()s have happened — so
 *  introspection can succeed (call #1) and the subsequent migration sync fails (call #2). */
class CountingFailTransport implements McpTransport {
  private calls = 0;
  constructor(
    private readonly tools: McpToolInfo[],
    private readonly results: Record<string, unknown>,
    private readonly failAfter: number,
  ) {}
  listTools(): Promise<McpToolInfo[]> {
    return Promise.resolve(this.tools);
  }
  callTool(call: McpToolCall): Promise<unknown> {
    this.calls++;
    if (this.calls > this.failAfter) return Promise.reject(new Error('sync boom'));
    return Promise.resolve(this.results[call.tool] ?? {});
  }
  listResources(): Promise<McpResourceInfo[]> {
    return Promise.resolve([]);
  }
  serverInfo(): { name?: string } | undefined {
    return { name: 'partner-api-mcp' };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

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

describe('connectFailureHint (MCP connect error classification — Bug 5)', () => {
  it('surfaces a curated reason for a used/expired code, redirect mismatch, rejection, timeout', () => {
    expect(connectFailureHint(new Error('token endpoint returned invalid_grant'))).toMatch(
      /expired or was already used/i,
    );
    expect(connectFailureHint(new Error('redirect_uri did not match'))).toMatch(/redirect URL/i);
    expect(connectFailureHint(new Error('401 invalid_client'))).toMatch(/rejected the authorization/i);
    expect(connectFailureHint(new Error('MCP initialize ETIMEDOUT'))).toMatch(/[Tt]imed out/);
  });

  it('returns null for an unknown cause (→ the now-logged generic 500)', () => {
    expect(connectFailureHint(new Error('some unexpected internal failure'))).toBeNull();
    expect(connectFailureHint('not even an error')).toBeNull();
  });
});

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

// ── MCP path: multi-instance, reconnect, and the no-registration contract ─────

import { beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnector, getConnector } from '../../src/connectors/registry.js';
import {
  setMcpServerUrl,
  getMcpServerUrl,
  putPendingConnect,
  peekPendingConnect,
} from '../../src/connectors/mcp/oauth.js';
import type { McpConnector, McpBeginResult, McpServerSpec } from '../../src/connectors/types.js';

/**
 * A fake MCP connector mirroring McpConnectorBase's contract closely enough for
 * the routes: every OAuth connect returns a redirect + pending id; completing a
 * pending returns the connection with the server's name and (for reconnects)
 * the target row. `requiresPreregisteredClient` simulates an authorization
 * server that supports neither a client-ID metadata document nor dynamic
 * registration — the SDK's terminal error shape.
 */
class FakeMcpConnector implements McpConnector {
  readonly connector = 'mcp';
  revoked: string[] = [];
  purged: string[] = [];
  requiresPreregisteredClient = false;
  private seq = 0;
  private pendings = new Map<
    string,
    { connectionId: string; serverUrl: string; targetConnectorId?: string }
  >();
  toolkits() {
    return ['mcp'];
  }
  models() {
    return MODELS;
  }
  presentation() {
    return { label: 'MCP server', icon: ICON };
  }
  mcpServers(): McpServerSpec[] {
    return [{ name: 'generic', oauth: true }];
  }
  authorize() {
    return Promise.resolve({ redirectUrl: 'https://auth.example/go' });
  }
  completeAuth() {
    return Promise.resolve({ connectionId: 'unused' });
  }
  beginConnect(
    _userId: string,
    _toolkit: string,
    opts?: {
      redirectUri?: string;
      serverUrl?: string;
      clientInfo?: { client_id: string; client_secret?: string };
      targetConnectorId?: string;
    },
  ): Promise<McpBeginResult> {
    if (!opts?.serverUrl) return Promise.reject(new Error('needs an MCP server URL'));
    if (this.requiresPreregisteredClient && !opts.clientInfo) {
      return Promise.reject(
        new Error('Incompatible auth server: does not support dynamic client registration'),
      );
    }
    const connectionId = `m-${++this.seq}`;
    setMcpServerUrl(connectionId, opts.serverUrl);
    const pendingId = `pend-${connectionId}`;
    this.pendings.set(pendingId, {
      connectionId,
      serverUrl: opts.serverUrl,
      ...(opts.targetConnectorId ? { targetConnectorId: opts.targetConnectorId } : {}),
    });
    // Mirror McpConnectorBase: the callback route resolves the pending record
    // from the shared store to find the connector before completing.
    putPendingConnect(pendingId, {
      connectionId,
      connector: this.connector,
      toolkit: 'mcp',
      serverUrl: opts.serverUrl,
      redirectUri: opts.redirectUri ?? 'http://127.0.0.1/api/connectors/oauth/callback',
      transportKind: 'http',
      ...(opts.targetConnectorId ? { targetConnectorId: opts.targetConnectorId } : {}),
    });
    return Promise.resolve({
      kind: 'redirect',
      redirectUrl: `https://auth.example/authorize?p=${pendingId}`,
      pendingId,
    });
  }
  completeConnect(pendingId: string) {
    const p = this.pendings.get(pendingId);
    if (!p) return Promise.reject(new Error('no pending'));
    this.pendings.delete(pendingId);
    return Promise.resolve({
      connectionId: p.connectionId,
      displayName: 'Fake Server',
      serverName: 'Fake Server',
      ...(p.targetConnectorId ? { targetConnectorId: p.targetConnectorId } : {}),
    });
  }
  disconnect(id: string) {
    this.revoked.push(id);
    return Promise.resolve();
  }
  purgeConnection(id: string) {
    this.purged.push(id);
    return Promise.resolve();
  }
  async *listChanges(): AsyncIterable<ExternalRecord> {
    yield { id: 'M1', row: { tid: 'M1', name: 'm' } };
  }
}

describe('connectors routes (MCP multi-instance)', () => {
  let db: Lattice | undefined;
  let tmpCfg: string;
  let prevCfg: string | undefined;

  beforeAll(() => {
    tmpCfg = mkdtempSync(join(tmpdir(), 'lattice-mcp-routes-'));
    prevCfg = process.env.LATTICE_CONFIG_DIR;
    process.env.LATTICE_CONFIG_DIR = tmpCfg;
    process.env.LATTICE_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
  });
  afterAll(() => {
    if (prevCfg === undefined) delete process.env.LATTICE_CONFIG_DIR;
    else process.env.LATTICE_CONFIG_DIR = prevCfg;
    rmSync(tmpCfg, { recursive: true, force: true });
  });
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  // The OAuth callback answers with an HTML page, not JSON — parse tolerantly.
  function htmlSafeRes(): {
    res: ServerResponse;
    done: Promise<{ status: number; body: unknown }>;
  } {
    let resolveDone!: (v: { status: number; body: unknown }) => void;
    const done = new Promise<{ status: number; body: unknown }>((r) => (resolveDone = r));
    let status = 200;
    const res = {
      writeHead(s: number) {
        status = s;
        return res;
      },
      end(payload?: string) {
        let body: unknown = null;
        if (payload) {
          try {
            body = JSON.parse(payload);
          } catch {
            body = payload;
          }
        }
        resolveDone({ status, body });
      },
    } as unknown as ServerResponse;
    return { res, done };
  }

  async function call(
    mcp: FakeMcpConnector,
    method: string,
    url: string,
    body?: unknown,
    connectedBy = 'u1',
  ): Promise<{ status: number; body: unknown }> {
    const req = fakeReq(method, url, body);
    const { res, done } = htmlSafeRes();
    await dispatchConnectorsRoute(req, res, {
      db: db!,
      connectors: [mcp],
      outputDir: '/tmp/does-not-matter',
      connectedBy,
    });
    return done;
  }

  /** Drive connect → OAuth callback for one server URL; returns the new row id. */
  async function connectServer(mcp: FakeMcpConnector, serverUrl: string): Promise<string> {
    const begun = (await call(mcp, 'POST', '/api/connectors/mcp/connect', { serverUrl })).body as {
      pendingId: string;
    };
    expect(begun.pendingId).toBeTruthy();
    const before = new Set(
      (
        (await call(mcp, 'GET', '/api/connectors')).body as { connectors: { id: string }[] }
      ).connectors.map((c) => c.id),
    );
    const cb = await call(
      mcp,
      'GET',
      `/api/connectors/oauth/callback?code=ok&state=${begun.pendingId}`,
    );
    expect(cb.status).toBe(200);
    const after = (
      (await call(mcp, 'GET', '/api/connectors')).body as { connectors: { id: string }[] }
    ).connectors;
    const created = after.find((c) => !before.has(c.id));
    expect(created).toBeTruthy();
    return created!.id;
  }

  it('every added server is its own connection: two URLs → two rows, each with its URL', async () => {
    db = new Lattice(':memory:');
    await db.init();
    const mcp = new FakeMcpConnector();
    const a = await connectServer(mcp, 'https://one.example/mcp');
    const b = await connectServer(mcp, 'https://two.example/mcp');
    expect(a).not.toBe(b);
    const list = (await call(mcp, 'GET', '/api/connectors')).body as {
      connectors: { id: string; displayName: string; serverUrl: string | null }[];
    };
    expect(list.connectors).toHaveLength(2);
    const urls = list.connectors.map((c) => c.serverUrl).sort();
    expect(urls).toEqual(['https://one.example/mcp', 'https://two.example/mcp']);
    expect(list.connectors[0]?.displayName).toBe('Fake Server');
  });

  it('reports itemCount for a TYPED connection from its per-kind tables, not mcp_items (regression)', async () => {
    // A typed connection writes to `mcp_<prefix>_<kind>`; aggregating only `mcp_items` reported 0.
    db = new Lattice(':memory:');
    await db.init();
    const conn = genericConnector();
    const connId = 'rt-typed';
    setMcpServerUrl(connId, 'https://mcp.justworks.com/');
    const toolkit = mcpToolkitFor(connId);
    setMcpSchemaDescriptor(connId, {
      prefix: 'justworks',
      kinds: [
        {
          kind: 'company',
          tool: 'get_company',
          naturalKey: 'id',
          columns: [{ name: 'name', sqlSpec: 'TEXT' }],
        },
      ],
    });
    const cid = await createConnector(db, {
      connector: 'mcp',
      toolkit,
      displayName: 'partner-api-mcp',
      connectionRef: connId,
      connectedBy: 'u1',
    });
    for (const m of conn.models(toolkit)) await db.defineLate(m.table, m.definition);
    await db.upsert('mcp_justworks_company', {
      id: 'co_1',
      name: 'Acme',
      _source_connector_id: cid,
    });
    const list = (await call(conn as unknown as FakeMcpConnector, 'GET', '/api/connectors'))
      .body as { connectors: { id: string; itemCount: number }[] };
    expect(list.connectors.find((c) => c.id === cid)?.itemCount).toBe(1);
    clearMcpSchemaDescriptor(connId);
    clearMcpConnection(connId);
  });

  it('migrating a legacy flat connection to typed tables soft-deletes the old mcp_items rows (regression: data was doubled)', async () => {
    db = new Lattice(':memory:');
    await db.init();
    const connId = 'rt-mig';
    setMcpServerUrl(connId, 'https://mcp.justworks.com/');
    // A legacy flat connection (toolkit `mcp`) with a row already in `mcp_items`.
    const cid = await createConnector(db, {
      connector: 'mcp',
      toolkit: 'mcp',
      displayName: 'partner-api-mcp',
      connectionRef: connId,
      connectedBy: 'u1',
    });
    const flat = genericConnector();
    for (const m of flat.models('mcp')) await db.defineLate(m.table, m.definition);
    await db.upsert('mcp_items', {
      item_id: 'list_deduction_types:MED',
      kind: 'item',
      tool: 'list_deduction_types',
      title: 'Medical',
      _source_connector_id: cid,
    });
    // A typed connector that introspects one kind from the server; sync-if-stale runs the migration.
    const transport = new RtFakeTransport([{ name: 'list_deduction_types' }], {
      list_deduction_types: { items: [{ id: 'MED', name: 'Medical (pretax)' }] },
    });
    const typed = genericConnector({ transportFactory: () => Promise.resolve(transport) });
    await call(typed as unknown as FakeMcpConnector, 'POST', '/api/connectors/sync-if-stale', {});
    // The pre-migration flat rows are soft-deleted (recoverable, but hidden)…
    const flatRows = await db.query('mcp_items', {
      filters: [{ col: '_source_connector_id', op: 'eq', val: cid }],
    });
    expect(flatRows.length).toBeGreaterThan(0);
    expect(flatRows.every((r) => r.deleted_at)).toBe(true);
    // …and the data now lives in the typed table.
    const typedRows = await db.query('mcp_justworks_deduction_types', {});
    expect(typedRows.length).toBeGreaterThan(0);
    clearMcpSchemaDescriptor(connId);
    clearMcpConnection(connId);
  });

  it('a post-re-key failure during migration rolls back to the flat toolkit (retriable) and never prematurely deletes mcp_items (regression)', async () => {
    db = new Lattice(':memory:');
    await db.init();
    const connId = 'rt-rollback';
    setMcpServerUrl(connId, 'https://mcp.justworks.com/');
    const cid = await createConnector(db, {
      connector: 'mcp',
      toolkit: 'mcp',
      displayName: 'partner-api-mcp',
      connectionRef: connId,
      connectedBy: 'u1',
    });
    const flat = genericConnector();
    for (const m of flat.models('mcp')) await db.defineLate(m.table, m.definition);
    await db.upsert('mcp_items', {
      item_id: 'list_deduction_types:MED',
      kind: 'item',
      tool: 'list_deduction_types',
      title: 'Medical',
      _source_connector_id: cid,
    });
    // Introspection (call #1) succeeds; the post-re-key sync (call #2) throws.
    const transport = new CountingFailTransport(
      [{ name: 'list_deduction_types' }],
      { list_deduction_types: { items: [{ id: 'MED', name: 'Medical (pretax)' }] } },
      1,
    );
    const typed = genericConnector({ transportFactory: () => Promise.resolve(transport) });
    await call(typed as unknown as FakeMcpConnector, 'POST', '/api/connectors/sync-if-stale', {});
    // Rolled back to the flat toolkit so the whole migration retries next load…
    expect((await getConnector(db, cid))?.toolkit).toBe('mcp');
    // …and the flat rows were NOT deleted (their data was never safely typed).
    const flatRows = await db.query('mcp_items', {
      filters: [{ col: '_source_connector_id', op: 'eq', val: cid }],
    });
    expect(flatRows.some((r) => !r.deleted_at)).toBe(true);
    clearMcpSchemaDescriptor(connId);
    clearMcpConnection(connId);
  });

  it('reconnect by connectorId repoints the SAME row via the stored URL and retires the old secrets', async () => {
    db = new Lattice(':memory:');
    await db.init();
    const mcp = new FakeMcpConnector();
    const id = await connectServer(mcp, 'https://one.example/mcp');
    const oldRef = (await getConnector(db, id))?.connectionRef;
    expect(oldRef).toBeTruthy();
    // Reconnect WITHOUT resending the URL — the stored one is used.
    const begun = (await call(mcp, 'POST', '/api/connectors/mcp/connect', { connectorId: id }))
      .body as { pendingId: string };
    expect(begun.pendingId).toBeTruthy();
    const cb = await call(
      mcp,
      'GET',
      `/api/connectors/oauth/callback?code=ok&state=${begun.pendingId}`,
    );
    expect(cb.status).toBe(200);
    const rec = await getConnector(db, id);
    expect(rec?.connectionRef).not.toBe(oldRef);
    expect(rec?.status).toBe('connected');
    // The superseded connection is PURGED (its stored URL is orphaned otherwise —
    // the new connectionId carries its own URL), not merely secret-revoked.
    expect(mcp.purged).toContain(oldRef);
    const list = (await call(mcp, 'GET', '/api/connectors')).body as { connectors: unknown[] };
    expect(list.connectors).toHaveLength(1); // repointed, not duplicated
  });

  it("reconnect against another member's row 404s", async () => {
    db = new Lattice(':memory:');
    await db.init();
    const mcp = new FakeMcpConnector();
    const id = await connectServer(mcp, 'https://one.example/mcp');
    const r = await call(
      mcp,
      'POST',
      '/api/connectors/mcp/connect',
      { connectorId: id },
      'mallory',
    );
    expect(r.status).toBe(404);
  });

  it('returns 422 client_registration_unsupported, then connects with a supplied client id', async () => {
    db = new Lattice(':memory:');
    await db.init();
    const mcp = new FakeMcpConnector();
    mcp.requiresPreregisteredClient = true;
    const first = await call(mcp, 'POST', '/api/connectors/mcp/connect', {
      serverUrl: 'https://strict.example/mcp',
    });
    expect(first.status).toBe(422);
    expect((first.body as { code?: string }).code).toBe('client_registration_unsupported');
    const second = await call(mcp, 'POST', '/api/connectors/mcp/connect', {
      serverUrl: 'https://strict.example/mcp',
      clientId: 'preregistered-id',
      clientSecret: 's3cret',
    });
    expect(second.status).toBe(200);
    expect((second.body as { redirectUrl?: string }).redirectUrl).toContain('auth.example');
  });

  it('GET hides registry rows from retired connector kinds (no live implementation)', async () => {
    db = new Lattice(':memory:');
    await db.init();
    const mcp = new FakeMcpConnector();
    await connectServer(mcp, 'https://one.example/mcp');
    await createConnector(db, {
      connector: 'gmail',
      toolkit: 'gmail',
      displayName: 'Gmail',
      connectionRef: 'legacy-1',
      connectedBy: 'u1',
    });
    const list = (await call(mcp, 'GET', '/api/connectors')).body as {
      connectors: { toolkit: string }[];
    };
    // The retired-kind `gmail` row (no live impl) is hidden; the MCP connection shows — now
    // under its per-connection toolkit `mcp:<connId>` (resolved back to the generic MCP connector).
    expect(list.connectors).toHaveLength(1);
    expect(list.connectors[0]?.toolkit).toMatch(/^mcp:/);
  });

  it('the stored server URL survives DELETE (soft disconnect keeps reconnect possible)', async () => {
    db = new Lattice(':memory:');
    await db.init();
    const mcp = new FakeMcpConnector();
    const id = await connectServer(mcp, 'https://one.example/mcp');
    const ref = (await getConnector(db, id))?.connectionRef;
    const del = await call(mcp, 'DELETE', '/api/connectors/mcp', { connectorId: id });
    expect(del.status).toBe(200);
    expect((await getConnector(db, id))?.status).toBe('disconnected');
    // disconnect() was called (secrets revoked), but the URL key is untouched by
    // the routes — the connector's own disconnect decides what to keep.
    expect(mcp.revoked).toContain(ref);
    expect(getMcpServerUrl(ref!)).toBe('https://one.example/mcp');
  });

  it('an abandoned/denied OAuth (?error) purges the pending connection state', async () => {
    db = new Lattice(':memory:');
    await db.init();
    const mcp = new FakeMcpConnector();
    // Begin a connect → a pending record + a stored server URL exist for the new id.
    const begun = (
      await call(mcp, 'POST', '/api/connectors/mcp/connect', {
        serverUrl: 'https://denied.example/mcp',
      })
    ).body as { pendingId: string };
    const pendingId = begun.pendingId;
    const newConnId = peekPendingConnect(pendingId)!.connectionId;
    expect(getMcpServerUrl(newConnId)).toBe('https://denied.example/mcp');
    // The provider redirects back with an error (user clicked "Deny").
    const cb = await call(
      mcp,
      'GET',
      `/api/connectors/oauth/callback?error=access_denied&state=${pendingId}`,
    );
    expect(cb.status).toBe(400);
    // The pending record and the abandoned connection's stored URL are gone —
    // no orphaned per-connection state accumulates from a denied sign-in.
    expect(peekPendingConnect(pendingId)).toBeNull();
    expect(getMcpServerUrl(newConnId)).toBeNull();
  });
});
