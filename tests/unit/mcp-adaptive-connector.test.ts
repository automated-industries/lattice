import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { genericConnector } from '../../src/connectors/generic/connector.js';
import { setMcpServerUrl, clearMcpConnection } from '../../src/connectors/mcp/oauth.js';
import { clearMcpSchemaDescriptor, mcpToolkitFor } from '../../src/connectors/mcp/schema-cache.js';
import type {
  McpTransport,
  McpToolCall,
  McpToolInfo,
  McpResourceInfo,
  McpResourceContent,
} from '../../src/connectors/mcp/transport.js';
import type { ExternalRecord, ListChangesContext } from '../../src/connectors/types.js';

/**
 * v5.1 adaptive engine: the generic introspective connector now (1) compiles a tool's declared
 * outputSchema into contractual columns WITHOUT sampling (correct for an empty account), (2) models
 * the server's resources as a typed table, and (3) reaches arg-requiring tools two-phase — a no-arg
 * discovery tool's rows parameterize a dependent tool via the existing per-parent fan-out.
 */

let tmp: string;
let prev: string | undefined;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lattice-mcp-adaptive-'));
  prev = process.env.LATTICE_CONFIG_DIR;
  process.env.LATTICE_CONFIG_DIR = tmp;
  process.env.LATTICE_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
});
afterAll(() => {
  if (prev === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = prev;
  rmSync(tmp, { recursive: true, force: true });
});

/** A fake transport that records every callTool and supports schemas + resources. */
class RichFakeTransport implements McpTransport {
  readonly callLog: McpToolCall[] = [];
  constructor(
    private readonly tools: McpToolInfo[],
    private readonly results: Record<string, unknown> | ((call: McpToolCall) => unknown),
    private readonly resources: McpResourceInfo[] = [],
  ) {}
  listTools(): Promise<McpToolInfo[]> {
    return Promise.resolve(this.tools);
  }
  callTool(call: McpToolCall): Promise<unknown> {
    this.callLog.push(call);
    const r = typeof this.results === 'function' ? this.results(call) : this.results[call.tool];
    return Promise.resolve(r ?? {});
  }
  listResources(): Promise<McpResourceInfo[]> {
    return Promise.resolve(this.resources);
  }
  readResource(): Promise<McpResourceContent[]> {
    return Promise.resolve([]);
  }
  serverInfo(): { name?: string } | undefined {
    return { name: 'rich-mcp' };
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

describe('v5.1 outputSchema-first', () => {
  it('derives contractual columns from a tool outputSchema without ever sampling it', async () => {
    const CONN = 'c-os';
    setMcpServerUrl(CONN, 'https://mcp.example.com/');
    const TK = mcpToolkitFor(CONN);
    const t = new RichFakeTransport(
      [
        {
          name: 'list_invoices',
          outputSchema: {
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    total: { type: 'number' },
                    status: { type: 'string' },
                  },
                  required: ['id'],
                },
              },
            },
          },
        },
      ],
      { list_invoices: { results: [] } }, // EMPTY account
    );
    const conn = genericConnector({ transportFactory: () => Promise.resolve(t) });
    const desc = await conn.introspect(CONN, TK, 'ex');
    const invoices = desc!.kinds.find((k) => k.kind === 'invoices')!;
    expect(invoices.provenance).toBe('contractual');
    expect(invoices.naturalKey).toBe('id');
    expect(invoices.columns.map((c) => c.name).sort()).toEqual(['status', 'total']);
    // The schema was authoritative → the tool was NEVER called at introspect (empty-account safe).
    expect(t.callLog).toHaveLength(0);
    clearMcpSchemaDescriptor(CONN);
    clearMcpConnection(CONN);
  });
});

