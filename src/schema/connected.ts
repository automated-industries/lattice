/**
 * Connected data types — tables backed by an external source via a connector.
 *
 * A table that declares `source` is a *connected data type*: its rows are
 * ingested from an external system (e.g. issues from a project tracker) rather
 * than authored locally. The framework stamps each row with bookkeeping that
 * records which connector instance produced it and when, so the data can be
 * re-synced idempotently, scoped per connector, and torn down completely when
 * the connector is disconnected.
 *
 * The natural key (a stable external identifier — e.g. an issue key) is the
 * table's primary key, so `upsert` is idempotent across re-syncs and the
 * connector lineage columns are preserved on conflict.
 *
 * Lineage columns (`_source_connector_id`, `_source_model`) are immutable: once
 * stamped at ingest they cannot be rewritten by `update()`, so a re-sync or a
 * manual edit can't quietly relabel which connector a row came from. The
 * sync-time bookkeeping column (`_source_synced_at`) is mutable.
 *
 * Opt-in per table; tables without a `source` add no columns and pay nothing.
 */

/** A row's connector lineage / sync bookkeeping. Mirrors the governance pattern. */
export const CONNECTED_COLUMNS: Record<string, string> = {
  /** Connector instance id (FK-ish to `__lattice_connectors.id`). Immutable. */
  _source_connector_id: 'TEXT',
  /** The connector model this row was produced by (e.g. `'issue'`). Immutable. */
  _source_model: 'TEXT',
  /** ISO timestamp of the last sync that wrote this row. Mutable (re-stamped). */
  _source_synced_at: 'TEXT',
};

/**
 * Lineage columns that may not be changed by `update()` after a row exists.
 * `_source_synced_at` is intentionally excluded — it is re-stamped every sync.
 */
export const IMMUTABLE_CONNECTED_FIELDS: readonly string[] = [
  '_source_connector_id',
  '_source_model',
];

/**
 * Lattice-added columns on a connected external table that must NOT be shown to the user: a
 * connected table is a faithful, read-only mirror, so its user-facing schema (SQL runner, table
 * view, data-model, column pickers) should present ONLY the source's real columns. These stay
 * PHYSICAL (the sync engine and lineage depend on `deleted_at` + `_source_*`, and `data`/`_pk`
 * back the MCP typed tables) — they are display-hidden, never dropped. Use with a
 * `db.getConnectedSource(table)` guard so authored tables keep their own lifecycle columns.
 */
export const CONNECTED_INTERNAL_COLUMNS: ReadonlySet<string> = new Set([
  'deleted_at',
  'created_at',
  'updated_at',
  '_source_connector_id',
  '_source_model',
  '_source_synced_at',
  'data',
  '_pk',
]);

/** True when `column` is a Lattice-added internal column on a connected mirror (see above). */
export function isConnectedInternalColumn(column: string): boolean {
  return CONNECTED_INTERNAL_COLUMNS.has(column);
}

/** Row visibility a connected table's rows default to when ingested into a cloud. */
export type ConnectedVisibility = 'private' | 'everyone';

/**
 * Declares a table as a connected data type (see module docs). Attached to a
 * {@link TableDefinition} as `source`.
 */
export interface ConnectorSource {
  /** The connector implementation that backs this table (e.g. `'jira'`). */
  connector: string;
  /** The external product/toolkit (e.g. `'jira'`). */
  toolkit: string;
  /** The model within the toolkit (e.g. `'issue'`). */
  model: string;
  /**
   * The column holding the stable external identifier. By convention this is
   * the table's primary key, so re-syncs upsert idempotently on it.
   */
  naturalKey: string;
  /**
   * Default row visibility when ingested into a cloud workspace. `'private'`
   * (the default) scopes rows to the connecting member; `'everyone'` shares
   * them with all cloud members. Configurable per connected type.
   */
  defaultVisibility?: ConnectedVisibility;
}

/** The DDL column spec map a connected-data-type contributes. */
export function connectedColumns(source: ConnectorSource | undefined): Record<string, string> {
  if (!source) return {};
  return { ...CONNECTED_COLUMNS };
}

/**
 * Thrown when an `update()` tries to change an immutable connector-lineage
 * column. Surfaced loudly so a row can't be silently relabeled to a different
 * connector or model after ingest.
 */
export class ConnectedSourceImmutableError extends Error {
  constructor(
    readonly table: string,
    readonly column: string,
  ) {
    super(
      `Connector lineage column "${column}" on "${table}" is immutable — it is ` +
        `stamped at ingest and cannot be changed by update().`,
    );
    this.name = 'ConnectedSourceImmutableError';
  }
}
