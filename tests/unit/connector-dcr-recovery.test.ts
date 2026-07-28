// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Lattice } from '../../src/lattice.js';
import { dispatchConnectorsRoute } from '../../src/gui/connectors-routes.js';
import {
  createConnector,
  getConnector,
  listConnectors,
  recordSync,
  sanitizeConnectorError,
  classifyConnectorFailure,
  isSetupIncomplete,
  CLIENT_REGISTRATION_UNSUPPORTED,
  CLIENT_REGISTRATION_MESSAGE,
} from '../../src/connectors/registry.js';
import { PrefabCatalog } from '../../src/connectors/prefab/index.js';
import {
  setMcpServerUrl,
  clearMcpConnection,
  putPendingConnect,
} from '../../src/connectors/mcp/oauth.js';
import { mcpToolkitFor } from '../../src/connectors/mcp/schema-cache.js';
import { connectorsSettingsJs } from '../../src/gui/app/modules/connectors-settings.js';
import type {
  Connector,
  ConnectedModelDef,
  ExternalRecord,
  McpBeginResult,
  ToolkitPresentation,
  McpServerSpec,
} from '../../src/connectors/types.js';

/**
 * Recovery from an authorization server that cannot issue a client dynamically.
 *
 * Some providers publish no dynamic-registration endpoint at all: connecting needs a client id the
 * user registered with the provider by hand. Lattice can already accept one — but the offer was
 * reachable ONLY from the initial connect form. When the same failure surfaced during a sync it was
 * recorded as the raw SDK sentence, the row read as "connected but broken", it carried no action
 * that could fix it, and its catalog card was hidden as though the service were already wired up.
 *
 * These tests pin: one shared classification for both paths, a row that reads as unfinished rather
 * than broken, a client-id action on the row, and a catalog card that stays reachable until the
 * connection actually works.
 */

const GMAIL_URL = 'https://gmailmcp.googleapis.com/mcp/v1';
/** What the SDK says when the authorization server publishes no registration endpoint. */
const SDK_DCR_ERROR = 'Incompatible auth server: does not support dynamic client registration';

