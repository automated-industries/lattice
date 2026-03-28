/**
 * Writeback State Store — pluggable persistence for offset/dedup tracking.
 *
 * Default: InMemoryStateStore (existing behavior, lost on process exit).
 * Optional: SQLiteStateStore (survives restarts, auto-creates tracking tables).
 */

import type Database from 'better-sqlite3';

/**
 * Interface for writeback state persistence.
 * Implementations track file offsets and seen entry keys.
 */
export interface WritebackStateStore {
  /** Get the byte offset for a file. Returns 0 if unknown. */
  getOffset(filePath: string): number;
  /** Get the last known file size. Returns 0 if unknown. */
  getSize(filePath: string): number;
  /** Set the byte offset and file size for a file. */
  setOffset(filePath: string, offset: number, size: number): void;
  /** Check if an entry key has been seen for a file. */
  isSeen(filePath: string, key: string): boolean;
  /** Mark an entry key as seen for a file. */
  markSeen(filePath: string, key: string): void;
}

/**
 * In-memory state store (default). State is lost on process exit.
 */
export class InMemoryStateStore implements WritebackStateStore {
  private readonly _offsets = new Map<string, { offset: number; size: number }>();
  private readonly _seen = new Map<string, Set<string>>();

  getOffset(filePath: string): number {
    return this._offsets.get(filePath)?.offset ?? 0;
  }

  getSize(filePath: string): number {
    return this._offsets.get(filePath)?.size ?? 0;
  }

  setOffset(filePath: string, offset: number, size: number): void {
    this._offsets.set(filePath, { offset, size });
  }

  isSeen(filePath: string, key: string): boolean {
    return this._seen.get(filePath)?.has(key) ?? false;
  }

  markSeen(filePath: string, key: string): void {
    if (!this._seen.has(filePath)) this._seen.set(filePath, new Set());
    this._seen.get(filePath)!.add(key);
  }
}

/**
 * SQLite-backed state store. Survives process restarts.
 * Auto-creates tracking tables on first use.
 */
export class SQLiteStateStore implements WritebackStateStore {
  private readonly _db: Database.Database;
  private _initialized = false;

  constructor(db: Database.Database) {
    this._db = db;
  }

  private _init(): void {
    if (this._initialized) return;
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS _lattice_writeback_offset (
        file_path TEXT PRIMARY KEY,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        file_size INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS _lattice_writeback_seen (
        file_path TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (file_path, entry_key)
      );
    `);
    this._initialized = true;
  }

  getOffset(filePath: string): number {
    this._init();
    const row = this._db.prepare('SELECT byte_offset FROM _lattice_writeback_offset WHERE file_path = ?').get(filePath) as { byte_offset: number } | undefined;
    return row?.byte_offset ?? 0;
  }

  getSize(filePath: string): number {
    this._init();
    const row = this._db.prepare('SELECT file_size FROM _lattice_writeback_offset WHERE file_path = ?').get(filePath) as { file_size: number } | undefined;
    return row?.file_size ?? 0;
  }

  setOffset(filePath: string, offset: number, size: number): void {
    this._init();
    this._db.prepare(`
      INSERT INTO _lattice_writeback_offset (file_path, byte_offset, file_size, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(file_path) DO UPDATE SET byte_offset = ?, file_size = ?, updated_at = datetime('now')
    `).run(filePath, offset, size, offset, size);
  }

  isSeen(filePath: string, key: string): boolean {
    this._init();
    return !!this._db.prepare('SELECT 1 FROM _lattice_writeback_seen WHERE file_path = ? AND entry_key = ?').get(filePath, key);
  }

  markSeen(filePath: string, key: string): void {
    this._init();
    this._db.prepare('INSERT OR IGNORE INTO _lattice_writeback_seen (file_path, entry_key) VALUES (?, ?)').run(filePath, key);
  }
}

/**
 * Factory to create a SQLite-backed state store from a better-sqlite3 Database.
 */
export function createSQLiteStateStore(db: Database.Database): WritebackStateStore {
  return new SQLiteStateStore(db);
}
