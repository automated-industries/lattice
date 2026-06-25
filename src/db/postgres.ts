import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type {
  StorageAdapter,
  PreparedStatement,
  PreparedStatementAsync,
  TxClient,
} from './adapter.js';
import type { Row } from '../types.js';

// Resolve this module's directory and a working CJS `require`. Works under
// both ESM (uses import.meta.url) and CJS (falls back to the __dirname /
// require globals Node injects into every CJS module).
//
// Under tsup's CJS bundling, `import.meta` is rewritten to `{}` so its `.url`
// is undefined — loading dist/index.cjs would crash at module init if we
// unconditionally called fileURLToPath(import.meta.url). Detect the branch
// and use the CJS-side globals instead.
//
// In an ESM bundle, the global `require` is not defined and tsup's
// `__require` shim throws "Dynamic require of '...' is not supported". We
// need a real runtime `require` to load `pg` (an optionalDependency the
// consumer installs into their node_modules). createRequire solves this:
// it builds a CommonJS `require` rooted at the URL of this file, so it
// walks up from `latticesql/dist/` and finds the consumer's `node_modules`
// entries.
let _moduleContext: { dir: string; require: NodeJS.Require } | null = null;
function moduleContext(): { dir: string; require: NodeJS.Require } {
  if (_moduleContext) return _moduleContext;
  const importMetaUrl = (import.meta as { url?: string }).url;
  if (importMetaUrl) {
    _moduleContext = {
      dir: path.dirname(fileURLToPath(importMetaUrl)),
      require: createRequire(importMetaUrl),
    };
  } else {
    // CJS path: __dirname and require are module-scope globals Node provides.
    _moduleContext = { dir: __dirname, require };
  }
  return _moduleContext;
}

/**
 * Pluggable Postgres backend for Lattice.
 *
 * Native against `pg.Pool` — no synckit, no worker thread, no `Atomics.wait`.
 * Every query runs on the Node main thread via async/await; the event loop
 * is free to handle other work between awaited DB roundtrips.
 *
 * **Async-only on Postgres (since 1.10.0).** The synchronous methods
 * (`run` / `get` / `all` / `prepare`) inherited from {@link StorageAdapter}
 * throw on Postgres — there is no synchronous way to execute a `pg.Pool`
 * query. Callers must use `runAsync` / `getAsync` / `allAsync` / `prepareAsync`
 * / `withClient`. Lattice core calls the async surface internally; downstream
 * code that escapes into `adapter.run(...)` directly needs to migrate to the
 * async surface (or use the higher-level `Lattice.query` / `.insert` /
 * `.render` / etc., which already do).
 *
 * Transactional contract:
 *   - All BEGIN/COMMIT must go through `withClient(fn)`. Raw `BEGIN` /
 *     `COMMIT` issued via separate pool checkouts can land on different
 *     upstream connections under transaction-mode pooling and break atomicity
 *     silently. `withClient(fn)` checks out a single pool client, runs `fn`
 *     against a `TxClient` whose run/get/all are pinned to that client, and
 *     commits or rolls back automatically.
 *
 * Polyfills (`pgcrypto` extension, `json_extract`, `strftime`): registered
 * lazily on first pool use via a `_polyfillsReady` Promise that every async
 * method awaits before its first query. SQLite-isms in user migrations
 * (`randomblob(N)`, `json_extract(doc, path)`, `strftime(...)`, etc.) keep
 * working unchanged when pointed at Postgres.
 *
 * Optional dependency: `pg` is listed in `optionalDependencies` — SQLite-only
 * consumers don't pay the install cost. The constructor throws a clear error
 * if it's missing. **`synckit` was removed in 1.10.0** — if you have a
 * dependency on it via this package, drop it from your install list.
 */
export interface PostgresAdapterOptions {
  /**
   * Maximum number of pool connections used by the async surface
   * (`runAsync` / `getAsync` / `allAsync` / `withClient`). Default 10.
   *
   * Under pgbouncer transaction-mode pooling (the recommended pooler for
   * `pg.Pool` clients), each pool slot consumes one upstream pgbouncer
   * connection only while a query or `withClient` block is in flight, so a
   * pool of 10 gives meaningful concurrency without exhausting a typical
   * Supabase project budget. Tune down for memory- or budget-constrained
   * environments; tune up if you observe pool waits in production.
   */
  poolSize?: number;
}

