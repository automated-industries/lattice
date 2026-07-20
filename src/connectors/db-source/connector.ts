/**
 * The external-database connector — a {@link CredentialConnector} that connects to
 * an external Postgres-family database (AWS RDS Postgres, Supabase, generic
 * Postgres) the user supplies via host/user/password fields (read-only by
 * contract — see external-pool.ts; raw connection strings are not accepted), and
 * IMPORTS its tables into Lattice as connected data types (so they land in the
 * SOURCE·INPUTS tier and sync via the shared connector sync engine).
 *
 * Unlike single-connection connectors (Jira/Trello), each external DB is its own
 * connection with its own table set, so the toolkit string is per-connection
 * (`db_source:<connectionId>`) and the dedicated `/api/db-sources` route creates a
 * new registry row per connection. The credentials (connection string) + the
 * introspected schema descriptor are persisted in the machine-local encrypted
 * store — never in the registry, responses, or logs.
 */

import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  getAssistantCredential,
  setAssistantCredential,
  deleteAssistantCredential,
} from '../../framework/user-config.js';
import type {
  CredentialConnector,
  CredentialField,
  ConnectedModelDef,
  ExternalRecord,
  AuthorizeResult,
  ConnectionResult,
  ListChangesContext,
  ToolkitPresentation,
} from '../types.js';
import { ConnectorUnavailableError } from '../errors.js';
import { dialectFor, type SqlDialect } from './dialects.js';
import { openExternalPool, withExternalPool, type ExternalPool } from './external-pool.js';
import { DB_SOURCE_ICON } from './icon.js';
import {
  getSchemaDescriptor,
  setSchemaDescriptor,
  clearSchemaDescriptor,
  buildModelDefs,
  naturalKeyFor,
  slugify,
  type DbSchemaDescriptor,
  type DbTableDesc,
} from './schema-cache.js';

/** Page size for every external-table import page. */
const PAGE_SIZE = 500;
/** Hard cap on pages per table — a backstop against an unbounded import loop. */
const MAX_PAGES = 1000;

const TOOLKIT_PREFIX = 'db_source:';
const credKind = (connectionId: string): string => `db_source_creds:${connectionId}`;

/** Read the stored connection string for a connection, or null. */
export function getDbSourceCreds(connectionId: string): string | null {
  return getAssistantCredential(credKind(connectionId));
}
/** Persist the connection string (machine-local, encrypted). */
export function setDbSourceCreds(connectionId: string, connectionString: string): void {
  setAssistantCredential(credKind(connectionId), connectionString);
}
/** Remove the stored connection string. */
export function clearDbSourceCreds(connectionId: string): void {
  deleteAssistantCredential(credKind(connectionId));
}

/**
 * The NON-SECRET connection parts (host/port/user/database/schema) for an
 * existing connection, parsed from the stored connection string + cached schema
 * — for pre-filling the edit form. The password is NEVER returned (Lattice does
 * not display stored secrets). Returns null when the connection has no stored
 * credentials.
 */
