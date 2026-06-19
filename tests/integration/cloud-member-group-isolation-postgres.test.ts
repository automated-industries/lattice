/**
 * Per-cloud member-group isolation.
 *
 * Postgres roles + role membership are CLUSTER-GLOBAL. Before 4.0 every cloud used
 * one hard-coded `lattice_members` group, so multiple clouds co-located on one
 * Postgres cluster SHARED that single role — putting unrelated clouds' members in
 * one group, and making concurrent provisioning across them contend on that one
 * shared role's catalog. 4.0 derives the group name from the cloud's own
 * (database, schema) namespace (memberGroupFor), giving each cloud its OWN group.
 *
 * This pins the guarantee: two clouds on one cluster get DISTINCT, stable, legal
 * group roles, and a member provisioned into one cloud is NOT a member of another
 * cloud's group.
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { installCloudRls, memberGroupFor, LEGACY_MEMBER_GROUP } from '../../src/cloud/rls.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { registerPostgresPolyfills } from '../../src/db/postgres.js';
import { getAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const dbs: Lattice[] = [];
const schemas: string[] = [];
const roles: string[] = [];

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
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  for (const s of schemas.splice(0)) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  await admin.end();
});

describe.skipIf(!PG_URL)('per-cloud member group isolation', () => {
  async function ownerCloud(prefix: string): Promise<Lattice> {
    const schema = `${prefix}_${randomBytes(4).toString('hex')}`;
    schemas.push(schema);
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const o = new Lattice(schemaUrl(schema));
    dbs.push(o);
    o.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
      render: () => '',
      outputFile: 'notes.md',
    });
    await o.init();
    await registerPostgresPolyfills((sql) => runAsyncOrSync(o.adapter, sql));
    await installCloudRls(o);
    // Track the per-cloud group role for cleanup (it is cluster-global; DROP SCHEMA
    // CASCADE does not remove it).
    roles.push(await memberGroupFor(o));
    return o;
  }

  it('two clouds on one cluster get DISTINCT, stable, legal group roles', async () => {
    const a = await ownerCloud('iso_a');
    const b = await ownerCloud('iso_b');
    const ga = await memberGroupFor(a);
    const gb = await memberGroupFor(b);

    expect(ga).not.toBe(gb); // distinct per cloud
    expect(ga).not.toBe(LEGACY_MEMBER_GROUP); // never the legacy shared constant
    expect(gb).not.toBe(LEGACY_MEMBER_GROUP);
    expect(ga).toMatch(/^lattice_m_[0-9a-f]{20}$/); // legal, bounded identifier
    expect(gb).toMatch(/^lattice_m_[0-9a-f]{20}$/);
    expect(await memberGroupFor(a)).toBe(ga); // stable: same cloud → same name

    // Each group exists as a NOLOGIN role (a member group, not a login).
    for (const g of [ga, gb]) {
      const row = (await getAsyncOrSync(
        a.adapter,
        `SELECT rolcanlogin FROM pg_roles WHERE rolname = $1`,
        [g],
      )) as { rolcanlogin?: boolean } | undefined;
      expect(row?.rolcanlogin).toBe(false);
    }
  });

  it("a member provisioned into cloud A is NOT a member of cloud B's group", async () => {
    const a = await ownerCloud('isx_a');
    const b = await ownerCloud('isx_b');
    const ga = await memberGroupFor(a);
    const gb = await memberGroupFor(b);

    const member = `lm_iso_${randomBytes(4).toString('hex')}`;
    roles.push(member);
    await provisionMemberRole(a, member, generateMemberPassword());

    const inA = (await getAsyncOrSync(a.adapter, `SELECT pg_has_role($1, $2, 'MEMBER') AS m`, [
      member,
      ga,
    ])) as { m?: boolean } | undefined;
    const inB = (await getAsyncOrSync(a.adapter, `SELECT pg_has_role($1, $2, 'MEMBER') AS m`, [
      member,
      gb,
    ])) as { m?: boolean } | undefined;
    expect(inA?.m).toBe(true); // in its own cloud's group
    expect(inB?.m).toBe(false); // never in the other cloud's group
  });
});
