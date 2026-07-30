/**
 * Connecting an external source — without a browser.
 *
 * Syncing a connected source, refreshing it, and tearing it down have been
 * library calls for a long time. CONNECTING one was not: the whole handshake
 * lived inside a request handler, so the very first step — the one that has to
 * happen before any of the others mean anything — was the one step a script, a
 * command, or a provisioning job could not take. A machine could keep a database
 * in sync forever and could not attach one.
 *
 * That is the gap this file closes. Everything here takes plain arguments and
 * returns plain values: a workspace, a connector, the credentials, who is
 * connecting. Nothing mentions a request, a response, or a status.
 *
 * WHAT STILL NEEDS A PERSON, stated plainly rather than hidden behind a call that
 * cannot work: authorizing an MCP server that uses OAuth. Somebody has to approve
 * the request on the server's own consent page, and the code that approval
 * produces is bound to that browser's session. So {@link connectSource} does not
 * pretend — it returns the URL to approve and stops, exactly as starting an
 * account sign-in does, and {@link completeMcpConnection} finishes the job once
 * the code comes back from wherever it was approved. A source that connects with
 * credentials, and an MCP server that is open or local, connect outright with no
 * browser anywhere in the story.
 *
 * FAILURES ARE TAGGED, NOT NUMBERED (see `./connector-errors.js`). The important
 * distinction this file draws is between a failure that kept nothing and a
 * failure that kept something: `setup_failed` means the connection was rolled
 * back and there is nothing to clean up, while `import_failed` means the
 * connection is still there, in an error state, with its id on the error so the
 * caller can retry it or remove it. Collapsing those two into one "it broke"
 * would be how a half-made connection goes unnoticed.
 */
import type { Lattice } from '../lattice.js';
import type { Connector, CredentialConnector, McpConnector } from '../connectors/types.js';
import { isCredentialConnector, isMcpConnector } from '../connectors/types.js';
import {
  listConnectors,
  getConnector,
  createConnector,
  getConnectorByToolkit,
  updateConnectorConnection,
} from '../connectors/registry.js';
import { syncConnector, syncStaleConnectors, collectConnectorKeys } from '../connectors/sync.js';
import type { SyncConnectorResult } from '../connectors/sync.js';
import { disconnectConnector } from '../connectors/teardown.js';
import { enableConnectorRls, secureConnectorTables } from '../connectors/acl.js';
import { ConnectorUnavailableError } from '../connectors/errors.js';
import { isPlaceholderServerName, hostnameLabelFor } from '../connectors/mcp/connector-base.js';
import { curatedLabelForServerUrl } from '../connectors/prefab/curated.js';
import { sanitizeConnectorLabel } from '../connectors/sanitize-label.js';
import { getMcpServerUrl } from '../connectors/mcp/oauth.js';
import { mcpToolkitFor } from '../connectors/mcp/schema-cache.js';
import { brandFromHost } from '../connectors/describe-connected.js';
import { DatabaseConnector } from '../connectors/db-source/connector.js';
import { connectorError } from './connector-errors.js';

// ── Connecting a source that this build serves as a connector ───────────────

/** How the caller is asking to connect: with credentials, or to an MCP server. */
export type SourceConnectRequest =
  | {
      kind: 'credential';
      /**
       * The values for the fields the connector declares. Read by key, coerced to
       * string and trimmed here, so a caller does not have to reproduce the
       * form's own normalisation to get the same result the app gets.
       */
      credentials: Record<string, unknown>;
    }
  | {
      kind: 'mcp';
      /**
       * Where the authorization should come back to. Required even for a server
       * that turns out not to need one, because whether it does is only known
       * after discovery.
       */
      redirectUri: string;
      /** The server to connect, when the toolkit has no fixed endpoint. */
      serverUrl?: string | undefined;
      /** OAuth scopes to request, when the caller has a curated set. */
      scope?: string | undefined;
      /** A pre-registered OAuth client, for a server that supports no registration. */
      clientId?: string | undefined;
      clientSecret?: string | undefined;
      /** Re-authorize an EXISTING connection rather than making another one. */
      targetConnectorId?: string | undefined;
    };

