/**
 * Schema classification — which "schema" a table belongs to, for the schema-grouped
 * TABLES sidebar. A table's schema is a pure function of its connected-source origin
 * (already stamped as `connectorToolkit` on GuiTableSummary):
 *
 *   - no source            → the LATTICE schema (native + derived + files + authored tables)
 *   - a connector toolkit  → that connector's schema (keyed by TOOLKIT, so two Gmail
 *                            connections share one physical table + one schema; the rows
 *                            are disambiguated per-row by `_source_connector_id`)
 *   - `db_source:<connId>` → that connected external database's schema (one per connection)
 *
 * Server-authoritative (called in enrichEntityTables) so the client renders from the
 * stamped `schemaKey`/`schemaLabel` with zero extra fetches. A sibling of tier-classify
 * (provenance schema is a DIFFERENT axis than the Inputs/Derived/Computed lifecycle tier).
 */

const DB_SOURCE_PREFIX = 'db_source:';
const MCP_PREFIX = 'mcp:';

export interface SchemaInfo {
  kind: 'lattice' | 'connector' | 'db_source';
  /** Stable grouping key (unique per schema). */
  key: string;
  /** Human label for the schema header. */
  label: string;
}

/** Title-case a toolkit slug for a connector schema header (`gmail` → `Gmail`). */
function titleCaseToolkit(toolkit: string): string {
  return toolkit
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Classify a table into its schema. `dbLabels` maps a `db_source:<connId>` toolkit to
 * the connected database's display name (built once per request from the connector
 * registry); `fallbackLabel` is the table's own entity label, used when a db-source
 * connection has no stored display name.
 */
export function classifySchema(
  connectorToolkit: string | undefined | null,
  dbLabels: Map<string, string>,
  fallbackLabel?: string,
): SchemaInfo {
  const src = connectorToolkit ?? '';
  if (!src) return { kind: 'lattice', key: 'lattice', label: 'LATTICE' };
  if (src.startsWith(DB_SOURCE_PREFIX)) {
    const connId = src.slice(DB_SOURCE_PREFIX.length);
    // Prefer the entity label (when non-empty after trim), then the connection id, then a
    // generic name. `||` semantics are needed (an empty label must fall through), spelled
    // out as ternaries so an empty string isn't treated as a valid label.
    const trimmed = (fallbackLabel ?? '').trim();
    const fallback = trimmed !== '' ? trimmed : connId !== '' ? connId : 'Database';
    return { kind: 'db_source', key: 'db:' + connId, label: dbLabels.get(src) ?? fallback };
  }
  // A per-connection MCP toolkit (`mcp:<connId>`) → its own schema group, labeled by the server
  // brand (from `dbLabels`, populated per connection) — so each server reads as e.g. JUSTWORKS,
  // mirroring how a db_source reads as its database name. Falls back to the connection id.
  if (src.startsWith(MCP_PREFIX)) {
    const connId = src.slice(MCP_PREFIX.length);
    const trimmed = (fallbackLabel ?? '').trim();
    const fallback = trimmed !== '' ? trimmed : connId !== '' ? connId : 'Connector';
    return { kind: 'connector', key: 'conn:' + src, label: dbLabels.get(src) ?? fallback };
  }
  // The legacy generic MCP connector (single `mcp` toolkit, pre-typed-tables) groups under a
  // "CONNECTORS" header rather than the jargon slug "MCP". A branded toolkit keeps its name.
  return {
    kind: 'connector',
    key: 'conn:' + src,
    label: src === 'mcp' ? 'Connectors' : titleCaseToolkit(src),
  };
}
