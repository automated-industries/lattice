/**
 * The EXTERNAL upstream node in a table's data-lineage map.
 *
 * A connected table (source tier — a live, read-only mirror synced from an external
 * connector or database) has a real upstream that is NOT a Lattice table: the connector
 * itself. The table-to-table lineage graph therefore can't represent it, so an isolated
 * connected table (one with no belongsTo/many-to-many edges to other synced tables) used to
 * render an EMPTY lineage and read as "no lineage" — the intermittent-by-table bug, where
 * some connected tables showed lineage (they happened to be referenced by another table) and
 * others showed nothing.
 *
 * {@link connectorUpstreamNode} is the single source of truth for that node. The GUI client
 * mirrors this logic inline inside `model-tables.ts`'s `renderTableLineage` (the composed
 * client IIFE can't import) — keep the two in sync; this file is the unit-tested authority.
 */

export interface LineageEntityLike {
  /** Tier from tier-classify (`source` | `model` | `computed`). */
  tier: string;
  /** Connector toolkit id when this table is a connected mirror (else null/absent). */
  connectorToolkit?: string | null;
  /** Clean connector / external-DB label (from schema-classify), shown on the node. */
  schemaLabel?: string | null;
}

export interface ExternalLineageNode {
  /** Marks a non-table lineage node (no `data-table`, non-navigable). */
  external: true;
  /** Display label for the connector / external source. */
  label: string;
  kind: 'connector';
}

/** Fallback label when a connected table exposes no clean connector/source label. */
export const CONNECTED_SOURCE_FALLBACK_LABEL = 'Connected source';

/**
 * The external upstream provenance node for a table, or `null` when the table is not a
 * connected source. Only source-tier tables that carry a `connectorToolkit` are connected
 * mirrors; every other table (authored, derived, computed, or the native `files` source)
 * returns `null` and keeps its ordinary table-to-table lineage.
 */
export function connectorUpstreamNode(e: LineageEntityLike): ExternalLineageNode | null {
  if (e.tier !== 'source' || !e.connectorToolkit) return null;
  // schemaLabel is a non-empty connector/DB label or null/undefined (never ''), so `??` matches
  // the client mirror's `e.schemaLabel || 'Connected source'` fallback in every real case.
  return {
    external: true,
    label: e.schemaLabel ?? CONNECTED_SOURCE_FALLBACK_LABEL,
    kind: 'connector',
  };
}
