import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorageAdapter, PreparedStatement } from './adapter.js';
import type { Row } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Pluggable Postgres backend for Lattice.
 *
 * Implementation note: the StorageAdapter interface is synchronous (because
 * better-sqlite3 is sync), but every Node Postgres client is async. We bridge
 * that gap with a synckit worker thread — the worker owns the pg.Client and
 * runs each query asynchronously; the main thread blocks on Atomics.wait via
 * synckit's createSyncFn. Each query pays ~1-3 ms of message-passing overhead,
 * which is fine for Lattice's batch-insert + periodic-render workload.
 *
 * If/when a workload genuinely needs OLTP-grade throughput, we can introduce
 * an async StorageAdapter variant without breaking SQLite consumers.
 *
 * Optional dependencies: `pg` and `synckit` are listed in `optionalDependencies`
 * — SQLite-only consumers don't pay the install cost. The constructor throws
 * a clear error if either is missing.
 */
export interface PostgresAdapterOptions {
  /** Override the worker file path. Useful in test setups. */
  workerPath?: string;
}

export class PostgresAdapter implements StorageAdapter {
  private readonly _connectionString: string;
  private readonly _workerPath: string;
  private _syncFn: ((action: unknown) => unknown) | null = null;
  private _opened = false;

  constructor(connectionString: string, options: PostgresAdapterOptions = {}) {
    this._connectionString = connectionString;
    this._workerPath = options.workerPath ?? path.join(__dirname, 'postgres-worker.js');
  }

  open(): void {
    if (this._opened) return;
    let createSyncFn: (worker: string) => (action: unknown) => unknown;
    try {
      // Dynamic require so SQLite-only consumers don't need synckit installed.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ({ createSyncFn } = require('synckit') as typeof import('synckit'));
    } catch {
      throw new Error(
        "PostgresAdapter requires 'pg' and 'synckit'. Install with:\n  npm install pg synckit",
      );
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('pg');
    } catch {
      throw new Error(
        "PostgresAdapter requires 'pg' and 'synckit'. Install with:\n  npm install pg synckit",
      );
    }
    this._syncFn = createSyncFn(this._workerPath);
    this._call({ type: 'open', connectionString: this._connectionString });
    this._opened = true;
  }

  close(): void {
    if (!this._opened) return;
    this._call({ type: 'close' });
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
 * Translate `?` positional placeholders to Postgres `$N` placeholders. Skips
 * over single-quoted string literals and double-quoted identifiers so a `?`
 * inside one of those is left alone. Single-line and block comments are also
 * passed through unchanged (they cannot contain real `?` parameters).
 */
function rewrite(sql: string): string {
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
        out += sql[i];
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
        out += sql[i];
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
        out += sql[i];
        i++;
      }
      continue;
    }
    // Block comment
    if (ch === '/' && sql[i + 1] === '*') {
      out += '/*';
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql[i];
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
    out += ch;
    i++;
  }
  return out;
}

/** Exposed for unit testing. */
export const _rewriteForTest = rewrite;