export function describeDbSourceConnection(connectionId: string): {
  host: string;
  port: string;
  user: string;
  database: string;
  schema: string;
} | null {
  const cs = getDbSourceCreds(connectionId);
  if (!cs) return null;
  let host = '';
  let port = '';
  let user = '';
  let database = '';
  try {
    const u = new URL(cs);
    host = u.hostname;
    port = u.port;
    user = u.username ? decodeURIComponent(u.username) : '';
    const path = u.pathname.replace(/^\//, '');
    database = path ? decodeURIComponent(path) : '';
  } catch {
    /* leave the parts blank when the stored string can't be parsed */
  }
  const schema = getSchemaDescriptor(connectionId)?.schema ?? 'public';
  return { host, port, user, database, schema };
}

/** The connection id embedded in a `db_source:<id>` toolkit, or '' if malformed. */
function connectionIdFromToolkit(toolkit: string): string {
  return toolkit.startsWith(TOOLKIT_PREFIX) ? toolkit.slice(TOOLKIT_PREFIX.length) : '';
}

/**
 * Assemble a Postgres connection string from host + user + database (+ optional
 * port/password). Raw connection strings are deliberately NOT accepted: pasting a
 * full URL invites reusing an owner/admin connection wholesale, and the read-only
 * data-source contract wants the credentials entered deliberately (ideally a
 * read-only database user). Throws loudly when incomplete — never a silent default.
 */
export function assembleConnectionString(creds: Record<string, string>): string {
  const host = (creds.host ?? '').trim();
  const user = (creds.user ?? '').trim();
  const database = (creds.database ?? '').trim();
  const password = (creds.password ?? '').trim();
  const port = (creds.port ?? '').trim() || '5432';
  if (host.includes('://')) {
    throw new ConnectorUnavailableError(
      'Enter the host name only (e.g. db.example.com) — connection strings are not accepted.',
    );
  }
  if (host && user && database) {
    const auth = password
      ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
      : encodeURIComponent(user);
    return `postgres://${auth}@${host}:${port}/${encodeURIComponent(database)}`;
  }
  throw new ConnectorUnavailableError(
    'Provide host + user + database (port and password optional).',
  );
}

/**
 * Recover the password from a stored `postgres://user:pass@host/db` string, so an
 * edit that leaves the password field blank can keep the current one (Lattice
 * never displays the stored password, so re-typing it just to fix a host is
 * hostile). Returns '' when the string has no password or can't be parsed.
 */
function passwordFromConnectionString(cs: string): string {
  try {
    const u = new URL(cs);
    return u.password ? decodeURIComponent(u.password) : '';
  } catch {
    return '';
  }
}

/** Coerce a raw external value to the imported column's Lattice spec. */
function coerce(v: unknown, spec: 'TEXT' | 'INTEGER' | 'REAL'): unknown {
  if (v === null || v === undefined) return null;
  if (spec === 'INTEGER') {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return Math.trunc(v);
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  if (spec === 'REAL') {
    if (typeof v === 'number') return v;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  // TEXT — strings pass through; Dates → ISO; objects/arrays → JSON; else String.
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v as number | boolean | bigint);
}

/** Stringify a key value (PK / synthesized key part) safely. */
function keyStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v as string | number | boolean | bigint);
}

/** Introspect a schema into a descriptor (all tables selected). */
async function introspectSchema(
  pool: ExternalPool,
  dialect: SqlDialect,
  schema: string,
  prefix: string,
): Promise<DbSchemaDescriptor> {
  const tablesQ = dialect.tablesSql(schema);
  const tableRows = (await pool.query(tablesQ.sql, tablesQ.params)).rows as { name: string }[];
  const colsQ = dialect.columnsSql(schema);
  const colRows = (await pool.query(colsQ.sql, colsQ.params)).rows as {
    table: string;
    name: string;
    type: string;
  }[];
  const pkQ = dialect.primaryKeysSql(schema);
  const pkRows = (await pool.query(pkQ.sql, pkQ.params)).rows as { table: string; col: string }[];
  const fkQ = dialect.foreignKeysSql(schema);
  const fkRows = (await pool.query(fkQ.sql, fkQ.params)).rows as {
    cname: string;
    table: string;
    col: string;
    ref_table: string;
    ref_col: string;
  }[];

  const colsByTable = new Map<string, { name: string; sqlSpec: 'TEXT' | 'INTEGER' | 'REAL' }[]>();
  for (const r of colRows) {
    const arr = colsByTable.get(r.table) ?? [];
    arr.push({ name: r.name, sqlSpec: dialect.mapType(r.type) });
    colsByTable.set(r.table, arr);
  }
  const pkByTable = new Map<string, string[]>();
  for (const r of pkRows) {
    const arr = pkByTable.get(r.table) ?? [];
    arr.push(r.col);
    pkByTable.set(r.table, arr);
  }
  // Group FK rows by constraint and keep SINGLE-COLUMN constraints only — a
  // composite FK (or the cross-product a composite produces through the
  // information_schema join) has >1 rows and can't map onto one graph edge.
  const fksByConstraint = new Map<string, typeof fkRows>();
  for (const r of fkRows) {
    const arr = fksByConstraint.get(r.cname) ?? [];
    arr.push(r);
    fksByConstraint.set(r.cname, arr);
  }
  const fksByTable = new Map<string, { column: string; refTable: string; refColumn: string }[]>();
  for (const rows of fksByConstraint.values()) {
    const [only] = rows;
    if (rows.length !== 1 || !only) continue;
    const arr = fksByTable.get(only.table) ?? [];
    arr.push({ column: only.col, refTable: only.ref_table, refColumn: only.ref_col });
    fksByTable.set(only.table, arr);
  }
  const tables: DbTableDesc[] = tableRows
    .map((t) => {
      const fks = fksByTable.get(t.name);
      return {
        name: t.name,
        columns: colsByTable.get(t.name) ?? [],
        pk: pkByTable.get(t.name) ?? [],
        selected: true,
        ...(fks ? { fks } : {}),
      };
    })
    .filter((t) => t.columns.length > 0);
  return { dialect: dialect.id, schema, prefix, tables };
}

