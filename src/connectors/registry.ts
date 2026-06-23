/**
 * Connector registry — the set of external sources a workspace has connected.
 *
 * One internal `__lattice_connectors` table (GUI-hidden by the `__lattice_`
 * prefix) records each connector instance: which implementation backs it
 * (`connector`, e.g. `'composio'`), which product (`toolkit`, e.g. `'jira'`),
 * the opaque per-member auth handle (`composio_connection_id`), who connected
 * it, and its sync state. No secret material is stored here — the connector's
 * API key lives in the machine-local encrypted credential store, and the SaaS
 * OAuth tokens live in the connector backend (e.g. Composio).
 *
 * On a cloud workspace the table is RLS-scoped private-to-owner (see the ACL
 * wiring), so each member sees and manages only their own connectors.
 *
 * The table is created on demand (idempotent `CREATE TABLE IF NOT EXISTS`), so a
 * library consumer that never touches connectors pays nothing.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Lattice } from '../lattice.js';
import { runAsyncOrSync, getAsyncOrSync, allAsyncOrSync } from '../db/adapter.js';

export const CONNECTORS_TABLE = '__lattice_connectors';

/** Lifecycle state of a connector instance. */
export type ConnectorStatus = 'connected' | 'error' | 'disconnected';

/** A row in the connector registry. */
export interface ConnectorRecord {
  id: string;
  /** Connector implementation, e.g. `'composio'`. */
  connector: string;
  /** External product/toolkit, e.g. `'jira'`. */
  toolkit: string;
  /** Human-friendly label shown in the GUI. */
  displayName: string | null;
  /** Opaque per-member auth handle from the connector backend (e.g. Composio). */
  composioConnectionId: string | null;
  /** Identity that connected this instance (member role / user id). */
  connectedBy: string | null;
  status: ConnectorStatus;
  /** ISO timestamp of the last successful sync, or null if never synced. */
  lastSyncAt: string | null;
  /** Last sync error message (cleared on success), or null. */
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Create the registry table if it doesn't exist (idempotent; both dialects). */
export async function ensureConnectorRegistry(db: Lattice): Promise<void> {
  await runAsyncOrSync(
    db.adapter,
    `CREATE TABLE IF NOT EXISTS "${CONNECTORS_TABLE}" (
       "id"                     TEXT PRIMARY KEY,
       "connector"              TEXT NOT NULL,
       "toolkit"                TEXT NOT NULL,
       "display_name"           TEXT,
       "composio_connection_id" TEXT,
       "connected_by"           TEXT,
       "status"                 TEXT NOT NULL DEFAULT 'connected',
       "last_sync_at"           TEXT,
       "last_error"             TEXT,
       "created_at"             TEXT NOT NULL,
       "updated_at"             TEXT NOT NULL
     )`,
  );
}

interface ConnectorRow {
  id: string;
  connector: string;
  toolkit: string;
  display_name: string | null;
  composio_connection_id: string | null;
  connected_by: string | null;
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(r: ConnectorRow): ConnectorRecord {
  return {
    id: r.id,
    connector: r.connector,
    toolkit: r.toolkit,
    displayName: r.display_name,
    composioConnectionId: r.composio_connection_id,
    connectedBy: r.connected_by,
    status: r.status as ConnectorStatus,
    lastSyncAt: r.last_sync_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreateConnectorInput {
  connector: string;
  toolkit: string;
  displayName?: string;
  composioConnectionId?: string;
  connectedBy?: string;
}

/** Insert a connector instance and return its id. */
export async function createConnector(db: Lattice, input: CreateConnectorInput): Promise<string> {
  await ensureConnectorRegistry(db);
  const id = uuidv4();
  const now = new Date().toISOString();
  await runAsyncOrSync(
    db.adapter,
    `INSERT INTO "${CONNECTORS_TABLE}"
       ("id","connector","toolkit","display_name","composio_connection_id","connected_by","status","last_sync_at","last_error","created_at","updated_at")
     VALUES (?, ?, ?, ?, ?, ?, 'connected', NULL, NULL, ?, ?)`,
    [
      id,
      input.connector,
      input.toolkit,
      input.displayName ?? null,
      input.composioConnectionId ?? null,
      input.connectedBy ?? null,
      now,
      now,
    ],
  );
  return id;
}

/** Fetch one connector by id, or null. */
export async function getConnector(db: Lattice, id: string): Promise<ConnectorRecord | null> {
  await ensureConnectorRegistry(db);
  const row = (await getAsyncOrSync(
    db.adapter,
    `SELECT * FROM "${CONNECTORS_TABLE}" WHERE "id" = ?`,
    [id],
  )) as ConnectorRow | undefined;
  return row ? toRecord(row) : null;
}

/**
 * Fetch the connector for a toolkit (optionally scoped to a connecting identity).
 * Returns the most recently created match, or null.
 */
export async function getConnectorByToolkit(
  db: Lattice,
  toolkit: string,
  connectedBy?: string,
): Promise<ConnectorRecord | null> {
  await ensureConnectorRegistry(db);
  const where = connectedBy ? `"toolkit" = ? AND "connected_by" = ?` : `"toolkit" = ?`;
  const params = connectedBy ? [toolkit, connectedBy] : [toolkit];
  const row = (await getAsyncOrSync(
    db.adapter,
    `SELECT * FROM "${CONNECTORS_TABLE}" WHERE ${where} ORDER BY "created_at" DESC, "id" DESC LIMIT 1`,
    params,
  )) as ConnectorRow | undefined;
  return row ? toRecord(row) : null;
}

/**
 * List connectors. Pass `connectedBy` to scope to one identity — an APP-LAYER
 * fail-closed filter that does not rely on RLS (the app/owner connection is
 * BYPASSRLS, so RLS would not filter its own reads). Callers serving a specific
 * member MUST pass it so one member can't see another's connectors.
 */
export async function listConnectors(
  db: Lattice,
  connectedBy?: string,
): Promise<ConnectorRecord[]> {
  await ensureConnectorRegistry(db);
  const rows = (connectedBy
    ? await allAsyncOrSync(
        db.adapter,
        `SELECT * FROM "${CONNECTORS_TABLE}" WHERE "connected_by" = ? ORDER BY "created_at" DESC`,
        [connectedBy],
      )
    : await allAsyncOrSync(
        db.adapter,
        `SELECT * FROM "${CONNECTORS_TABLE}" ORDER BY "created_at" DESC`,
      )) as unknown as ConnectorRow[];
  return rows.map(toRecord);
}

/** Update a connector's backend connection id + mark it connected (re-auth/reuse). */
export async function updateConnectorConnection(
  db: Lattice,
  id: string,
  composioConnectionId: string,
): Promise<void> {
  await runAsyncOrSync(
    db.adapter,
    `UPDATE "${CONNECTORS_TABLE}" SET "composio_connection_id" = ?, "status" = 'connected', "updated_at" = ? WHERE "id" = ?`,
    [composioConnectionId, new Date().toISOString(), id],
  );
}

/** Record a sync outcome: success stamps `last_sync_at` + clears the error. */
export async function recordSync(
  db: Lattice,
  id: string,
  outcome: { ok: true; at: string } | { ok: false; error: string },
): Promise<void> {
  const now = new Date().toISOString();
  if (outcome.ok) {
    await runAsyncOrSync(
      db.adapter,
      `UPDATE "${CONNECTORS_TABLE}" SET "status" = 'connected', "last_sync_at" = ?, "last_error" = NULL, "updated_at" = ? WHERE "id" = ?`,
      [outcome.at, now, id],
    );
  } else {
    await runAsyncOrSync(
      db.adapter,
      `UPDATE "${CONNECTORS_TABLE}" SET "status" = 'error', "last_error" = ?, "updated_at" = ? WHERE "id" = ?`,
      [outcome.error, now, id],
    );
  }
}

/** Set a connector's lifecycle status (e.g. `'disconnected'` on teardown). */
export async function setConnectorStatus(
  db: Lattice,
  id: string,
  status: ConnectorStatus,
): Promise<void> {
  await runAsyncOrSync(
    db.adapter,
    `UPDATE "${CONNECTORS_TABLE}" SET "status" = ?, "updated_at" = ? WHERE "id" = ?`,
    [status, new Date().toISOString(), id],
  );
}

/** Hard-delete a connector registry row (used by a full teardown). */
export async function deleteConnectorRecord(db: Lattice, id: string): Promise<void> {
  await runAsyncOrSync(db.adapter, `DELETE FROM "${CONNECTORS_TABLE}" WHERE "id" = ?`, [id]);
}