/** A source that is connected and has had its first sync. */
export interface SourceConnected {
  kind: 'connected';
  connectorId: string;
  result: SyncConnectorResult;
}

/**
 * A source that needs a person to approve it first. The URL is opened by
 * whoever has a browser; the code that comes back finishes at
 * {@link completeMcpConnection}.
 */
export interface SourceAuthorizationRequired {
  kind: 'authorize';
  redirectUrl: string;
  pendingId: string;
}

export type SourceConnectResult = SourceConnected | SourceAuthorizationRequired;

/**
 * Connect one source: validate, record it, define + secure its tables, and run
 * the first sync.
 *
 * Idempotent for a credential source — reconnecting reuses this member's
 * registry row for the toolkit and retires the credentials it replaces. An MCP
 * connect creates its OWN row per connection, so several servers sit side by
 * side, unless `targetConnectorId` names one to repoint.
 *
 * @throws a tagged {@link import('./connector-errors.js').ConnectorError} for a
 * refusal the caller can act on, and the connector's own error for anything the
 * connector itself classified.
 */
export async function connectSource(
  db: Lattice,
  connector: Connector,
  toolkit: string,
  connectedBy: string,
  request: SourceConnectRequest,
): Promise<SourceConnectResult> {
  if (request.kind === 'mcp') {
    if (!isMcpConnector(connector)) {
      throw connectorError(
        'unsupported',
        `Toolkit "${toolkit}" does not connect to an MCP server.`,
      );
    }
    return await connectMcpSource(db, connector, toolkit, connectedBy, request);
  }
  if (!isCredentialConnector(connector)) {
    throw connectorError(
      'unsupported',
      `Toolkit "${toolkit}" does not support credential connect.`,
    );
  }
  return await connectCredentialSource(db, connector, toolkit, connectedBy, request.credentials);
}

/**
 * Collect the connector's declared fields out of a raw record, and refuse before
 * anything is attempted when a required one is blank.
 *
 * Presence is checked here; whether the values are CORRECT is the source's
 * answer to give, and it gives it by refusing the connection.
 */
