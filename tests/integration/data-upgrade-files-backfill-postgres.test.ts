/**
 * Regression — 4.3.8: the legacy `files` backfill ran
 *   UPDATE files SET ref_kind='local_ref', ref_uri=path, ref_provider='fs'
 *    WHERE path IS NOT NULL AND path <> '' AND ref_kind IS NULL AND blob_path IS NULL
 * but on a 3.x-origin `files` table the 4.x reference columns
 * (ref_kind/ref_uri/ref_provider/blob_path) don't exist yet — the cloud schema
 * reconcile that adds them is backgrounded, so the synchronous backfill hit
 * `column "ref_kind" does not exist` and aborted the whole workspace open. The
 * backfill must be self-sufficient (ensure its columns exist first) and the whole
 * open-time data upgrade must be fault-isolated (never fatal to the open).
 *
 * Postgres-gated.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { upgradeLegacyData } from '../../src/framework/data-upgrade.js';
import { getAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const dbs: Lattice[] = [];
const schemas: string[] = [];

function schemaUrl(schema: string): string {
  return `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function freshDb(prefix: string): Promise<Lattice> {
  const schema = `${prefix}_${randomBytes(4).toString('hex')}`;
  schemas.push(schema);
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  const db = new Lattice(schemaUrl(schema));
  dbs.push(db);
  await db.init(); // NB: no files entity defined → reconcile does NOT add the 4.x ref cols
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
  'postgres data upgrade — files backfill on a 3.x files table (4.3.8)',
  () => {
    it('does NOT throw when the 4.x ref columns are absent; it adds them + backfills', async () => {
      const db = await freshDb('filesbf');
      // A 3.x-shape files table: has `path`, lacks ref_kind/ref_uri/ref_provider/blob_path.
      await runAsyncOrSync(db.adapter, `CREATE TABLE "files" (id text primary key, path text)`);
      await runAsyncOrSync(
        db.adapter,
        `INSERT INTO "files"(id, path) VALUES ('f1', '/data/x.txt'), ('f2', '')`,
      );

      // Pre-fix this throws `column "ref_kind" does not exist` and aborts the open.
      await expect(upgradeLegacyData(db)).resolves.not.toThrow();

      // The path row is backfilled into the reference model; the empty-path row is left.
      const f1 = (await getAsyncOrSync(
        db.adapter,
        `SELECT ref_kind, ref_uri, ref_provider FROM "files" WHERE id='f1'`,
      )) as { ref_kind: string | null; ref_uri: string | null; ref_provider: string | null };
      expect(f1.ref_kind).toBe('local_ref');
      expect(f1.ref_uri).toBe('/data/x.txt');
      expect(f1.ref_provider).toBe('fs');

      const f2 = (await getAsyncOrSync(
        db.adapter,
        `SELECT ref_kind FROM "files" WHERE id='f2'`,
      )) as { ref_kind: string | null };
      expect(f2.ref_kind).toBeNull(); // empty path → not a resolvable local_ref
    });

    it('a failing open-time data upgrade is non-fatal (the open survives)', async () => {
      const db = await freshDb('filesfi');
      // A files table whose backfill UPDATE will error (a trigger), to prove the whole
      // upgradeLegacyData is fault-isolated and never aborts the open.
      await runAsyncOrSync(db.adapter, `CREATE TABLE "files" (id text primary key, path text)`);
      await runAsyncOrSync(db.adapter, `INSERT INTO "files"(id, path) VALUES ('f', '/data/y.txt')`);
      await runAsyncOrSync(
        db.adapter,
        `CREATE FUNCTION files_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`,
      );
      await runAsyncOrSync(
        db.adapter,
        `CREATE TRIGGER files_boom_t BEFORE UPDATE ON "files" FOR EACH ROW EXECUTE FUNCTION files_boom()`,
      );

      // Even though the backfill UPDATE errors, the upgrade resolves (warn + skip).
      await expect(upgradeLegacyData(db)).resolves.not.toThrow();
    });
  },
);

describe('sqlite data upgrade — files backfill is idempotent across re-opens (4.3.8)', () => {
  it('adds missing ref columns + backfills, and a RE-OPEN neither throws NOR spuriously warns', async () => {
    // SQLite's ADD COLUMN is NOT idempotent — it throws "duplicate column" if the
    // column exists. The legacy `path` is left in place, so the backfill gate stays
    // true on every open. If the backfill re-added the (now-present) ref columns it
    // would throw on the 2nd open; the fault isolation would then SILENTLY swallow a
    // warning every open. Adding only the MISSING columns is what keeps the re-open
    // clean — assert no warning fired to prove that, not just the fault isolation.
    const db = new Lattice(':memory:');
    await db.init();
    await runAsyncOrSync(db.adapter, `CREATE TABLE "files" (id text primary key, path text)`);
    await runAsyncOrSync(db.adapter, `INSERT INTO "files"(id, path) VALUES ('f1', '/data/x.txt')`);

    await upgradeLegacyData(db); // 1st open: adds the four TEXT ref cols + backfills

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(upgradeLegacyData(db)).resolves.not.toThrow(); // 2nd open
    expect(warn).not.toHaveBeenCalled(); // proves add-only-missing (no duplicate-column error to swallow)
    warn.mockRestore();

    const f1 = (await getAsyncOrSync(
      db.adapter,
      `SELECT ref_kind, ref_uri, ref_provider FROM "files" WHERE id='f1'`,
    )) as { ref_kind: string | null; ref_uri: string | null; ref_provider: string | null };
    expect(f1.ref_kind).toBe('local_ref');
    expect(f1.ref_uri).toBe('/data/x.txt');
    expect(f1.ref_provider).toBe('fs');
    db.close();
  });
});
