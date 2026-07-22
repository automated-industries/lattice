import { describe, it, expect } from 'vitest';
import { slackConnector } from '../../src/connectors/slack/connector.js';
import type {
  McpTransport,
  McpToolCall,
  McpToolInfo,
  McpResourceInfo,
} from '../../src/connectors/mcp/transport.js';
import type { ExternalRecord, ListChangesContext } from '../../src/connectors/types.js';

/**
 * The Slack connector is a HAND-AUTHORED, parameterized-tool connector: its
 * message-history tool requires a `channel`, which the introspective connector
 * would skip. This proves the mechanism — the channel id flows in as the sync
 * parentKey, `conversations_history` runs with it, and rows are mapped
 * channel-uniquely (message ts is only unique per channel). (Mapper field paths are
 * documented-but-spike-unverified; this test pins the WIRING, using a fake transport,
 * not the live server's exact JSON.)
 */

const CHANNEL_ID = 'C0123ABCD';

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
    return { name: 'slack' };
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

describe('Slack connector', () => {
  const TK = 'slack';
  function conn(results: Record<string, unknown>): {
    c: ReturnType<typeof slackConnector>;
    t: FakeTransport;
  } {
    const t = new FakeTransport(results);
    return { c: slackConnector({ transportFactory: () => Promise.resolve(t) }), t };
  }

  it('models channels, users, and per-channel messages in order', () => {
    const { c } = conn({});
    expect(c.models(TK).map((m) => m.table)).toEqual([
      'slack_channels',
      'slack_users',
      'slack_messages',
    ]);
    // Messages are per-channel: they declare slack_channels as their parent (the channel source).
    const m = c.models(TK).find((x) => x.table === 'slack_messages')!;
    expect(m.parent?.table).toBe('slack_channels');
    expect(m.parent?.keyColumn).toBe('channel_id');
  });

  it('serves the Slack MCP over the /v1/mcp Streamable-HTTP endpoint (not /sse)', () => {
    const { c } = conn({});
    const server = c.mcpServers(TK)[0];
    expect(server.url).toMatch(/\/v1\/mcp$/);
    expect(server.url).not.toMatch(/\/sse$/);
  });

  it('lists channels from the no-channel-arg tool (the parentKey source)', async () => {
    const { c } = conn({
      list_channels: {
        channels: [
          {
            id: CHANNEL_ID,
            name: 'general',
            is_private: false,
            topic: { value: 'Company-wide' },
            purpose: { value: 'All the things' },
            num_members: 42,
          },
        ],
      },
    });
    const ctx: ListChangesContext = { connectionId: 'x', userId: 'u' };
    const channels = await collect(c.listChanges(TK, 'slack_channels', ctx));
    expect(channels.map((s) => s.id)).toEqual([CHANNEL_ID]);
    expect(channels[0]?.row.name).toBe('general');
    expect(channels[0]?.row.topic).toBe('Company-wide');
    expect(channels[0]?.row.num_members).toBe('42');
  });

  it('runs the PER-CHANNEL history with the channel parentKey and maps channel-unique rows', async () => {
    const { c, t } = conn({
      conversations_history: {
        messages: [
          {
            ts: '1700000000.000100',
            user: 'U1',
            text: 'hello team',
            thread_ts: '1700000000.000100',
          },
        ],
      },
    });
    const ctx: ListChangesContext = { connectionId: 'x', userId: 'u', parentKey: CHANNEL_ID };
    const messages = await collect(c.listChanges(TK, 'slack_messages', ctx));
    // The parameterized tool ran WITH the channel — the whole point of the connector.
    expect(t.calls[0]?.tool).toBe('conversations_history');
    expect((t.calls[0]?.args as { channel?: string }).channel).toBe(CHANNEL_ID);
    // Row mapped; its natural key is channel-namespaced so two channels' identical ts never collide.
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe(`${CHANNEL_ID}/1700000000.000100`);
    expect(messages[0]?.row.text).toBe('hello team');
    expect(messages[0]?.row.channel_id).toBe(CHANNEL_ID);
  });

  it('stops paging when Slack returns an empty next_cursor (no infinite loop)', async () => {
    const { c, t } = conn({
      list_channels: {
        channels: [{ id: CHANNEL_ID, name: 'general' }],
        response_metadata: { next_cursor: '' },
      },
    });
    const ctx: ListChangesContext = { connectionId: 'x', userId: 'u' };
    const channels = await collect(c.listChanges(TK, 'slack_channels', ctx));
    expect(channels).toHaveLength(1);
    // An empty next_cursor is end-of-pages: exactly one tool call, no re-page.
    expect(t.calls).toHaveLength(1);
  });
});