export class DatabaseConnector implements CredentialConnector {
  readonly connector = 'db_source';

  /** @param credsLoader test seam — resolve a connection id to its connection string. */
  constructor(
    private readonly credsLoader: (connectionId: string) => string | null = getDbSourceCreds,
  ) {}

  // db-sources are surfaced per-connection through the dedicated Inputs > Databases
  // UI, NOT as a single tile in the generic Connectors grid — so the catalog
  // enumeration is empty. Per-connection toolkits are resolved from the registry
  // by the route.
  toolkits(): string[] {
    return [];
  }

  models(toolkit: string): ConnectedModelDef[] {
    const id = connectionIdFromToolkit(toolkit);
    if (!id) return [];
    const descriptor = getSchemaDescriptor(id);
    return descriptor ? buildModelDefs(id, descriptor) : [];
  }

  presentation(_toolkit: string): ToolkitPresentation {
    return { label: 'Database', icon: DB_SOURCE_ICON };
  }

  credentialFields(): CredentialField[] {
    // Host/port/user/password/database ONLY — no raw connection-string field.
    // The connection is read-only by contract (see external-pool.ts); entering
    // the parts deliberately nudges toward a dedicated read-only DB user rather
    // than pasting an owner/admin URL.
    return [
      { key: 'host', label: 'Host', type: 'text', required: true },
      { key: 'port', label: 'Port', type: 'text', placeholder: '5432', required: false },
      { key: 'database', label: 'Database', type: 'text', required: true },
      { key: 'user', label: 'User', type: 'text', required: true },
      { key: 'password', label: 'Password', type: 'password', required: false },
    ];
  }

  helpUrl(): string | undefined {
    return undefined;
  }

  authorize(_userId: string, _toolkit: string): Promise<AuthorizeResult> {
    return Promise.reject(
      new Error('Databases connect with a connection string or host/user/password — not OAuth.'),
    );
  }
  completeAuth(_userId: string, _toolkit: string): Promise<ConnectionResult> {
    return Promise.reject(new Error('Databases have no OAuth step to complete.'));
  }

