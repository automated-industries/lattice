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
}

export interface PreparedStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
}
