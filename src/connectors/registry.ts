/**
 * Connector registry — the set of external sources a workspace has connected.
 *
 * One internal `__lattice_connectors` table (GUI-hidden by the `__lattice_`
 * prefix) records each connector instance: which implementation backs it
 * (`connector`, e.g. `'jira'`), which product (`toolkit`, e.g. `'jira'`),
 * the opaque per-member connection handle (`connectionRef`), who connected
 * it, and its sync state. No secret material is stored here — the connector's
 * credentials (e.g. a SaaS API token) live in the machine-local encrypted
 * credential store, keyed by the connection handle.
 *
 * On a cloud workspace this table is OWNER-ONLY bookkeeping: members hold no grant
 * on it at all, and a caller serving one member scopes reads to that member with
 * {@link listConnectors}'s `connectedBy` filter — an app-layer gate, since the
 * owner's own connection is not row-filtered either way.
 *
 * The table is created on demand (idempotent `CREATE TABLE IF NOT EXISTS`), so a
 * local workspace that never touches connectors pays nothing. Securing a cloud
 * table ensures it up front instead, because the ownership stamp reads it to
 * attribute connected rows.
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
  /** Connector implementation, e.g. `'jira'`. */
  connector: string;
  /** External product/toolkit, e.g. `'jira'`. */
  toolkit: string;
  /** Human-friendly label shown in the GUI. */
  displayName: string | null;
  /** Opaque per-member connection handle (the key for the connection's stored credentials). */
  connectionRef: string | null;
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
    // The SQL column keeps its original name (internal); the public field is generic.
    connectionRef: r.composio_connection_id,
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
  connectionRef?: string;
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
      input.connectionRef ?? null,
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

/**
 * List connectors WITHOUT creating the registry table — an empty list when the
 * table does not physically exist yet.
 *
 * {@link listConnectors} creates the table on demand, which is right for a
 * caller that is about to write to it but wrong for the two read-only callers
 * that run on every open and every reconciliation: a workspace that never
 * connected anything should not pay a `CREATE TABLE` on each pass, and a scoped
 * cloud member holds no privilege to issue one at all.
 *
 * "Does not exist" is answered by asking the database, so it is a fact rather
 * than a swallowed error — anything else the read throws still propagates to the
 * caller, which must decide loudly rather than treat a failed read as "no
 * connectors".
 */
export async function listConnectorsIfPresent(db: Lattice): Promise<ConnectorRecord[]> {
  if (db.getDialect() === 'postgres') {
    const reg = (await getAsyncOrSync(
      db.adapter,
      `SELECT to_regclass('${CONNECTORS_TABLE}') AS reg`,
    )) as { reg?: unknown } | undefined;
    if (reg?.reg == null) return [];
  } else {
    const row = (await getAsyncOrSync(
      db.adapter,
      `SELECT name FROM sqlite_master WHERE type='table' AND name='${CONNECTORS_TABLE}'`,
    )) as { name?: string } | undefined;
    if (!row) return [];
  }
  const rows = (await allAsyncOrSync(
    db.adapter,
    `SELECT * FROM "${CONNECTORS_TABLE}" ORDER BY "created_at" DESC`,
  )) as unknown as ConnectorRow[];
  return rows.map(toRecord);
}

/**
 * Update a connector's backend connection id + mark it connected (re-auth/reuse).
 *
 * A reconnect can also re-key the toolkit: an MCP connection's toolkit is per-connection
 * (`mcp:<connectionRef>`), so a new connectionRef means a new toolkit. Passing it keeps the
 * registry row, its descriptor, and its typed tables all keyed to the current connection.
 *
 * `displayName` re-stamps the label. Pass it when the reconnect resolved a better one than the row
 * currently holds — a row that was created before a connection ever authenticated can be carrying
 * a generic placeholder the server reported, and leaving it in place would keep that useless title
 * forever even after the connection is finally working. Omit it (or pass undefined) to leave the
 * existing label untouched; it is never cleared.
 */
export async function updateConnectorConnection(
  db: Lattice,
  id: string,
  connectionRef: string,
  toolkit?: string,
  displayName?: string,
): Promise<void> {
  const sets = [`"composio_connection_id" = ?`];
  const params: unknown[] = [connectionRef];
  if (toolkit !== undefined) {
    sets.push(`"toolkit" = ?`);
    params.push(toolkit);
  }
  if (displayName !== undefined) {
    sets.push(`"display_name" = ?`);
    params.push(displayName);
  }
  // `last_error` is deliberately NOT cleared here: the sync that follows a successful reconnect
  // clears it on success, and clearing it up front would erase the recorded reason when a caller
  // uses this to roll a half-applied change back.
  sets.push(`"status" = 'connected'`, `"updated_at" = ?`);
  params.push(new Date().toISOString(), id);
  await runAsyncOrSync(
    db.adapter,
    `UPDATE "${CONNECTORS_TABLE}" SET ${sets.join(', ')} WHERE "id" = ?`,
    params,
  );
}

