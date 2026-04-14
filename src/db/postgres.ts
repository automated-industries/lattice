import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { StorageAdapter, PreparedStatement } from './adapter.js';
import type { Row } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In an ESM bundle, the global `require` is not defined and tsup's `__require`
// shim throws "Dynamic require of '...' is not supported". We need a real
// runtime `require` to load `pg` and `synckit` (which are optionalDependencies
// the consumer installs into their node_modules). createRequire solves this:
// it builds a CommonJS `require` rooted at the URL of this file, so it walks
// up from `latticesql/dist/` and finds the consumer's `node_modules` entries.
const requireFromHere = createRequire(import.meta.url);

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
      // requireFromHere = createRequire(import.meta.url). Lets us load
      // optionalDependencies from the consumer's node_modules without relying
      // on the bundler's `__require` shim (which throws under ESM).
      ({ createSyncFn } = requireFromHere('synckit') as typeof import('synckit'));
    } catch (err) {
      throw new Error(
        "PostgresAdapter requires 'synckit'. Install with: npm install synckit\n" +
          'Underlying error: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    try {
      requireFromHere('pg');
    } catch (err) {
      throw new Error(
        "PostgresAdapter requires 'pg'. Install with: npm install pg\n" +
          'Underlying error: ' +
          (err instanceof Error ? err.message : String(err)),
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
  let hadInsertOrIgnore = false;
  let s = mapCodeRegions(sql, (code) => {
    return code.replace(/INSERT(\s+)OR\s+IGNORE(\s+)INTO/gi, (_m, w1, _w2) => {
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
    code.replace(/CREATE(\s+)VIEW(\s+)IF\s+NOT\s+EXISTS/gi, (_m, w1, _w2) => {
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
      "PostgresAdapter: datetime(" +
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
