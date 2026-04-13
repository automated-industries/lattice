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
    // .cjs extension because the published package.json has `"type": "module"`
    // and the worker is built as CJS — Node refuses to run a `.js` CJS file
    // under `type: module`. tsup emits the worker as `dist/postgres-worker.cjs`.
    this._workerPath = options.workerPath ?? path.join(__dirname, 'postgres-worker.cjs');
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

  // INSERT OR IGNORE → INSERT INTO + trailing ON CONFLICT DO NOTHING. We
  // protect string literals here because user data containing those keywords
  // is plausible (e.g. agent prompt text). The function-call translations
  // below span string boundaries (hex('abc')), so they intentionally don't
  // get the same protection.
  let s = mapCodeRegions(sql, (code) => {
    let mutated = code;
    let needsOnConflict = false;
    mutated = mutated.replace(/INSERT(\s+)OR\s+IGNORE(\s+)INTO/gi, (_m, w1, _w2) => {
      needsOnConflict = true;
      return `INSERT${w1}INTO`;
    });
    if (needsOnConflict && !/ON\s+CONFLICT/i.test(mutated)) {
      // Append ON CONFLICT DO NOTHING — but only if the user hasn't already
      // written an explicit ON CONFLICT clause (which would conflict with
      // ours). For a single-statement migration this is straightforward; for
      // multi-statement scripts the user should split before passing in.
      mutated = mutated.replace(/(\s*;?\s*)$/, ' ON CONFLICT DO NOTHING$1');
    }
    return mutated;
  });

  // Function-call translations: hex(<expr>) → encode(<expr>, 'hex'), and
  // randomblob(N) → gen_random_bytes(N). These need to match across string
  // boundaries (the argument may be a string literal), so they don't go
  // through mapCodeRegions. Order matters: hex() wraps randomblob() in our
  // common UUID pattern, so translate hex first.
  s = replaceFunction(s, 'hex', (arg) => `encode(${arg}, 'hex')`);
  s = replaceFunction(s, 'randomblob', (arg) => `gen_random_bytes(${arg})`);

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
        out += sql[i];
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
        out += sql[i];
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
        out += sql[i];
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
        out += sql[i];
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

function rewrite(sql: string): string {
  return rewriteParams(translateDialect(sql));
}

/** Exposed for unit testing. */
export const _rewriteForTest = rewrite;
export const _translateDialectForTest = translateDialect;