describe('v5.1 resources kind', () => {
  it('models the server resources as a typed table keyed by uri', async () => {
    const CONN = 'c-res';
    setMcpServerUrl(CONN, 'https://mcp.example.com/');
    const TK = mcpToolkitFor(CONN);
    const t = new RichFakeTransport(
      [{ name: 'get_status' }],
      { get_status: { id: 's1', state: 'ok' } },
      [
        {
          name: 'Handbook',
          uri: 'file:///handbook.md',
          mimeType: 'text/markdown',
          description: 'the handbook',
        },
      ],
    );
    const conn = genericConnector({ transportFactory: () => Promise.resolve(t) });
    const desc = await conn.introspect(CONN, TK, 'ex');
    const res = desc!.kinds.find((k) => k.origin === 'resources')!;
    expect(res).toBeTruthy();
    expect(res.naturalKey).toBe('uri');
    const model = conn.models(TK).find((m) => m.model === res.kind)!;
    expect(model.table).toBe('mcp_ex_resources');

    const rows = await collect(
      conn.listChanges(TK, res.kind, { connectionId: CONN, userId: 'u1' }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('file:///handbook.md');
    expect(rows[0]!.row.name).toBe('Handbook');
    clearMcpSchemaDescriptor(CONN);
    clearMcpConnection(CONN);
  });
});

describe('v5.1 two-phase arg handling', () => {
  it('parameterizes an arg-requiring tool from a discovery tool and fans out per parent', async () => {
    const CONN = 'c-2p';
    setMcpServerUrl(CONN, 'https://mcp.sites-like.com/');
    const TK = mcpToolkitFor(CONN);
    const t = new RichFakeTransport(
      [
        { name: 'getAccessibleSites' }, // no-arg discovery
        {
          name: 'searchIssues',
          inputSchema: {
            type: 'object',
            properties: {
              cloudId: { type: 'string' },
              jql: { type: 'string', default: 'ORDER BY updated' },
            },
            required: ['cloudId', 'jql'],
          },
        },
      ],
      (call) => {
        if (call.tool === 'getAccessibleSites') {
          return {
            items: [
              { id: 'cloud_1', name: 'Site One' },
              { id: 'cloud_2', name: 'Site Two' },
            ],
          };
        }
        if (call.tool === 'searchIssues') {
          return { results: [{ key: `${String(call.args.cloudId)}-1`, summary: 'S' }] };
        }
        return {};
      },
    );
    const conn = genericConnector({ transportFactory: () => Promise.resolve(t) });
    const desc = await conn.introspect(CONN, TK, 'atl');

    const site = desc!.kinds.find((k) => !k.parentKind && k.origin !== 'resources')!;
    const issues = desc!.kinds.find((k) => k.parentKind)!;
    expect(issues).toBeTruthy();
    expect(issues.parentKind).toBe(site.kind);
    const binding = issues.argBindings!.find((b) => b.arg === 'cloudId')!;
    expect(binding.via).toBe('discovery');
    expect(issues.argBindings!.find((b) => b.arg === 'jql')!.via).toBe('default');

    // The model carries a parent link so the existing per-parent sync fan-out drives it.
    const model = conn.models(TK).find((m) => m.model === issues.kind)!;
    expect(model.parent).toBeTruthy();
    expect(model.parent!.childColumn).toBe('cloudid');
    expect(model.parent!.keyColumn).toBe(site.naturalKey);

    // listChanges for the child WITH a parentKey calls the tool with cloudId=parentKey (+ the jql
    // default) and namespaces the child id by the parent so two sites' ids never collide.
    const ctx: ListChangesContext = { connectionId: CONN, userId: 'u1', parentKey: 'cloud_1' };
    const rows = await collect(conn.listChanges(TK, issues.kind, ctx));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('cloud_1/cloud_1-1');
    const issueCall = t.callLog.find(
      (c) => c.tool === 'searchIssues' && c.args.cloudId === 'cloud_1',
    )!;
    expect(issueCall).toBeTruthy();
    expect(issueCall.args.jql).toBe('ORDER BY updated');
    clearMcpSchemaDescriptor(CONN);
    clearMcpConnection(CONN);
  });

  it('records an unresolvable open-domain arg instead of silently dropping the tool', async () => {
    const CONN = 'c-unres';
    setMcpServerUrl(CONN, 'https://mcp.example.com/');
    const TK = mcpToolkitFor(CONN);
    const t = new RichFakeTransport(
      [
        {
          name: 'list_reports',
          inputSchema: {
            type: 'object',
            properties: { projectId: { type: 'string' } },
            required: ['projectId'],
          },
        },
        { name: 'get_ping' }, // an arg-free tool so the descriptor isn't empty
      ],
      { get_ping: { id: 'p1', ok: true } },
    );
    const conn = genericConnector({ transportFactory: () => Promise.resolve(t) });
    const desc = await conn.introspect(CONN, TK, 'ex');
    // No discovery kind supplies projectId → the tool is recorded as unresolved, not modeled.
    expect(desc!.kinds.some((k) => k.kind === 'reports')).toBe(false);
    expect(desc!.unresolved?.some((u) => u.tool === 'list_reports')).toBe(true);
    clearMcpSchemaDescriptor(CONN);
    clearMcpConnection(CONN);
  });
});
