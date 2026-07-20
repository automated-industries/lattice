// Generic tier classifier for the Model "Tables" explorer. Lattice is workspace-
// agnostic, so (unlike a per-app hardcoded layer map) the tier is derived from
// runtime table metadata that /api/entities already carries. Pure + dependency-free
// so it's unit-tested directly; the client module (app/modules/model-tables.ts)
// embeds a byte-for-byte JS mirror of `classifyTier` (kept in sync with this file).

/**
 * The three columns of the data-model view, displayed as
 * "Inputs" (source) → "Derived Tables" (model) → "Computed Tables" (computed).
 */
export type Tier = 'source' | 'model' | 'computed';

/** The subset of a table summary the classifier reads. */
export interface ClassifiableTable {
  name: string;
  columns?: string[];
  /** Set by the server for connector-synced tables (e.g. 'jira'). */
  connectorToolkit?: string;
  /** Framework-shipped native entity (files, secrets). */
  native?: boolean;
  /**
   * Set by the server for saved computed tables (live, read-only projections
   * defined over other tables). Authoritative.
   */
  computedTable?: boolean;
  /**
   * Server-stamped provenance: 'source' = ingested/connected data; 'derived' =
   * materialized from ingested data (via the lineage store).
   */
  origin?: 'source' | 'derived';
}

/**
 * Classify a table into one of the three tiers. Priority order matters:
 * 1. COMPUTED ("Computed Tables") — a saved computed table. Authoritative and
 *    checked first: a computed projection may surface provenance columns from
 *    its base (e.g. `_source_connector_id`), so this must win over the SOURCE
 *    signals below.
 * 2. SOURCE ("Inputs") — an explicit provenance signal (server-stamped
 *    `origin: 'source'`, connector-synced, the ingested `files` table, or a
 *    stamped `_source_connector_id` column).
 * 3. MODEL ("Derived Tables") — the default: every other table.
 */
export function classifyTier(t: ClassifiableTable): Tier {
  const name = t.name.toLowerCase();
  const cols = t.columns ?? [];

  // 1. COMPUTED — authoritative server flag.
  if (t.computedTable) return 'computed';

  // 2. SOURCE — explicit provenance.
  if (t.origin === 'source') return 'source';
  if (t.connectorToolkit) return 'source';
  if (name === 'files') return 'source';
  if (cols.includes('_source_connector_id')) return 'source';

  // 3. MODEL ("Derived Tables") — default.
  return 'model';
}
