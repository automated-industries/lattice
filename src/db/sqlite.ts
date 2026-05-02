import Database from 'better-sqlite3';
import type { StorageAdapter, PreparedStatement, TxClient } from './adapter.js';
import type { Row } from '../types.js';

export class SQLiteAdapter implements StorageAdapter {
  readonly dialect = 'sqlite' as const;
  private _db: Database.Database | null = null;
  private readonly _path: string;
  private readonly _wal: boolean;
  private readonly _busyTimeout: number;

  constructor(path: string, options?: { wal?: boolean; busyTimeout?: number }) {
    this._path = path;
    this._wal = options?.wal ?? true;
    this._busyTimeout = options?.busyTimeout ?? 5000;
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
    this._db?.close();
    this._db = null;
  }

  run(sql: string, params: unknown[] = []): void {
    this.db.prepare(sql).run(...params);
  }

  get(sql: string, params: unknown[] = []): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  all(sql: string, params: unknown[] = []): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  prepare(sql: string): PreparedStatement {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params: unknown[]) =>
        stmt.run(...params) as { changes: number; lastInsertRowid: number | bigint },
      get: (...params: unknown[]) => stmt.get(...params) as Row | undefined,
      all: (...params: unknown[]) => stmt.all(...params) as Row[],
    };
  }

  introspectColumns(table: string): string[] {
    const rows = this.all(`PRAGMA table_info("${table}")`);
    return rows.map((r) => r.name as string);
  }

  /**
   * SQLite ALTER TABLE ADD COLUMN requires constant defaults. CURRENT_TIMESTAMP,
   * datetime('now'), and RANDOM() are non-constant and reject. Strip them for
   * the ALTER, then backfill existing rows. Skip PRIMARY KEY columns — SQLite
   * cannot add those via ALTER, and if the table exists it has its own PK.
   */
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
        .replace(/\bDEFAULT\s+CURRENT_TIMESTAMP\b/gi, '')
        .replace(/\bDEFAULT\s+datetime\([^)]*\)/gi, '')
        .replace(/\bDEFAULT\s+RANDOM\(\)/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      this.run(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${safeType || 'TEXT'}`);
      this.run(`UPDATE "${table}" SET "${column}" = CURRENT_TIMESTAMP WHERE "${column}" IS NULL`);
    } else {
      this.run(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${typeSpec}`);
    }
  }

  /**
   * Run `fn` inside a BEGIN/COMMIT block on the single SQLite connection.
   * The TxClient surface delegates to the same underlying database as the
   * sync surface — there's no separate connection pool to worry about.
   * This exists for cross-dialect parity with PostgresAdapter.withClient.
   *
   * Throws inside `fn` cause an automatic ROLLBACK; otherwise the
   * transaction commits when `fn` resolves.
   *
   * Better-sqlite3 ships its own `db.transaction(fn)` helper, but it takes
   * a synchronous function. Our contract takes an async `fn` (because the
   * Postgres path needs to await DB I/O), so we issue BEGIN/COMMIT/ROLLBACK
   * manually around the awaited call. SQLite's busy_timeout pragma already
   * handles concurrent-writer waiting.
   */
  async withClient<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    const dbRef = this.db;
    const getSync = this.get.bind(this);
    const allSync = this.all.bind(this);
    const tx: TxClient = {
      run: (sql: string, params?: unknown[]) => {
        const info = dbRef.prepare(sql).run(...(params ?? []));
        return Promise.resolve({ changes: info.changes });
      },
      get: (sql: string, params?: unknown[]) => {
        return Promise.resolve(getSync(sql, params ?? []));
      },
      all: (sql: string, params?: unknown[]) => {
        return Promise.resolve(allSync(sql, params ?? []));
      },
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
        // Rollback can fail if the connection is already in an aborted state;
        // we surface the original error rather than the rollback failure.
      }
      throw err;
    }
  }
}
