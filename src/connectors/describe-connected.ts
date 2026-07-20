import type { Lattice } from '../lattice.js';
import { listConnectors } from './registry.js';
import { getMcpServerUrl } from './mcp/oauth.js';
import {
  connectionIdFromToolkit,
  getMcpSchemaDescriptor,
  mcpTableName,
} from './mcp/schema-cache.js';
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
 * The brand a hostname reads as — its registrable-domain label, title-cased. This lets the
 * assistant match a user's plain "justworks" to a server at "mcp.justworks.com": the brand
 * is surfaced LITERALLY in the context, instead of being buried in the host or the server's
 * self-advertised name ("partner-api-mcp"). Returns null when no meaningful label exists.
 * The label is a DNS label (alphanumeric + hyphen), so it needs no prompt-injection sanitize.
 */
export function brandFromHost(host: string | null): string | null {
  if (!host) return null;
  const h = host.toLowerCase();
  // An IPv4 literal (e.g. 203.0.113.5) has no brand — its labels are numeric. Return null so
  // the caller falls back to the server's self-advertised name rather than leading with "113".
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return null;
  const labels = h.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  // The registrable name is the label before the TLD; for a common two-part public suffix
  // (co.uk / com.au) step back one more so we don't return "Co"/"Com".
  const TWO_PART = new Set(['co', 'com', 'org', 'net', 'gov', 'ac']);
  let idx = labels.length - 2;
  if (idx > 0 && TWO_PART.has(labels[idx] ?? '')) idx -= 1;
  const name = labels[idx];
  // Reject www, too-short, all-numeric (a stray IP label), and punycode/IDN (`xn--…`) labels —
  // none of them read as a human brand; better to fall back to the server's self-advertised name.
  if (!name || name.length < 2 || name === 'www' || /^\d+$/.test(name) || name.startsWith('xn--'))
    return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * A compact summary of the workspace's connected external sources for the
 * assistant's context, so it can answer "are you connected to X?" and knows
 * which table holds each source's data. Returns '' when nothing is connected.
 *
 * On a CLOUD (Postgres) workspace this is scoped by `connectedBy` so a member
 * never sees another member's connections. On a LOCAL (SQLite) single-user
 * workspace the `connected_by` stamp is meaningless and can drift when the
 * user's saved identity changes (a connector stamped with an old email would
 * then be invisible), so every connection is listed — matching how the sidebar
 * re-registers connector tables locally. This is the same trust boundary: a
 * local workspace is one user's own machine.
 */
export async function describeConnectedSources(db: Lattice, connectedBy: string): Promise<string> {
  const scoped = db.getDialect() === 'postgres';
  const rows = (await listConnectors(db, scoped ? connectedBy : undefined)).filter(
    (c) => c.status !== 'disconnected',
  );
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
    // Lead with the brand read from the host (so a plain "justworks" matches
    // "mcp.justworks.com"), keeping the server's self-advertised name as a secondary alias.
    const brand = brandFromHost(rawHost);
    const primary = brand ?? (name !== '' ? name : 'MCP server');
    const showAlias =
      name !== '' && name !== 'MCP server' && name.toLowerCase() !== brand?.toLowerCase();
    const alias = showAlias ? ` (server name "${name}")` : '';
    // Point the assistant at the table(s) where THIS connection's data actually lives. A typed
    // connection (per-connection toolkit `mcp:<id>` with an introspected descriptor) writes to
    // one `mcp_<prefix>_<kind>` table per record kind; only a legacy/unmodeled connection uses
    // the flat `mcp_items`. Naming `mcp_items` for a typed connection sends it to an empty table.
    const connId = connectionIdFromToolkit(c.toolkit);
    const descriptor = connId ? getMcpSchemaDescriptor(connId) : null;
    let dataPhrase = 'Its synced items are in the `mcp_items` table.';
    if (descriptor && descriptor.kinds.length > 0) {
      const list = descriptor.kinds
        .map((k) => `\`${mcpTableName(descriptor.prefix, k.kind)}\``)
        .join(', ');
      dataPhrase =
        descriptor.kinds.length === 1
          ? `Its synced data is in the ${list} table.`
          : `Its synced data is in these tables: ${list}.`;
    }
    lines.push(`- ${primary}${alias} — an MCP server${where}, connected. ${dataPhrase}`);
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
    `When asked whether a source is connected, treat this list as authoritative, and query the noted tables to answer questions about that source's data. ` +
    `These synced tables are READ-ONLY mirrors — their rows are replaced on every sync, so never write to them (no create/update/delete). ` +
    `To record or enrich data that belongs to a connected source, write it into the workspace's own record instead.\n` +
    lines.join('\n')
  );
}
