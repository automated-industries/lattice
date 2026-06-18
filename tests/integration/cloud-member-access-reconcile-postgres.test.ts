/**
 * Regression — `reconcileCloudMemberAccess` converges per-table member access on
 * every cloud owner open, fixing two drift classes the version-gated per-table
 * securing cannot self-heal:
 *
 *  1. PRIVACY: the assistant's internal conversation tables
 *     (`chat_threads`/`chat_messages`) are forced `never_share`, so one member
 *     can never read another's chat — even if a restore left them stamped
 *     `everyone` (a bulk "share everything" leak).
 *  2. GRANTS: a restore that kept the RLS policy + per-table securing migration
 *     but dropped the member GRANT (a `pg_dump --no-privileges` round-trip)
 *     leaves a shared table unreadable; the reconcile re-issues the grant.
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { MEMBER_GROUP } from '../../src/cloud/rls.js';
import { secureCloud, reconcileCloudMemberAccess } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';

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

describe.skipIf(!PG_URL)('cloud member access reconcile', () => {
  async function ownerCloud(schema: string): Promise<{ o: Lattice; ownerPool: pg.Pool }> {
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const o = new Lattice(schemaUrl(schema));
    dbs.push(o);
    o.define('note', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'note.md',
    });
    o.define('chat_threads', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', owner_user_id: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'chat_threads.md',
    });
    o.define('chat_messages', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        thread_id: 'TEXT',
        owner_user_id: 'TEXT',
        content_json: 'TEXT',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: 'chat_messages.md',
    });
    await o.init();
    await secureCloud(o);
    const ownerPool = new pg.Pool({ connectionString: schemaUrl(schema), max: 1 });
    pools.push(ownerPool);
    return { o, ownerPool };
  }

  it('forces internal chat tables never_share — a member cannot read another user’s chat', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `car_${tag}`;
    const member = `lm_car_${tag}`;
    schemas.push(schema);
    roles.push(member);
    const { o, ownerPool } = await ownerCloud(schema);

    await o.upsert('chat_messages', {
      id: 'm1',
      thread_id: 't1',
      content_json: '{"text":"secret"}',
      owner_user_id: 'owner-x', // belongs to the owner, not the member
    });

    // Simulate a restore that left chat stamped shared (the old leak scenario):
    // policy says everyone + the existing row is visibility=everyone.
    await ownerPool.query(
      `UPDATE __lattice_table_policy SET never_share = false, default_row_visibility = 'everyone' WHERE table_name = 'chat_messages'`,
    );
    await ownerPool.query(
      `UPDATE __lattice_owners SET visibility = 'everyone' WHERE table_name = 'chat_messages'`,
    );

    const memberPw = generateMemberPassword();
    await provisionMemberRole(o, member, memberPw);
    const M = memberPool(schema, member, memberPw);

    // Defense-in-depth: even in this corrupted "everyone" state, the per-author
    // chat RLS (owner_user_id = session_user, fail-closed on NULL) STILL blocks the
    // member — a chat row is readable only by its author, so this can't leak even
    // if the table policy is wrong. (Previously the member saw it here.)
    expect((await M.query('SELECT id FROM chat_messages')).rows).toHaveLength(0);

    // Owner open also converges the table policy back to never_share (belt + braces).
    await reconcileCloudMemberAccess(o);

    expect((await M.query('SELECT id FROM chat_messages')).rows).toHaveLength(0);
    const pol = await ownerPool.query(
      `SELECT never_share FROM __lattice_table_policy WHERE table_name = 'chat_messages'`,
    );
    expect(pol.rows[0]?.never_share).toBe(true);
  });

  it('re-grants member access after a grant-dropping restore (--no-privileges round-trip)', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `cgr_${tag}`;
    const member = `lm_cgr_${tag}`;
    schemas.push(schema);
    roles.push(member);
    const { o, ownerPool } = await ownerCloud(schema);
    await o.upsert('note', { id: 'n1', body: 'shared' });
    await ownerPool.query(`SELECT lattice_set_row_visibility('note', 'n1', 'everyone')`);

    const memberPw = generateMemberPassword();
    await provisionMemberRole(o, member, memberPw);
    const M = memberPool(schema, member, memberPw);

    // Sanity: the shared row is readable.
    expect((await M.query('SELECT id FROM note')).rows).toHaveLength(1);

    // Drop the grant the way a `pg_dump --no-privileges` restore would (policy +
    // RLS remain, GRANT gone) → the member can no longer read the table.
    await ownerPool.query(`REVOKE ALL ON "note" FROM ${MEMBER_GROUP}`);
    await expect(M.query('SELECT id FROM note')).rejects.toThrow(/permission denied/i);

    // Owner open converges access → grant re-issued, shared row readable again.
    await reconcileCloudMemberAccess(o);
    expect((await M.query('SELECT id FROM note')).rows.map((r) => r.id as string)).toEqual(['n1']);
  });
});
