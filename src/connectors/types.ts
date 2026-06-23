/**
 * Connector SPI — the fetch/auth contract a connector implementation satisfies.
 *
 * Lattice ships no per-SaaS API clients of its own. A *connector* (e.g. the
 * Composio adapter) handles OAuth and data fetching for a family of external
 * products (*toolkits*, e.g. `jira`), and exposes each external object type as a
 * *connected data type* — a Lattice table whose rows are synced from the source.
 *
 * The SPI is deliberately small: authorize a member, finalize the connection,
 * stream normalized records for a model, and revoke. Everything Lattice-specific
 * (schema, ACL, graph edges, teardown) is driven from the {@link ConnectedModelDef}
 * descriptors and handled by the sync engine — a connector only fetches + maps.
 */

import type { TableDefinition } from '../types.js';

/**
 * A foreign-key relation on a connected model, used to auto-build graph edges
 * after a sync (via `extractEdgesFromColumn`) so connected rows are retrievable
 * as relationship-aware context.
 */
export interface ConnectedEdgeSpec {
  /** FK column on this model's table. */
  fkColumn: string;
  /** The table the FK points to. */
  dstTable: string;
  /** Edge type label (e.g. `'in_project'`). */
  type: string;
}

/**
 * One model a toolkit exposes as a connected data type. Carries the full Lattice
 * {@link TableDefinition} (with a `source` descriptor) plus the graph edges to
 * derive after each sync.
 */
export interface ConnectedModelDef {
  /** Model key within the toolkit (e.g. `'issue'`). */
  model: string;
  /** Lattice table name (e.g. `'jira_issues'`). */
  table: string;
  /** Natural-key column — also the table's primary key, for idempotent upsert. */
  naturalKey: string;
  /** The table definition registered with `db.define()` (must set `source`). */
  definition: TableDefinition;
  /** FK relations to materialize as graph edges after sync. */
  graphEdges?: ConnectedEdgeSpec[];
  /** Embedded text columns, so the sync engine can refresh embeddings. */
  embedded?: boolean;
  /**
   * Declares this model is fetched once *per parent row* rather than in one pass
   * (e.g. comments fetched per issue). The sync engine queries the parent table's
   * already-synced keys and calls {@link Connector.listChanges} with each as
   * `parentKey`. Omit for models fetched in a single paged pass.
   */
  parent?: {
    /** The parent connected table (must be synced earlier in the model order). */
    table: string;
    /** The parent's key column to iterate (its natural key / primary key). */
    keyColumn: string;
    /** The FK column on THIS table to stamp with each parent key during sync. */
    childColumn: string;
  };
}

/**
 * A record fetched from the external source, normalized for upsert. `row` holds
 * the column→value map for the Lattice table (the connector lineage columns are
 * stamped by the sync engine, not here).
 */
export interface ExternalRecord {
  /** Natural-key value (the row's primary key). */
  id: string;
  /** Column→value map for the table row. */
  row: Record<string, unknown>;
}

/** Result of beginning an OAuth authorization for a member. */
export interface AuthorizeResult {
  /** The URL the member must visit to grant access. */
  redirectUrl: string;
  /** Opaque handle to poll/finalize the pending connection. */
  pendingId?: string;
}

/** Result of finalizing a connection after the member completes OAuth. */
export interface ConnectionResult {
  /** The backend connected-account id, stored in the registry. */
  connectionId: string;
}

/** Context for a sync fetch — the member's connection + identity. */
export interface ListChangesContext {
  /** The connector backend's connected-account id. */
  connectionId: string;
  /** Per-member identity (the connector backend's user id). */
  userId: string;
  /** Cursor from a prior page, or null for a full pull. */
  cursor?: string | null;
  /** Parent row key for a per-parent model (e.g. an issue key when fetching its comments). */
  parentKey?: string;
}

/**
 * A connector implementation. Concrete connectors (e.g. Composio) implement this;
 * the sync engine and GUI program against it.
 */
export interface Connector {
  /** Connector id (e.g. `'composio'`). */
  readonly connector: string;
  /** The toolkits this connector can serve (e.g. `['jira']`). */
  toolkits(): string[];
  /** The connected-data-type models for a toolkit. */
  models(toolkit: string): ConnectedModelDef[];
  /** Begin OAuth for a member + toolkit; returns a redirect URL. */
  authorize(userId: string, toolkit: string): Promise<AuthorizeResult>;
  /** Finalize the connection once the member has completed OAuth. */
  completeAuth(userId: string, toolkit: string): Promise<ConnectionResult>;
  /**
   * Stream normalized records for a model, paginated and bounded. Implementations
   * MUST page rather than load everything at once (bounded reads).
   */
  listChanges(
    toolkit: string,
    model: string,
    ctx: ListChangesContext,
  ): AsyncIterable<ExternalRecord>;
  /** Revoke a connected account (teardown). */
  disconnect(connectionId: string): Promise<void>;
}
