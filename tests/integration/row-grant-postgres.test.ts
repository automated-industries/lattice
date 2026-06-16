/**
 * Recovered per-row "share with specific people" (custom grants). The 3.0 RLS
 * rewrite dropped per-row enrichment; the SQL (lattice_grant_row /
 * lattice_revoke_row / lattice_row_grantees) survived but had no HTTP/JS layer.
 * These tests cover the thin wrappers grantRow/revokeRow and the owner-only gate:
 *   - grant → the member sees the row + the owner's _access.grantees reflects it;
 *   - revoke → access + grantee removed;
 *   - a non-owner cannot grant (SECURITY DEFINER raises).
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
  grantRow,
  revokeRow,
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

describe.skipIf(!PG_URL)('per-row custom grants (Feature B)', () => {
  async function ownerCloud(schema: string): Promise<Lattice> {
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const o = new Lattice(schemaUrl(schema), { encryptionKey: 'row-grant-test-key' });
    dbs.push(o);
    registerNativeEntities(o);
    await o.init();
    await secureCloud(o);
    return o;
  }

  it('grants then revokes a member, reflected in the owner _access.grantees', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `rg_${tag}`;
    const member = `lm_rg_${tag}`;
    schemas.push(schema);
    roles.push(member);
    const o = await ownerCloud(schema);

    // The owner creates a (default-private) note they own.
    await o.insert('notes', { id: 'n1', title: 'Plan', body: 'secret-ish' });

    const memberPw = generateMemberPassword();
    await provisionMemberRole(o, member, memberPw);
    const M = memberPool(schema, member, memberPw);

    // Before any grant: the member cannot see the private row.
    expect((await M.query('SELECT id FROM notes')).rows.map((r) => r.id)).not.toContain('n1');

    // Grant → custom visibility, member can read, owner sees the grantee.
    await grantRow(o, 'notes', 'n1', member);
    expect((await M.query('SELECT id FROM notes')).rows.map((r) => r.id)).toContain('n1');
    let access = await rowAccessSummaries(o, 'notes', ['n1']);
    expect(access.get('n1')?.visibility).toBe('custom');
    expect(access.get('n1')?.grantees ?? []).toContain(member);

    // Revoke → member loses access, grantee cleared.
    await revokeRow(o, 'notes', 'n1', member);
    expect((await M.query('SELECT id FROM notes')).rows.map((r) => r.id)).not.toContain('n1');
    access = await rowAccessSummaries(o, 'notes', ['n1']);
    expect(access.get('n1')?.grantees ?? []).not.toContain(member);
  });

  it('a non-owner cannot grant access to a row (owner-only SECURITY DEFINER)', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `rg_${tag}`;
    const member = `lm_rg_${tag}`;
    schemas.push(schema);
    roles.push(member);
    const o = await ownerCloud(schema);
    await o.insert('notes', { id: 'n1', title: 'Plan', body: 'x' });

    const memberPw = generateMemberPassword();
    await provisionMemberRole(o, member, memberPw);
    const M = memberPool(schema, member, memberPw);

    // The member tries to grant THEMSELVES access to a row they don't own.
    await expect(M.query(`SELECT lattice_grant_row('notes', 'n1', $1)`, [member])).rejects.toThrow(
      /only the row owner/i,
    );
  });
});
