/**
 * 4.3.6 — a failing Postgres query attaches its STATEMENT to the error. A bare
 * Postgres error (e.g. `invalid input syntax for type timestamp with time zone:
 * ""`) names neither the query nor the table/column; the adapter now appends the
 * failing statement so an error deep in an open-time convergence is debuggable.
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { getAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const dbs: Lattice[] = [];
const schemas: string[] = [];
function schemaUrl(schema: string): string {
  return `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function open(): Promise<Lattice> {
  const schema = `errctx_${randomBytes(4).toString('hex')}`;
  schemas.push(schema);
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  const db = new Lattice(schemaUrl(schema));
  dbs.push(db);
  await db.init();
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

describe.skipIf(!PG_URL)('postgres adapter — failing query names its statement (4.3.6)', () => {
  it("attaches the failing statement to a cast error (the '' -> timestamptz class)", async () => {
    const db = await open();
    let msg = '';
    try {
      await getAsyncOrSync(db.adapter, `SELECT ''::timestamptz AS x`);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/invalid input syntax for type timestamp with time zone/i);
    expect(msg).toContain('[lattice-sql] failing statement:');
    expect(msg).toContain("SELECT ''::timestamptz");
  });

  it('attaches the statement on the withClient (transaction) path too', async () => {
    const db = await open();
    let msg = '';
    try {
      await runAsyncOrSync(db.adapter, `SELECT 1 FROM "no_such_table_xyz"`);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('[lattice-sql] failing statement:');
    expect(msg).toContain('no_such_table_xyz');
  });

  it('does not double-append as an error unwinds through nested calls', async () => {
    const db = await open();
    let msg = '';
    try {
      await getAsyncOrSync(db.adapter, `SELECT ''::timestamptz`);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg.match(/\[lattice-sql\] failing statement:/g)?.length).toBe(1);
  });
});