// Subset of the `pg` package we actually use. Keeping a local alias avoids
// having to import types from `pg` (an optionalDependency) at the top level —
// the SQLite-only path would otherwise pay the type cost. The runtime
// `requireFromHere('pg')` returns a value compatible with the real `pg.Pool`,
// and we cast to this subset.
interface PgQueryResult {
  rows: Row[];
  rowCount: number | null;
}
interface PgPoolClient {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>;
  release(err?: unknown): void;
}
interface PgPool {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>;
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
  // Idle-client error events; without a listener pg escalates them to an
  // unhandled 'error' that crashes the process (see the handler in open()).
  on(event: 'error', listener: (err: Error) => void): void;
}
interface PgModule {
  Pool: new (config: { connectionString: string; max?: number }) => PgPool;
}

const SYNC_NOT_SUPPORTED_MSG =
  'PostgresAdapter: synchronous adapter methods (run/get/all/prepare/introspectColumns/addColumn) are no longer supported on Postgres as of latticesql 1.10.0. ' +
  'Use the async surface (runAsync/getAsync/allAsync/prepareAsync/introspectColumnsAsync/addColumnAsync/withClient) instead. ' +
  'Lattice core methods (Lattice.query, .insert, .update, .render, etc.) already route through the async surface — only consumer code that escapes into adapter.run/get/all directly needs migrating.';

/**
 * Route the query pool through Supabase's TRANSACTION-mode pooler.
 *
 * Supabase exposes a session-mode pooler on port 5432 and a transaction-mode
 * pooler on port 6543 at the same `*.pooler.supabase.com` host. Session mode
 * pins one scarce upstream slot per pooled client for the client's whole
 * lifetime, so a small pooler `pool_size` (commonly 15) is quickly exhausted by
 * the query pool + the realtime LISTEN client + a burst of concurrent queries —
 * surfacing as `EMAXCONNSESSION`. Transaction mode hands back the upstream
 * connection at COMMIT, multiplexing many clients over far fewer slots. The
 * query pool only ever needs a connection per transaction (this adapter holds no
 * cross-statement session state — see `prepareAsync`), so it belongs on 6543.
 *
 * Only the QUERY POOL is rewritten. The realtime broker is a separate `pg.Client`
 * that MUST stay on the session pooler (LISTEN/NOTIFY requires session mode) and
 * is untouched by this.
 *
 * Surgical + conservative: only a Supabase pooler host on the session port is
 * bumped to 6543 — direct/non-Supabase/already-6543/unparseable URLs are left
 * exactly as-is, and only the host:port is touched (never userinfo). Set
 * `LATTICE_PG_SESSION_POOLER=1` to force the pool back onto session mode.
 */
export function toTransactionPoolerUrl(connectionString: string): string {
  if (process.env.LATTICE_PG_SESSION_POOLER) return connectionString;
  return connectionString.replace(/(\.pooler\.supabase\.com):5432\b/, '$1:6543');
}

export class PostgresAdapter implements StorageAdapter {
  readonly dialect = 'postgres' as const;
  private readonly _connectionString: string;
  private readonly _poolSize: number;
  private _pool: PgPool | null = null;
  private _polyfillsReady: Promise<void> | null = null;
  private _opened = false;

  constructor(connectionString: string, options: PostgresAdapterOptions = {}) {
    this._connectionString = connectionString;
    this._poolSize = options.poolSize ?? 10;
  }

  open(): void {
    if (this._opened) return;
    const ctxRequire = moduleContext().require;
    let pgMod: PgModule;
    try {
      pgMod = ctxRequire('pg') as PgModule;
    } catch (err) {
      throw new Error(
        "PostgresAdapter requires 'pg'. Install with: npm install pg\n" +
          'Underlying error: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    this._pool = new pgMod.Pool({
      connectionString: toTransactionPoolerUrl(this._connectionString),
      max: this._poolSize,
    });
    // An idle pooled client can emit 'error' when its TCP connection drops out
    // from under us — a network blip, the Supabase pooler recycling a backend,
    // or a server restart (observed as `read EADDRNOTAVAIL`). Node escalates an
    // unhandled EventEmitter 'error' to a process-wide crash, so without this
    // listener a single transient idle-connection reset takes down the entire
    // server. pg evicts the broken client from the pool itself; the next query
    // transparently opens a fresh connection. Log and swallow so we survive the
    // blip instead of crashing mid-session.
    this._pool.on('error', (err: Error) => {
      console.error('[latticesql] recovered from idle Postgres client error:', err.message);
    });
    // Fire the polyfill registration immediately. Every async method awaits
    // this Promise before its first query, so by the time any user query
    // runs the polyfills are guaranteed to be in place. We don't await here
    // because open() is synchronous per the StorageAdapter contract.
    this._polyfillsReady = this._registerPolyfills();
    this._opened = true;
  }

