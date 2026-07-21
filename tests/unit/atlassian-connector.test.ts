import { describe, it, expect } from 'vitest';
import { atlassianConnector } from '../../src/connectors/atlassian/connector.js';
import type {
  McpTransport,
  McpToolCall,
  McpToolInfo,
  McpResourceInfo,
} from '../../src/connectors/mcp/transport.js';
import type { ExternalRecord, ListChangesContext } from '../../src/connectors/types.js';

/**
 * The Atlassian connector is the first HAND-AUTHORED, parameterized-tool connector:
 * its useful read tools all require a `cloudId`, which the introspective connector
 * would skip. This proves the mechanism — the cloudId flows in as the sync parentKey,
 * the parameterized tool runs with it, and rows are mapped site-uniquely. (Mapper
 * field paths are documented-but-spike-unverified; this test pins the WIRING, using a
 * fake transport, not the live server's exact JSON.)
 */

const CLOUD_ID = '11111111-2222-3333-4444-555555555555';

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
    return { name: 'atlassian' };
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

describe('Atlassian (Jira + Confluence) connector', () => {
  const TK = 'atlassian';
  function conn(results: Record<string, unknown>): {
    c: ReturnType<typeof atlassianConnector>;
    t: FakeTransport;
  } {
    const t = new FakeTransport(results);
    return { c: atlassianConnector({ transportFactory: () => Promise.resolve(t) }), t };
  }

  it('models both products (Jira + Confluence) from one connector, children parented on the site', () => {
    const { c } = conn({});
    expect(c.models(TK).map((m) => m.table)).toEqual([
      'atlassian_sites',
      'jira_projects',
      'jira_issues',
      'confluence_spaces',
      'confluence_pages',
    ]);
    // The parameterized children declare atlassian_sites as their parent (the cloudId source).
    for (const table of ['jira_issues', 'jira_projects', 'confluence_pages']) {
      const m = c.models(TK).find((x) => x.table === table)!;
      expect(m.parent?.table).toBe('atlassian_sites');
      expect(m.parent?.keyColumn).toBe('cloud_id');
    }
  });

  it('serves the Atlassian MCP over the /v1/mcp Streamable-HTTP endpoint (not /v1/sse)', () => {
    const { c } = conn({});
    const server = c.mcpServers(TK)[0];
    expect(server.url).toMatch(/\/v1\/mcp$/);
    expect(server.url).not.toMatch(/\/sse$/);
  });

  it('lists sites from the no-arg tool (the cloudId source)', async () => {
    const { c } = conn({
      getAccessibleAtlassianResources: {
        resources: [{ id: CLOUD_ID, name: 'Acme', url: 'https://acme.atlassian.net' }],
      },
    });
    const ctx: ListChangesContext = { connectionId: 'x', userId: 'u' };
    const sites = await collect(c.listChanges(TK, 'sites', ctx));
    expect(sites.map((s) => s.id)).toEqual([CLOUD_ID]);
    expect(sites[0]?.row.name).toBe('Acme');
  });

  it('runs the PARAMETERIZED Jira search with the cloudId parentKey and maps site-unique rows', async () => {
    const { c, t } = conn({
      searchJiraIssuesUsingJql: {
        issues: [
          {
            key: 'PROJ-1',
            fields: {
              summary: 'Fix the thing',
              status: { name: 'To Do' },
              project: { key: 'PROJ' },
            },
          },
        ],
      },
    });
    const ctx: ListChangesContext = { connectionId: 'x', userId: 'u', parentKey: CLOUD_ID };
    const issues = await collect(c.listChanges(TK, 'jira_issues', ctx));
    // The parameterized tool ran WITH the cloudId — the whole point of the connector.
    expect(t.calls[0]?.tool).toBe('searchJiraIssuesUsingJql');
    expect((t.calls[0]?.args as { cloudId?: string }).cloudId).toBe(CLOUD_ID);
    // Row mapped; its natural key is site-namespaced so two sites' PROJ-1 never collide.
    expect(issues).toHaveLength(1);
    expect(issues[0]?.id).toBe(`${CLOUD_ID}/PROJ-1`);
    expect(issues[0]?.row.summary).toBe('Fix the thing');
    expect(issues[0]?.row.project_key).toBe('PROJ');
  });

  it('runs the parameterized Confluence page search with the cloudId parentKey', async () => {
    const { c, t } = conn({
      getConfluencePages: { results: [{ id: '123', title: 'Runbook', status: 'current' }] },
    });
    const ctx: ListChangesContext = { connectionId: 'x', userId: 'u', parentKey: CLOUD_ID };
    const pages = await collect(c.listChanges(TK, 'confluence_pages', ctx));
    expect((t.calls[0]?.args as { cloudId?: string }).cloudId).toBe(CLOUD_ID);
    expect(pages[0]?.id).toBe(`${CLOUD_ID}/123`);
    expect(pages[0]?.row.title).toBe('Runbook');
  });
});
