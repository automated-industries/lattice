// Generic tier classifier for the Model "Tables" explorer. Lattice is workspace-
// agnostic, so (unlike a per-app hardcoded layer map) the tier is derived from
// runtime table metadata that /api/entities already carries. Pure + dependency-free
// so it's unit-tested directly; the client module (app/modules/model-tables.ts)
// embeds a byte-for-byte JS mirror of `classifyTier` (kept in sync with this file).

/** The three columns of the data-model view, source → surface. */
export type Tier = 'source' | 'model' | 'surface';

/** The subset of a table summary the classifier reads. */
export interface ClassifiableTable {
  name: string;
  columns?: string[];
  /** Set by the server for connector-synced tables (e.g. 'jira'). */
  connectorToolkit?: string;
  /** Framework-shipped native entity (files, secrets). */
  native?: boolean;
}

// App / system plumbing (settings, auth, chat, notifications, …).
const SURFACE_RE =
  /(^|_)(settings?|config|auth|oauth|tokens?|sessions?|chat|threads?|messages?|todos?|notifications?|app)(_|$)/i;

/**
 * Classify a table into one of the three tiers. Priority order matters:
 * 1. SOURCE — an explicit provenance signal (connector-synced, the ingested
 *    `files` table, or a stamped `_source_connector_id` column). Authoritative,
 *    so it wins over name heuristics.
 * 2. SURFACE — app/system/settings/auth/chat plumbing, or the secrets store.
 * 3. MODEL — the default: first-class user/business entities.
 */
export function classifyTier(t: ClassifiableTable): Tier {
  const name = t.name.toLowerCase();
  const cols = t.columns ?? [];

  // 1. SOURCE — authoritative provenance.
  if (t.connectorToolkit) return 'source';
  if (name === 'files') return 'source';
  if (cols.includes('_source_connector_id')) return 'source';

  // 2. SURFACE — app/system plumbing + secrets.
  if (name === 'secrets') return 'surface';
  if (SURFACE_RE.test(name)) return 'surface';

  // 3. MODEL — default.
  return 'model';
}
