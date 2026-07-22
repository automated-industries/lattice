import { describe, it, expect } from 'vitest';
import { driveConnector } from '../../src/connectors/drive/connector.js';
import type {
  McpTransport,
  McpToolCall,
  McpToolInfo,
  McpResourceInfo,
} from '../../src/connectors/mcp/transport.js';
import type { ExternalRecord, ListChangesContext } from '../../src/connectors/types.js';

/**
 * The Google Drive connector is a FLAT, single-model connector: one paged
 * `search_files` pass feeds `drive_files`. Drive file ids are globally unique, so
 * the natural key is the raw id (no parent-namespacing). This test pins the WIRING
 * — the tool call, its args, the mapper, and cursor→pageToken paging — using a fake
 * transport, not the live server's exact JSON. (Mapper field paths are
 * documented-but-spike-unverified.)
 */

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
    return { name: 'drive' };
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

describe('Google Drive connector', () => {
  const TK = 'drive';
  function conn(results: Record<string, unknown>): {
    c: ReturnType<typeof driveConnector>;
    t: FakeTransport;
  } {
    const t = new FakeTransport(results);
    return { c: driveConnector({ transportFactory: () => Promise.resolve(t) }), t };
  }

  it('models a single flat drive_files table', () => {
    const { c } = conn({});
    expect(c.models(TK).map((m) => m.table)).toEqual(['drive_files']);
    // Flat model — no parent (contrast the per-site Atlassian children).
    expect(c.models(TK)[0]?.parent).toBeUndefined();
  });

  it('serves the Drive MCP over the /v1/mcp Streamable-HTTP endpoint (not /sse)', () => {
    const { c } = conn({});
    const server = c.mcpServers(TK)[0];
    expect(server.url).toMatch(/\/v1\/mcp$/);
    expect(server.url).not.toMatch(/\/sse$/);
  });

  it('runs search_files with pageSize and maps files with the globally-unique raw id (no namespacing)', async () => {
    const { c, t } = conn({
      search_files: {
        files: [
          {
            id: 'file-abc',
            name: 'Q3 Plan.pdf',
            mimeType: 'application/pdf',
            owners: [{ emailAddress: 'alice@example.com' }],
            modifiedTime: '2026-07-01T12:00:00Z',
            webViewLink: 'https://drive.google.com/file/d/file-abc/view',
            parents: ['folder-root'],
          },
        ],
      },
    });
    const ctx: ListChangesContext = { connectionId: 'x', userId: 'u' };
    const files = await collect(c.listChanges(TK, 'drive_files', ctx));
    // The tool ran with the paging arg.
    expect(t.calls[0]?.tool).toBe('search_files');
    expect((t.calls[0]?.args as { pageSize?: number }).pageSize).toBe(100);
    // Row mapped; the natural key is the raw id (globally unique — never namespaced).
    expect(files).toHaveLength(1);
    expect(files[0]?.id).toBe('file-abc');
    expect(files[0]?.row.name).toBe('Q3 Plan.pdf');
    expect(files[0]?.row.mime_type).toBe('application/pdf');
    expect(files[0]?.row.owner).toBe('alice@example.com');
    expect(files[0]?.row.modified_at).toBe('2026-07-01T12:00:00Z');
    expect(files[0]?.row.web_view_link).toBe('https://drive.google.com/file/d/file-abc/view');
    expect(files[0]?.row.parents).toBe(JSON.stringify(['folder-root']));
  });

  it('injects a prior cursor as pageToken on the next page', async () => {
    const { c, t } = conn({ search_files: { files: [{ id: 'f1', name: 'A' }] } });
    const ctx: ListChangesContext = { connectionId: 'x', userId: 'u', cursor: 'PAGE2' };
    await collect(c.listChanges(TK, 'drive_files', ctx));
    expect((t.calls[0]?.args as { pageToken?: string }).pageToken).toBe('PAGE2');
    expect((t.calls[0]?.args as { pageSize?: number }).pageSize).toBe(100);
  });
});
