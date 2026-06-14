/**
 * #C — the cloud object bootstrap must CONVERGE: it is idempotent and run
 * directly (not behind a one-shot version gate), so an object ADDED to the
 * bootstrap in a later release reaches clouds already stamped at an earlier
 * version. The classic failure was `__lattice_member_invites` never reaching
 * existing v7 clouds (and a version-gated `secure` no-op'ing).
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { installCloudRls } from '../../src/cloud/rls.js';
import { installCloudSettings } from '../../src/cloud/settings.js';
import { getAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const dbs: Lattice[] = [];
const schemas: string[] = [];

function schemaUrl(schema: string): string {
  return `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}
function uniq(): string {
  const s = `cv_${randomBytes(4).toString('hex')}`;
  schemas.push(s);
  return s;
}
async function regclass(db: Lattice, schema: string, table: string): Promise<string | null> {
  const row = (await getAsyncOrSync(db.adapter, `SELECT to_regclass($1) AS reg`, [
    `"${schema}"."${table}"`,
  ])) as { reg?: string | null } | undefined;
  return row?.reg ?? null;
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

describe.skipIf(!PG_URL)('#C cloud bootstrap converges (idempotent, not version-gated)', () => {
  async function owner(schema: string): Promise<Lattice> {
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const o = new Lattice(schemaUrl(schema));
    dbs.push(o);
    o.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'notes.md',
    });
    await o.init();
    return o;
  }

  it('re-running installCloudRls re-creates a dropped bootstrap object', async () => {
    const schema = uniq();
    const o = await owner(schema);
    await installCloudRls(o);
    expect(await regclass(o, schema, '__lattice_member_invites')).not.toBeNull();

    // Simulate a cloud secured BEFORE the invites table joined the bootstrap:
    // drop it, then re-run. A version gate would skip (no-op) and leave it
    // missing; the direct, idempotent bootstrap re-creates it.
    await runAsyncOrSync(o.adapter, `DROP TABLE "${schema}"."__lattice_member_invites"`);
    expect(await regclass(o, schema, '__lattice_member_invites')).toBeNull();

    await installCloudRls(o); // converge
    expect(await regclass(o, schema, '__lattice_member_invites')).not.toBeNull();
  });

  it('re-running installCloudSettings re-creates its dropped table (converges)', async () => {
    const schema = uniq();
    const o = await owner(schema);
    await installCloudRls(o);
    await installCloudSettings(o);
    expect(await regclass(o, schema, '__lattice_cloud_settings')).not.toBeNull();

    await runAsyncOrSync(o.adapter, `DROP TABLE "${schema}"."__lattice_cloud_settings" CASCADE`);
    expect(await regclass(o, schema, '__lattice_cloud_settings')).toBeNull();

    await installCloudSettings(o); // converge
    expect(await regclass(o, schema, '__lattice_cloud_settings')).not.toBeNull();
  });
});