/**
 * Stable code for "this authorization server cannot issue a client on its own". The GUI keys the
 * recovery affordance on it, so it must not drift.
 */
export const CLIENT_REGISTRATION_UNSUPPORTED = 'client_registration_unsupported';

/** The one user-facing sentence for that failure, wherever it is detected. */
export const CLIENT_REGISTRATION_MESSAGE =
  'This MCP server requires a pre-registered OAuth client. Enter the client ID (and secret, if it has one) issued by the provider.';

/**
 * Classify a raw connector failure into a stable code plus the message a member should actually
 * read. Returns null when the failure is not one of the known, actionable classes.
 *
 * This lives here — beside {@link recordSync} — so BOTH paths that can hit the failure share one
 * classification: the connect request, and a sync that fails long after connect. When only the
 * connect path knew about it, the very same failure arriving during a sync was persisted as the
 * client library's raw sentence, which names no fix and leaves the member with a dead end.
 *
 * Two shapes mean the same thing: the authorization server publishes no registration endpoint at
 * all, or it published one and rejected the registration. Both are fixed by supplying a client the
 * user registered by hand, so both map to one code. Matching the shared phrase covers them without
 * swallowing unrelated failures. The curated message re-classifies to itself so reading a
 * previously persisted error yields the same code.
 */
export function classifyConnectorFailure(raw: string): { code: string; message: string } | null {
  if (/dynamic client registration/i.test(raw) || raw === CLIENT_REGISTRATION_MESSAGE) {
    return { code: CLIENT_REGISTRATION_UNSUPPORTED, message: CLIENT_REGISTRATION_MESSAGE };
  }
  return null;
}

/**
 * `last_error` is surfaced to the member via GET /api/connectors, so a raw DB error
 * — which on a unique/PK conflict can echo the conflicting key VALUE — would leak
 * another member's data as an existence oracle. Genericize constraint/conflict
 * errors (no value), and bound everything else. The full error is still THROWN by
 * the sync so server logs keep the detail.
 *
 * A known, actionable failure is replaced by its curated message FIRST, so the member reads the
 * fix rather than the client library's wording no matter which path recorded it.
 */
export function sanitizeConnectorError(raw: string): string {
  const known = classifyConnectorFailure(raw);
  if (known) return known.message;
  if (/constraint|unique|duplicate|conflict|violat|primary key|SQLITE_/i.test(raw)) {
    return 'A record could not be written during sync (possible conflict). Try reconnecting.';
  }
  return raw.length > 500 ? raw.slice(0, 500) + '…' : raw;
}

/**
 * True when a connection never finished setting up: it recorded an error and has never completed a
 * sync, so nothing was ever ingested through it. Such a row is NOT a working connection that later
 * broke — it never worked at all, and presenting it as "connected" (or merely "error") both
 * misreads its state and, when it is used to decide which services are already wired up, hides the
 * catalog card that offers the way to finish it.
 *
 * Derived rather than stored: it is a reading of the existing lifecycle columns, so no persisted
 * state can drift out of step with it.
 */
export function isSetupIncomplete(rec: {
  status: ConnectorStatus;
  lastSyncAt: string | null;
  lastError: string | null;
}): boolean {
  if (rec.status === 'disconnected') return false;
  if (rec.lastSyncAt) return false;
  return rec.lastError != null && rec.lastError !== '';
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
      [sanitizeConnectorError(outcome.error), now, id],
    );
  }
}

/**
 * The per-member identity to key connectors on. On a cloud (Postgres) this is the
 * member's `session_user` (the scoped login role the RLS ownership model keys on),
 * so the connector's per-member partition and the row-ownership stamp agree. On
 * SQLite / non-cloud it's the caller's `fallback` (the machine-local identity).
 */
export async function resolveConnectorIdentity(db: Lattice, fallback: string): Promise<string> {
  if (db.getDialect() !== 'postgres') return fallback;
  const row = (await getAsyncOrSync(db.adapter, 'SELECT session_user AS u')) as
    | { u?: string }
    | undefined;
  return row?.u ?? fallback;
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