  close(): void {
    if (!this._opened) return;
    if (this._pool) {
      // Fire-and-forget — pool.end() is async, but close() is the sync
      // contract; existing in-flight queries on the pool will still settle,
      // and the upstream connections will close as they drain.
      void this._pool.end().catch(() => {
        // Pool teardown failures don't affect close() semantics.
      });
      this._pool = null;
    }
    this._polyfillsReady = null;
    this._opened = false;
  }

  // ── Sync surface (no longer supported on Postgres) ──────────────────
  // The synchronous methods on StorageAdapter exist for SQLite consumers
  // (better-sqlite3 is sync by design). On Postgres they throw — `pg.Pool`
  // is fundamentally async and the synckit-bridged sync path was removed
  // in 1.10.0 to drop the `Atomics.wait` blocking it imposed on the Node
  // main thread.

  run(_sql: string, _params: unknown[] = []): void {
    throw new Error(SYNC_NOT_SUPPORTED_MSG);
  }

  get(_sql: string, _params: unknown[] = []): Row | undefined {
    throw new Error(SYNC_NOT_SUPPORTED_MSG);
  }

  all(_sql: string, _params: unknown[] = []): Row[] {
    throw new Error(SYNC_NOT_SUPPORTED_MSG);
  }

  prepare(_sql: string): PreparedStatement {
    throw new Error(SYNC_NOT_SUPPORTED_MSG);
  }

  introspectColumns(_table: string): string[] {
    throw new Error(SYNC_NOT_SUPPORTED_MSG);
  }

  addColumn(_table: string, _column: string, _typeSpec: string): void {
    throw new Error(SYNC_NOT_SUPPORTED_MSG);
  }

  // ── Async surface ───────────────────────────────────────────────────
  // Native against pg.Pool. The Node event loop is free to handle other
  // work (HTTP requests, Slack socket pings, scheduler timers, etc.) while
  // these calls await DB I/O.

  async runAsync(sql: string, params: unknown[] = []): Promise<void> {
    const pool = await this._readyPool();
    await pool.query(rewrite(sql), params);
  }

  async getAsync(sql: string, params: unknown[] = []): Promise<Row | undefined> {
    const pool = await this._readyPool();
    const r = await pool.query(rewrite(sql), params);
    return r.rows[0];
  }

  async allAsync(sql: string, params: unknown[] = []): Promise<Row[]> {
    const pool = await this._readyPool();
    const r = await pool.query(rewrite(sql), params);
    return r.rows;
  }

  /**
   * Async prepared-statement-shaped helper.
   *
   * Important: under transaction-mode pooling (the recommended pooler for
   * pg.Pool callers), server-side prepared statements cannot persist across
   * calls — pgbouncer returns the upstream connection to the pool at
   * COMMIT, which invalidates any per-connection prepared-statement cache.
   * This implementation therefore stores the rewritten SQL once and
   * re-executes it per call. It shares the surface of a real prepared
   * statement (so consumers can write the same code as for SQLite) but
   * not the binding cost amortization. Inside a `withClient(fn)` block,
   * prefer `tx.run`/`tx.get`/`tx.all` — they share the same checked-out
   * client for the transaction lifetime and avoid the per-call setup.
   */
  prepareAsync(sql: string): PreparedStatementAsync {
    const rewritten = rewrite(sql);
    return {
      run: async (...params: unknown[]) => {
        const pool = await this._readyPool();
        const r = await pool.query(rewritten, params);
        return { changes: r.rowCount ?? 0, lastInsertRowid: 0 };
      },
      get: async (...params: unknown[]) => {
        const pool = await this._readyPool();
        const r = await pool.query(rewritten, params);
        return r.rows[0];
      },
      all: async (...params: unknown[]) => {
        const pool = await this._readyPool();
        const r = await pool.query(rewritten, params);
        return r.rows;
      },
    };
  }

