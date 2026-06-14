/**
 * Stage 3 acceptance test — the per-viewer enrichment model end-to-end on a real
 * Postgres cloud. An enrichment is recorded as a DERIVED observation (never
 * written into the shared row), gated by the visibility of the source it came
 * from. This proves, over scoped member roles:
 *
 *   - per-viewer VALUES: a member who can see the source folds in the enriched
 *     value; a member who can't sees only ground truth — two correct versions;
 *   - the observation substrate is sealed: a member cannot read the hidden
 *     derived observation from __lattice_changelog directly (RLS);
 *   - existence non-disclosure: the canonical row never moved, so a member who
 *     can't see the source sees no value AND no sign one exists;
 *   - revocation is structural: un-share the source and the value reverts to
 *     ground truth with no residue.
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import {
  installCloudRls,
  enableRlsForTable,
  enableChangelogRls,
  backfillOwnership,
} from '../../src/cloud/rls.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const pools: pg.Pool[] = [];
const dbs: Lattice[] = [];
const schemas: string[] = [];
const roles: string[] = [];

function schemaUrl(schema: string): string {
  return `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

function memberUrl(schema: string, role: string, password: string): string {
  const u = new URL(PG_URL!);
  u.username = role;
  u.password = password;
  u.searchParams.set('options', `-c search_path=${schema}`);
  return u.toString();
}

/** A member's Lattice, opened introspect-only (a scoped role can't DDL), with the
 *  table it will fold registered so get()/history() know the columns. */
async function memberDb(schema: string, role: string, password: string): Promise<Lattice> {
  const d = new Lattice(memberUrl(schema, role, password));
  d.define('contact', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', phone: 'TEXT' },
    render: () => '',
    outputFile: 'contact.md',
  });
  await d.init({ introspectOnly: true });
  dbs.push(d);
  return d;
}

afterEach(async () => {
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      // best-effort
    }
  }
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

describe.skipIf(!PG_URL)(
  'per-viewer enrichment — observations folded per source visibility',
  () => {
    it('a derived value is visible only to a member who can see its source; revocation reverts it', async () => {
      const tag = randomBytes(4).toString('hex');
      const schema = `pv_${tag}`;
      const bob = `pv_b_${tag}`;
      const carol = `pv_c_${tag}`;
      schemas.push(schema);
      roles.push(bob, carol);

      const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
      pools.push(admin);
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const url = schemaUrl(schema);

      // Owner builds the cloud: a contact (ground-truth phone) + a source file F,
      // then an enrichment of the phone DERIVED from F — recorded as an observation
      // (the canonical row is NOT touched).
      const owner = new Lattice(url);
      owner.define('contact', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', phone: 'TEXT' },
        render: () => '',
        outputFile: 'contact.md',
      });
      owner.define('files', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
        render: () => '',
        outputFile: 'files.md',
      });
      await owner.init();
      await owner.upsert('contact', { id: 'c1', name: 'Acme', phone: 'gt-phone' });
      await owner.upsert('files', { id: 'F', name: 'card.pdf' });
      await owner.observe(
        'contact',
        'c1',
        { phone: 'enriched-from-F' },
        { sourceRef: ['F'], changeKind: 'derived' },
      );

      await installCloudRls(owner);
      await owner.ensureObservationSubstrate();
      await enableChangelogRls(owner);
      for (const t of ['contact', 'files']) {
        const pk = owner.getPrimaryKey(t);
        await backfillOwnership(owner, t, pk);
        await enableRlsForTable(owner, t, pk);
      }
      const bobPw = generateMemberPassword();
      const carolPw = generateMemberPassword();
      await provisionMemberRole(owner, bob, bobPw);
      await provisionMemberRole(owner, carol, carolPw);

      // The contact row is shared with everyone (this test isolates per-viewer
      // VALUES, so the row itself must be visible to both members). Source F is
      // shared with bob only.
      const ownerPool = new pg.Pool({ connectionString: url, max: 1 });
      pools.push(ownerPool);
      await ownerPool.query(`SELECT lattice_set_row_visibility('contact','c1','everyone')`);
      await ownerPool.query(`SELECT lattice_grant_row('files','F',$1)`, [bob]);
      owner.close();

      // Bob can see F → his fold shows the enriched phone.
      const bobDb = await memberDb(schema, bob, bobPw);
      expect((await bobDb.foldForViewer('contact', 'c1'))?.phone).toBe('enriched-from-F');

      // Carol cannot see F → her fold shows ground truth, and the canonical row she
      // reads is unchanged — no value, and no sign an enrichment exists.
      const carolDb = await memberDb(schema, carol, carolPw);
      expect((await carolDb.foldForViewer('contact', 'c1'))?.phone).toBe('gt-phone');
      expect((await carolDb.get('contact', 'c1'))?.phone).toBe('gt-phone');

      // Carol cannot read the hidden derived observation from the substrate directly.
      const carolPool = new pg.Pool({
        connectionString: memberUrl(schema, carol, carolPw),
        max: 1,
      });
      pools.push(carolPool);
      const carolRaw = await carolPool.query(
        `SELECT id FROM "__lattice_changelog" WHERE table_name='contact' AND change_kind='derived'`,
      );
      expect(carolRaw.rows).toEqual([]);
      // Bob, who can see F, does see exactly that observation.
      const bobPool = new pg.Pool({ connectionString: memberUrl(schema, bob, bobPw), max: 1 });
      pools.push(bobPool);
      const bobRaw = await bobPool.query(
        `SELECT id FROM "__lattice_changelog" WHERE table_name='contact' AND change_kind='derived'`,
      );
      expect(bobRaw.rows).toHaveLength(1);

      // Revocation is structural: un-share F from bob → his fold reverts to ground
      // truth with no residue.
      await ownerPool.query(`SELECT lattice_revoke_row('files','F',$1)`, [bob]);
      expect((await bobDb.foldForViewer('contact', 'c1'))?.phone).toBe('gt-phone');
    });
  },
);
