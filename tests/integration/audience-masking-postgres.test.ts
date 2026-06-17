/**
 * Per-column cell masking through a generated view, on a real Postgres cloud with
 * scoped member roles. Covers the live secret-column path (audience `owner`): the
 * column reveals only to the row's owner and reads NULL for everyone else, the
 * base column is UNREACHABLE to members (SELECT revoked, so the mask can't be
 * bypassed with raw SQL), and the view still row-filters per the real member
 * (session_user) even though it executes with its owner's rights.
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { installCloudRls, enableRlsForTable, backfillOwnership } from '../../src/cloud/rls.js';
import { enableAudienceView } from '../../src/cloud/audience.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const pools: pg.Pool[] = [];
const schemas: string[] = [];
const roles: string[] = [];

function schemaUrl(schema: string): string {
  return `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

function memberPool(schema: string, role: string, password: string): pg.Pool {
  const u = new URL(PG_URL!);
  u.username = role;
  u.password = password;
  u.searchParams.set('options', `-c search_path=${schema}`);
  const p = new pg.Pool({ connectionString: u.toString(), max: 1 });
  pools.push(p);
  return p;
}

afterEach(async () => {
  for (const p of pools.splice(0)) await p.end();
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const s of schemas.splice(0)) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  await admin.end();
});

describe.skipIf(!PG_URL)('cloud audience masking — owner secret column', () => {
  it('reveals an owner-secret column only to the row owner and seals the base table', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `aud_${tag}`;
    const alice = `aud_a_${tag}`;
    schemas.push(schema);
    roles.push(alice);

    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = schemaUrl(schema);

    // `comp` is a secret column: audience `owner` → only the row owner sees it.
    const owner = new Lattice(url);
    owner.define('person', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', comp: 'TEXT' },
      columnAudience: { comp: 'owner' },
      render: () => '',
      outputFile: 'person.md',
    });
    await owner.init();
    await owner.upsert('person', { id: 'p1', name: 'A', comp: 'p1-comp' });
    await owner.upsert('person', { id: 'p2', name: 'B', comp: 'p2-comp' });

    await installCloudRls(owner);
    const pk = owner.getPrimaryKey('person');
    await backfillOwnership(owner, 'person', pk);
    await enableRlsForTable(owner, 'person', pk);
    await enableAudienceView(
      owner,
      'person',
      Object.keys(owner.getRegisteredColumns('person')!),
      pk,
      owner.getColumnAudience('person'),
    );

    const alicePw = generateMemberPassword();
    await provisionMemberRole(owner, alice, alicePw);

    // Share both rows with everyone so they're row-visible to the member; the
    // column mask is what we're isolating here.
    const ownerPool = new pg.Pool({ connectionString: url, max: 1 });
    pools.push(ownerPool);
    await ownerPool.query(`SELECT lattice_set_row_visibility('person','p1','everyone')`);
    await ownerPool.query(`SELECT lattice_set_row_visibility('person','p2','everyone')`);

    const A = memberPool(schema, alice, alicePw);

    // Alice is not the owner of either row → comp is masked to NULL, name passes through.
    const aRows = (
      await A.query<{ id: string; name: string; comp: string | null }>(
        `SELECT id, name, comp FROM person_v ORDER BY id`,
      )
    ).rows;
    expect(aRows).toEqual([
      { id: 'p1', name: 'A', comp: null },
      { id: 'p2', name: 'B', comp: null },
    ]);

    // The base column is UNREACHABLE — members can't bypass the mask with raw SQL.
    await expect(A.query(`SELECT comp FROM person`)).rejects.toThrow(/permission denied/i);

    // The owner reads the real values from the base table (the mask is for members).
    const ownerRows = (
      await ownerPool.query<{ id: string; comp: string }>(`SELECT id, comp FROM person ORDER BY id`)
    ).rows;
    expect(ownerRows).toEqual([
      { id: 'p1', comp: 'p1-comp' },
      { id: 'p2', comp: 'p2-comp' },
    ]);

    owner.close();
  });
});
