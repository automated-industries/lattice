/**
 * A short-lived connection pool to an EXTERNAL database (the one a user connects
 * as a db-source Input) — deliberately NOT the global StorageAdapter, which is
 * Lattice's own DB. Opens a small pool, runs the supplied work, and always closes
 * it. `pg` is lazy-required (an optionalDependency) with a clear, actionable error
 * if absent, mirroring PostgresAdapter; the Supabase session→transaction pooler
 * rewrite is reused so external Supabase DBs connect on 6543 too.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { toTransactionPoolerUrl } from '../../db/postgres.js';

/** The minimal external-pool surface the connector depends on (query only). */
export interface ExternalPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface PgPoolInstance {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
  on(event: 'error', cb: (err: Error) => void): void;
}
interface PgModule {
  Pool: new (cfg: {
    connectionString: string;
    max?: number;
    /** Postgres startup parameters (e.g. a read-only session default). */
    options?: string;
  }) => PgPoolInstance;
}

/**
 * External-database connections are READ-ONLY by contract — a data-source import
 * must never be able to write to the source. Enforced in depth:
 *
 *  1. WIRE level — every pooled connection starts with
 *     `default_transaction_read_only = on` (a Postgres startup parameter), so the
 *     server itself refuses writes even if a statement slipped past the guard.
 *  2. QUERY level — the pool wrapper only forwards read-shaped statements
 *     (SELECT / WITH / SHOW / EXPLAIN). Anything else throws HERE, loudly,
 *     before touching the network — poolers that strip startup parameters
 *     (some transaction poolers do) are still covered by this layer.
 */
const READ_ONLY_STARTUP = '-c default_transaction_read_only=on';
const READ_KEYWORDS = new Set(['select', 'with', 'show', 'explain']);

/** Throw unless `sql` is a read-shaped statement (see READ-ONLY contract above). */
export function assertReadOnlySql(sql: string): void {
  // Strip leading whitespace + line/block comments to find the first keyword.
  const stripped = sql
    .replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/g, '')
    .trimStart()
    .toLowerCase();
  const keyword = /^[a-z]+/.exec(stripped)?.[0] ?? '';
  if (!READ_KEYWORDS.has(keyword)) {
    throw new Error(
      `external database connections are read-only — refusing to run "${keyword || sql.slice(0, 20)}…"`,
    );
  }
}

// Lazy `require('pg')` resolved against this module's directory (works under both
// the ESM and CJS builds), mirroring db/postgres.ts.
let _require: NodeJS.Require | null = null;
function moduleRequire(): NodeJS.Require {
  if (_require) return _require;
  const importMetaUrl = (import.meta as { url?: string }).url;
  _require = importMetaUrl ? createRequire(fileURLToPath(importMetaUrl)) : require;
  return _require;
}

function loadPg(): PgModule {
  let pg: PgModule;
  try {
    pg = moduleRequire()('pg') as PgModule;
  } catch (err) {
    throw new Error(
      "The database connector requires 'pg'. Install it with: npm install pg\n" +
        'Underlying error: ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  return pg;
}

/**
 * Open a short-lived pool to `connectionString`, run `fn`, and ALWAYS close it.
 * A small pool (this is for bounded import reads, not Lattice's own workload). An
 * idle-client 'error' is logged + swallowed so a transient drop can't crash the
 * process (mirrors PostgresAdapter).
 */
export async function withExternalPool<T>(
  connectionString: string,
  fn: (pool: ExternalPool) => Promise<T>,
): Promise<T> {
  const { pool, close } = openExternalPool(connectionString);
  try {
    return await fn(pool);
  } finally {
    await close();
  }
}

/**
 * Open a short-lived pool to `connectionString`. Returns the query surface plus a
 * `close()` the caller MUST invoke in a `finally`. Used by the streaming
 * `listChanges` generator, which pages with the pool held open across yields.
 */
export function openExternalPool(connectionString: string): {
  pool: ExternalPool;
  close: () => Promise<void>;
} {
  const pg = loadPg();
  const instance = new pg.Pool({
    connectionString: toTransactionPoolerUrl(connectionString),
    max: 4,
    // Layer 1 of the read-only contract (see above).
    options: READ_ONLY_STARTUP,
  });
  instance.on('error', (err: Error) => {
    console.error('[latticesql] recovered from idle external-db client error:', err.message);
  });
  return {
    pool: {
      query: (sql, params) => {
        // Layer 2 of the read-only contract: reject non-read statements before
        // they ever reach the source database.
        assertReadOnlySql(sql);
        return instance.query(sql, params);
      },
    },
    close: () =>
      instance
        .end()
        .then(() => undefined)
        .catch(() => undefined),
  };
}
