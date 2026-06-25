/**
 * Regression — 4.3.3: opening a 3.x-created Postgres cloud workspace on 4.x aborted
 * with `invalid input syntax for type timestamp with time zone: ""`. 3.x persisted
 * nullable TEXT timestamp columns as '' (empty string); the SQLite-compat `strftime`
 * polyfill cast its modifier straight to timestamptz, so any open-time query that ran
 * `strftime(fmt, <a '' value>)` threw and bricked the whole workspace open. The
 * polyfill is the ONLY `::timestamptz` cast site in the codebase, so making it
 * empty-/invalid-safe (return NULL, SQLite's semantics) fixes the open.
 *
 * Also covers: the 3-arg `strftime(format, timestring, modifier)` overload the
 * changelog retention prune needs (Postgres had no 3-arg form → "function does not
 * exist"), and the CREATE-OR-REPLACE upgrade path (an existing cloud's prior broken
 * function must be replaced, not left in place by an IF-absent guard).
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { registerPostgresPolyfills } from '../../src/db/postgres.js';
import { getAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const dbs: Lattice[] = [];
const schemas: string[] = [];

function schemaUrl(schema: string): string {
  return `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function open(): Promise<Lattice> {
  const schema = `strf_${randomBytes(4).toString('hex')}`;
  schemas.push(schema);
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  const db = new Lattice(schemaUrl(schema));
  dbs.push(db);
  await db.init(); // registers the polyfills
  return db;
}

afterEach(async () => {
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      /* noop */
    }
  }
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const s of schemas.splice(0)) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  await admin.end();
});

describe.skipIf(!PG_URL)(
  'postgres strftime polyfill — empty/invalid timestamp safety (4.3.3)',
  () => {
    it('strftime(fmt, "") returns NULL instead of throwing (the open-bricking cast)', async () => {
      const db = await open();
      const row = (await getAsyncOrSync(
        db.adapter,
        `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', '') AS x`,
      )) as { x: string | null };
      expect(row.x).toBeNull();
    });

    it('strftime over a TEXT column holding "" returns NULL (the actual 3.x mechanism)', async () => {
      const db = await open();
      await runAsyncOrSync(
        db.adapter,
        `CREATE TABLE "legacy" (id text primary key, created_at text)`,
      );
      await runAsyncOrSync(db.adapter, `INSERT INTO "legacy"(id, created_at) VALUES ('a', '')`);
      // Pre-fix this threw `invalid input syntax for type timestamp with time zone: ""`.
      const row = (await getAsyncOrSync(
        db.adapter,
        `SELECT strftime('%Y', created_at) AS x FROM "legacy" WHERE id='a'`,
      )) as { x: string | null };
      expect(row.x).toBeNull();
    });

    it('a real "now" modifier still formats correctly', async () => {
      const db = await open();
      const row = (await getAsyncOrSync(db.adapter, `SELECT strftime('%Y', 'now') AS x`)) as {
        x: string;
      };
      expect(row.x).toMatch(/^\d{4}$/);
    });

    it('a malformed (non-empty) legacy value returns NULL, never throws', async () => {
      const db = await open();
      const row = (await getAsyncOrSync(
        db.adapter,
        `SELECT strftime('%Y', 'not-a-date') AS x`,
      )) as { x: string | null };
      expect(row.x).toBeNull();
    });

    it('3-arg strftime(format, "now", modifier) works (changelog retention prune form)', async () => {
      const db = await open();
      // The exact shape the changelog prune emits: previously "function does not exist".
      await runAsyncOrSync(
        db.adapter,
        `CREATE TABLE "__lattice_changelog" (id text primary key, created_at text)`,
      );
      await runAsyncOrSync(
        db.adapter,
        `INSERT INTO "__lattice_changelog"(id, created_at) VALUES ('old', '2000-01-01T00:00:00.000Z')`,
      );
      await runAsyncOrSync(
        db.adapter,
        `INSERT INTO "__lattice_changelog"(id, created_at) VALUES ('new', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      );
      await runAsyncOrSync(
        db.adapter,
        `DELETE FROM "__lattice_changelog" WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', $1)`,
        ['-30 days'],
      );
      const rows = (await getAsyncOrSync(
        db.adapter,
        `SELECT count(*)::int AS n FROM "__lattice_changelog"`,
      )) as { n: number };
      expect(rows.n).toBe(1); // the year-2000 row pruned, the fresh one kept
    });

    it('CREATE OR REPLACE upgrades a prior (pre-4.3.3) strftime that threw on ""', async () => {
      const db = await open();
      // Simulate an existing 3.x cloud whose strftime is the OLD, unsafe definition.
      await runAsyncOrSync(
        db.adapter,
        `CREATE OR REPLACE FUNCTION strftime(format text, modifier text)
         RETURNS text LANGUAGE plpgsql IMMUTABLE AS $fn$
         DECLARE ts timestamptz;
         BEGIN
           IF modifier = 'now' THEN ts := now(); ELSE ts := modifier::timestamptz; END IF;
           RETURN to_char(ts, 'YYYY');
         END; $fn$;`,
      );
      // The old one throws on '' …
      let threw = false;
      try {
        await getAsyncOrSync(db.adapter, `SELECT strftime('%Y', '') AS x`);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      // … re-running polyfill registration (what the owner does on open) UPGRADES it.
      await registerPostgresPolyfills((sql) => runAsyncOrSync(db.adapter, sql));
      const row = (await getAsyncOrSync(db.adapter, `SELECT strftime('%Y', '') AS x`)) as {
        x: string | null;
      };
      expect(row.x).toBeNull(); // now empty-safe
    });
  },
);