let tmpCfg: string;
let prevCfg: string | undefined;
beforeAll(() => {
  tmpCfg = mkdtempSync(join(tmpdir(), 'lattice-dcr-recovery-'));
  prevCfg = process.env.LATTICE_CONFIG_DIR;
  process.env.LATTICE_CONFIG_DIR = tmpCfg;
  process.env.LATTICE_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
});
afterAll(() => {
  if (prevCfg === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = prevCfg;
  rmSync(tmpCfg, { recursive: true, force: true });
});

// ── A stub MCP connector standing in for a provider with no dynamic registration ──

/** Pending connects this stub handed out, so the callback can complete one. */
interface Pending {
  connectionId: string;
  serverUrl: string;
  targetConnectorId?: string;
}

class NoRegistrationConnector implements Connector {
  readonly connector = 'mcp';
  /** Set false once the caller supplies a pre-registered client (mirrors the SDK's behavior). */
  requiresPreregisteredClient = true;
  lastClientId: string | undefined;
  private seq = 0;
  private readonly pendings = new Map<string, Pending>();

  toolkits(): string[] {
    return ['mcp'];
  }
  presentation(_toolkit: string): ToolkitPresentation {
    return { label: 'MCP server' };
  }
  models(_toolkit: string): ConnectedModelDef[] {
    return [];
  }
  mcpServers(_toolkit: string): McpServerSpec[] {
    return [{ name: 'mcp' }];
  }
  authorize(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  completeAuth(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  purgeConnection(): Promise<void> {
    return Promise.resolve();
  }
  // eslint-disable-next-line require-yield
  async *listChanges(): AsyncIterable<ExternalRecord> {
    return;
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
      return Promise.reject(new Error(SDK_DCR_ERROR));
    }
    this.lastClientId = opts.clientInfo?.client_id;
    const connectionId = `dcr-${++this.seq}`;
    setMcpServerUrl(connectionId, opts.serverUrl);
    const pendingId = `pend-${connectionId}`;
    this.pendings.set(pendingId, {
      connectionId,
      serverUrl: opts.serverUrl,
      ...(opts.targetConnectorId ? { targetConnectorId: opts.targetConnectorId } : {}),
    });
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

  completeConnect(pendingId: string): Promise<{
    connectionId: string;
    displayName: string | null;
    serverName?: string;
    targetConnectorId?: string;
  }> {
    const p = this.pendings.get(pendingId);
    if (!p) return Promise.reject(new Error('no pending'));
    this.pendings.delete(pendingId);
    return Promise.resolve({
      connectionId: p.connectionId,
      displayName: null,
      // The provider's servers all answer with the same generic name.
      serverName: 'StatelessServer',
      ...(p.targetConnectorId ? { targetConnectorId: p.targetConnectorId } : {}),
    });
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

interface ListedConnector {
  id: string;
  displayName: string | null;
  status: string;
  lastError: string | null;
  lastErrorCode: string | null;
  setupIncomplete: boolean;
  itemCount: number;
}

describe('dynamic-registration failure classification', () => {
  it('maps the SDK sentence to one actionable message + a stable code', () => {
    const known = classifyConnectorFailure(SDK_DCR_ERROR);
    expect(known?.code).toBe(CLIENT_REGISTRATION_UNSUPPORTED);
    expect(known?.message).toBe(CLIENT_REGISTRATION_MESSAGE);
    // The other shape of the same failure: the endpoint existed but rejected us.
    expect(
      classifyConnectorFailure('dynamic client registration failed: 403 Forbidden')?.code,
    ).toBe(CLIENT_REGISTRATION_UNSUPPORTED);
    // Re-classifying the curated message is stable (it is what gets persisted).
    expect(classifyConnectorFailure(CLIENT_REGISTRATION_MESSAGE)?.code).toBe(
      CLIENT_REGISTRATION_UNSUPPORTED,
    );
  });

  it('leaves an unrelated failure alone', () => {
    expect(classifyConnectorFailure('connection reset by peer')).toBeNull();
  });

  it('a sync-time failure is persisted as the actionable message, not the SDK sentence', () => {
    expect(sanitizeConnectorError(SDK_DCR_ERROR)).toBe(CLIENT_REGISTRATION_MESSAGE);
    // The pre-existing conflict genericization is untouched.
    expect(sanitizeConnectorError('UNIQUE constraint failed: t.id')).toMatch(/possible conflict/);
  });
});

describe('isSetupIncomplete', () => {
  it('is true for a connection that errored before it ever synced', () => {
    expect(
      isSetupIncomplete({
        status: 'error',
        lastSyncAt: null,
        lastError: CLIENT_REGISTRATION_MESSAGE,
      }),
    ).toBe(true);
  });

  it('is false once a sync has succeeded, and for a healthy or disconnected row', () => {
    expect(
      isSetupIncomplete({
        status: 'error',
        lastSyncAt: '2026-01-01T00:00:00.000Z',
        lastError: 'x',
      }),
    ).toBe(false);
    expect(isSetupIncomplete({ status: 'connected', lastSyncAt: null, lastError: null })).toBe(
      false,
    );
    expect(isSetupIncomplete({ status: 'disconnected', lastSyncAt: null, lastError: 'x' })).toBe(
      false,
    );
  });
});

describe('connectors route — recovery from a missing dynamic registration', () => {
  let db: Lattice | undefined;
  const catalog = new PrefabCatalog();
  const mcp = new NoRegistrationConnector();

  beforeEach(() => {
    mcp.requiresPreregisteredClient = true;
    mcp.lastClientId = undefined;
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
  ): Promise<{ status: number; body: unknown }> {
    const req = fakeReq(method, url, body);
    const { res, done } = fakeRes();
    await dispatchConnectorsRoute(req, res, {
      db: db!,
      connectors: [mcp],
      outputDir: join(tmpCfg, 'out'),
      connectedBy,
      catalog,
    });
    return done;
  }

  async function open(): Promise<void> {
    db = new Lattice(':memory:');
    await db.init();
  }

  /** A row that reached the registry but never authenticated — the state under test. */
  async function seedStrandedRow(): Promise<{ id: string; connectionId: string }> {
    const connectionId = `stranded-${Math.random().toString(36).slice(2)}`;
    setMcpServerUrl(connectionId, GMAIL_URL);
    const id = await createConnector(db!, {
      connector: 'mcp',
      toolkit: mcpToolkitFor(connectionId),
      displayName: 'StatelessServer',
      connectionRef: connectionId,
      connectedBy: 'u1',
    });
    await recordSync(db!, id, { ok: false, error: SDK_DCR_ERROR });
    return { id, connectionId };
  }

  it('the connect path answers 422 with the shared code + message', async () => {
    await open();
    const r = await call('POST', '/api/connectors/mcp/connect', { serverUrl: GMAIL_URL });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({
      code: CLIENT_REGISTRATION_UNSUPPORTED,
      error: CLIENT_REGISTRATION_MESSAGE,
    });
  });

  it('a stranded row lists as setup-incomplete with the actionable message + code', async () => {
    await open();
    const { id, connectionId } = await seedStrandedRow();
    const body = (await call('GET', '/api/connectors')).body as { connectors: ListedConnector[] };
    const row = body.connectors.find((c) => c.id === id);
    expect(row?.lastError).toBe(CLIENT_REGISTRATION_MESSAGE);
    expect(row?.lastErrorCode).toBe(CLIENT_REGISTRATION_UNSUPPORTED);
    expect(row?.setupIncomplete).toBe(true);
    expect(row?.itemCount).toBe(0);
    clearMcpConnection(connectionId);
  });

  it('a stranded row does NOT hide its own catalog card, but a working one does', async () => {
    await open();
    const { id, connectionId } = await seedStrandedRow();
    const stranded = (await call('GET', '/api/connectors')).body as {
      catalog: { id: string }[];
    };
    expect(stranded.catalog.map((e) => e.id)).toContain('gmail');
    // Once the connection actually works, the card is redundant and drops off.
    await recordSync(db!, id, { ok: true, at: new Date().toISOString() });
    const working = (await call('GET', '/api/connectors')).body as { catalog: { id: string }[] };
    expect(working.catalog.map((e) => e.id)).not.toContain('gmail');
    clearMcpConnection(connectionId);
  });

  it('supplying a client id repoints the SAME row instead of creating a second one', async () => {
    await open();
    const { id, connectionId } = await seedStrandedRow();
    mcp.requiresPreregisteredClient = false;
    // No serverUrl in the body: the route resolves the row's stored endpoint.
    const begun = (
      await call('POST', '/api/connectors/mcp/connect', {
        connectorId: id,
        clientId: 'preregistered-id',
        clientSecret: 's3cret',
      })
    ).body as { pendingId?: string };
    expect(begun.pendingId).toBeTruthy();
    expect(mcp.lastClientId).toBe('preregistered-id');
    const cb = await call('GET', `/api/connectors/oauth/callback?code=ok&state=${begun.pendingId}`);
    expect(cb.status).toBe(200);
    const rows = await listConnectors(db!, 'u1');
    expect(rows).toHaveLength(1);
    const rec = await getConnector(db!, id);
    expect(rec?.status).toBe('connected');
    expect(rec?.lastError).toBeNull();
    expect(rec?.connectionRef).not.toBe(connectionId);
    // The placeholder handshake name never becomes the label for a known endpoint.
    expect(rec?.displayName).toBe('Gmail');
    const body = (await call('GET', '/api/connectors')).body as { connectors: ListedConnector[] };
    expect(body.connectors[0]?.setupIncomplete).toBe(false);
    expect(body.connectors[0]?.lastErrorCode).toBeNull();
  });
});

// ── The panel: a stranded row must carry the action that fixes it ──

interface FetchCall {
  url: string;
  method: string;
  body?: string;
}

interface PanelConn {
  id: string;
  toolkit?: string;
  displayName: string;
  status: string;
  serverUrl?: string | null;
  lastSyncAt?: string | null;
  lastError?: string | null;
  lastErrorCode?: string | null;
  setupIncomplete?: boolean;
  itemCount?: number;
}

describe('MCP connectors panel — client-id recovery action (jsdom)', () => {
  let panelConnectors: PanelConn[] = [];
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  function loadPanel(calls: FetchCall[]): void {
    const w = globalThis as unknown as Record<string, unknown>;
    w.escapeHtml = (s: unknown): string =>
      String(s).replace(
        /[&<>"]/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
      );
    w.fetchJson = () => Promise.resolve({ connectors: panelConnectors, catalog: [] });
    w.fetch = (url: string, opts?: { method?: string; body?: string }) => {
      calls.push({ url, method: opts?.method ?? 'GET', body: opts?.body });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    };
    w.refreshEntities = () => Promise.resolve();
    w.renderSidebar = () => undefined;
    (0, eval)(connectorsSettingsJs);
  }

  beforeEach(() => {
    document.body.innerHTML =
      '<div class="db-panel"><div id="mcp-catalog"></div><div id="mcp-connectors-list"></div>' +
      '<div id="mcp-connectors-form" class="db-form-host"></div></div>';
    panelConnectors = [
      {
        id: 'c1',
        toolkit: 'mcp',
        displayName: 'Gmail',
        status: 'error',
        serverUrl: GMAIL_URL,
        lastSyncAt: null,
        lastError: CLIENT_REGISTRATION_MESSAGE,
        lastErrorCode: CLIENT_REGISTRATION_UNSUPPORTED,
        setupIncomplete: true,
        itemCount: 0,
      },
    ];
  });

  it('reads as unfinished rather than broken', async () => {
    loadPanel([]);
    (globalThis as unknown as { renderConnectorsPanel: () => void }).renderConnectorsPanel();
    await flush();
    const list = document.querySelector('#mcp-connectors-list')!;
    expect(list.textContent).toContain('Setup incomplete');
    expect(list.textContent).not.toContain('error');
  });

  it('offers an Add OAuth client ID action that re-drives connect for THAT row', async () => {
    const calls: FetchCall[] = [];
    loadPanel(calls);
    (globalThis as unknown as { renderConnectorsPanel: () => void }).renderConnectorsPanel();
    await flush();
    const action = document.querySelector<HTMLButtonElement>('button[data-conn-act="add-client"]')!;
    expect(action).toBeTruthy();
    action.click();
    await flush();
    // The action opens the SAME form the initial connect path uses.
    expect(document.querySelector<HTMLElement>('#mcp-client-fields')!.hidden).toBe(false);
    document.querySelector<HTMLInputElement>('#mcp-add-client-id')!.value = 'preregistered-id';
    document.querySelector<HTMLInputElement>('#mcp-add-client-secret')!.value = 's3cret';
    document.querySelector<HTMLButtonElement>('button[data-conn-act="connect"]')!.click();
    await flush();
    const post = calls.find((c) => c.url === '/api/connectors/mcp/connect' && c.method === 'POST');
    expect(post).toBeTruthy();
    expect(JSON.parse(post!.body ?? '{}')).toMatchObject({
      connectorId: 'c1',
      clientId: 'preregistered-id',
      clientSecret: 's3cret',
    });
  });

  it('a healthy row still offers Refresh and Disconnect only', async () => {
    panelConnectors = [
      {
        id: 'c2',
        toolkit: 'mcp',
        displayName: 'Payroll MCP',
        status: 'connected',
        serverUrl: 'https://mcp.acmecorp.example.com/x',
        lastSyncAt: '2026-01-01T00:00:00.000Z',
        lastError: null,
        lastErrorCode: null,
        setupIncomplete: false,
        itemCount: 4,
      },
    ];
    loadPanel([]);
    (globalThis as unknown as { renderConnectorsPanel: () => void }).renderConnectorsPanel();
    await flush();
    expect(document.querySelector('button[data-conn-act="add-client"]')).toBeNull();
    expect(document.querySelector('button[data-conn-act="refresh"]')).toBeTruthy();
    expect(document.querySelector('button[data-conn-act="disconnect"]')).toBeTruthy();
  });
});
