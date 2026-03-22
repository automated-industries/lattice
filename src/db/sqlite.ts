import Database from 'better-sqlite3';
import type { StorageAdapter, PreparedStatement } from './adapter.js';
import type { Row } from '../types.js';

export class SQLiteAdapter implements StorageAdapter {
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
}