  async introspectColumnsAsync(table: string): Promise<string[]> {
    const pool = await this._readyPool();
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = $1
       ORDER BY ordinal_position`,
      [table],
    );
    return r.rows.map((row) => (row as { column_name: string }).column_name);
  }

  /**
   * Whole-schema column introspection in a single query — the batched
   * equivalent of {@link introspectColumnsAsync}. The boot path uses this to
   * collapse one `information_schema` round-trip per declared table into one,
   * which on a high-RTT cloud is the difference between ~hundreds of serial
   * round-trips and a single query.
   *
   * `tables` is accepted for interface symmetry but ignored: querying the
   * whole `current_schema()` once is cheaper than constraining to a list, and
   * the caller folds out tables it doesn't care about. Throws on query failure
   * — a degraded read must never masquerade as "every table is missing".
   */
  async introspectAllColumns(_tables: string[]): Promise<Map<string, Set<string>>> {
    const pool = await this._readyPool();
    const r = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`,
    );
    const map = new Map<string, Set<string>>();
    for (const row of r.rows) {
      const { table_name, column_name } = row as { table_name: string; column_name: string };
      let s = map.get(table_name);
      if (!s) {
        s = new Set();
        map.set(table_name, s);
      }
      s.add(column_name);
    }
    return map;
  }

  async addColumnAsync(table: string, column: string, typeSpec: string): Promise<void> {
    // Postgres accepts non-constant defaults (NOW(), random(), CURRENT_TIMESTAMP)
    // natively in ALTER TABLE ADD COLUMN. Skip PRIMARY KEY columns — same
    // reasoning as SQLite (existing tables already have a PK).
    const upper = typeSpec.toUpperCase();
    if (upper.includes('PRIMARY KEY')) return;
    const translated = translateTypeSpec(typeSpec);
    const pool = await this._readyPool();
    await pool.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" ${translated}`);
  }

  /**
   * Run `fn` against a single checked-out pool client wrapped in BEGIN/COMMIT.
   * The TxClient handed to `fn` runs every query against the same upstream
   * connection for the full transaction lifetime — pgbouncer transaction-mode
   * cannot multiplex away mid-transaction, so atomicity holds.
   *
   * Throws inside `fn` cause an automatic ROLLBACK; otherwise COMMIT.
   * The client is always released back to the pool in `finally`, with the
   * captured error passed to `release(err)` on failure so pg.Pool destroys
   * the connection rather than recycling a known-bad one.
   */
  async withClient<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    const pool = await this._readyPool();
    const client = await pool.connect();
    const tx: TxClient = {
      run: async (sql: string, params?: unknown[]) => {
        const r = await client.query(rewrite(sql), params ?? []);
        return { changes: r.rowCount ?? 0 };
      },
      get: async (sql: string, params?: unknown[]) => {
        const r = await client.query(rewrite(sql), params ?? []);
        return r.rows[0];
      },
      all: async (sql: string, params?: unknown[]) => {
        const r = await client.query(rewrite(sql), params ?? []);
        return r.rows;
      },
    };

    let releaseErr: unknown;
    try {
      await client.query('BEGIN');
      try {
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        releaseErr = err;
        try {
          await client.query('ROLLBACK');
        } catch {
          // ROLLBACK on an already-aborted connection can fail; we surface
          // the original error and let the `release(err)` in `finally`
          // destroy the connection.
        }
        throw err;
      }
    } finally {
      client.release(releaseErr);
    }
  }

  /**
   * Resolve the pool, waiting for one-time polyfill registration to complete.
   * Every async method funnels through here so the polyfills are guaranteed
   * to be in place by the time the caller's first query runs.
   */
  private async _readyPool(): Promise<PgPool> {
    if (!this._pool) {
      throw new Error('PostgresAdapter: not open — call open() first');
    }
    if (this._polyfillsReady) await this._polyfillsReady;
    return this._pool;
  }

  /**
   * Idempotently register the SQLite-compat polyfills the dialect translator
   * relies on:
   *   - `pgcrypto` extension — provides `gen_random_bytes()` for the
   *     `randomblob()` translation.
   *   - `json_extract(doc, path)` SQL function — mimics SQLite's
   *     `$.a.b.c` path syntax against jsonb.
   *   - `strftime(format, modifier)` SQL function — handles the common
   *     `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` pattern lattice itself emits
   *     for ISO timestamps.
   *
   * Each registration is wrapped in try/catch so a permission-restricted
   * provider (e.g. some managed Postgres tiers don't allow CREATE EXTENSION)
   * surfaces a non-fatal warning rather than blocking pool readiness.
   */
  private async _registerPolyfills(): Promise<void> {
    if (!this._pool) return;
    const pool = this._pool;
    await registerPostgresPolyfills((sql) => pool.query(sql).then(() => undefined));
  }
}

