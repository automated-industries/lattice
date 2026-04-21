/**
 * synckit worker for PostgresAdapter.
 *
 * The main thread sends one of the action verbs below; this worker owns the
 * pg.Client and runs the matching query. synckit blocks the main thread on
 * Atomics.wait until the worker posts its reply.
 */
import { runAsWorker } from 'synckit';
// pg is loaded dynamically so SQLite-only consumers don't pay the install cost.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client } = require('pg') as typeof import('pg');

type Action =
  | { type: 'open'; connectionString: string }
  | { type: 'close' }
  | { type: 'run'; sql: string; params: unknown[] }
  | { type: 'get'; sql: string; params: unknown[] }
  | { type: 'all'; sql: string; params: unknown[] }
  | { type: 'introspectColumns'; table: string }
  | { type: 'addColumn'; table: string; column: string; typeSpec: string };

type Result =
  | { ok: true; rows?: Record<string, unknown>[]; rowCount?: number }
  | { ok: false; error: string };

let client: import('pg').Client | null = null;

function ensureClient(): import('pg').Client {
  if (!client) throw new Error('PostgresAdapter worker: client not opened');
  return client;
}

runAsWorker(async (action: Action): Promise<Result> => {
  try {
    switch (action.type) {
      case 'open': {
        if (client) return { ok: true };
        client = new Client({ connectionString: action.connectionString });
        await client.connect();
        // Idempotently enable pgcrypto for gen_random_bytes() — needed by the
        // randomblob() translation. Non-fatal on providers that restrict
        // CREATE EXTENSION (the extension may already be enabled elsewhere).
        try {
          await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
        } catch (extErr) {
          console.warn(
            '[PostgresAdapter] CREATE EXTENSION pgcrypto failed (may already be enabled by your provider):',
            extErr instanceof Error ? extErr.message : extErr,
          );
        }
        // Register a SQLite-compatible `json_extract(doc, path)` polyfill so
        // migrations written against SQLite's JSON syntax work on Postgres
        // unchanged. Path is the SQLite-flavored `$.a.b.c` form — strip the
        // leading `$.` and split on `.` to feed Postgres's `jsonb #>> array`
        // operator. Non-fatal if CREATE FUNCTION is permission-restricted.
        try {
          await client.query(
            `CREATE OR REPLACE FUNCTION json_extract(doc text, path text)
             RETURNS text
             LANGUAGE sql
             IMMUTABLE
             AS $fn$
               SELECT doc::jsonb #>> string_to_array(regexp_replace(path, '^\\$\\.?', ''), '.')
             $fn$;`,
          );
        } catch (jeErr) {
          console.warn(
            '[PostgresAdapter] could not register json_extract polyfill:',
            jeErr instanceof Error ? jeErr.message : jeErr,
          );
        }
        // strftime polyfill — handles the common `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
        // pattern used for ISO-with-milliseconds timestamps. Other format strings
        // fall through to a best-effort token replacement. The `modifier`
        // argument supports 'now' and ISO-formatted strings.
        try {
          await client.query(
            `CREATE OR REPLACE FUNCTION strftime(format text, modifier text)
             RETURNS text
             LANGUAGE plpgsql
             IMMUTABLE
             AS $fn$
             DECLARE ts timestamptz;
             BEGIN
               IF modifier = 'now' THEN
                 ts := now();
               ELSE
                 ts := modifier::timestamptz;
               END IF;
               RETURN to_char(
                 ts AT TIME ZONE 'UTC',
                 replace(replace(replace(replace(replace(replace(replace(replace(
                   format,
                   '%Y', 'YYYY'),
                   '%m', 'MM'),
                   '%d', 'DD'),
                   '%H', 'HH24'),
                   '%M', 'MI'),
                   '%S', 'SS'),
                   '%f', 'MS'),
                   'T', '"T"')
               );
             END;
             $fn$;`,
          );
        } catch (sfErr) {
          console.warn(
            '[PostgresAdapter] could not register strftime polyfill:',
            sfErr instanceof Error ? sfErr.message : sfErr,
          );
        }
        return { ok: true };
      }
      case 'close': {
        if (client) {
          await client.end();
          client = null;
        }
        return { ok: true };
      }
      case 'run': {
        const r = await ensureClient().query(action.sql, action.params);
        return { ok: true, rowCount: r.rowCount ?? 0 };
      }
      case 'get': {
        const r = await ensureClient().query<Record<string, unknown>>(action.sql, action.params);
        return { ok: true, rows: r.rows.slice(0, 1) };
      }
      case 'all': {
        const r = await ensureClient().query<Record<string, unknown>>(action.sql, action.params);
        return { ok: true, rows: r.rows };
      }
      case 'introspectColumns': {
        const r = await ensureClient().query<Record<string, unknown>>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = $1
           ORDER BY ordinal_position`,
          [action.table],
        );
        return { ok: true, rows: r.rows };
      }
      case 'addColumn': {
        // Postgres accepts non-constant defaults (NOW(), random(), CURRENT_TIMESTAMP)
        // natively in ALTER TABLE ADD COLUMN. Skip PRIMARY KEY columns — same
        // reasoning as SQLite (existing tables already have a PK).
        const upper = action.typeSpec.toUpperCase();
        if (upper.includes('PRIMARY KEY')) return { ok: true };
        const translated = translateTypeSpec(action.typeSpec);
        await ensureClient().query(
          `ALTER TABLE "${action.table}" ADD COLUMN IF NOT EXISTS "${action.column}" ${translated}`,
        );
        return { ok: true };
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

function translateTypeSpec(typeSpec: string): string {
  return typeSpec
    .replace(/\bBLOB\b/gi, 'BYTEA')
    .replace(/\bdatetime\(\s*'now'\s*\)/gi, 'NOW()')
    .replace(/\bRANDOM\(\)/gi, 'random()');
}
