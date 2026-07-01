import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gmailConnector, GMAIL_MODELS } from '../../src/connectors/gmail/connector.js';
import { genericConnector } from '../../src/connectors/generic/connector.js';
import { SimpleMcpConnector } from '../../src/connectors/mcp/connector-base.js';
import type {
  McpTransport,
  McpToolCall,
  McpToolInfo,
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

describe('Gmail connector', () => {
  it('defines three connected tables, parents before children, all private', () => {
    expect(GMAIL_MODELS.map((m) => m.table)).toEqual([
      'gmail_labels',
      'gmail_threads',
      'gmail_messages',
    ]);
    for (const m of GMAIL_MODELS) {
      expect(m.definition.source?.defaultVisibility).toBe('private');
      expect(m.definition.source?.connector).toBe('gmail');
    }
    const messages = GMAIL_MODELS.find((m) => m.table === 'gmail_messages');
    expect(messages?.parent?.table).toBe('gmail_threads');
    expect(messages?.graphEdges?.[0]?.dstTable).toBe('gmail_threads');
  });

  it('maps list_labels output to label rows', async () => {
    const conn = gmailConnector({
      transportFactory: factoryFor(
        new FakeTransport([{ name: 'list_labels' }], {
          list_labels: { labels: [{ id: 'L1', name: 'Inbox', type: 'system' }] },
        }),
      ),
    });
    const rows = await collect(conn.listChanges('gmail', 'label', CTX));
    expect(rows).toEqual([{ id: 'L1', row: { name: 'Inbox', type: 'system' } }]);
  });

  it('pages threads via next_page_token', async () => {
    const t = new FakeTransport([{ name: 'search_threads' }], {
      search_threads: (args) =>
        args.page_token === 'p2'
          ? { threads: [{ id: 't2', snippet: 'second' }] }
          : { threads: [{ id: 't1', snippet: 'first' }], next_page_token: 'p2' },
    });
    const conn = gmailConnector({ transportFactory: factoryFor(t) });
    const rows = await collect(conn.listChanges('gmail', 'thread', CTX));
    expect(rows.map((r) => r.id)).toEqual(['t1', 't2']);
    expect(t.closed).toBe(true);
  });

  it('maps get_thread messages per parent thread, stamping the FK', async () => {
    const conn = gmailConnector({
      transportFactory: factoryFor(
        new FakeTransport([{ name: 'get_thread' }], {
          get_thread: { messages: [{ id: 'm1', from: 'a@x.com', subject: 'Hi', body: 'Body' }] },
        }),
      ),
    });
    const rows = await collect(conn.listChanges('gmail', 'message', { ...CTX, parentKey: 't1' }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('m1');
    expect(rows[0]?.row).toMatchObject({
      thread_id: 't1',
      from_addr: 'a@x.com',
      subject: 'Hi',
      body_text: 'Body',
    });
  });
});

describe('Generic (introspective) connector', () => {
  it('calls read tools, skips write tools, and maps items into mcp_items', async () => {
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
      tool: 'list_things',
      title: 'Thing One',
      summary: 'desc',
    });
    const row0 = rows[0]?.row;
    expect(typeof row0?.data).toBe('string');
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
});