/**
 * The SQLite-compat polyfills the dialect translator relies on (see
 * {@link PostgresAdapter._registerPolyfills}). Extracted so they can ALSO be
 * created up-front by the cloud owner during `secureCloud`: once a cloud revokes
 * `CREATE ON SCHEMA … FROM PUBLIC`, a scoped member can neither create these
 * functions nor `CREATE OR REPLACE` an owner's — so they must already exist
 * before any member connects, or every member query that uses `json_extract` /
 * `strftime` (e.g. the audit-table timestamp default) fails. Owner-created
 * functions are EXECUTE-able by members by default.
 */
export const POSTGRES_POLYFILLS: readonly { warn: string; sql: string }[] = [
  {
    warn: 'CREATE EXTENSION pgcrypto failed (may already be enabled by your provider):',
    sql: 'CREATE EXTENSION IF NOT EXISTS pgcrypto',
  },
  {
    warn: 'could not register json_extract polyfill:',
    // Create ONLY if absent. `CREATE OR REPLACE` on an existing function requires
    // ownership, but on a cloud the function is owned by whichever single role
    // created it first — so every OTHER member's per-connect replace raised "must
    // be owner of function" and (sharing the render transaction) aborted it,
    // yielding an empty render. The IF-absent guard makes a present function a
    // clean no-op for everyone, regardless of who owns it.
    sql: `DO $do$ BEGIN
      IF to_regprocedure('json_extract(text, text)') IS NULL THEN
        CREATE FUNCTION json_extract(doc text, path text)
          RETURNS text
          LANGUAGE sql
          IMMUTABLE
          AS $fn$
            SELECT doc::jsonb #>> string_to_array(regexp_replace(path, '^\\$\\.?', ''), '.')
          $fn$;
      END IF;
    END $do$;`,
  },
  {
    warn: 'could not register strftime format helper:',
    // Shared format translator (SQLite strftime tokens → to_char patterns), in UTC.
    // Factored out so the 2-arg and 3-arg strftime overloads share one definition.
    // Each polyfill below is CREATE OR REPLACE (so an existing cloud's prior copy is
    // UPGRADED when the owner opens), wrapped in a DO block whose EXCEPTION swallows a
    // scoped member's insufficient-privilege failure IN A SUBTRANSACTION — so a member
    // that runs registration inside a transaction is NOT aborted. ("must be owner of
    // function", raised when a non-owner CREATE OR REPLACEs another role's function, is
    // SQLSTATE 42501 / `insufficient_privilege`, same class as "permission denied".) The
    // owner already owns + replaced the function; the member simply uses the owner's
    // copy — and `ownPolyfillsByGroup` re-owns the whole set to the member group so any
    // member can replace them on a later upgrade.
    sql: `DO $do$ BEGIN
      CREATE OR REPLACE FUNCTION __lattice_strftime_fmt(ts timestamptz, format text)
        RETURNS text
        LANGUAGE sql
        IMMUTABLE
        AS $fn$
          SELECT to_char(
            ts AT TIME ZONE 'UTC',
            replace(replace(replace(replace(replace(replace(replace(replace(
              format,
              '%Y', 'YYYY'),
              '%m', 'MM'),
              '%d', 'DD'),
              '%H', 'HH24'),
              '%M', 'MI'),
              '%S', 'SS'),
              '%f', 'MS'),
              'T', '"T"')
          );
        $fn$;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END $do$;`,
  },
  {
    warn: 'could not register strftime polyfill:',
    // The pre-4.3.3 strftime cast the modifier straight to timestamptz and threw
    // `invalid input syntax for type timestamp with time zone: ""` on a legacy ''
    // value (3.x stored nullable TEXT timestamps as ''), bricking the whole workspace
    // open. Now an empty, whitespace, or unparseable time string returns NULL (SQLite's
    // strftime semantics) instead of aborting the query.
    sql: `DO $do$ BEGIN
      CREATE OR REPLACE FUNCTION strftime(format text, modifier text)
        RETURNS text
        LANGUAGE plpgsql
        IMMUTABLE
        AS $fn$
        DECLARE ts timestamptz;
        BEGIN
          IF modifier = 'now' THEN
            ts := now();
          ELSIF NULLIF(btrim(modifier), '') IS NULL THEN
            RETURN NULL;
          ELSE
            BEGIN
              ts := modifier::timestamptz;
            EXCEPTION WHEN others THEN
              RETURN NULL;
            END;
          END IF;
          RETURN __lattice_strftime_fmt(ts, format);
        END;
        $fn$;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END $do$;`,
  },
  {
    warn: 'could not register 3-arg strftime polyfill:',
    // SQLite's 3-arg strftime(format, timestring, modifier) — used by the changelog
    // retention prune (e.g. strftime('%Y-...','now','-30 days')). Postgres had no
    // 3-arg overload, so that prune threw `function strftime(...) does not exist` on
    // every PG cloud with retention. Resolve the base time, apply the modifier as an
    // interval, then reuse the shared formatter. Empty/invalid → NULL, never throws.
    sql: `DO $do$ BEGIN
      CREATE OR REPLACE FUNCTION strftime(format text, timestring text, modifier text)
        RETURNS text
        LANGUAGE plpgsql
        IMMUTABLE
        AS $fn$
        DECLARE ts timestamptz;
        BEGIN
          IF timestring = 'now' THEN
            ts := now();
          ELSIF NULLIF(btrim(timestring), '') IS NULL THEN
            RETURN NULL;
          ELSE
            BEGIN
              ts := timestring::timestamptz;
            EXCEPTION WHEN others THEN
              RETURN NULL;
            END;
          END IF;
          BEGIN
            ts := ts + modifier::interval;
          EXCEPTION WHEN others THEN
            RETURN NULL;
          END;
          RETURN __lattice_strftime_fmt(ts, format);
        END;
        $fn$;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END $do$;`,
  },
];