  /**
   * Validate the credentials against the external DB (`SELECT 1`), introspect its
   * schema, and persist both the connection string + schema descriptor encrypted
   * under a fresh connection id. Returns the id (recorded in the registry by the
   * caller) and the database name as the display name.
   */
  async connect(creds: Record<string, string>): Promise<{
    connectionId: string;
    displayName: string | null;
  }> {
    const connectionString = assembleConnectionString(creds);
    const dialect = dialectFor(connectionString);
    const schema = (creds.schema ?? '').trim() || 'public';
    const connectionId = uuidv4();

    let dbName = (creds.database ?? '').trim();
    const descriptor = await withExternalPool(connectionString, async (pool) => {
      try {
        await pool.query('SELECT 1');
      } catch (e) {
        // Surface the cause without ever echoing the password.
        throw new Error(
          `Could not connect to the database: ${(e as Error).message}. ` +
            'Check the connection details and that the database accepts connections.',
        );
      }
      if (!dbName) {
        try {
          const r = await pool.query('SELECT current_database() AS db');
          const db = r.rows[0]?.db;
          dbName = typeof db === 'string' && db ? db : 'database';
        } catch {
          dbName = 'database';
        }
      }
      // The imported-table prefix is the database name + a short connection-id
      // suffix. The name alone COLLIDES across providers that share a default
      // database name (every Supabase project is "postgres"): two different
      // connections would then import into the SAME db_<prefix>_* tables and
      // cross-contaminate each other's rows. The suffix keeps names readable
      // while guaranteeing per-connection isolation.
      const prefix = `${slugify(dbName).slice(0, 24)}_${connectionId.slice(0, 4)}`;
      return introspectSchema(pool, dialect, schema, prefix);
    });

    if (!descriptor.tables.length) {
      throw new Error(`Connected, but found no tables in schema "${schema}".`);
    }
    setDbSourceCreds(connectionId, connectionString);
    setSchemaDescriptor(connectionId, descriptor);
    return { connectionId, displayName: dbName };
  }

  /**
   * Re-authenticate an EXISTING connection with edited credentials (e.g. a rotated
   * password or a corrected host/port). Unlike {@link connect}, this reuses the
   * connection id AND the descriptor's original table prefix, so the imported
   * tables keep their physical names and rows upsert idempotently onto the same
   * objects — an edit re-points the same database, it does not fork a new table
   * set. Validates against the DB, re-introspects (picking up any newly-added
   * tables), and overwrites the stored connection string + schema descriptor.
   */
  async reconnect(
    connectionId: string,
    creds: Record<string, string>,
  ): Promise<{ connectionId: string; displayName: string | null }> {
    const existing = getSchemaDescriptor(connectionId);
    if (!existing) {
      throw new Error(
        'This connection has no cached schema to update — disconnect it and add the database again.',
      );
    }
    // "Leave the password blank to keep the current one": recover it from the
    // stored connection string when the edit omits it, so fixing a host/port/user
    // doesn't force re-typing a password Lattice never displays.
    const merged: Record<string, string> = { ...creds };
    if (!(merged.password ?? '').trim()) {
      const prior = this.credsLoader(connectionId);
      const priorPass = prior ? passwordFromConnectionString(prior) : '';
      if (priorPass) merged.password = priorPass;
    }
    const connectionString = assembleConnectionString(merged);
    const dialect = dialectFor(connectionString);
    // Keep the original schema unless the edit explicitly overrides it.
    const schema = (merged.schema ?? '').trim() || existing.schema || 'public';
    // Reuse the original prefix — the physical table names must not move.
    const prefix = existing.prefix;
    let dbName = (merged.database ?? '').trim();
    const descriptor = await withExternalPool(connectionString, async (pool) => {
      try {
        await pool.query('SELECT 1');
      } catch (e) {
        throw new Error(
          `Could not connect to the database: ${(e as Error).message}. ` +
            'Check the connection details and that the database accepts connections.',
        );
      }
      if (!dbName) {
        try {
          const r = await pool.query('SELECT current_database() AS db');
          const db = r.rows[0]?.db;
          dbName = typeof db === 'string' && db ? db : 'database';
        } catch {
          dbName = 'database';
        }
      }
      return introspectSchema(pool, dialect, schema, prefix);
    });
    if (!descriptor.tables.length) {
      throw new Error(`Connected, but found no tables in schema "${schema}".`);
    }
    setDbSourceCreds(connectionId, connectionString);
    setSchemaDescriptor(connectionId, descriptor);
    return { connectionId, displayName: dbName };
  }

