import { createRequire } from 'node:module';
import type { StorageAdapter, PreparedStatement, TxClient } from './adapter.js';
import type { Row } from '../types.js';

/**
 * SQLite adapter backed by the runtime's built-in `node:sqlite` `DatabaseSync`
 * (synchronous) instead of the `better-sqlite3` native addon. This exists so
 * Lattice can run under a runtime that ships `node:sqlite` but cannot load
 * native N-API addons (the desktop build). The surface is a 1:1 mirror of the
 * better-sqlite3 adapter — same StorageAdapter contract, same SQL — with three
 * substitutions where the two SQLite bindings differ:
 *
 *   1. pragmas are issued via `exec()` (no `.pragma()` helper);
 *   2. the `data_version` half of changeProbe is read with a plain
 *      `PRAGMA data_version` statement (no `{ simple: true }` option);
 *   3. BLOB columns read back as `Uint8Array` rather than `Buffer`. Lattice's
 *      own file storage is disk-based (content-addressed blobs), so the core
 *      never round-trips file bytes through a BLOB column; a user-defined
 *      `blob` column consumed specifically as a Node `Buffer` is the only place
 *      the difference is observable. `Buffer` is itself a `Uint8Array`, so byte
 *      access is identical; only Buffer-only methods would differ.
 */

// ── Minimal structural types for the node:sqlite surface we use ──────────
// Declared locally so the build does not depend on the runtime's @types
// shipping `node:sqlite` typings.
interface NodeSqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}
interface NodeStatementSync {
  run(...params: unknown[]): NodeSqliteRunResult;
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
}
interface NodeDatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): NodeStatementSync;
  close(): void;
}
type NodeDatabaseSyncCtor = new (path: string) => NodeDatabaseSync;

/** Resolve a real runtime `require`, working under both ESM and CJS bundles. */
function runtimeRequire(): NodeJS.Require {
  const importMetaUrl = (import.meta as { url?: string }).url;
  return importMetaUrl ? createRequire(importMetaUrl) : require;
}

// Module-level cache — load the ctor once, reuse for the process lifetime.
let _ctor: NodeDatabaseSyncCtor | null = null;

/** Upper bound on cached prepared statements (see DenoSqliteAdapter._prepared). */
const MAX_CACHED_STMTS = 512;

/**
 * Lazily acquire the `node:sqlite` `DatabaseSync` constructor. Kept out of
 * module-init (mirrors the lazy better-sqlite3 loader) so importing this module
 * never touches `node:sqlite` — which lets it be statically imported by core
 * even on a runtime where `node:sqlite` is absent or flag-gated, as long as the
 * adapter is never actually opened there.
 */
function loadNodeSqlite(): NodeDatabaseSyncCtor {
  if (_ctor) return _ctor;
  const mod = runtimeRequire()('node:sqlite') as { DatabaseSync?: NodeDatabaseSyncCtor };
  if (!mod.DatabaseSync) {
    throw new Error(
      'node:sqlite is unavailable in this runtime — cannot open the Deno SQLite adapter',
    );
  }
  _ctor = mod.DatabaseSync;
  return _ctor;
}

export class DenoSqliteAdapter implements StorageAdapter {
  readonly dialect = 'sqlite' as const;
  private _db: NodeDatabaseSync | null = null;
  private readonly _path: string;
  private readonly _wal: boolean;
  private readonly _busyTimeout: number;

  /**
   * Prepared-statement cache, keyed by SQL text. This is load-bearing, not an
   * optimization: `node:sqlite`'s `DatabaseSync.prepare()` — unlike `better-sqlite3`,
   * which caches compiled statements internally — compiles a FRESH native
   * `sqlite3_stmt` on every call and never finalizes it eagerly. Preparing per call
   * (as the raw adapter surface does) therefore leaks a native statement every
   * `run`/`get`/`all`; under a bulk-write loop (e.g. ingesting a folder of files, or
   * the change-probe watch loop) these accumulate far faster than GC reclaims them and
   * abort the runtime with a native memory blowup. Caching by SQL text keeps the live
   * native-statement count flat — the same behavior `better-sqlite3` gives for free.
   */
  private readonly _stmtCache = new Map<string, NodeStatementSync>();
  private _stmtCacheMisses = 0;

  constructor(path: string, options?: { wal?: boolean; busyTimeout?: number }) {
    this._path = path;
    this._wal = options?.wal ?? true;
    this._busyTimeout = options?.busyTimeout ?? 5000;
  }

  get db(): NodeDatabaseSync {
    if (!this._db) throw new Error('DenoSqliteAdapter: not open — call open() first');
    return this._db;
  }

  /**
   * Return the compiled statement for `sql`, reusing a cached one when present. A
   * `node:sqlite` statement is reusable across executions (each `run`/`get`/`all`
   * re-binds its params), and SQLite's `prepare_v2` auto-recompiles a cached statement
   * across a schema change (ALTER TABLE) transparently — so reuse is safe. Bounded so a
   * caller that inlines values into SQL (unbounded distinct text) can't grow it without
   * limit; on overflow the whole cache is dropped (evicted statements finalize on GC)
   * and rebuilt from the next calls.
   */
  private _prepared(sql: string): NodeStatementSync {
    const cached = this._stmtCache.get(sql);
    if (cached) return cached;
    if (this._stmtCache.size >= MAX_CACHED_STMTS) this._stmtCache.clear();
    const stmt = this.db.prepare(sql);
    this._stmtCache.set(sql, stmt);
    this._stmtCacheMisses += 1;
    return stmt;
  }

