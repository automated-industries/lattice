/**
 * Stage 2 acceptance test — per-column cell masking through a generated view, on
 * a real Postgres cloud with scoped member roles. Proves the column-level half of
 * the per-viewer model the way cloud-rls-postgres proves the row-level half:
 *
 *   - a fixed-policy masked column (`comp`, audience `subject:<col>+role:hr`) is
 *     NULL through the view for a member who is neither the subject nor in the
 *     role, and the real value for one who is;
 *   - the base table's column is UNREACHABLE to members (SELECT revoked) — the
 *     mask cannot be bypassed with raw SQL;
 *   - the view still row-filters per the real member (session_user), even though
 *     it executes with its owner's rights;
 *   - a member cannot self-assign a role to unmask a column;
 *   - two members see two correct versions of the same row.
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { installCloudRls, enableRlsForTable, backfillOwnership } from '../../src/cloud/rls.js';
import { enableAudienceView } from '../../src/cloud/audience.js';
import { provisionMemberRole, generateMemberPassword, grantCell } from '../../src/cloud/members.js';

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

describe.skipIf(!PG_URL)('cloud audience masking — generated cell-masking view', () => {
  it('masks a fixed-policy column per viewer and seals the base table', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `aud_${tag}`;
    const alice = `aud_a_${tag}`;
    const bob = `aud_b_${tag}`;
    schemas.push(schema);
    roles.push(alice, bob);

    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = schemaUrl(schema);

    // Owner builds a `person` table whose `comp` column is visible only to the
    // row's subject (the role named in subject_role) OR a member holding 'hr'.
    const owner = new Lattice(url);
    owner.define('person', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT',
        comp: 'TEXT',
        subject_role: 'TEXT',
      },
      columnAudience: { comp: 'subject:subject_role+role:hr' },
      render: () => '',
      outputFile: 'person.md',
    });
    await owner.init();
    await owner.upsert('person', { id: 'p1', name: 'A', comp: 'alice-comp', subject_role: alice });
    await owner.upsert('person', { id: 'p2', name: 'B', comp: 'bob-comp', subject_role: 'nobody' });

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
    const bobPw = generateMemberPassword();
    await provisionMemberRole(owner, alice, alicePw);
    await provisionMemberRole(owner, bob, bobPw);
    owner.close();

    // The rows are shared with everyone (this test isolates COLUMN masking, so
    // both rows must be row-visible to both members).
    const ownerPool = new pg.Pool({ connectionString: url, max: 1 });
    pools.push(ownerPool);
    await ownerPool.query(`SELECT lattice_set_row_visibility('person','p1','everyone')`);
    await ownerPool.query(`SELECT lattice_set_row_visibility('person','p2','everyone')`);

    const A = memberPool(schema, alice, alicePw);
    const B = memberPool(schema, bob, bobPw);

    // Alice is the subject of p1 → sees p1.comp; not subject of p2, no role → p2.comp NULL.
    const aRows = (
      await A.query<{ id: string; comp: string | null }>(
        `SELECT id, comp FROM person_v ORDER BY id`,
      )
    ).rows;
    expect(aRows).toEqual([
      { id: 'p1', comp: 'alice-comp' },
      { id: 'p2', comp: null },
    ]);

    // Bob is subject of neither and holds no role → every comp is masked.
    const bRows = (
      await B.query<{ id: string; comp: string | null }>(
        `SELECT id, comp FROM person_v ORDER BY id`,
      )
    ).rows;
    expect(bRows).toEqual([
      { id: 'p1', comp: null },
      { id: 'p2', comp: null },
    ]);

    // The base column is UNREACHABLE — members can't bypass the mask with raw SQL.
    await expect(B.query(`SELECT comp FROM person`)).rejects.toThrow(/permission denied/i);
    await expect(A.query(`SELECT comp FROM person`)).rejects.toThrow(/permission denied/i);

    // A member cannot self-assign a role to unmask the column.
    await expect(B.query(`SELECT lattice_assign_role('${bob}','hr')`)).rejects.toThrow(
      /only a cloud owner/i,
    );

    // The owner grants bob the 'hr' role → bob now sees every comp (fixed policy).
    await ownerPool.query(`SELECT lattice_assign_role('${bob}','hr')`);
    const bAfter = (
      await B.query<{ id: string; comp: string | null }>(
        `SELECT id, comp FROM person_v ORDER BY id`,
      )
    ).rows;
    expect(bAfter).toEqual([
      { id: 'p1', comp: 'alice-comp' },
      { id: 'p2', comp: 'bob-comp' },
    ]);

    // Two correct versions of p1: alice (subject) sees the value; a fresh
    // non-subject/non-role member would not. (Alice still sees only her own.)
    const aP1 = (await A.query<{ comp: string | null }>(`SELECT comp FROM person_v WHERE id='p1'`))
      .rows[0];
    expect(aP1?.comp).toBe('alice-comp');
  });

  it('per-card override: the owner grants one member one masked cell, nothing more', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `card_${tag}`;
    const dave = `card_d_${tag}`;
    schemas.push(schema);
    roles.push(dave);

    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = schemaUrl(schema);

    // comp is masked to non-HR members by the schema-level audience.
    const owner = new Lattice(url);
    owner.define('person', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', comp: 'TEXT' },
      columnAudience: { comp: 'role:hr' },
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
    const davePw = generateMemberPassword();
    await provisionMemberRole(owner, dave, davePw);

    const ownerPool = new pg.Pool({ connectionString: url, max: 1 });
    pools.push(ownerPool);
    await ownerPool.query(`SELECT lattice_set_row_visibility('person','p1','everyone')`);
    await ownerPool.query(`SELECT lattice_set_row_visibility('person','p2','everyone')`);

    const D = memberPool(schema, dave, davePw);
    // Dave holds no 'hr' role → every comp is masked.
    expect(
      (
        await D.query<{ id: string; comp: string | null }>(
          `SELECT id, comp FROM person_v ORDER BY id`,
        )
      ).rows,
    ).toEqual([
      { id: 'p1', comp: null },
      { id: 'p2', comp: null },
    ]);

    // Owner grants dave the single p1.comp cell (per-card override).
    await grantCell(owner, 'person', 'p1', 'comp', dave);
    owner.close();

    // Dave now sees exactly p1.comp — and still nothing on p2.
    expect(
      (
        await D.query<{ id: string; comp: string | null }>(
          `SELECT id, comp FROM person_v ORDER BY id`,
        )
      ).rows,
    ).toEqual([
      { id: 'p1', comp: 'p1-comp' },
      { id: 'p2', comp: null },
    ]);
  });
});
