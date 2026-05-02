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
// need a real runtime `require` to load `pg` and `synckit` (which are
// optionalDependencies the consumer installs into their node_modules).
// createRequire solves this: it builds a CommonJS `require` rooted at the
// URL of this file, so it walks up from `latticesql/dist/` and finds the
// consumer's `node_modules` entries.
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
 * Two surfaces, one adapter:
 *   - Sync surface (`run` / `get` / `all` / `prepare`): bridged via a synckit
 *     worker thread that owns a single pg.Client. The main thread blocks on
 *     Atomics.wait until the worker posts its reply. Used by callers that
 *     haven't migrated to the async surface; preserved for back-compat so
 *     consumers can adopt the async surface incrementally.
 *   - Async surface (`runAsync` / `getAsync` / `allAsync` / `prepareAsync` /
 *     `withClient`): native against a `pg.Pool` in the main thread. No
 *     synckit, no Atomics.wait. The Node event loop is free to serve other
 *     work between awaited DB roundtrips — exactly the property normal Node
 *     async I/O is supposed to have. Required for any workload that runs
 *     long sync bursts on the main thread (the original motivation for this
 *     adapter rewrite).
 *
 * The two surfaces share the same underlying database but use different
 * upstream connections: the synckit worker owns one pg.Client, the pool owns
 * up to `poolSize` connections. Total upstream connection demand per
 * adapter instance is `1 + poolSize` while both surfaces are alive. Once
 * all consumers have migrated to the async surface, the synckit worker
 * (and its single connection) can be removed in a future release.
 *
 * Transactional contract:
 *   - Sync `adapter.run('BEGIN')` / `adapter.run('COMMIT')` is no longer a
 *     safe idiom. The synckit worker's single pg.Client still happens to
 *     pin those calls to one connection (so existing call sites keep
 *     working), but new transaction boundaries MUST go through `withClient(fn)`
 *     because the async surface is pool-backed and raw BEGIN/COMMIT can
 *     land on different upstream connections under transaction-mode pooling.
 *   - `withClient(fn)` checks out a single pool client, runs `fn` against
 *     a `TxClient` whose run/get/all are pinned to that client, and
 *     commits or rolls back automatically.
 *
 * Polyfills (json_extract, strftime, pgcrypto extension): registered by
 * the synckit worker on open(). Kept there for PR 1 since synckit always
 * runs first; when synckit is removed in a later release the pool will
 * need its own one-shot registration on first checkout.
 *
 * Optional dependencies: `pg` and `synckit` are listed in `optionalDependencies`
 * — SQLite-only consumers don't pay the install cost. The constructor throws
 * a clear error if either is missing.
 */
export interface PostgresAdapterOptions {
  /** Override the worker file path. Useful in test setups. */
  workerPath?: string;
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
}
interface PgModule {
  Pool: new (config: { connectionString: string; max?: number }) => PgPool;
}

export class PostgresAdapter implements StorageAdapter {
  readonly dialect = 'postgres' as const;
  private readonly _connectionString: string;
  private readonly _workerPath: string;
  private readonly _poolSize: number;
  private _syncFn: ((action: unknown) => unknown) | null = null;
  private _pool: PgPool | null = null;
  private _opened = false;

  constructor(connectionString: string, options: PostgresAdapterOptions = {}) {
    this._connectionString = connectionString;
    // .cjs extension because the published package.json has `"type": "module"`
    // and the worker is built as CJS — Node refuses to run a `.js` CJS file
    // under `type: module`. tsup emits the worker as `dist/postgres-worker.cjs`.
    this._workerPath = options.workerPath ?? path.join(moduleContext().dir, 'postgres-worker.cjs');
    this._poolSize = options.poolSize ?? 10;
  }

