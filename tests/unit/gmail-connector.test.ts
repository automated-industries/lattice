import { describe, it, expect } from 'vitest';
import { gmailConnector } from '../../src/connectors/gmail/connector.js';
import type {
  McpTransport,
  McpToolCall,
  McpToolInfo,
  McpResourceInfo,
} from '../../src/connectors/mcp/transport.js';
import type { ExternalRecord, ListChangesContext } from '../../src/connectors/types.js';

/**
 * The Gmail connector is a HAND-AUTHORED, parameterized-tool connector: its message
 * read tool requires a `thread_id`, which the introspective connector would skip.
 * This proves the mechanism — the thread_id flows in as the sync parentKey, the
 * parameterized `get_thread` runs with it, and messages are mapped. (Mapper field
 * paths are documented-but-spike-unverified; this test pins the WIRING, using a fake
 * transport, not the live server's exact JSON.)
 */

const THREAD_ID = 'thread-abc123';

class FakeTransport implements McpTransport {
  calls: McpToolCall[] = [];
  constructor(private readonly results: Record<string, unknown>) {}
  listTools(): Promise<McpToolInfo[]> {
    return Promise.resolve(Object.keys(this.results).map((name) => ({ name })));
  }
  callTool(call: McpToolCall): Promise<unknown> {
    this.calls.push(call);
    return Promise.resolve(this.results[call.tool] ?? {});
  }
  listResources(): Promise<McpResourceInfo[]> {
    return Promise.resolve([]);
  }
  serverInfo(): { name?: string } | undefined {
    return { name: 'gmail' };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

async function collect(it: AsyncIterable<ExternalRecord>): Promise<ExternalRecord[]> {
  const out: ExternalRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

describe('Gmail connector', () => {
  const TK = 'gmail';
  function conn(results: Record<string, unknown>): {
    c: ReturnType<typeof gmailConnector>;
    t: FakeTransport;
  } {
    const t = new FakeTransport(results);
    return { c: gmailConnector({ transportFactory: () => Promise.resolve(t) }), t };
  }

  it('models labels, threads, and per-thread messages in order', () => {
    const { c } = conn({});
    expect(c.models(TK).map((m) => m.table)).toEqual([
      'gmail_labels',
      'gmail_threads',
      'gmail_messages',
    ]);
    // The message model declares gmail_threads as its parent (the thread_id source).
    const m = c.models(TK).find((x) => x.table === 'gmail_messages')!;
    expect(m.parent?.table).toBe('gmail_threads');
    expect(m.parent?.keyColumn).toBe('thread_id');
  });

  it('serves the Gmail MCP over the /v1/mcp Streamable-HTTP endpoint (not /sse)', () => {
    const { c } = conn({});
    const server = c.mcpServers(TK)[0];
    expect(server.url).toMatch(/\/v1\/mcp$/);
    expect(server.url).not.toMatch(/\/sse$/);
  });

  it('lists labels from the no-arg tool', async () => {
    const { c } = conn({
      list_labels: { labels: [{ id: 'INBOX', name: 'Inbox', type: 'system' }] },
    });
    const ctx: ListChangesContext = { connectionId: 'x', userId: 'u' };
    const out = await collect(c.listChanges(TK, 'gmail_labels', ctx));
    expect(out.map((l) => l.id)).toEqual(['INBOX']);
    expect(out[0]?.row.name).toBe('Inbox');
  });

  it('runs the PARAMETERIZED get_thread with the thread_id parentKey and maps messages', async () => {
    const { c, t } = conn({
      get_thread: {
        messages: [
          {
            id: 'msg-1',
            from: 'alice@example.com',
            subject: 'Hello',
            body: 'Hi there',
          },
        ],
      },
    });
    const ctx: ListChangesContext = { connectionId: 'x', userId: 'u', parentKey: THREAD_ID };
    const msgs = await collect(c.listChanges(TK, 'gmail_messages', ctx));
    // The parameterized tool ran WITH the thread_id — the whole point of the connector.
    expect(t.calls[0]?.tool).toBe('get_thread');
    expect((t.calls[0]?.args as { thread_id?: string }).thread_id).toBe(THREAD_ID);
    // Row mapped; message ids are globally unique so the natural key is NOT namespaced.
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.id).toBe('msg-1');
    expect(msgs[0]?.row.thread_id).toBe(THREAD_ID);
    expect(msgs[0]?.row.subject).toBe('Hello');
    expect(msgs[0]?.row.from_addr).toBe('alice@example.com');
  });
});