/**
 * Run the polyfill DDL through `run`. Each statement is independent and
 * non-fatal: a permission-restricted role surfaces a warning rather than
 * throwing (a member who can't create them is fine as long as the owner already
 * did). Used by the adapter on connect AND by `secureCloud` (as the owner).
 */
export async function registerPostgresPolyfills(
  run: (sql: string) => Promise<unknown>,
): Promise<void> {
  let permissionDenied = false;
  for (const { warn, sql } of POSTGRES_POLYFILLS) {
    try {
      await run(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A scoped cloud member has no CREATE on schema public, so it can neither
      // create these nor CREATE OR REPLACE the owner's — but the owner already
      // created them during secureCloud and members hold EXECUTE on them, so this
      // is expected-and-recovered, not a failure. Collapse the per-statement
      // "permission denied for schema public" / "must be owner of function" noise
      // into ONE debug line instead of a warning per statement on every member
      // connect. ("must be owner of function" is what a member's CREATE OR REPLACE
      // of the owner's strftime/json_extract raises.) A genuine non-permission
      // failure (e.g. pgcrypto unavailable while securing as the owner) still warns
      // loudly — it is actionable.
      if (/permission denied/i.test(msg) || /must be owner of/i.test(msg)) {
        permissionDenied = true;
      } else {
        console.warn(`[PostgresAdapter] ${warn}`, msg);
      }
    }
  }
  if (permissionDenied) {
    console.debug(
      '[PostgresAdapter] SQLite-compat polyfills are owner-managed on this cloud; skipping member-side (re)creation (expected).',
    );
  }
}

/**
 * Translate the most common SQLite-isms to Postgres before executing. Runs
 * before the `?` → `$N` pass. Translations applied:
 *
 *   - `INSERT OR IGNORE INTO ...` → `INSERT INTO ... ON CONFLICT DO NOTHING`
 *     (appended at the end of the statement, before any trailing `;`).
 *     Postgres needs at least one unique constraint on the target table for
 *     this to apply — schemas without one will surface a runtime error.
 *   - `INSERT OR REPLACE INTO ...` → throws with a clear error. The
 *     translator does not try to synthesize an `ON CONFLICT DO UPDATE` clause
 *     because the correct conflict target depends on table-level metadata the
 *     translator doesn't see. Migrate these to native Postgres syntax.
 *   - `randomblob(N)` → `gen_random_bytes(N)` (requires `pgcrypto` extension).
 *   - `hex(<expr>)` → `encode(<expr>, 'hex')` (Postgres lacks the SQLite
 *     `hex()` shorthand).
 *
 * String literals, double-quoted identifiers, single-line comments, and
 * block comments are passed through verbatim.
 */
function translateDialect(sql: string): string {
  // INSERT OR REPLACE is intentionally not translated; surface loudly so the
  // operator picks the right ON CONFLICT DO UPDATE form themselves. Checked
  // against full SQL (false positives for the literal text inside a string
  // are accepted — extremely rare in real migrations).
  if (/INSERT\s+OR\s+REPLACE\s+INTO/i.test(sql)) {
    throw new Error(
      "PostgresAdapter: 'INSERT OR REPLACE INTO ...' is not auto-translated. " +
        'Use INSERT INTO ... ON CONFLICT (col) DO UPDATE SET ... in your migration.',
    );
  }

  // INSERT OR IGNORE → INSERT INTO + trailing ON CONFLICT DO NOTHING.
  //
  // Two passes:
  //   1. mapCodeRegions walks code regions (skipping string literals and
  //      comments) and strips `OR IGNORE` from every INSERT it sees,
  //      recording whether at least one was found.
  //   2. If the original statement had an INSERT OR IGNORE and no explicit
  //      ON CONFLICT clause, append `ON CONFLICT DO NOTHING` at the very end
  //      of the WHOLE SQL (before any trailing semicolon).
  //
  // Appending at the statement level — not per-code-region — is what lets
  // an `INSERT OR IGNORE INTO t (...) SELECT '<string>', ... FROM x LIMIT 1`
  // translate correctly. A per-region append would insert the clause after
  // the column list (and before the SELECT body) because the string literals
  // split the statement into multiple code regions.
  let hadInsertOrIgnore = false as boolean;
  let s = mapCodeRegions(sql, (code) => {
    return code.replace(/INSERT(\s+)OR\s+IGNORE(\s+)INTO/gi, (_m: string, w1: string) => {
      hadInsertOrIgnore = true;
      return `INSERT${w1}INTO`;
    });
  });
  if (hadInsertOrIgnore && !hasOnConflictInCode(s)) {
    s = s.replace(/(\s*;?\s*)$/, ' ON CONFLICT DO NOTHING$1');
  }

  // CREATE VIEW IF NOT EXISTS → CREATE OR REPLACE VIEW. SQLite supports
  // `IF NOT EXISTS` on views; Postgres does not (the parser rejects it as
  // "syntax error at or near 'NOT'"). CREATE OR REPLACE VIEW is the
  // Postgres-native idempotent form and works in SQLite too (though we
  // only fire this translation on the Postgres path).
  s = mapCodeRegions(s, (code) =>
    code.replace(/CREATE(\s+)VIEW(\s+)IF\s+NOT\s+EXISTS/gi, (_m: string, w1: string) => {
      return `CREATE${w1}OR REPLACE VIEW`;
    }),
  );

  // Function-call translations: hex(<expr>) → encode(<expr>, 'hex'),
  // randomblob(N) → gen_random_bytes(N), datetime('now') → NOW(). These
  // need to match across string boundaries (the argument may be a string
  // literal), so they don't go through mapCodeRegions. Order matters: hex()
  // wraps randomblob() in our common UUID pattern, so translate hex first.
  // datetime('now') is emitted by Lattice itself (soft-delete, defaults),
  // not just user migrations — the translation lives here so it runs
  // against adapter.run() calls too.
  s = replaceFunction(s, 'hex', (arg) => `encode(${arg}, 'hex')`);
  s = replaceFunction(s, 'randomblob', (arg) => `gen_random_bytes(${arg})`);
  s = replaceFunction(s, 'datetime', (arg) => {
    // Only translate the 'now' shortcut. Other datetime() forms (e.g.
    // `datetime('2024-01-01', '+1 day')`) need a hand-written Postgres
    // equivalent — we throw so the operator notices.
    const trimmed = arg.trim();
    if (trimmed === "'now'" || trimmed === '"now"') return 'NOW()';
    throw new Error(
      'PostgresAdapter: datetime(' +
        arg +
        ") is not auto-translated. Only datetime('now') is supported. " +
        'Use NOW() or an equivalent Postgres expression in your migration.',
    );
  });

  return s;
}

/**
 * Translate SQLite type specs to Postgres equivalents for ALTER TABLE ADD COLUMN.
 * Used by addColumnAsync — exposed at module scope so it's testable.
 */
function translateTypeSpec(typeSpec: string): string {
  return typeSpec
    .replace(/\bBLOB\b/gi, 'BYTEA')
    .replace(/\bdatetime\(\s*'now'\s*\)/gi, 'NOW()')
    .replace(/\bRANDOM\(\)/gi, 'random()');
}

/**
 * Walk the SQL once, segregating code regions from string literals,
 * double-quoted identifiers, and comments. Apply `xform` to each code region
 * and concatenate the result. The non-code segments (strings, comments,
 * identifiers) are passed through verbatim.
 *
 * Note: the SQL is split at boundaries between code and quoted/comment
 * regions, so a translation that needs to span both (rare) is not supported
 * by this helper. All of our current translations are local — they don't
 * span quoted regions — so this is fine.
 */
/**
 * Check for an `ON CONFLICT` clause in the code regions of the SQL (skipping
 * string literals and comments). Used to decide whether to append our own
 * `ON CONFLICT DO NOTHING` or leave the user's explicit clause alone.
 */
function hasOnConflictInCode(sql: string): boolean {
  let found = false;
  mapCodeRegions(sql, (code) => {
    if (/ON\s+CONFLICT/i.test(code)) found = true;
    return code;
  });
  return found;
}

function mapCodeRegions(sql: string, xform: (code: string) => string): string {
  let out = '';
  let codeStart = 0;
  let i = 0;
  const flushCode = (end: number) => {
    if (end > codeStart) out += xform(sql.slice(codeStart, end));
  };
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      flushCode(i);
      out += "'";
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += "''";
          i += 2;
          continue;
        }
        out += sql.charAt(i);
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      codeStart = i;
      continue;
    }
    if (ch === '"') {
      flushCode(i);
      out += '"';
      i++;
      while (i < sql.length) {
        out += sql.charAt(i);
        if (sql[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      codeStart = i;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      flushCode(i);
      while (i < sql.length && sql[i] !== '\n') {
        out += sql.charAt(i);
        i++;
      }
      codeStart = i;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      flushCode(i);
      out += '/*';
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql.charAt(i);
        i++;
      }
      if (i < sql.length) {
        out += '*/';
        i += 2;
      }
      codeStart = i;
      continue;
    }
    i++;
  }
  flushCode(sql.length);
  return out;
}

