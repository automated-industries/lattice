/**
 * Postgres data-upgrade: the legacy `deleted_at = '' → NULL` normalization must run
 * as ONE server-side migration (a single DO block looping the deleted_at tables),
 * NOT one db.migrate transaction per table. A cloud has 100+ tables and connects
 * through a pooler, so a per-table loop = 100+ pooler transactions, which stalled
 * the workspace switch past its 20s open timeout. This pins both the correctness
 * (every table's '' normalized) AND the shape (exactly one `…:all` sentinel — never
 * a per-table sentinel).
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { upgradeLegacyData } from '../../src/framework/data-upgrade.js';
import { runAsyncOrSync, getAsyncOrSync, allAsyncOrSync } from '../../src/db/adapter.js';

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
      /* best-effort */
    }
  }
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const s of schemas.splice(0)) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  await admin.end();
});

describe.skipIf(!PG_URL)('postgres data upgrade — single-DO-block deleted_at normalization', () => {
  it('normalizes every deleted_at table in ONE migration (one :all sentinel, not per-table)', async () => {
    const schema = `dau_${randomBytes(4).toString('hex')}`;
    schemas.push(schema);
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();

    const db = new Lattice(schemaUrl(schema));
    dbs.push(db);
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'notes.md',
    });
    db.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'tasks.md',
    });
    await db.init();

    await runAsyncOrSync(
      db.adapter,
      `INSERT INTO "notes" (id, body, deleted_at) VALUES ('n1','a','')`,
    );
    await runAsyncOrSync(
      db.adapter,
      `INSERT INTO "tasks" (id, title, deleted_at) VALUES ('t1','x','')`,
    );
    await runAsyncOrSync(
      db.adapter,
      `INSERT INTO "notes" (id, body, deleted_at) VALUES ('n2','b','2026-01-01T00:00:00Z')`,
    );

    await upgradeLegacyData(db);

    // Correctness: every table's '' normalized to NULL; a real delete untouched.
    const n1 = (await getAsyncOrSync(
      db.adapter,
      `SELECT deleted_at FROM "notes" WHERE id='n1'`,
    )) as {
      deleted_at: string | null;
    };
    const t1 = (await getAsyncOrSync(
      db.adapter,
      `SELECT deleted_at FROM "tasks" WHERE id='t1'`,
    )) as {
      deleted_at: string | null;
    };
    const n2 = (await getAsyncOrSync(
      db.adapter,
      `SELECT deleted_at FROM "notes" WHERE id='n2'`,
    )) as {
      deleted_at: string | null;
    };
    expect(n1.deleted_at).toBeNull();
    expect(t1.deleted_at).toBeNull();
    expect(n2.deleted_at).toBe('2026-01-01T00:00:00Z');

    // Shape (the perf guard): EXACTLY ONE collapsed `:all` sentinel — never a
    // per-table sentinel (which would mean one pooler transaction per table).
    const sentinels = (await allAsyncOrSync(
      db.adapter,
      `SELECT version FROM "__lattice_migrations" WHERE version LIKE 'internal:upgrade:deleted-at-empty-to-null:%'`,
    )) as { version: string }[];
    expect(sentinels.map((s) => s.version)).toEqual([
      'internal:upgrade:deleted-at-empty-to-null:v1:all',
    ]);

    // Idempotent: a second run is a no-op (sentinel already applied) and adds nothing.
    await upgradeLegacyData(db);
    const again = (await allAsyncOrSync(
      db.adapter,
      `SELECT count(*)::int AS n FROM "__lattice_migrations" WHERE version LIKE 'internal:upgrade:deleted-at-empty-to-null:%'`,
    )) as { n: number }[];
    expect(again[0].n).toBe(1);
  });

  it('backfills a deleted_at column on a user table missing it', async () => {
    const schema = `dau_${randomBytes(4).toString('hex')}`;
    schemas.push(schema);
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();

    const db = new Lattice(schemaUrl(schema));
    dbs.push(db);
    await db.init();

    // A table created without the soft-delete envelope (an import / older path).
    await runAsyncOrSync(
      db.adapter,
      `CREATE TABLE "canonical_types" (id TEXT PRIMARY KEY, name TEXT)`,
    );
    await runAsyncOrSync(
      db.adapter,
      `INSERT INTO "canonical_types" (id, name) VALUES ('c1', 'Person')`,
    );

    await upgradeLegacyData(db);

    const cols = (await allAsyncOrSync(
      db.adapter,
      `SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = '${schema}' AND table_name = 'canonical_types'`,
    )) as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('deleted_at');
    const row = (await getAsyncOrSync(
      db.adapter,
      `SELECT name, deleted_at FROM "canonical_types" WHERE id='c1'`,
    )) as { name: string; deleted_at: string | null };
    expect(row.name).toBe('Person'); // no data lost
    expect(row.deleted_at).toBeNull(); // existing rows read as live

    // Idempotent: a second open doesn't throw or re-add.
    await upgradeLegacyData(db);
    const cols2 = (await allAsyncOrSync(
      db.adapter,
      `SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = '${schema}' AND table_name = 'canonical_types' AND column_name = 'deleted_at'`,
    )) as { name: string }[];
    expect(cols2.length).toBe(1);
  });
});