  open(): void {
    if (this._opened) return;
    const ctxRequire = moduleContext().require;
    let createSyncFn: (worker: string) => (action: unknown) => unknown;
    try {
      // moduleContext().require bridges ESM → CJS (via createRequire) or is
      // the native CJS require under the dual-bundle CJS output. Lets us
      // load optionalDependencies from the consumer's node_modules without
      // relying on the bundler's `__require` shim (which throws under ESM).
      ({ createSyncFn } = ctxRequire('synckit') as typeof import('synckit'));
    } catch (err) {
      throw new Error(
        "PostgresAdapter requires 'synckit'. Install with: npm install synckit\n" +
          'Underlying error: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
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
    this._syncFn = createSyncFn(this._workerPath);
    this._call({ type: 'open', connectionString: this._connectionString });
    // Pool is opened lazily on first async use to keep the upstream-connection
    // footprint minimal for callers that only use the sync surface today.
    this._pool = new pgMod.Pool({
      connectionString: this._connectionString,
      max: this._poolSize,
    });
    this._opened = true;
  }

  close(): void {
    if (!this._opened) return;
    this._call({ type: 'close' });
    if (this._pool) {
      // Fire-and-forget — pool.end() is async, but close() is the sync
      // contract; existing in-flight async queries on the pool will still
      // settle, and the upstream connections will close as they drain.
      void this._pool.end().catch(() => {
        // Pool teardown failures don't affect close() semantics.
      });
      this._pool = null;
    }
    this._opened = false;
    this._syncFn = null;
  }

  run(sql: string, params: unknown[] = []): void {
    this._call({ type: 'run', sql: rewrite(sql), params });
  }

  get(sql: string, params: unknown[] = []): Row | undefined {
    const r = this._call({ type: 'get', sql: rewrite(sql), params }) as { rows?: Row[] };
    return r.rows?.[0];
  }

  all(sql: string, params: unknown[] = []): Row[] {
    const r = this._call({ type: 'all', sql: rewrite(sql), params }) as { rows?: Row[] };
    return r.rows ?? [];
  }

  prepare(sql: string): PreparedStatement {
    // Postgres connections handle prepared-statement caching server-side; we
    // just translate the SQL once and execute via the same call paths.
    const rewritten = rewrite(sql);
    return {
      run: (...params: unknown[]) => {
        const r = this._call({ type: 'run', sql: rewritten, params }) as { rowCount?: number };
        // Postgres surfaces inserted IDs via RETURNING clauses, not lastInsertRowid.
        // Consumers that need a fresh ID should use TEXT PRIMARY KEY + UUID and
        // RETURNING explicitly. We surface 0 here to satisfy the SQLite contract.
        return { changes: r.rowCount ?? 0, lastInsertRowid: 0 };
      },
      get: (...params: unknown[]) => {
        const r = this._call({ type: 'get', sql: rewritten, params }) as { rows?: Row[] };
        return r.rows?.[0];
      },
      all: (...params: unknown[]) => {
        const r = this._call({ type: 'all', sql: rewritten, params }) as { rows?: Row[] };
        return r.rows ?? [];
      },
    };
  }

  introspectColumns(table: string): string[] {
    const r = this._call({ type: 'introspectColumns', table }) as {
      rows?: { column_name: string }[];
    };
    return (r.rows ?? []).map((row) => row.column_name);
  }

  addColumn(table: string, column: string, typeSpec: string): void {
    this._call({ type: 'addColumn', table, column, typeSpec });
  }

  // ── Async surface ───────────────────────────────────────────────────
  // Native against pg.Pool. No synckit, no Atomics.wait. The Node event
  // loop is free to handle other work (HTTP requests, Slack socket pings,
  // scheduler timers, etc.) while these calls await DB I/O.

  async runAsync(sql: string, params: unknown[] = []): Promise<void> {
    const pool = this._requirePool();
    await pool.query(rewrite(sql), params);
  }

  async getAsync(sql: string, params: unknown[] = []): Promise<Row | undefined> {
    const pool = this._requirePool();
    const r = await pool.query(rewrite(sql), params);
    return r.rows[0];
  }

  async allAsync(sql: string, params: unknown[] = []): Promise<Row[]> {
    const pool = this._requirePool();
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
        const pool = this._requirePool();
        const r = await pool.query(rewritten, params);
        return { changes: r.rowCount ?? 0, lastInsertRowid: 0 };
      },
      get: async (...params: unknown[]) => {
        const pool = this._requirePool();
        const r = await pool.query(rewritten, params);
        return r.rows[0];
      },
      all: async (...params: unknown[]) => {
        const pool = this._requirePool();
        const r = await pool.query(rewritten, params);
        return r.rows;
      },
    };
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
    const pool = this._requirePool();
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

  private _requirePool(): PgPool {
    if (!this._pool) {
      throw new Error('PostgresAdapter: not open — call open() first');
    }
    return this._pool;
  }

  private _call(action: unknown): { rows?: Row[]; rowCount?: number } {
    if (!this._syncFn) throw new Error('PostgresAdapter: not open — call open() first');
    const result = this._syncFn(action) as
      | { ok: true; rows?: Row[]; rowCount?: number }
      | { ok: false; error: string };
    if (!result.ok) {
      throw new Error(`PostgresAdapter: ${result.error}`);
    }
    return result;
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
