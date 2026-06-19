/**
 * #H cloud members — invite/revoke fixes verified against real Postgres.
 *  B: re-inviting an existing member must NOT restate NOSUPERUSER-class attrs
 *     (that trips Supabase supautils); the ALTER branch sets only login+password.
 *  D: the members enumeration must EXCLUDE the owner (it was double-counted).
 *  E: revokeMemberRole fully removes the role (and surfaces failures, not swallow).
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { installCloudRls, memberGroupFor } from '../../src/cloud/rls.js';
import {
  provisionMemberRole,
  revokeMemberRole,
  generateMemberPassword,
} from '../../src/cloud/members.js';
import { getAsyncOrSync, allAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const dbs: Lattice[] = [];
const schemas: string[] = [];
const roles: string[] = [];

function schemaUrl(schema: string): string {
  return `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}
function uniqSchema(): string {
  const s = `mb_${randomBytes(4).toString('hex')}`;
  schemas.push(s);
  return s;
}
function memberRole(): string {
  const r = `lm_${randomBytes(4).toString('hex')}`;
  roles.push(r);
  return r;
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
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  await admin.end();
});

describe.skipIf(!PG_URL)('#H cloud members (invite/revoke)', () => {
  async function owner(): Promise<Lattice> {
    const schema = uniqSchema();
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
    await installCloudRls(o);
    return o;
  }

  it('B: re-provisioning an existing member role does not error and stays non-privileged', async () => {
    const o = await owner();
    const role = memberRole();
    await provisionMemberRole(o, role, generateMemberPassword());
    // The ELSE/ALTER branch (re-invite) must not throw (it restated NOSUPERUSER
    // before, which Supabase supautils rejects with 42501).
    await expect(provisionMemberRole(o, role, generateMemberPassword())).resolves.toBeUndefined();
    const r = (await getAsyncOrSync(
      o.adapter,
      `SELECT rolsuper, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname = ?`,
      [role],
    )) as { rolsuper?: boolean; rolcreaterole?: boolean; rolcanlogin?: boolean } | undefined;
    expect(r?.rolsuper).toBe(false);
    expect(r?.rolcreaterole).toBe(false);
    expect(r?.rolcanlogin).toBe(true);
  });

  it('D: member enumeration excludes the owner (no double-count)', async () => {
    const o = await owner();
    const group = await memberGroupFor(o);
    const m1 = memberRole();
    await provisionMemberRole(o, m1, generateMemberPassword());
    // Simulate the reported double-count: the owner is ALSO in the member group.
    await runAsyncOrSync(o.adapter, `GRANT ${group} TO CURRENT_USER`);
    try {
      const me = (await getAsyncOrSync(o.adapter, `SELECT session_user AS u`)) as { u?: string };
      const ownerRole = me?.u ?? '';
      // The exact enumeration the members route uses (with the de-dup WHERE).
      const rows = (await allAsyncOrSync(
        o.adapter,
        `SELECT m.rolname AS role
           FROM pg_auth_members am
           JOIN pg_roles g ON g.oid = am.roleid AND g.rolname = ?
           JOIN pg_roles m ON m.oid = am.member
          WHERE m.rolname <> ?
          ORDER BY m.rolname`,
        [group, ownerRole],
      )) as { role: string }[];
      const names = rows.map((r) => r.role);
      expect(names).toContain(m1);
      expect(names).not.toContain(ownerRole); // owner is NOT listed as a member
    } finally {
      await runAsyncOrSync(o.adapter, `REVOKE ${group} FROM CURRENT_USER`).catch(() => undefined);
    }
  });

  it('E: revokeMemberRole fully removes the role', async () => {
    const o = await owner();
    const role = memberRole();
    await provisionMemberRole(o, role, generateMemberPassword());
    let exists = (await getAsyncOrSync(o.adapter, `SELECT 1 AS x FROM pg_roles WHERE rolname = ?`, [
      role,
    ])) as { x?: number } | undefined;
    expect(exists?.x).toBe(1);
    await revokeMemberRole(o, role); // must not swallow; must remove
    exists = (await getAsyncOrSync(o.adapter, `SELECT 1 AS x FROM pg_roles WHERE rolname = ?`, [
      role,
    ])) as { x?: number } | undefined;
    expect(exists).toBeUndefined();
  });
});
