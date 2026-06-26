/**
 * Regression — 4.3.7: the legacy `deleted_at = '' -> NULL` normalization aborted the
 * whole workspace open when a cloud's `deleted_at` column was a real `timestamptz`
 * (not `text`). `UPDATE t SET deleted_at = NULL WHERE deleted_at = ''` forces Postgres
 * to parse `''::timestamptz` at PLAN time, which is invalid input — so the statement
 * throws regardless of data (a timestamptz column can't even hold ''). The
 * normalization must be TYPE-AWARE (only touch text-typed deleted_at columns) and
 * per-table fault-isolated (one bad table can't abort the open).
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { upgradeLegacyData } from '../../src/framework/data-upgrade.js';
import { getAsyncOrSync, runAsyncOrSync, allAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const dbs: Lattice[] = [];
const schemas: string[] = [];

function schemaUrl(schema: string): string {
  return `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
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
  'postgres data upgrade — type-aware deleted_at normalization (4.3.7)',
  () => {
    it('does NOT throw when deleted_at is a timestamptz column (and still normalizes text ones)', async () => {
      const schema = `dattz_${randomBytes(4).toString('hex')}`;
      schemas.push(schema);
      const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.end();

      const db = new Lattice(schemaUrl(schema));
      dbs.push(db);
      await db.init();

      // A cloud where deleted_at is a real timestamptz column (the user's case).
      await runAsyncOrSync(
        db.adapter,
        `CREATE TABLE "ts_tbl" (id text primary key, deleted_at timestamptz)`,
      );
      await runAsyncOrSync(
        db.adapter,
        `INSERT INTO "ts_tbl"(id, deleted_at) VALUES ('a', NULL), ('b', now())`,
      );
      // …and a legacy text deleted_at table that DOES carry '' rows to normalize.
      await runAsyncOrSync(
        db.adapter,
        `CREATE TABLE "txt_tbl" (id text primary key, deleted_at text)`,
      );
      await runAsyncOrSync(
        db.adapter,
        `INSERT INTO "txt_tbl"(id, deleted_at) VALUES ('x', ''), ('y', '2026-01-01T00:00:00Z')`,
      );
      // …and a DOMAIN-over-text deleted_at (reports data_type 'USER-DEFINED'): the
      // blacklist must still normalize it (an allow-list of text/varchar/char would
      // wrongly skip it, leaving '' rows that 4.x reads as deleted).
      await runAsyncOrSync(db.adapter, `CREATE DOMAIN dom_at AS text`);
      await runAsyncOrSync(
        db.adapter,
        `CREATE TABLE "dom_tbl" (id text primary key, deleted_at dom_at)`,
      );
      await runAsyncOrSync(db.adapter, `INSERT INTO "dom_tbl"(id, deleted_at) VALUES ('d', '')`);

      // Pre-fix this throws `invalid input syntax for type timestamp with time zone: ""`
      // and aborts. It must complete cleanly.
      await expect(upgradeLegacyData(db)).resolves.not.toThrow();

      // The timestamptz column is untouched (correct — it can't hold '').
      const tsRows = (await allAsyncOrSync(
        db.adapter,
        `SELECT id, deleted_at FROM "ts_tbl" ORDER BY id`,
      )) as { id: string; deleted_at: string | null }[];
      expect(tsRows.find((r) => r.id === 'a')?.deleted_at).toBeNull();
      expect(tsRows.find((r) => r.id === 'b')?.deleted_at).not.toBeNull();

      // The TEXT column's '' is normalized to NULL; a real value is untouched.
      const txtX = (await getAsyncOrSync(
        db.adapter,
        `SELECT deleted_at FROM "txt_tbl" WHERE id='x'`,
      )) as { deleted_at: string | null };
      const txtY = (await getAsyncOrSync(
        db.adapter,
        `SELECT deleted_at FROM "txt_tbl" WHERE id='y'`,
      )) as { deleted_at: string | null };
      expect(txtX.deleted_at).toBeNull();
      expect(txtY.deleted_at).toBe('2026-01-01T00:00:00Z');

      // The DOMAIN-over-text column's '' is normalized too (blacklist, not allow-list).
      const domD = (await getAsyncOrSync(
        db.adapter,
        `SELECT deleted_at FROM "dom_tbl" WHERE id='d'`,
      )) as { deleted_at: string | null };
      expect(domD.deleted_at).toBeNull();
    });

    it('one un-normalizable table does not abort the others (per-table fault isolation)', async () => {
      const schema = `datfi_${randomBytes(4).toString('hex')}`;
      schemas.push(schema);
      const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.end();

      const db = new Lattice(schemaUrl(schema));
      dbs.push(db);
      await db.init();

      // A text deleted_at table with '' to normalize…
      await runAsyncOrSync(
        db.adapter,
        `CREATE TABLE "good" (id text primary key, deleted_at text)`,
      );
      await runAsyncOrSync(db.adapter, `INSERT INTO "good"(id, deleted_at) VALUES ('g', '')`);
      // …and a text deleted_at column the connecting role can UPDATE-block via a trigger
      // that always errors, to prove one bad table is skipped, not fatal.
      await runAsyncOrSync(db.adapter, `CREATE TABLE "bad" (id text primary key, deleted_at text)`);
      await runAsyncOrSync(db.adapter, `INSERT INTO "bad"(id, deleted_at) VALUES ('b', '')`);
      await runAsyncOrSync(
        db.adapter,
        `CREATE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`,
      );
      await runAsyncOrSync(
        db.adapter,
        `CREATE TRIGGER bad_boom BEFORE UPDATE ON "bad" FOR EACH ROW EXECUTE FUNCTION boom()`,
      );

      await expect(upgradeLegacyData(db)).resolves.not.toThrow();

      // The good table WAS normalized despite the bad table erroring.
      const g = (await getAsyncOrSync(
        db.adapter,
        `SELECT deleted_at FROM "good" WHERE id='g'`,
      )) as { deleted_at: string | null };
      expect(g.deleted_at).toBeNull();
    });
  },
);
