/**
 * #13 — the Data Model sharing UI regressed because the server stopped setting
 * the `ownedByMe` / `shared` fields the client gates the sharing controls + the
 * red/amber/green node border on. The 3.1 mapping the server now applies for a
 * cloud owner is: `ownedByMe = true` and `shared = (defaultRowVisibility ===
 * 'everyone')`. This verifies the policy data that mapping reads — an
 * everyone-default table is distinguishable from a private one — which is exactly
 * what `t.shared` keys on. (The owner block itself runs only when cloudRlsInstalled
 * resolves the public-schema cloud, so the policy layer is the isolated unit.)
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { installCloudRls } from '../../src/cloud/rls.js';
import { setTableDefaultVisibility, getAllTablePolicies } from '../../src/cloud/table-policy.js';

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

describe.skipIf(!PG_URL)('#13 data-model sharing — everyone-default = shared', () => {
  it('distinguishes a shared (everyone) table from a private one via the policy', async () => {
    const schema = `sh_${randomBytes(4).toString('hex')}`;
    schemas.push(schema);
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();

    const owner = new Lattice(schemaUrl(schema));
    dbs.push(owner);
    for (const t of ['shared_t', 'private_t']) {
      owner.define(t, {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
        render: () => '',
        outputFile: `${t}.md`,
      });
    }
    await owner.init();
    await installCloudRls(owner);
    await setTableDefaultVisibility(owner, 'shared_t', 'everyone');

    const policies = await getAllTablePolicies(owner);
    // The server maps: t.shared = (defaultRowVisibility === 'everyone').
    expect(policies.shared_t?.defaultRowVisibility).toBe('everyone'); // → shared: true
    expect(policies.private_t?.defaultRowVisibility ?? 'private').toBe('private'); // → shared: false
  });
});
