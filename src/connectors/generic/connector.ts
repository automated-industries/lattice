/**
 * The introspective MCP connector — the always-works path.
 *
 * Point it at ANY reachable MCP server (a URL you supply, or a local stdio
 * command) and it pulls that server's readable items in as context without a
 * hand-authored schema: it introspects the server's tools (`tools/list`), calls
 * each no-argument read tool, and stores the returned items in one connected
 * `*_items` table (typed columns for tool/title/summary + a JSON `data` blob,
 * FTS on title/summary, per-member `private` visibility — the same connector-table
 * conventions every typed connector uses).
 *
 * Two uses:
 *  - {@link genericConnector} — a bring-your-own-URL connector (no default server).
 *  - {@link introspectiveConnector} — the same engine pre-pointed at a specific
 *    provider's MCP endpoint with its own branded table (Jira / Trello / monday),
 *    so those connect + pull data reliably even where a fully-typed schema can't
 *    be pinned without verifying the provider's exact tool contract.
 *
 * Only read-shaped tools are called: tools that require arguments are skipped in
 * introspective mode, and obvious write tools are never called.
 */

import {
  McpConnectorBase,
  type McpModelBinding,
  type McpConnectorDeps,
} from '../mcp/connector-base.js';
import { mcpModel, str, jsonCol, arrayField } from '../mcp/connected-model.js';
import { letterIcon } from '../mcp/icon.js';
import type {
  ConnectedModelDef,
  ExternalRecord,
  ListChangesContext,
  McpServerSpec,
  ToolkitPresentation,
} from '../types.js';

/** Per-tool item cap, so a chatty server can't flood the local DB (bounded reads). */
const MAX_ITEMS_PER_TOOL = 500;

/** Tool-name fragments that mark a mutation — never called introspectively. */
const WRITE_HINTS = [
  'create',
  'update',
  'delete',
  'remove',
  'send',
  'add',
  'set',
  'edit',
  'write',
  'move',
  'archive',
  'label',
  'draft',
  'reply',
  'post',
];

function looksLikeWrite(tool: string): boolean {
  const t = tool.toLowerCase();
  return WRITE_HINTS.some((h) => t.includes(h));
}

/** Configuration for an introspective connector instance. */
export interface IntrospectiveSpec {
  /** Connector + toolkit id. */
  connector: string;
  /** Display label. */
  label: string;
  /** Badge letter + colour for the fallback icon. */
  iconLetter: string;
  iconColor: string;
  /** The connected table name (e.g. `'mcp_items'`, `'jira_items'`). */
  table: string;
  /** The MCP server(s). A branded connector sets a default url; generic leaves it blank. */
  servers: McpServerSpec[];
}

class IntrospectiveMcpConnector extends McpConnectorBase {
  readonly connector: string;
  private readonly model: ConnectedModelDef;

  constructor(
    private readonly spec: IntrospectiveSpec,
    deps: McpConnectorDeps = {},
  ) {
    super(deps.transportFactory, deps.oauth);
    this.connector = spec.connector;
    this.model = mcpModel({
      connector: spec.connector,
      toolkit: spec.connector,
      table: spec.table,
      model: 'item',
      naturalKey: 'item_id',
      columns: { tool: 'TEXT', title: 'TEXT', summary: 'TEXT', data: 'TEXT' },
      def: {
        description: `Items pulled from the ${spec.label} MCP server`,
        render: 'default-list',
        fts: { fields: ['title', 'summary'] },
      },
    });
  }

  toolkits(): string[] {
    return [this.spec.connector];
  }
  presentation(_toolkit: string): ToolkitPresentation {
    return { label: this.spec.label, icon: letterIcon(this.spec.iconLetter, this.spec.iconColor) };
  }
  models(_toolkit: string): ConnectedModelDef[] {
    return [this.model];
  }
  mcpServers(_toolkit: string): McpServerSpec[] {
    return this.spec.servers;
  }
  protected bindings(_toolkit: string): McpModelBinding[] {
    return []; // unused — listChanges is introspective
  }

  override async *listChanges(
    toolkit: string,
    model: string,
    ctx: ListChangesContext,
  ): AsyncIterable<ExternalRecord> {
    if (model !== 'item') return;
    const transport = await this.openServerTransport(toolkit, ctx.connectionId);
    try {
      const tools = await transport.listTools();
      for (const tool of tools) {
        if (looksLikeWrite(tool.name)) continue;
        let result: unknown;
        try {
          result = await transport.callTool({ tool: tool.name, args: {} });
        } catch {
          continue; // needs arguments / not callable bare — skip in introspective mode
        }
        const found = arrayField(result, [
          'items',
          'results',
          'data',
          'records',
          'value',
          'entries',
        ]);
        const list = found.length > 0 ? found : result != null ? [result] : [];
        let i = 0;
        for (const it of list) {
          if (i >= MAX_ITEMS_PER_TOOL) break;
          i++;
          const obj =
            it && typeof it === 'object' ? (it as Record<string, unknown>) : { value: it };
          const idPart = str(obj.id) ?? str(obj.key) ?? str(obj.uid) ?? str(obj.name) ?? String(i);
          const row: Record<string, unknown> = {
            tool: tool.name,
            // idPart is always a string (falls back to the index), so title is too.
            title:
              str(obj.title) ?? str(obj.name) ?? str(obj.subject) ?? str(obj.summary) ?? idPart,
          };
          const summary = str(obj.description) ?? str(obj.snippet) ?? str(obj.summary);
          if (summary !== undefined) row.summary = summary;
          const data = jsonCol(it);
          if (data !== undefined) row.data = data;
          yield { id: `${tool.name}:${idPart}`, row };
        }
      }
    } finally {
      await transport.close();
    }
  }
}

/** Build an introspective connector for a specific provider (branded, pre-pointed). */
export function introspectiveConnector(
  spec: IntrospectiveSpec,
  deps: McpConnectorDeps = {},
): McpConnectorBase {
  return new IntrospectiveMcpConnector(spec, deps);
}

/** The generic MCP connector — point it at any reachable MCP server (no default url). */
export function genericConnector(deps: McpConnectorDeps = {}): McpConnectorBase {
  return introspectiveConnector(
    {
      connector: 'mcp',
      label: 'Custom MCP server',
      iconLetter: '+',
      iconColor: '#6b7280',
      table: 'mcp_items',
      servers: [{ name: 'generic', transport: 'http', oauth: true }],
    },
    deps,
  );
}