  /** Diagnostics: live cached-statement count + total compiles (cache misses). */
  stmtCacheStats(): { size: number; misses: number } {
    return { size: this._stmtCache.size, misses: this._stmtCacheMisses };
  }

  open(): void {
    const Ctor = loadNodeSqlite();
    // Drop any statements cached against a previous handle — a re-open without an
    // intervening close() would otherwise reuse statements bound to the old DB.
    this._stmtCache.clear();
    this._db = new Ctor(this._path);
    this._db.exec(`PRAGMA busy_timeout = ${this._busyTimeout.toString()}`);
    if (this._wal) {
      this._db.exec('PRAGMA journal_mode = WAL');
    }
  }

  close(): void {
    // Drop cached statement references first so the DB can finalize them cleanly.
    this._stmtCache.clear();
    this._db?.close();
    this._db = null;
  }

  run(sql: string, params: unknown[] = []): void {
    this._prepared(sql).run(...params);
  }

  get(sql: string, params: unknown[] = []): Row | undefined {
    return this._prepared(sql).get(...params);
  }

  all(sql: string, params: unknown[] = []): Row[] {
    return this._prepared(sql).all(...params);
  }

  prepare(sql: string): PreparedStatement {
    const stmt = this._prepared(sql);
    return {
      run: (...params: unknown[]) => {
        const info = stmt.run(...params);
        return {
          changes: Number(info.changes),
          lastInsertRowid: info.lastInsertRowid,
        };
      },
      get: (...params: unknown[]) => stmt.get(...params),
      all: (...params: unknown[]) => stmt.all(...params),
    };
  }

  introspectColumns(table: string): string[] {
    const rows = this.all(`PRAGMA table_info("${table}")`);
    return rows.map((r) => r.name as string);
  }

  /** Mirror of SQLiteAdapter.addColumn — SQLite ALTER quirks are binding-agnostic. */
  addColumn(table: string, column: string, typeSpec: string): void {
    const upperType = typeSpec.toUpperCase();
    if (upperType.includes('PRIMARY KEY')) return;

    const hasNonConstantDefault =
      upperType.includes('CURRENT_TIMESTAMP') ||
      /DATETIME\s*\(\s*'NOW'\s*\)/i.test(typeSpec) ||
      upperType.includes('RANDOM()');

    if (hasNonConstantDefault) {
      const safeType = typeSpec
        .replace(/\bNOT\s+NULL\b/gi, '')
        .replace(/\bDEFAULT\s+\(?\s*CURRENT_TIMESTAMP\s*\)?/gi, '')
        .replace(/\bDEFAULT\s+\(?\s*datetime\([^)]*\)\s*\)?/gi, '')
        .replace(/\bDEFAULT\s+\(?\s*RANDOM\(\)\s*\)?/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      this.run(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${safeType || 'TEXT'}`);
      this.run(`UPDATE "${table}" SET "${column}" = CURRENT_TIMESTAMP WHERE "${column}" IS NULL`);
    } else {
      this.run(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${typeSpec}`);
    }
  }

  /**
   * O(1) watch-loop change-probe — same composition as SQLiteAdapter, but
   * `data_version` is read with a plain prepared statement because node:sqlite
   * has no `.pragma(name, { simple: true })` scalar helper.
   */
  changeProbe(): string {
    // Runs continuously on the watch loop — MUST reuse cached statements, or each tick
    // leaks two native statements for the process lifetime.
    const dataVersion = (this._prepared('PRAGMA data_version').get() as { data_version: number })
      .data_version;
    const totalChanges = (this._prepared('SELECT total_changes() AS n').get() as { n: number }).n;
    return `${String(dataVersion)}:${String(totalChanges)}`;
  }

  // ── Async surface (sync under the hood; mirrors SQLiteAdapter) ──────────
  // eslint-disable-next-line @typescript-eslint/require-await
  async runAsync(sql: string, params?: unknown[]): Promise<void> {
    this.run(sql, params);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getAsync(sql: string, params?: unknown[]): Promise<Row | undefined> {
    return this.get(sql, params);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async allAsync(sql: string, params?: unknown[]): Promise<Row[]> {
    return this.all(sql, params);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async introspectColumnsAsync(table: string): Promise<string[]> {
    return this.introspectColumns(table);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async introspectAllColumns(tables: string[]): Promise<Map<string, Set<string>>> {
    const map = new Map<string, Set<string>>();
    for (const t of tables) {
      try {
        const cols = this.introspectColumns(t);
        if (cols.length > 0) map.set(t, new Set(cols));
      } catch {
        /* absent */
      }
    }
    return map;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async addColumnAsync(table: string, column: string, typeSpec: string): Promise<void> {
    this.addColumn(table, column, typeSpec);
  }

  /** BEGIN/COMMIT around an awaited fn; ROLLBACK on throw. Mirror of SQLiteAdapter. */
  async withClient<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    const getSync = this.get.bind(this);
    const allSync = this.all.bind(this);
    const tx: TxClient = {
      run: (sql: string, params?: unknown[]) => {
        const info = this._prepared(sql).run(...(params ?? []));
        return Promise.resolve({ changes: Number(info.changes) });
      },
      get: (sql: string, params?: unknown[]) => Promise.resolve(getSync(sql, params ?? [])),
      all: (sql: string, params?: unknown[]) => Promise.resolve(allSync(sql, params ?? [])),
    };

    this.run('BEGIN');
    try {
      const result = await fn(tx);
      this.run('COMMIT');
      return result;
    } catch (err) {
      try {
        this.run('ROLLBACK');
      } catch {
        // Surface the original error, not a rollback failure on an aborted txn.
      }
      throw err;
    }
  }
}
