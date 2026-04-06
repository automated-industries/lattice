import Database from 'better-sqlite3';
import type { StorageAdapter, PreparedStatement } from './adapter.js';
import type { Row } from '../types.js';

/** Regex matching SQL that should bypass the prepared-statement cache (DDL / PRAGMA). */
const DDL_RE = /^\s*(CREATE|ALTER|DROP|PRAGMA)\b/i;

/** Default maximum number of cached prepared statements. */
const DEFAULT_CACHE_MAX = 500;

export class SQLiteAdapter implements StorageAdapter {
  private _db: Database.Database | null = null;
  private readonly _path: string;
  private readonly _wal: boolean;
  private readonly _busyTimeout: number;

  /** Cached prepared statements keyed by SQL string. */
  private _stmtCache = new Map<string, Database.Statement>();
  private readonly _cacheMax: number;

  constructor(path: string, options?: { wal?: boolean; busyTimeout?: number; cacheMax?: number }) {
    this._path = path;
    this._wal = options?.wal ?? true;
    this._busyTimeout = options?.busyTimeout ?? 5000;
    this._cacheMax = options?.cacheMax ?? DEFAULT_CACHE_MAX;
  }

  get db(): Database.Database {
    if (!this._db) throw new Error('SQLiteAdapter: not open — call open() first');
    return this._db;
  }

  open(): void {
    this._db = new Database(this._path);
    this._db.pragma(`busy_timeout = ${this._busyTimeout.toString()}`);
    if (this._wal) {
      this._db.pragma('journal_mode = WAL');
    }
  }

  close(): void {
    this._stmtCache.clear();
    this._db?.close();
    this._db = null;
  }

  /** Clear the prepared-statement cache. Call after DDL changes (schema/migrations). */
  clearStatementCache(): void {
    this._stmtCache.clear();
  }

  /**
   * Return a cached prepared statement for the given SQL, or compile and cache a new one.
   * DDL statements bypass the cache entirely.
   */
  private _cachedPrepare(sql: string): Database.Statement {
    if (DDL_RE.test(sql)) {
      return this.db.prepare(sql);
    }
    let stmt = this._stmtCache.get(sql);
    if (stmt) return stmt;
    stmt = this.db.prepare(sql);
    if (this._stmtCache.size >= this._cacheMax) {
      this._stmtCache.clear();
    }
    this._stmtCache.set(sql, stmt);
    return stmt;
  }

  run(sql: string, params: unknown[] = []): void {
    this._cachedPrepare(sql).run(...params);
  }

  get(sql: string, params: unknown[] = []): Row | undefined {
    return this._cachedPrepare(sql).get(...params) as Row | undefined;
  }

  all(sql: string, params: unknown[] = []): Row[] {
    return this._cachedPrepare(sql).all(...params) as Row[];
  }

  /** Execute raw SQL that may contain multiple statements (e.g. migrations). */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    const stmt = this._cachedPrepare(sql);
    return {
      run: (...params: unknown[]) =>
        stmt.run(...params) as { changes: number; lastInsertRowid: number | bigint },
      get: (...params: unknown[]) => stmt.get(...params) as Row | undefined,
      all: (...params: unknown[]) => stmt.all(...params) as Row[],
    };
  }
}
