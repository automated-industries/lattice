import type { Row } from '../types.js';

/**
 * Adapter dialect identifier. Used by callers that need to issue
 * dialect-specific SQL (e.g. the migration runner's `pg_xact_advisory_lock`
 * on Postgres). Lattice itself uses this only for cross-dialect concerns
 * the dialect-translation layer can't paper over — most application code
 * should never need to branch on it.
 */
export type AdapterDialect = 'sqlite' | 'postgres';

/** Pluggable storage backend interface */
export interface StorageAdapter {
  /** Adapter dialect. Drives the few cross-dialect branches in lattice core. */
  readonly dialect: AdapterDialect;
  /** Execute a statement with no return value */
  run(sql: string, params?: unknown[]): void;
  /** Execute a statement and return one row or undefined */
  get(sql: string, params?: unknown[]): Row | undefined;
  /** Execute a statement and return all rows */
  all(sql: string, params?: unknown[]): Row[];
  /** Prepare and cache a statement for repeated execution */
  prepare(sql: string): PreparedStatement;
  /** Open the connection */
  open(): void;
  /** Close the connection */
  close(): void;
  /**
   * Return the column names of a table. Used by the schema layer to detect
   * missing columns and to drive entity-context queries. Implementations
   * dispatch on their own dialect (SQLite uses `PRAGMA table_info`, Postgres
   * uses `information_schema.columns`).
   */
  introspectColumns(table: string): string[];
  /**
   * Add a column to an existing table. Implementations handle dialect quirks:
   * SQLite cannot use non-constant defaults in `ALTER TABLE ADD COLUMN` and
   * must backfill them; Postgres handles `DEFAULT NOW()`/`DEFAULT random()`
   * natively.
   */
  addColumn(table: string, column: string, typeSpec: string): void;

  // ── Async surface (optional) ────────────────────────────────────────
  // Adapters that can serve queries without blocking the Node main thread
  // implement these. The Postgres adapter implements them against `pg.Pool`;
  // the SQLite adapter does not (better-sqlite3 is synchronous by design,
  // and SQLite's local file I/O is fast enough that adding a thread bridge
  // would cost more than it saves). When present, lattice and downstream
  // callers prefer the async surface to keep the event loop free during
  // heavy DB work.
  //
  // Sync stubs above remain authoritative for SQLite and for any caller
  // that hasn't migrated yet. Implementations that expose the async surface
  // MUST keep the sync surface working for the same connection, with the
  // same dialect translations, so a partial migration is always safe.

  /** Async equivalent of run(). Returns when the statement has completed. */
  runAsync?(sql: string, params?: unknown[]): Promise<void>;
  /** Async equivalent of get(). */
  getAsync?(sql: string, params?: unknown[]): Promise<Row | undefined>;
  /** Async equivalent of all(). */
  allAsync?(sql: string, params?: unknown[]): Promise<Row[]>;
  /**
   * Async equivalent of prepare().
   *
   * Note: in Postgres under transaction-mode pooling (pgbouncer port 6543),
   * server-side prepared statements cannot persist across calls because the
   * upstream connection is returned to the pool at COMMIT. The PostgresAdapter
   * implementation therefore stores SQL + binding shape and re-executes per
   * call — semantically a prepared statement, but without SQLite-style
   * binding cost amortization. SQLite's implementation keeps real prepared
   * statements via better-sqlite3.
   *
   * Inside `withClient(fn)`, prefer the `tx.run`/`tx.get`/`tx.all` methods
   * directly rather than `prepareAsync` — they share the same checked-out
   * client for the transaction lifetime and avoid the per-call setup.
   */
  prepareAsync?(sql: string): PreparedStatementAsync;
  /**
   * Run `fn` against a single connection-scoped client, wrapped in BEGIN/COMMIT.
   * `fn` receives a `TxClient` whose `run`/`get`/`all` calls are guaranteed to
   * land on the same upstream connection for the lifetime of the transaction.
   * Throws inside `fn` cause an automatic ROLLBACK; otherwise the transaction
   * commits when `fn` resolves.
   *
   * Replacement for raw `adapter.run('BEGIN')` / `adapter.run('COMMIT')`
   * sequences. With `pg.Pool`-backed adapters, raw BEGIN/COMMIT calls can
   * land on different upstream connections and break atomicity silently;
   * `withClient(fn)` is the only way to hold a single connection across the
   * entire transaction.
   *
   * SQLite implementations may execute `fn` inside `db.transaction(fn)` (or
   * the equivalent `BEGIN`/`COMMIT` sequence) since better-sqlite3 has no
   * pool to reason about — every operation runs against the single open
   * connection. The TxClient surface is intentionally identical across
   * dialects so callers don't need to branch on adapter type.
   */
  withClient?<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;
}

export interface PreparedStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
}

/** Async equivalent of {@link PreparedStatement}. */
export interface PreparedStatementAsync {
  run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
  get(...params: unknown[]): Promise<Row | undefined>;
  all(...params: unknown[]): Promise<Row[]>;
}

/**
 * Connection-scoped client passed to `StorageAdapter.withClient(fn)`. All
 * `run`/`get`/`all` calls made against the same `TxClient` instance are
 * guaranteed to land on the same upstream connection for the transaction's
 * lifetime — that's the whole point of withClient. This makes raw BEGIN/COMMIT
 * call-site migrations to withClient mechanical: rename `this._adapter.run(sql, params)`
 * to `await tx.run(sql, params)`, drop the manual BEGIN/COMMIT/ROLLBACK lines.
 *
 * `run` returns `{ changes }` so callers that count affected rows (e.g.
 * INSERT-OR-IGNORE patterns) can do so without an extra SELECT roundtrip.
 * SQLite reports `db.prepare(...).run(...).changes`; Postgres reports
 * `pg.QueryResult.rowCount` (zero when the driver doesn't surface a count
 * for the query type, matching the SQLite contract).
 */
export interface TxClient {
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  get(sql: string, params?: unknown[]): Promise<Row | undefined>;
  all(sql: string, params?: unknown[]): Promise<Row[]>;
}