/**
 * Replace every `name(<arg>)` with the given translator, respecting nested
 * parens and skipping over string literals. Used for the small set of SQLite
 * scalar functions we translate (hex, randomblob).
 */
function replaceFunction(sql: string, name: string, translate: (arg: string) => string): string {
  const pattern = new RegExp(`\\b${name}\\s*\\(`, 'gi');
  let out = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    // Append everything up to the function call.
    out += sql.slice(lastIndex, match.index);
    // Find the matching close paren, respecting nested parens + string literals.
    let depth = 1;
    let i = match.index + match[0].length;
    const argStart = i;
    while (i < sql.length && depth > 0) {
      const ch = sql[i];
      if (ch === "'") {
        // Skip past string literal (including '' escapes).
        i++;
        while (i < sql.length) {
          if (sql[i] === "'" && sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          if (sql[i] === "'") {
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth > 0) i++;
    }
    if (depth !== 0) {
      // Unbalanced — fall back to passing through verbatim.
      out += sql.slice(match.index);
      lastIndex = sql.length;
      break;
    }
    const arg = sql.slice(argStart, i);
    out += translate(arg);
    lastIndex = i + 1; // skip the matching ')'
    pattern.lastIndex = lastIndex;
  }
  out += sql.slice(lastIndex);
  return out;
}

/**
 * Translate `?` positional placeholders to Postgres `$N` placeholders. Skips
 * over single-quoted string literals and double-quoted identifiers so a `?`
 * inside one of those is left alone. Single-line and block comments are also
 * passed through unchanged (they cannot contain real `?` parameters).
 */
function rewriteParams(sql: string): string {
  let out = '';
  let i = 0;
  let n = 1;
  while (i < sql.length) {
    const ch = sql[i];
    // Single-quoted string: handle '' escapes
    if (ch === "'") {
      out += ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += "''";
          i += 2;
          continue;
        }
        out += sql.charAt(i);
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Double-quoted identifier
    if (ch === '"') {
      out += ch;
      i++;
      while (i < sql.length) {
        out += sql.charAt(i);
        if (sql[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Single-line comment
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        out += sql.charAt(i);
        i++;
      }
      continue;
    }
    // Block comment
    if (ch === '/' && sql[i + 1] === '*') {
      out += '/*';
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql.charAt(i);
        i++;
      }
      if (i < sql.length) {
        out += '*/';
        i += 2;
      }
      continue;
    }
    if (ch === '?') {
      out += '$' + String(n++);
      i++;
      continue;
    }
    out += ch ?? '';
    i++;
  }
  return out;
}

function rewrite(sql: string): string {
  return rewriteParams(translateDialect(sql));
}

/** Exposed for unit testing. */
export const _rewriteForTest = rewrite;
export const _translateDialectForTest = translateDialect;
