import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { genericConnector } from '../../src/connectors/generic/connector.js';
import { setMcpServerUrl, clearMcpConnection } from '../../src/connectors/mcp/oauth.js';
import { clearMcpSchemaDescriptor } from '../../src/connectors/mcp/schema-cache.js';
import type {
  McpTransport,
  McpToolCall,
  McpToolInfo,
  McpResourceInfo,
  McpServerRef,
} from '../../src/connectors/mcp/transport.js';
import type { ExternalRecord, ListChangesContext } from '../../src/connectors/types.js';

/**
 * #5 typed MCP modeling — connector engine, end to end with a fake transport: introspect a
 * server → one TYPED table per record kind (namespaced per connection) → typed listChanges
 * routes each model to its tool. The legacy flat `mcp_items` path stays for un-introspected
 * connections. No network / MCP SDK / real credential store (LATTICE_CONFIG_DIR → temp).
 */

let tmp: string;
let prev: string | undefined;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lattice-mcp-typed-'));
  prev = process.env.LATTICE_CONFIG_DIR;
  process.env.LATTICE_CONFIG_DIR = tmp;
  process.env.LATTICE_ENCRYPTION_KEY ||= Buffer.alloc(32, 9).toString('base64');
});
afterAll(() => {
  if (prev === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = prev;
  rmSync(tmp, { recursive: true, force: true });
});

class FakeTransport implements McpTransport {
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

function jwConnector() {
  const t = new FakeTransport(
    [{ name: 'list_deduction_types' }, { name: 'get_company' }, { name: 'create_thing' }],
    {
      list_deduction_types: {
        items: [
          { code: 'MED', name: 'Medical (pretax)', pretax: true },
          { code: 'DEN', name: 'Dental (pretax)', pretax: true },
        ],
      },
      get_company: { id: 'co_1', name: 'Acme', employees: 600 },
    },
  );
  return genericConnector({ transportFactory: (_ref: McpServerRef) => Promise.resolve(t) });
}

async function collect(it: AsyncIterable<ExternalRecord>): Promise<ExternalRecord[]> {
  const out: ExternalRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

describe('#5 typed MCP connector', () => {
  const CONN = 'c-jw';
  const TOOLKIT = 'mcp:c-jw';
  beforeAll(() => {
    setMcpServerUrl(CONN, 'https://mcp.justworks.com/');
  });
  afterAll(() => {
    clearMcpSchemaDescriptor(CONN);
    clearMcpConnection(CONN);
  });

  it('introspects the server into typed per-kind models (write tools skipped)', async () => {
    const conn = jwConnector();
    const descriptor = await conn.introspect(CONN, TOOLKIT, 'justworks');
    expect(descriptor).toBeTruthy();

    const models = conn.models(TOOLKIT);
    // One typed table per read kind — the write tool (`create_thing`) is never modeled.
    expect(models.map((m) => m.table).sort()).toEqual([
      'mcp_justworks_company',
      'mcp_justworks_deduction_types',
    ]);
    const company = models.find((m) => m.table === 'mcp_justworks_company')!;
    expect(company.naturalKey).toBe('id'); // get_company items carry an id
    expect(Object.keys(company.definition.columns)).toEqual(
      expect.arrayContaining(['id', 'name', 'employees', 'data']),
    );
    expect(company.definition.source?.toolkit).toBe('mcp:c-jw'); // per-connection grouping key
  });

  it('typed listChanges routes a model to ITS tool and maps typed rows', async () => {
    const conn = jwConnector();
    await conn.introspect(CONN, TOOLKIT, 'justworks');
    const ctx: ListChangesContext = { connectionId: CONN, userId: 'u1' };

    const deductions = await collect(conn.listChanges(TOOLKIT, 'deduction_types', ctx));
    expect(deductions).toHaveLength(2);
    expect(deductions[0]!.row.code).toBe('MED');
    expect(deductions[0]!.row.name).toBe('Medical (pretax)');
    expect(typeof deductions[0]!.row.data).toBe('string'); // full item in the JSON overflow

    const companies = await collect(conn.listChanges(TOOLKIT, 'company', ctx));
    expect(companies).toHaveLength(1);
    expect(companies[0]!.id).toBe('co_1'); // natural key from the item's id
    expect(companies[0]!.row.employees).toBe(600);
  });

  it('falls back to the flat mcp_items model for an un-introspected (legacy) connection', () => {
    const conn = jwConnector();
    // Legacy toolkit `mcp` (no per-connection id) → the single flat model.
    const models = conn.models('mcp');
    expect(models).toHaveLength(1);
    expect(models[0]!.table).toBe('mcp_items');
  });
});
