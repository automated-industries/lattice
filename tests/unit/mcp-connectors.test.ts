import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { genericConnector } from '../../src/connectors/generic/connector.js';
import { SimpleMcpConnector } from '../../src/connectors/mcp/connector-base.js';
import {
  setMcpServerUrl,
  getMcpServerUrl,
  LatticeOAuthProvider,
} from '../../src/connectors/mcp/oauth.js';
import type {
  McpTransport,
  McpToolCall,
  McpToolInfo,
  McpResourceInfo,
  McpServerRef,
} from '../../src/connectors/mcp/transport.js';
import type { McpOAuthDriver } from '../../src/connectors/mcp/connector-base.js';
import type { ExternalRecord, ListChangesContext } from '../../src/connectors/types.js';

/**
 * MCP connectors — mapping + connect flow, proven with a fake transport (canned
 * tool JSON) and a fake OAuth driver, so no network / MCP SDK / real credential
 * store is touched. LATTICE_CONFIG_DIR is redirected to a temp dir so the pending
 * OAuth state never touches the developer's ~/.lattice.
 */

let tmp: string;
let prevCfg: string | undefined;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lattice-mcp-test-'));
  prevCfg = process.env.LATTICE_CONFIG_DIR;
  process.env.LATTICE_CONFIG_DIR = tmp;
  process.env.LATTICE_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
});
afterAll(() => {
  if (prevCfg === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = prevCfg;
  rmSync(tmp, { recursive: true, force: true });
});

type ToolResult = Record<string, unknown> | ((args: Record<string, unknown>) => unknown);

class FakeTransport implements McpTransport {
  closed = false;
  constructor(
    private readonly tools: McpToolInfo[],
    private readonly results: Record<string, ToolResult>,
    private readonly resources: McpResourceInfo[] = [],
    private readonly name?: string,
  ) {}
  listTools(): Promise<McpToolInfo[]> {
    return Promise.resolve(this.tools);
  }
  callTool(call: McpToolCall): Promise<unknown> {
    const r = this.results[call.tool];
    if (r === undefined) return Promise.reject(new Error(`no fake for tool ${call.tool}`));
    return Promise.resolve(
      typeof r === 'function' ? (r as (a: Record<string, unknown>) => unknown)(call.args) : r,
    );
  }
  listResources(): Promise<McpResourceInfo[]> {
    return Promise.resolve(this.resources);
  }
  serverInfo(): { name?: string } | undefined {
    return this.name ? { name: this.name } : undefined;
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

function factoryFor(t: FakeTransport, seen?: McpServerRef[]) {
  return (ref: McpServerRef): Promise<McpTransport> => {
    seen?.push(ref);
    return Promise.resolve(t);
  };
}

async function collect(it: AsyncIterable<ExternalRecord>): Promise<ExternalRecord[]> {
  const out: ExternalRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

const CTX: ListChangesContext = { connectionId: 'c1', userId: 'u1' };

describe('Generic (introspective) connector', () => {
  it('defines one private mcp_items table with kind/tool/server columns', () => {
    const conn = genericConnector();
    const models = conn.models('mcp');
    expect(models.map((m) => m.table)).toEqual(['mcp_items']);
    const def = models[0]?.definition;
    expect(def?.source?.defaultVisibility).toBe('private');
    const cols = Object.keys(def?.columns ?? {});
    for (const c of ['kind', 'tool', 'server', 'title', 'summary', 'data']) {
      expect(cols).toContain(c);
    }
  });

  it('calls read tools, skips write tools, and maps items into mcp_items', async () => {
    setMcpServerUrl(CTX.connectionId, 'https://mcp.example.com/mcp');
    const conn = genericConnector({
      transportFactory: factoryFor(
        new FakeTransport([{ name: 'list_things' }, { name: 'create_thing' }], {
          list_things: { items: [{ id: 'x1', title: 'Thing One', description: 'desc' }] },
          // create_thing must never be called; if it is, this throws.
        }),
      ),
    });
    const rows = await collect(conn.listChanges('mcp', 'item', CTX));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('list_things:x1');
    expect(rows[0]?.row).toMatchObject({
      kind: 'item',
      tool: 'list_things',
      server: 'mcp.example.com',
      title: 'Thing One',
      summary: 'desc',
    });
    const row0 = rows[0]?.row;
    expect(typeof row0?.data).toBe('string');
  });

  it("lists the server's resources as kind='resource' rows alongside tool items", async () => {
    setMcpServerUrl(CTX.connectionId, 'https://mcp.example.com/mcp');
    const conn = genericConnector({
      transportFactory: factoryFor(
        new FakeTransport(
          [{ name: 'list_things' }],
          { list_things: { items: [{ id: 'x1', title: 'Thing One' }] } },
          [
            {
              name: 'Q1 report',
              uri: 'file:///reports/q1.pdf',
              description: 'Quarterly report',
              mimeType: 'application/pdf',
            },
          ],
        ),
      ),
    });
    const rows = await collect(conn.listChanges('mcp', 'item', CTX));
    expect(rows.map((r) => r.id)).toEqual(['list_things:x1', 'resource:file:///reports/q1.pdf']);
    const resource = rows[1];
    expect(resource?.row).toMatchObject({
      kind: 'resource',
      server: 'mcp.example.com',
      title: 'Q1 report',
      summary: 'Quarterly report',
    });
    expect(String(resource?.row.data)).toContain('file:///reports/q1.pdf');
    expect(String(resource?.row.data)).toContain('application/pdf');
  });

  it('yields no resource rows when the server has none (capability optional)', async () => {
    const conn = genericConnector({
      transportFactory: factoryFor(
        new FakeTransport([{ name: 'list_things' }], {
          list_things: { items: [{ id: 'x1', title: 'T' }] },
        }),
      ),
    });
    const rows = await collect(conn.listChanges('mcp', 'item', CTX));
    expect(rows).toHaveLength(1);
  });
});

// A minimal TYPED connector standing in for any library consumer of
// SimpleMcpConnector — locks the binding/paging/session engine the branded
// connectors used to exercise.
function typedSpec(overrides: Record<string, unknown> = {}) {
  return {
    connector: 'x',
    presentation: { label: 'X' },
    models: [],
    bindings: [
      {
        model: 'note',
        tool: 'get_notes',
        buildArgs: (ctx: { parentKey?: string; cursor?: string | null }) => ({
          parent: ctx.parentKey,
          page: ctx.cursor ?? undefined,
        }),
        items: (r: unknown) => (r as { notes?: unknown[] }).notes ?? [],
        map: (item: unknown, ctx: { parentKey?: string }) => {
          const o = item as { id: string; text: string };
          return { id: o.id, row: { text: o.text, parent: ctx.parentKey ?? null } };
        },
        nextCursor: (r: unknown) => (r as { next?: string }).next ?? null,
      },
    ],
    servers: [{ name: 'x', url: 'https://mcp.example/x', transport: 'http' as const }],
    ...overrides,
  };
}

describe('typed bindings: paging + per-parent mapping (SimpleMcpConnector)', () => {
  it('pages via nextCursor and stamps the parent key', async () => {
    const t = new FakeTransport([{ name: 'get_notes' }], {
      get_notes: (args) =>
        args.page === 'p2'
          ? { notes: [{ id: 'n2', text: 'second' }] }
          : { notes: [{ id: 'n1', text: 'first' }], next: 'p2' },
    });
    const conn = new SimpleMcpConnector(typedSpec(), { transportFactory: factoryFor(t) });
    const rows = await collect(conn.listChanges('x', 'note', { ...CTX, parentKey: 'P' }));
    expect(rows.map((r) => r.id)).toEqual(['n1', 'n2']);
    expect(rows[0]?.row).toMatchObject({ text: 'first', parent: 'P' });
    expect(t.closed).toBe(true);
  });
});

describe('sync session reuses ONE transport across parent keys (#8)', () => {
  function sessionConn() {
    const seen: McpServerRef[] = [];
    const t = new FakeTransport([{ name: 'get_notes' }], {
      get_notes: { notes: [{ id: 'n1', text: 'hello' }] },
    });
    const conn = new SimpleMcpConnector(typedSpec(), { transportFactory: factoryFor(t, seen) });
    return { conn, t, seen };
  }

  it('opens a fresh transport per listChanges when NO session is active (unchanged single-shot path)', async () => {
    const { conn, seen } = sessionConn();
    await collect(conn.listChanges('x', 'note', { ...CTX, parentKey: 'p1' }));
    await collect(conn.listChanges('x', 'note', { ...CTX, parentKey: 'p2' }));
    expect(seen).toHaveLength(2); // the old N+1: one connect per parent key
  });

  it('opens ONE transport for the whole session, reuses it, and closes it on endSyncSession', async () => {
    const { conn, t, seen } = sessionConn();
    await conn.beginSyncSession('c1');
    await collect(conn.listChanges('x', 'note', { ...CTX, parentKey: 'p1' }));
    await collect(conn.listChanges('x', 'note', { ...CTX, parentKey: 'p2' }));
    expect(seen).toHaveLength(1); // reused across both parent keys
    expect(t.closed).toBe(false); // not closed mid-session
    await conn.endSyncSession('c1');
    expect(t.closed).toBe(true); // closed exactly once, at session end
  });
});

describe('MCP connect flow', () => {
  const emptyModels = { connector: 'x', presentation: { label: 'X' }, models: [], bindings: [] };

  it('connects a local stdio server immediately (no OAuth redirect)', async () => {
    const seen: McpServerRef[] = [];
    const conn = new SimpleMcpConnector(
      { ...emptyModels, servers: [{ name: 'x', command: 'mcp-x', transport: 'stdio' }] },
      { transportFactory: factoryFor(new FakeTransport([{ name: 'list' }], {}), seen) },
    );
    const r = await conn.beginConnect('u1', 'x');
    expect(r.kind).toBe('connected');
    expect(seen[0]?.transport).toBe('stdio');
  });

  it("uses the server's self-reported name for an open server's display name", async () => {
    const conn = new SimpleMcpConnector(
      { ...emptyModels, servers: [{ name: 'x', url: 'https://mcp.example/x', oauth: false }] },
      {
        transportFactory: factoryFor(new FakeTransport([{ name: 'list' }], {}, [], 'Notes Server')),
      },
    );
    const r = await conn.beginConnect('u1', 'x');
    expect(r.kind).toBe('connected');
    if (r.kind !== 'connected') return;
    expect(r.displayName).toBe('Notes Server');
  });

  it('returns an OAuth redirect for an HTTP server, then completes the connection', async () => {
    const oauth: McpOAuthDriver = {
      begin: () =>
        Promise.resolve({ authorizationUrl: 'https://auth.example/authorize?x=1', toolNames: [] }),
      complete: () => Promise.resolve({ toolNames: ['t'] }),
    };
    const conn = new SimpleMcpConnector(
      {
        ...emptyModels,
        connector: 'y',
        presentation: { label: 'Y' },
        servers: [{ name: 'y', url: 'https://mcp.example/sse', transport: 'sse', oauth: true }],
      },
      { oauth },
    );
    const begun = await conn.beginConnect('u1', 'y', {
      redirectUri: 'http://127.0.0.1/api/connectors/oauth/callback',
    });
    expect(begun.kind).toBe('redirect');
    if (begun.kind !== 'redirect') return;
    expect(begun.redirectUrl).toContain('auth.example');
    const done = await conn.completeConnect(begun.pendingId, { code: 'the-code' });
    expect(done.connectionId).toBeTruthy();
    expect(done.displayName).toBe('Y');
    // Pending state is one-shot: a second completion fails loudly.
    await expect(conn.completeConnect(begun.pendingId, { code: 'again' })).rejects.toThrow();
  });

  it("prefers the MCP handshake's server name over the toolkit label after OAuth", async () => {
    const oauth: McpOAuthDriver = {
      begin: () =>
        Promise.resolve({ authorizationUrl: 'https://auth.example/authorize', toolNames: [] }),
      complete: () => Promise.resolve({ toolNames: ['t'], serverName: 'Payroll MCP' }),
    };
    const conn = new SimpleMcpConnector(
      { ...emptyModels, servers: [{ name: 'x', url: 'https://mcp.example/x', oauth: true }] },
      { oauth },
    );
    const begun = await conn.beginConnect('u1', 'x', {
      redirectUri: 'http://127.0.0.1/api/connectors/oauth/callback',
    });
    if (begun.kind !== 'redirect') throw new Error('expected redirect');
    const done = await conn.completeConnect(begun.pendingId, { code: 'c' });
    expect(done.displayName).toBe('Payroll MCP');
    expect(done.serverName).toBe('Payroll MCP');
  });

  it('stores a user-supplied pre-registered client and echoes the reconnect target', async () => {
    const oauth: McpOAuthDriver = {
      begin: () =>
        Promise.resolve({ authorizationUrl: 'https://auth.example/authorize', toolNames: [] }),
      complete: () => Promise.resolve({ toolNames: [] }),
    };
    const conn = new SimpleMcpConnector(
      { ...emptyModels, servers: [{ name: 'x', url: 'https://mcp.example/x', oauth: true }] },
      { oauth },
    );
    const begun = await conn.beginConnect('u1', 'x', {
      redirectUri: 'http://127.0.0.1/api/connectors/oauth/callback',
      clientInfo: { client_id: 'preregistered-id', client_secret: 's3cret' },
      targetConnectorId: 'row-42',
    });
    if (begun.kind !== 'redirect') throw new Error('expected redirect');
    const done = await conn.completeConnect(begun.pendingId, { code: 'c' });
    // The reconnect target rode the pending state across begin → complete.
    expect(done.targetConnectorId).toBe('row-42');
    // The pre-registered client landed in the store the SDK's clientInformation()
    // short-circuit reads — this is what skips registration entirely.
    const provider = new LatticeOAuthProvider(done.connectionId, 'http://127.0.0.1/cb');
    expect(provider.clientInformation()).toMatchObject({
      client_id: 'preregistered-id',
      client_secret: 's3cret',
    });
  });

  it('Bug 5b: discards a stored DCR client when the loopback redirect_uri changed between launches', () => {
    const id = 'conn-5b-redirect';
    const cbFor = (port: number): string =>
      `http://127.0.0.1:${String(port)}/api/connectors/oauth/callback`;
    // Launch 1: register a client bound to port 111.
    new LatticeOAuthProvider(id, cbFor(111)).saveClientInformation({
      client_id: 'dcr-old',
      redirect_uris: [cbFor(111)],
    });
    // Same port → the client is reused (no needless re-registration).
    expect(new LatticeOAuthProvider(id, cbFor(111)).clientInformation()).toMatchObject({
      client_id: 'dcr-old',
    });
    // Launch 2 on a NEW ephemeral port → the stale client is discarded so the SDK
    // re-registers with the CURRENT redirect_uri (the strict-AS invalid_grant fix).
    expect(new LatticeOAuthProvider(id, cbFor(222)).clientInformation()).toBeUndefined();
  });

  it('Bug 5b: saveClientInformation records the redirect_uri even when the DCR response omits it', () => {
    const id = 'conn-5b-norecord';
    new LatticeOAuthProvider(id, 'http://127.0.0.1:333/cb').saveClientInformation({
      client_id: 'dcr-no-redirect', // response carried no redirect_uris
    });
    expect(
      new LatticeOAuthProvider(id, 'http://127.0.0.1:333/cb').clientInformation(),
    ).toMatchObject({ client_id: 'dcr-no-redirect' });
    expect(
      new LatticeOAuthProvider(id, 'http://127.0.0.1:444/cb').clientInformation(),
    ).toBeUndefined();
  });

  it('retains the stored server URL across disconnect (reconnect keeps the address)', async () => {
    const conn = new SimpleMcpConnector(
      { ...emptyModels, servers: [{ name: 'x', url: 'https://mcp.example/x', oauth: false }] },
      { transportFactory: factoryFor(new FakeTransport([{ name: 'list' }], {})) },
    );
    const r = await conn.beginConnect('u1', 'x');
    if (r.kind !== 'connected') throw new Error('expected connected');
    expect(getMcpServerUrl(r.connectionId)).toBe('https://mcp.example/x');
    await conn.disconnect(r.connectionId);
    expect(getMcpServerUrl(r.connectionId)).toBe('https://mcp.example/x');
    // Hard purge removes it too — nothing outlives the registry row.
    await conn.purgeConnection(r.connectionId);
    expect(getMcpServerUrl(r.connectionId)).toBeNull();
  });
});
