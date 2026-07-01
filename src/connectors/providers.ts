/**
 * Branded MCP connectors for providers with a hosted, third-party-reachable MCP
 * server: Jira (Atlassian) and monday.com expose standard-OAuth MCP endpoints
 * (verified reachable), so these connect out of the box; Trello ships without a
 * default endpoint (supply your Trello MCP server URL).
 *
 * They reuse the introspective engine ({@link introspectiveConnector}) with their
 * own branded `*_items` connected table. This is deliberate: unlike Gmail/Calendar/
 * Drive (whose read-tool shapes are pinned in typed modules), these providers'
 * exact MCP tool contracts (e.g. Atlassian's cloud-id-scoped tools) can't be pinned
 * without verifying against a live account — so rather than ship guessed typed
 * bindings, they pull whatever read tools the server exposes into a typed
 * `*_items` table (per-member visibility, FTS, rendered context). A future PR can
 * promote any of them to a fully-typed schema once its tool contract is verified.
 */

import { introspectiveConnector } from './generic/connector.js';
import type { McpConnectorBase, McpConnectorDeps } from './mcp/connector-base.js';

/** Jira via the Atlassian Remote MCP Server (standard OAuth). */
export function jiraConnector(deps: McpConnectorDeps = {}): McpConnectorBase {
  return introspectiveConnector(
    {
      connector: 'jira',
      label: 'Jira',
      iconLetter: 'J',
      iconColor: '#0052CC',
      table: 'jira_items',
      servers: [
        {
          name: 'atlassian',
          url: 'https://mcp.atlassian.com/v1/sse',
          transport: 'sse',
          oauth: true,
        },
      ],
    },
    deps,
  );
}

/** monday.com via its hosted MCP server (standard OAuth). */
export function mondayConnector(deps: McpConnectorDeps = {}): McpConnectorBase {
  return introspectiveConnector(
    {
      connector: 'monday',
      label: 'monday.com',
      iconLetter: 'M',
      iconColor: '#FF3D57',
      table: 'monday_items',
      servers: [
        { name: 'monday', url: 'https://mcp.monday.com/sse', transport: 'sse', oauth: true },
      ],
    },
    deps,
  );
}

/** Trello — supply your Trello MCP server URL at connect time (no hosted default). */
export function trelloConnector(deps: McpConnectorDeps = {}): McpConnectorBase {
  return introspectiveConnector(
    {
      connector: 'trello',
      label: 'Trello',
      iconLetter: 'T',
      iconColor: '#0079BF',
      table: 'trello_items',
      servers: [{ name: 'trello', transport: 'http', oauth: true }],
    },
    deps,
  );
}
