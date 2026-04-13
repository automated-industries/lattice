import type { Row } from '../types.js';

/** Pluggable storage backend interface */
export interface StorageAdapter {
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
}

export interface PreparedStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
}
