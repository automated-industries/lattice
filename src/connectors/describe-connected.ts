import type { Lattice } from '../lattice.js';
import { listConnectors } from './registry.js';
import { getMcpServerUrl } from './mcp/oauth.js';
import { sanitizeConnectorLabel } from './sanitize-label.js';

function hostnameOf(u: string | null): string | null {
  if (!u) return null;
  try {
    return new URL(u).hostname || null;
  } catch {
    return null;
  }
}

/**
 * A compact, MEMBER-SCOPED summary of the workspace's connected external sources
 * for the assistant's context, so it can answer "are you connected to X?" and
 * knows which table holds each source's data. Scoped by `connectedBy` — never
 * surface another member's connections on a cloud. Returns '' when nothing is
 * connected (the caller omits the section entirely).
 */
export async function describeConnectedSources(db: Lattice, connectedBy: string): Promise<string> {
  const rows = (await listConnectors(db, connectedBy)).filter((c) => c.status !== 'disconnected');
  const mcp = rows.filter((c) => c.connector === 'mcp');
  const dbs = rows.filter((c) => c.connector === 'db_source');
  if (mcp.length === 0 && dbs.length === 0) return '';
  // Both the display name (an MCP server's self-advertised name) and the host
  // are untrusted — sanitize before they enter the prompt (prompt-injection).
  const lines: string[] = [];
  for (const c of mcp) {
    const name = sanitizeConnectorLabel(c.displayName ?? 'MCP server');
    const rawHost = c.connectionRef ? hostnameOf(getMcpServerUrl(c.connectionRef)) : null;
    const host = rawHost ? sanitizeConnectorLabel(rawHost) : null;
    const where = host ? ` at ${host}` : '';
    lines.push(
      `- ${name || 'MCP server'} (MCP server${where}) — connected. Its synced items are in the \`mcp_items\` table.`,
    );
  }
  for (const c of dbs) {
    const name = sanitizeConnectorLabel(c.displayName ?? 'database');
    lines.push(
      `- ${name || 'database'} (external Postgres database) — connected. Its imported tables are prefixed \`db_\`.`,
    );
  }
  return (
    `\n\n# Connected data sources\n` +
    `These external sources ARE connected to this workspace right now; their data is synced into the tables noted. ` +
    `When asked whether a source is connected, treat this list as authoritative, and query the noted tables to answer questions about that source's data.\n` +
    lines.join('\n')
  );
}
