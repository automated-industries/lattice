/**
 * Batch per-row "share with specific people" (custom grants committed at once).
 * The GUI used to POST one /api/cloud/row-grant per checkbox (live auto-save,
 * one person at a time, panel collapsing after each). The batch helper
 * batchRowGrants flips the row to custom ONCE and grants/revokes every subject
 * in a single call, each through the same owner-gated, idempotent SECURITY
 * DEFINER path.
 *
 * Asserts:
 *   - one batch grant of [m1, m2] → BOTH can SELECT the row, visibility is
 *     'custom', and the owner's _access.grantees contains BOTH;
 *   - a follow-up batch revoke of [m2] → m2 loses access, m1 keeps it;
 *   - a non-owner invoking the underlying grant path is rejected (owner-only).
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import {
  provisionMemberRole,
  generateMemberPassword,
  batchRowGrants,
  rowAccessSummaries,
} from '../../src/cloud/members.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const pools: pg.Pool[] = [];
const dbs: Lattice[] = [];
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
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      /* best-effort */
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

describe.skipIf(!PG_URL)('batch per-row custom grants (batchRowGrants)', () => {
  async function ownerCloud(schema: string): Promise<Lattice> {
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const o = new Lattice(schemaUrl(schema), { encryptionKey: 'row-grants-batch-test-key' });
    dbs.push(o);
    registerNativeEntities(o);
    await o.init();
    await secureCloud(o);
    return o;
  }

  it('one batch grant flips the row to custom ONCE and grants every member', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `rgb_${tag}`;
    const m1 = `lm_rgb1_${tag}`;
    const m2 = `lm_rgb2_${tag}`;
    schemas.push(schema);
    roles.push(m1, m2);
    const o = await ownerCloud(schema);

    // Owner creates a default-private note they own.
    await o.insert('notes', { id: 'n1', title: 'Plan', body: 'secret-ish' });

    const pw1 = generateMemberPassword();
    const pw2 = generateMemberPassword();
    await provisionMemberRole(o, m1, pw1);
    await provisionMemberRole(o, m2, pw2);
    const M1 = memberPool(schema, m1, pw1);
    const M2 = memberPool(schema, m2, pw2);

    // Before any grant: neither member can see the private row.
    expect((await M1.query('SELECT id FROM notes')).rows.map((r) => r.id)).not.toContain('n1');
    expect((await M2.query('SELECT id FROM notes')).rows.map((r) => r.id)).not.toContain('n1');

    // ONE batch call grants both members at once.
    await batchRowGrants(o, 'notes', 'n1', [m1, m2], []);

    // (i) both members can now SELECT the row.
    expect((await M1.query('SELECT id FROM notes')).rows.map((r) => r.id)).toContain('n1');
    expect((await M2.query('SELECT id FROM notes')).rows.map((r) => r.id)).toContain('n1');

    // (ii) one batch flipped visibility to custom and granted BOTH.
    let access = await rowAccessSummaries(o, 'notes', ['n1']);
    expect(access.get('n1')?.visibility).toBe('custom');
    const grantees = access.get('n1')?.grantees ?? [];
    expect(grantees).toContain(m1);
    expect(grantees).toContain(m2);

    // A follow-up batch revoke of m2 only → m2 loses access, m1 keeps it.
    await batchRowGrants(o, 'notes', 'n1', [], [m2]);
    expect((await M2.query('SELECT id FROM notes')).rows.map((r) => r.id)).not.toContain('n1');
    expect((await M1.query('SELECT id FROM notes')).rows.map((r) => r.id)).toContain('n1');
    access = await rowAccessSummaries(o, 'notes', ['n1']);
    const after = access.get('n1')?.grantees ?? [];
    expect(after).not.toContain(m2);
    expect(after).toContain(m1);
  });

  it('a non-owner cannot grant access through the batch path (owner-only SECURITY DEFINER)', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `rgb_${tag}`;
    const member = `lm_rgb_${tag}`;
    schemas.push(schema);
    roles.push(member);
    const o = await ownerCloud(schema);
    await o.insert('notes', { id: 'n1', title: 'Plan', body: 'x' });

    const memberPw = generateMemberPassword();
    await provisionMemberRole(o, member, memberPw);
    const M = memberPool(schema, member, memberPw);

    // batchRowGrants loops the SECURITY DEFINER lattice_grant_row, which raises
    // for a non-owner. A member opening a member-scoped Lattice and calling the
    // batch helper must be rejected — same owner-only gate as the single route.
    const memberDb = new Lattice(
      (() => {
        const u = new URL(PG_URL!);
        u.username = member;
        u.password = memberPw;
        u.searchParams.set('options', `-c search_path=${schema}`);
        return u.toString();
      })(),
      { encryptionKey: 'row-grants-batch-test-key' },
    );
    dbs.push(memberDb);
    await memberDb.init();

    await expect(batchRowGrants(memberDb, 'notes', 'n1', [member], [])).rejects.toThrow(
      /only the row owner/i,
    );

    // Sanity: the member still cannot see the row.
    expect((await M.query('SELECT id FROM notes')).rows.map((r) => r.id)).not.toContain('n1');
  });
});
