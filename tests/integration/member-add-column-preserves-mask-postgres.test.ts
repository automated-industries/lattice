/**
 * A MEMBER adding a field must not be able to un-mask a column.
 *
 * `lattice_member_add_column` is the one view-generating path that runs on a
 * MEMBER's connection: a member cannot `ALTER TABLE`, so their create/update with a
 * new field name is routed through this `SECURITY DEFINER` helper, which adds the
 * column and rebuilds `<t>_v`. It rebuilt that view from `__lattice_column_policy`
 * alone — and the policy does not record every mask:
 *
 *   - a computed column inheriting its source's masking is guarded in the generated
 *     view but has NO policy row, so a policy-only rebuild un-masks it on a
 *     perfectly healthy workspace; and
 *   - a policy stranded under an older name reads back empty, as it does everywhere.
 *
 * The stranded case is the one that matters most, and it is why this is not merely
 * a stale view: the rebuild REPLACES `<t>_v`, so an un-masked rebuild destroys the
 * last surviving record of what was secret. After that no owner reconcile can
 * recover it — the exposure is permanent, and it was caused by an ordinary member
 * action taken while no owner was connected.
 *
 * Nothing exercised this path before. Every other rebuild is TypeScript and carries
 * the preservation logic; this one is plpgsql and did not, and the two disagreeing
 * is exactly how it survived a review that checked the TypeScript ones.
 *
 * Postgres-gated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud, reconcileCloudMemberAccess } from '../../src/cloud/setup.js';
import { setColumnAudience } from '../../src/cloud/audience.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { runAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const SECRET = 'MEMBER-ADDCOL-EYES-ONLY';
const databases: string[] = [];
const roles: string[] = [];
const pools: pg.Pool[] = [];

function dbUrl(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

afterEach(async () => {
  for (const p of pools.splice(0)) await p.end().catch(() => undefined);
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  for (const db of databases.splice(0)) {
    await admin
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db],
      )
      .catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${db}"`).catch(() => undefined);
  }
  await admin.end();
});

async function maskedCloud(): Promise<{
  owner: Lattice;
  dbname: string;
  role: string;
  pw: string;
}> {
  const dbname = `lattice_mac_${randomBytes(4).toString('hex')}`;
  databases.push(dbname);
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE DATABASE "${dbname}"`);
  await admin.end();

  const owner = new Lattice(dbUrl(dbname));
  owner.define('journal', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', secret: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'journal.md',
  });
  await owner.init();
  await secureCloud(owner);
  await owner.insert('journal', { id: 'j1', body: 'visible', secret: SECRET });
  await runAsyncOrSync(
    owner.adapter,
    `SELECT lattice_set_row_visibility('journal','j1','everyone')`,
  );
  await setColumnAudience(
    owner,
    'journal',
    'secret',
    'owner',
    ['id', 'body', 'secret', 'deleted_at'],
    ['id'],
  );

  const role = `lm_${randomBytes(3).toString('hex')}`;
  roles.push(role);
  const pw = generateMemberPassword();
  await provisionMemberRole(owner, role, pw);
  return { owner, dbname, role, pw };
}

describe.skipIf(!PG_URL)('a member adding a field cannot un-mask a column', () => {
  it('keeps the mask when the policy is intact', async () => {
    const { owner, dbname, role, pw } = await maskedCloud();
    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);

    expect((await member.query(`SELECT secret FROM "journal_v"`)).rows[0]?.secret).toBeNull();
    await member.query(`SELECT lattice_member_add_column('journal', 'note', 'text')`);
    expect((await member.query(`SELECT secret FROM "journal_v"`)).rows[0]?.secret).toBeNull();

    owner.close();
  }, 180_000);

  it('keeps the mask when the policy has been STRANDED, and does not destroy the evidence', async () => {
    const { owner, dbname, role, pw } = await maskedCloud();

    // The drift every 5.4-or-earlier tenant can already be in: the policy is keyed
    // to a name nothing answers to, and the standing view is the only record left.
    await runAsyncOrSync(
      owner.adapter,
      `UPDATE "__lattice_column_policy" SET "table_name" = 'gone' WHERE "table_name" = 'journal'`,
    );

    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);
    expect((await member.query(`SELECT secret FROM "journal_v"`)).rows[0]?.secret).toBeNull();

    // An ordinary member action, taken with no owner connected.
    await member.query(`SELECT lattice_member_add_column('journal', 'note', 'text')`);

    // Without preservation this returns the value in clear — and permanently, since
    // the rebuild has overwritten the only surviving record of the mask.
    expect((await member.query(`SELECT secret FROM "journal_v"`)).rows[0]?.secret).toBeNull();

    // The evidence survived, so an owner reconcile can still recover the policy.
    await reconcileCloudMemberAccess(owner);
    expect((await member.query(`SELECT secret FROM "journal_v"`)).rows[0]?.secret).toBeNull();

    owner.close();
  }, 180_000);
});
