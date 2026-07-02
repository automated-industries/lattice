// Generic tier classifier for the Model "Tables" explorer. Lattice is workspace-
// agnostic, so (unlike a per-app hardcoded layer map) the tier is derived from
// runtime table metadata that /api/entities already carries. Pure + dependency-free
// so it's unit-tested directly; the client module (app/modules/model-tables.ts)
// embeds a byte-for-byte JS mirror of `classifyTier` (kept in sync with this file).

/** The two columns of the data-model view: Source (ingested/connected) → Tables. */
export type Tier = 'source' | 'model';

/** The subset of a table summary the classifier reads. */
export interface ClassifiableTable {
  name: string;
  columns?: string[];
  /** Set by the server for connector-synced tables (e.g. 'jira'). */
  connectorToolkit?: string;
  /** Framework-shipped native entity (files, secrets). */
  native?: boolean;
}

/**
 * Classify a table into one of the two tiers. Priority order matters:
 * 1. SOURCE — an explicit provenance signal (connector-synced, the ingested
 *    `files` table, or a stamped `_source_connector_id` column). Authoritative.
 * 2. MODEL ("Tables") — the default: every other table. The former "Surface"
 *    (app/system/settings/auth/chat plumbing) tier was removed as an arbitrary
 *    distinction — those tables now list under Tables like the rest.
 */
export function classifyTier(t: ClassifiableTable): Tier {
  const name = t.name.toLowerCase();
  const cols = t.columns ?? [];

  // 1. SOURCE — authoritative provenance.
  if (t.connectorToolkit) return 'source';
  if (name === 'files') return 'source';
  if (cols.includes('_source_connector_id')) return 'source';

  // 2. MODEL ("Tables") — default (includes the former Surface tables).
  return 'model';
}