function readDeclaredCredentials(
  connector: CredentialConnector,
  raw: Record<string, unknown>,
): Record<string, string> {
  const creds: Record<string, string> = {};
  const missing: string[] = [];
  for (const f of connector.credentialFields()) {
    const v = typeof raw[f.key] === 'string' ? (raw[f.key] as string).trim() : '';
    creds[f.key] = v;
    if (f.required !== false && !v) missing.push(f.key);
  }
  if (missing.length > 0) {
    throw connectorError(
      'invalid_request',
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required`,
    );
  }
  return creds;
}

/** Validate credentials against the source, then record + sync the connection. */
async function connectCredentialSource(
  db: Lattice,
  connector: CredentialConnector,
  toolkit: string,
  connectedBy: string,
  raw: Record<string, unknown>,
): Promise<SourceConnected> {
  const creds = readDeclaredCredentials(connector, raw);
  let connection: { connectionId: string; displayName: string | null };
  try {
    connection = await connector.connect(creds);
  } catch (e) {
    // Bad credentials / bad input / unreachable source — the caller's to fix.
    throw connectorError('source_rejected', (e as Error).message);
  }
  const existing = await getConnectorByToolkit(db, toolkit, connectedBy);
  let connectorId: string;
  if (existing) {
    // Retire the prior connection's stored credentials before repointing.
    if (existing.connectionRef && existing.connectionRef !== connection.connectionId) {
      await connector.disconnect(existing.connectionRef);
    }
    await updateConnectorConnection(db, existing.id, connection.connectionId);
    connectorId = existing.id;
  } else {
    connectorId = await createConnector(db, {
      connector: connector.connector,
      toolkit,
      displayName: connection.displayName ?? toolkit,
      connectionRef: connection.connectionId,
      connectedBy,
    });
  }
  // Define + (owner-only) secure the connected tables before ingest, so a cloud
  // owner's rows are RLS-stamped on insert. No-op off-cloud/non-owner.
  for (const m of connector.models(toolkit)) await db.defineLate(m.table, m.definition);
  await enableConnectorRls(db, connector, toolkit);
  const result = await syncConnector(db, connector, connectorId);
  return { kind: 'connected', connectorId, result };
}

/**
 * A trimmed value, or undefined when there was nothing there.
 *
 * A blank string and an absent one mean the same thing to every caller here —
 * "not supplied" — and collapsing them once is what keeps a form that posts empty
 * fields from being read as a request to connect to the empty address.
 */
function present(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t !== undefined && t !== '' ? t : undefined;
}

/**
 * Begin — and where no person is needed, finish — connecting an MCP server.
 *
 * A reconnect is checked for ownership BEFORE discovery runs, so pointing this
 * at somebody else's row costs a lookup rather than a network round trip against
 * a server the caller has no business reaching on their behalf.
 */
async function connectMcpSource(
  db: Lattice,
  connector: McpConnector,
  toolkit: string,
  connectedBy: string,
  request: Extract<SourceConnectRequest, { kind: 'mcp' }>,
): Promise<SourceConnectResult> {
  let serverUrl = present(request.serverUrl);
  const targetConnectorId = present(request.targetConnectorId);
  if (targetConnectorId) {
    const rec = await getConnector(db, targetConnectorId);
    // Ownership AND connector-kind must match: this path may never reach an
    // external-database row, or a row of a retired kind, by id.
    if (rec?.connectedBy !== connectedBy || rec.connector !== connector.connector) {
      throw connectorError('connector_not_found', 'connector not found');
    }
    // The server URL is retained across a disconnect (it is not a secret), so a
    // reconnect need not resend it.
    if (!serverUrl && rec.connectionRef)
      serverUrl = getMcpServerUrl(rec.connectionRef) ?? undefined;
    if (!serverUrl) {
      throw connectorError(
        'source_unavailable',
        'This connector has no stored server URL — add it again.',
      );
    }
  }
  const clientId = present(request.clientId);
  const clientSecret = present(request.clientSecret);
  const scope = present(request.scope);
  const begin = await connector.beginConnect(connectedBy, toolkit, {
    redirectUri: request.redirectUri,
    ...(serverUrl ? { serverUrl } : {}),
    ...(scope ? { scope } : {}),
    ...(clientId
      ? {
          clientInfo: {
            client_id: clientId,
            ...(clientSecret ? { client_secret: clientSecret } : {}),
          },
        }
      : {}),
    ...(targetConnectorId ? { targetConnectorId } : {}),
  });
  if (begin.kind === 'redirect') {
    return { kind: 'authorize', redirectUrl: begin.redirectUrl, pendingId: begin.pendingId };
  }
  const out = await completeMcpConnection(db, connector, {
    connectionId: begin.connectionId,
    connectedBy,
    // A curated label for a known endpoint outranks whatever the server called
    // itself, and a host-derived label backs both up.
    displayName:
      curatedLabelForServerUrl(serverUrl) ?? begin.displayName ?? hostnameLabelFor(serverUrl),
    ...(targetConnectorId ? { targetConnectorId } : {}),
  });
  return { kind: 'connected', ...out };
}

/**
 * A server's self-reported name, or null when it is absent or one of the generic
 * placeholders several services of one vendor all answer with. Sanitized because
 * it is attacker-controlled text that becomes a stored label.
 */
export function namedMcpServer(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const name = sanitizeConnectorLabel(raw);
  return name !== '' && !isPlaceholderServerName(name) ? name : null;
}

/**
 * The display name a finished MCP connect should store, best first.
 *
 * A placeholder must not win: several services of one vendor report the SAME
 * name, so taking it renders every one of them under one identical, useless
 * title.
 */
export function mcpConnectionLabel(input: {
  serverUrl?: string | undefined;
  serverName?: string | null | undefined;
  displayName?: string | null | undefined;
}): string | null {
  return (
    curatedLabelForServerUrl(input.serverUrl) ??
    namedMcpServer(input.serverName) ??
    input.displayName ??
    hostnameLabelFor(input.serverUrl)
  );
}

/** What finishing an MCP connect needs to know. */
export interface CompleteMcpConnectionInput {
  /** The connection the authorization produced. */
  connectionId: string;
  /** Identity that owns the connection (member role / user id). */
  connectedBy: string;
  /** The label to store, or null to fall back to the server brand. */
  displayName: string | null;
  /** Repoint an EXISTING row instead of creating one (a reconnect). */
  targetConnectorId?: string | undefined;
}

/**
 * Record an established MCP connection, define + secure its connected tables,
 * and run the initial sync.
 *
 * Shared by the direct connect path (an open or local server) and the end of an
 * OAuth round trip, so a connection made either way is indistinguishable
 * afterwards. Every NEW connect creates its own registry row — several MCP
 * servers sit side by side. A reconnect repoints the existing row instead, after
 * an ownership check, retiring the old connection's secrets.
 */
export async function completeMcpConnection(
  db: Lattice,
  connector: McpConnector,
  input: CompleteMcpConnectionInput,
): Promise<{ connectorId: string; result: SyncConnectorResult }> {
  const { connectionId, connectedBy, displayName, targetConnectorId } = input;
  // MCP is modeled PER CONNECTION (like an external database): the toolkit carries the
  // connection id, so each server groups under its own schema header + gets its own typed tables.
  const toolkit = mcpToolkitFor(connectionId);
  // The server brand (from its host) names the tables + the sidebar group.
  let host: string | null = null;
  try {
    host = new URL(getMcpServerUrl(connectionId) ?? '').hostname || null;
  } catch {
    /* stdio / no stored URL */
  }
  const brand = brandFromHost(host);
  // Introspect the server into a typed schema descriptor — one table per record kind. Best-effort:
  // on failure the connection still works via the flat fallback table (models() returns it when no
  // descriptor exists).
  if (connector.introspect) {
    try {
      await connector.introspect(
        connectionId,
        toolkit,
        brand ?? displayName ?? connector.connector,
      );
    } catch (e) {
      console.warn(
        `[connectors] MCP introspection failed for ${connectionId} (flat fallback): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  let connectorId: string;
  if (targetConnectorId) {
    const existing = await getConnector(db, targetConnectorId);
    // Ownership AND kind must match — a member may only repoint their own row,
    // and only a row of THIS connector kind (never an external database or a
    // retired row reached by id through the MCP path).
    if (existing?.connectedBy !== connectedBy || existing.connector !== connector.connector) {
      throw new ConnectorUnavailableError('Connector not found — it may have been removed.');
    }
    if (existing.connectionRef && existing.connectionRef !== connectionId) {
      // The old connection is fully superseded (the new connectionId carries its
      // own stored URL), so PURGE it — a plain disconnect would leave the old
      // connection's server-URL key orphaned with nothing referencing it.
      await (connector.purgeConnection?.(existing.connectionRef) ??
        connector.disconnect(existing.connectionRef));
    }
    // Re-key the toolkit to the new connection (its typed tables live under the new connection id),
    // and re-stamp the label this connect resolved. A row created before the connection ever
    // authenticated can be carrying the generic name its server reported; without this it would
    // keep that useless title forever, even once the connection finally works.
    await updateConnectorConnection(
      db,
      existing.id,
      connectionId,
      toolkit,
      displayName ?? brand ?? undefined,
    );
    connectorId = existing.id;
  } else {
    connectorId = await createConnector(db, {
      connector: connector.connector,
      toolkit,
      displayName: displayName ?? brand ?? connector.connector,
      connectionRef: connectionId,
      connectedBy,
    });
  }
  for (const m of connector.models(toolkit)) await db.defineLate(m.table, m.definition);
  await enableConnectorRls(db, connector, toolkit);
  const result = await syncConnector(db, connector, connectorId);
  return { connectorId, result };
}

// ── Bringing every connected source up to date ──────────────────────────────

/** The pre-typed-tables MCP toolkit, and the one table every kind landed in. */
const LEGACY_MCP_TOOLKIT = 'mcp';
const LEGACY_MCP_TABLE = 'mcp_items';

/**
 * Migrate a LEGACY flat MCP connection to typed per-kind tables: introspect the
 * server, re-key the row's toolkit to the per-connection form, register the typed
 * tables, and force a sync to populate them.
 *
 * Idempotent + best-effort — returns false (leaving the flat connection
 * untouched) if the connector cannot introspect or the server exposes nothing
 * modelable. Belongs to the refresh pass rather than to opening a workspace, so
 * its network introspection never blocks an open. Once migrated, reopening
 * re-registers the typed tables with no network.
 */
export async function migrateLegacyMcpConnection(
  db: Lattice,
  connector: McpConnector,
  row: { id: string; connectionRef: string | null; displayName: string | null },
): Promise<boolean> {
  const connectionId = row.connectionRef;
  if (!connectionId || !connector.introspect) return false;
  const toolkit = mcpToolkitFor(connectionId);
  let host: string | null = null;
  try {
    host = new URL(getMcpServerUrl(connectionId) ?? '').hostname || null;
  } catch {
    /* stdio / no stored URL */
  }
  const brand = brandFromHost(host);
  const descriptor = await connector.introspect(
    connectionId,
    toolkit,
    brand ?? row.displayName ?? connector.connector,
  );
  if (!descriptor) return false; // nothing modelable → keep the flat fallback
  // The re-key must happen BEFORE the sync (which reads the toolkit off the row to pick the typed
  // models). But the re-key is the only step the retry gate keys on (it re-selects the flat
  // toolkit), so if any later step fails after re-keying, roll the toolkit back — otherwise the row
  // is left typed-but-empty with its data stranded in the flat table and the migration never
  // retries. Better a retriable flat connection than a silent half-migration.
  await updateConnectorConnection(db, row.id, connectionId, toolkit);
  try {
    for (const m of connector.models(toolkit)) await db.defineLate(m.table, m.definition);
    await enableConnectorRls(db, connector, toolkit);
    await syncConnector(db, connector, row.id); // force-populate the typed tables now
    // Retire the pre-migration flat rows for this connection: their data now lives in the typed
    // tables, so leaving them would double the data live, inflate the item count, and survive a
    // later disconnect (which tears down only the current toolkit's typed tables). Soft-delete
    // (never hard) so they stay recoverable and drop out of context/search/counts. Skip cleanly
    // when there is no flat table; a real database error propagates to the rollback.
    if (db.getRegisteredTableNames().includes(LEGACY_MCP_TABLE)) {
      const now = new Date().toISOString();
      const staleKeys = await collectConnectorKeys(db, LEGACY_MCP_TABLE, 'item_id', row.id);
      for (const key of staleKeys) await db.update(LEGACY_MCP_TABLE, key, { deleted_at: now });
    }
  } catch (e) {
    // Roll the re-key back so the ENTIRE migration retries on the next pass (idempotently:
    // introspect re-sets the descriptor, the sync upserts). The caller logs the failure — and with
    // the row back on the flat toolkit, its "flat fallback kept" message is now accurate.
    await updateConnectorConnection(db, row.id, connectionId, LEGACY_MCP_TOOLKIT);
    throw e;
  }
  return true;
}

/** How many sources a refresh pass brought up to date, and how many refused. */
export interface StaleRefreshResult {
  synced: number;
  failed: number;
}

/**
 * Bring every stale source this member owns up to date, repairing any that
 * predate the current table layout first.
 *
 * This is the whole pass, not the sync inside it, and the difference matters: a
 * caller that only synced would leave a legacy connection stranded on its old
 * layout forever, and would skip securing tables that a member's session created
 * on a shared database. Both are one-time repairs that only ever ran because a
 * browser happened to load a page.
 *
 * Fault-isolated per connection: a slow or unreachable server is reported and
 * stepped over, never allowed to fail the pass for everything else.
 */
export async function refreshStaleSources(
  db: Lattice,
  connectors: Connector[],
  connectedBy: string,
): Promise<StaleRefreshResult> {
  let synced = 0;
  let failed = 0;
  const mcpImpl = connectors.find((c) => c.toolkits().includes(LEGACY_MCP_TOOLKIT));
  if (mcpImpl && isMcpConnector(mcpImpl)) {
    const legacy = (await listConnectors(db, connectedBy)).filter(
      (c) =>
        c.connector === LEGACY_MCP_TOOLKIT &&
        c.toolkit === LEGACY_MCP_TOOLKIT &&
        c.status !== 'disconnected',
    );
    for (const row of legacy) {
      try {
        await migrateLegacyMcpConnection(db, mcpImpl, row);
      } catch (e) {
        console.warn(
          `[connectors] MCP typed-table migration failed for ${row.id} (flat fallback kept): ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
  }
  for (const connector of connectors) {
    // Owner-only no-op: ensure connected tables created in any member's session
    // are secured on a shared database (the owner auto-secures on open).
    await secureConnectorTables(db, connector);
    // Scope to THIS member — never sync another member's connectors as ourselves.
    const r = await syncStaleConnectors(db, connector, undefined, connectedBy);
    synced += r.synced.length;
    failed += r.failed.length;
  }
  return { synced, failed };
}

// ── External databases ──────────────────────────────────────────────────────

/** What connecting an external database needs to know. */
export interface DatabaseSourceInput {
  /**
   * Host, port, database, user, password — and optionally `schema`. Read by key
   * and trimmed, so a caller passes the same shape the form submits.
   */
  credentials: Record<string, unknown>;
  /** Identity that owns the connection (member role / user id). */
  connectedBy: string;
  /** Rendered-context output dir, so a rolled-back setup can prune what it made. */
  outputDir: string;
  /** Substitute connector — a test seam, or a dialect variant. */
  connector?: DatabaseConnector | undefined;
}

/** A connected external database and what its first import brought in. */
export interface DatabaseSourceConnected {
  connectorId: string;
  displayName: string | null;
  result: SyncConnectorResult;
}

/** The declared database fields out of a raw record, plus an explicit schema. */
function readDatabaseCredentials(
  connector: DatabaseConnector,
  raw: Record<string, unknown>,
): Record<string, string> {
  const creds: Record<string, string> = {};
  for (const f of connector.credentialFields()) {
    const v = raw[f.key];
    creds[f.key] = typeof v === 'string' ? v.trim() : '';
  }
  const schemaVal = raw.schema;
  if (typeof schemaVal === 'string' && schemaVal.trim()) creds.schema = schemaVal.trim();
  return creds;
}

/**
 * Connect a new external database: validate, introspect, register, import.
 *
 * An external database is its OWN connection with its own table set, so every
 * connect CREATES a registry row — several databases coexist and none of them
 * upserts over another.
 *
 * The two failure halves are deliberately not symmetrical, and this is the whole
 * reason the function is written the way it is:
 *
 *   SETUP (before any row lands) rolls the connection back completely — registry
 *   row, credentials, descriptor — because a failure there means nothing was ever
 *   imported and a half-made entry would sit in the list forever pointing at
 *   nothing. A rollback that itself fails is appended to the error, never
 *   swallowed.
 *
 *   IMPORT (after rows are committing) KEEPS everything. An all-or-nothing
 *   rollback here is the "data imports and then silently vanishes" failure: a
 *   late step throwing after thousands of rows are committed would wipe every one
 *   of them, along with the only trace of what went wrong. The connection stays,
 *   already stamped with its error by the sync, and the caller is told its id so
 *   it can be retried or removed.
 */
export async function connectDatabaseSource(
  db: Lattice,
  input: DatabaseSourceInput,
): Promise<DatabaseSourceConnected> {
  const connector = input.connector ?? new DatabaseConnector();
  const creds = readDatabaseCredentials(connector, input.credentials);

  let connection: { connectionId: string; displayName: string | null };
  try {
    connection = await connector.connect(creds);
  } catch (e) {
    // Bad credentials / unreachable / unsupported dialect / no tables.
    throw connectorError('source_rejected', (e as Error).message);
  }
  const toolkit = `db_source:${connection.connectionId}`;
  const connectorId = await createConnector(db, {
    connector: 'db_source',
    toolkit,
    displayName: connection.displayName ?? 'Database',
    connectionRef: connection.connectionId,
    connectedBy: input.connectedBy,
  });

  try {
    for (const m of connector.models(toolkit)) await db.defineLate(m.table, m.definition);
    await enableConnectorRls(db, connector, toolkit);
  } catch (e) {
    let rollbackNote = '';
    try {
      await disconnectConnector(db, connector, connectorId, {
        outputDir: input.outputDir,
        mode: 'hard',
      });
    } catch (re) {
      rollbackNote = ` (cleanup also failed: ${(re as Error).message} — remove the connection manually)`;
    }
    throw connectorError(
      e instanceof ConnectorUnavailableError ? 'source_unavailable' : 'setup_failed',
      `Connection setup failed: ${(e as Error).message}${rollbackNote}`,
    );
  }

  try {
    const result = await syncConnector(db, connector, connectorId);
    return { connectorId, displayName: connection.displayName, result };
  } catch (e) {
    // Log the raw error first: the registry's stored error is sanitized, so this
    // is the only full-fidelity trace of what the import actually hit.
    console.error(`[latticesql] db-source import failed for connection ${connectorId}:`, e);
    throw connectorError(
      e instanceof ConnectorUnavailableError ? 'source_unavailable' : 'import_failed',
      `Import failed: ${(e as Error).message} — the connection is kept with this error; use Refresh to retry.`,
      connectorId,
    );
  }
}

/** What re-pointing an existing external database needs to know. */
export interface DatabaseSourceReconnectInput extends DatabaseSourceInput {
  /** The connection being edited. Must belong to `connectedBy`. */
  connectorId: string;
}

/**
 * Edit an existing external database's stored credentials — a rotated password, a
 * corrected host or port — and re-sync it.
 *
 * Reuses the same connection id and table prefix, so the imported objects stay
 * put and rows upsert idempotently onto them: an edit re-points the same
 * database, it does not fork a second copy of it. A successful re-sync also
 * clears the error state, so fixing a broken connection makes it well again in
 * one step.
 */
export async function reconnectDatabaseSource(
  db: Lattice,
  input: DatabaseSourceReconnectInput,
): Promise<DatabaseSourceConnected> {
  const connector = input.connector ?? new DatabaseConnector();
  const rec = await getConnector(db, input.connectorId);
  // Ownership AND kind must match — a caller-supplied id must be this member's,
  // and must be an external database rather than any other connected source.
  if (rec?.connector !== 'db_source' || rec.connectedBy !== input.connectedBy) {
    throw connectorError('connector_not_found', 'Database connection not found');
  }
  if (!rec.connectionRef) {
    throw connectorError('invalid_request', 'This connection cannot be edited.');
  }
  const creds = readDatabaseCredentials(connector, input.credentials);

  let connection: { connectionId: string; displayName: string | null };
  try {
    connection = await connector.reconnect(rec.connectionRef, creds);
  } catch (e) {
    // Bad credentials / unreachable → the caller's to fix; the old connection is
    // left intact, because the stored credentials are only overwritten on success.
    throw connectorError('source_rejected', (e as Error).message);
  }
  // Register any tables the re-introspection ADDED (existing ones no-op) and
  // re-apply access control, mirroring the connect path's setup phase.
  try {
    const toolkit = `db_source:${rec.connectionRef}`;
    for (const m of connector.models(toolkit)) await db.defineLate(m.table, m.definition);
    await enableConnectorRls(db, connector, toolkit);
  } catch (e) {
    throw connectorError(
      e instanceof ConnectorUnavailableError ? 'source_unavailable' : 'setup_failed',
      `Reconnect setup failed: ${(e as Error).message}`,
    );
  }
  try {
    const result = await syncConnector(db, connector, input.connectorId);
    return {
      connectorId: input.connectorId,
      displayName: connection.displayName ?? rec.displayName,
      result,
    };
  } catch (e) {
    throw connectorError(
      e instanceof ConnectorUnavailableError ? 'source_unavailable' : 'import_failed',
      (e as Error).message,
      input.connectorId,
    );
  }
}
