import { describe, it, expect } from 'vitest';
import { salesforceConnector } from '../../src/connectors/salesforce/connector.js';
import type {
  McpTransport,
  McpToolCall,
  McpToolInfo,
  McpResourceInfo,
} from '../../src/connectors/mcp/transport.js';
import type { ExternalRecord, ListChangesContext } from '../../src/connectors/types.js';

/**
 * The Salesforce connector is a FLAT-list connector: each model is a top-level list
 * tool (`list_accounts` / `list_contacts` / `list_opportunities`) with no parent
 * key, and `account_id` is a plain FK COLUMN. This test pins the WIRING with a fake
 * transport — the list tools run, rows map, the FK column is populated, and the
 * natural keys are the globally-unique Salesforce `Id`s (NOT namespaced). The mapper
 * field paths themselves are documented-but-spike-unverified.
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
    return { name: 'salesforce' };
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

describe('Salesforce connector', () => {
  const TK = 'salesforce';
  function conn(results: Record<string, unknown>): {
    c: ReturnType<typeof salesforceConnector>;
    t: FakeTransport;
  } {
    const t = new FakeTransport(results);
    return { c: salesforceConnector({ transportFactory: () => Promise.resolve(t) }), t };
  }

  it('models accounts, contacts, and opportunities in order (flat — no parent)', () => {
    const { c } = conn({});
    expect(c.models(TK).map((m) => m.table)).toEqual([
      'salesforce_accounts',
      'salesforce_contacts',
      'salesforce_opportunities',
    ]);
    // Flat connector: no model declares a sync parent.
    for (const m of c.models(TK)) {
      expect(m.parent).toBeUndefined();
    }
  });

  it('serves the Salesforce MCP over the /v1/mcp Streamable-HTTP endpoint (not /v1/sse)', () => {
    const { c } = conn({});
    const server = c.mcpServers(TK)[0];
    expect(server.url).toMatch(/\/v1\/mcp$/);
    expect(server.url).not.toMatch(/\/sse$/);
  });

  it('lists accounts with the pageSize arg and maps rows (owner from Owner.Name)', async () => {
    const { c, t } = conn({
      list_accounts: {
        records: [
          {
            Id: '001AAA',
            Name: 'Acme Corp',
            Industry: 'Manufacturing',
            Type: 'Customer',
            Website: 'https://acme.example',
            Owner: { Name: 'Rep One' },
          },
        ],
      },
    });
    const ctx: ListChangesContext = { connectionId: 'x', userId: 'u' };
    const rows = await collect(c.listChanges(TK, 'accounts', ctx));
    // The list tool ran with the injected pageSize arg.
    expect(t.calls[0]?.tool).toBe('list_accounts');
    expect((t.calls[0]?.args as { pageSize?: number }).pageSize).toBe(100);
    // Row mapped; natural key is the plain, globally-unique Salesforce Id (NOT namespaced).
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('001AAA');
    expect(rows[0]?.row.name).toBe('Acme Corp');
    expect(rows[0]?.row.industry).toBe('Manufacturing');
    expect(rows[0]?.row.owner).toBe('Rep One');
  });

  it('maps contacts with account_id as a plain FK column (AccountId), un-namespaced key', async () => {
    const { c, t } = conn({
      list_contacts: {
        records: [
          {
            Id: '003BBB',
            AccountId: '001AAA',
            Name: 'Jane Buyer',
            Email: 'jane@acme.example',
            Title: 'VP',
            Phone: '555-0100',
          },
        ],
      },
    });
    const ctx: ListChangesContext = { connectionId: 'x', userId: 'u' };
    const rows = await collect(c.listChanges(TK, 'contacts', ctx));
    expect(t.calls[0]?.tool).toBe('list_contacts');
    expect(rows[0]?.id).toBe('003BBB');
    // account_id is a plain FK column copied straight from AccountId — no parentKey.
    expect(rows[0]?.row.account_id).toBe('001AAA');
    expect(rows[0]?.row.email).toBe('jane@acme.example');
  });

  it('maps opportunities (stage from StageName, account_id FK)', async () => {
    const { c } = conn({
      list_opportunities: {
        records: [
          {
            Id: '006CCC',
            AccountId: '001AAA',
            Name: 'Big Deal',
            StageName: 'Prospecting',
            Amount: 50000,
            CloseDate: '2026-09-30',
          },
        ],
      },
    });
    const ctx: ListChangesContext = { connectionId: 'x', userId: 'u' };
    const rows = await collect(c.listChanges(TK, 'opportunities', ctx));
    expect(rows[0]?.id).toBe('006CCC');
    expect(rows[0]?.row.account_id).toBe('001AAA');
    expect(rows[0]?.row.stage).toBe('Prospecting');
    expect(rows[0]?.row.amount).toBe('50000');
    expect(rows[0]?.row.close_date).toBe('2026-09-30');
  });
});