  async *listChanges(
    toolkit: string,
    model: string,
    ctx: ListChangesContext,
  ): AsyncIterable<ExternalRecord> {
    const id = connectionIdFromToolkit(toolkit) || ctx.connectionId;
    const descriptor = getSchemaDescriptor(id);
    if (!descriptor) {
      throw new ConnectorUnavailableError(`No schema for database connection "${id}" — reconnect.`);
    }
    const t = descriptor.tables.find((x) => x.name === model);
    if (!t?.selected) return;

    const connectionString = this.credsLoader(ctx.connectionId);
    if (!connectionString) {
      throw new ConnectorUnavailableError(
        `No stored credentials for connection "${ctx.connectionId}" — reconnect the database.`,
      );
    }
    const dialect = dialectFor(connectionString);
    const { key: naturalKey, synthesized } = naturalKeyFor(t);
    const projected = t.columns.map((c) => c.name);
    const specByCol = new Map(t.columns.map((c) => [c.name, c.sqlSpec] as const));
    // Keyset-paginate only on a single-column PK; composite/keyless tables use
    // offset pagination.
    const [firstPk] = t.pk;
    const keyCol = t.pk.length === 1 && firstPk !== undefined ? firstPk : null;

    const mapRow = (r: Record<string, unknown>): ExternalRecord => {
      const row: Record<string, unknown> = {};
      for (const c of t.columns) row[c.name] = coerce(r[c.name], specByCol.get(c.name) ?? 'TEXT');
      let recId: string;
      if (synthesized) {
        // Composite PK → a JSON array of the key parts. MUST be sanitizer-safe:
        // the previous '\\x01' joiner was a control char that sanitizeRow STRIPS
        // at storage time, so the stored _pk never matched the in-memory seen-key
        // and pruneVanished_ soft-deleted every composite-PK row on the very sync
        // that imported it. JSON is also collision-safe (a separator appearing
        // inside a key value can't produce an ambiguous joined string).
        recId =
          t.pk.length > 1
            ? JSON.stringify(t.pk.map((k) => keyStr(r[k])))
            : createHash('sha1').update(JSON.stringify(row)).digest('hex');
        row._pk = recId;
      } else {
        recId = keyStr(r[naturalKey]);
      }
      return { id: recId, row };
    };

    const { pool, close } = openExternalPool(connectionString);
    try {
      if (keyCol) {
        let afterKey: unknown;
        for (let page = 0; page < MAX_PAGES; page++) {
          const q = dialect.pageSql({
            schema: descriptor.schema,
            table: t.name,
            columns: projected,
            keyCol,
            afterKey,
            offset: 0,
            limit: PAGE_SIZE,
          });
          const rows = (await pool.query(q.sql, q.params)).rows;
          for (const r of rows) yield mapRow(r);
          if (rows.length < PAGE_SIZE) return;
          afterKey = rows[rows.length - 1]?.[keyCol];
        }
      } else {
        for (let page = 0; page < MAX_PAGES; page++) {
          const q = dialect.pageSql({
            schema: descriptor.schema,
            table: t.name,
            columns: projected,
            keyCol: null,
            offset: page * PAGE_SIZE,
            limit: PAGE_SIZE,
          });
          const rows = (await pool.query(q.sql, q.params)).rows;
          for (const r of rows) yield mapRow(r);
          if (rows.length < PAGE_SIZE) return;
        }
      }
      throw new Error(
        `Database import for "${t.name}" exceeded ${String(MAX_PAGES)} pages — aborting to avoid an unbounded loop.`,
      );
    } finally {
      await close();
    }
  }

  async disconnect(connectionId: string): Promise<void> {
    clearDbSourceCreds(connectionId);
    clearSchemaDescriptor(connectionId);
    return Promise.resolve();
  }
}
