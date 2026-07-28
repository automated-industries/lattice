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

async function maskedCloud(col = 'secret'): Promise<{
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
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', [col]: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'journal.md',
  });
  await owner.init();
  await secureCloud(owner);
  await owner.insert('journal', { id: 'j1', body: 'visible', [col]: SECRET });
  await runAsyncOrSync(
    owner.adapter,
    `SELECT lattice_set_row_visibility('journal','j1','everyone')`,
  );
  await setColumnAudience(
    owner,
    'journal',
    col,
    'owner',
    ['id', 'body', col, 'deleted_at'],
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

  /**
   * The same attack with a MIXED-CASE column name.
   *
   * Postgres quotes any identifier that is not all-lowercase, so the view emits
   * END AS "secretNote" rather than END AS secret_note. The plpgsql reader was
   * case-sensitive, required an unquoted name, and matched a single literal space —
   * three ways to miss, all of them under-recovering — while the TypeScript reader
   * it is supposed to mirror handled every one. So this leaked while the snake_case
   * case above passed, and the test that existed used snake_case.
   *
   * Mixed-case columns are legal (`assertSafeIdentifier` allows them) and arrive
   * through the library and through connector introspection, neither of which
   * lowercases.
   */
  it('keeps the mask for a MIXED-CASE column name, which Postgres quotes', async () => {
    const { owner, dbname, role, pw } = await maskedCloud('secretNote');
    await runAsyncOrSync(
      owner.adapter,
      `UPDATE "__lattice_column_policy" SET "table_name" = 'gone' WHERE "table_name" = 'journal'`,
    );

    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);
    expect(
      (await member.query(`SELECT "secretNote" FROM "journal_v"`)).rows[0]?.secretNote,
    ).toBeNull();

    await member.query(`SELECT lattice_member_add_column('journal', 'note', 'text')`);

    expect(
      (await member.query(`SELECT "secretNote" FROM "journal_v"`)).rows[0]?.secretNote,
    ).toBeNull();

    owner.close();
  }, 180_000);

  /**
   * ...and the member can still WRITE afterwards.
   *
   * A security fix that quietly bricks member writes is not a fix, and this path had
   * exactly that shape. The last statement of the helper is a column-less
   * `REVOKE SELECT ON <base>`, which in Postgres drops the table-level grant AND every
   * column-level one. The owner-side generator welds two re-grants to that same
   * revoke — the unmasked columns, and the pk + deleted_at an `UPDATE ... WHERE id = ?`
   * needs — because taking base SELECT away takes the member's ability to write with
   * it. The plpgsql path re-issued neither, so a member who added a field to a masked
   * table permanently lost `UPDATE` and soft-delete on it: every write came back
   * "permission denied for table journal" until an owner reopened the workspace.
   *
   * Asserted on the writes themselves, not on privilege bits. Privilege bits were
   * correct throughout every leak in this release, and the earlier version of this
   * same brick went unnoticed for exactly that reason: the masked-table tests checked
   * grants and never performed a member write.
   */
  it('leaves the member able to UPDATE and soft-delete after adding a field', async () => {
    const { owner, dbname, role, pw } = await maskedCloud();
    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);

    // Writes work BEFORE the add-column, so a failure below is caused by it.
    await expect(
      member.query(`UPDATE "journal" SET "body" = 'edited before' WHERE "id" = 'j1'`),
    ).resolves.toBeTruthy();

    await member.query(`SELECT lattice_member_add_column('journal', 'note', 'text')`);

    // The write paths a member's GUI actually uses: an edit, and a soft delete.
    await expect(
      member.query(`UPDATE "journal" SET "body" = 'edited after' WHERE "id" = 'j1'`),
    ).resolves.toBeTruthy();
    await expect(
      member.query(
        `UPDATE "journal" SET "deleted_at" = 'now' WHERE "id" = 'j1' AND "deleted_at" IS NULL`,
      ),
    ).resolves.toBeTruthy();
    // The column the member just added is writable too — it is unmasked, so the
    // re-grant has to cover columns that did not exist when the view was first built.
    await expect(
      member.query(`UPDATE "journal" SET "note" = 'mine' WHERE "id" = 'j1'`),
    ).resolves.toBeTruthy();

    // Restoring writes must not have restored READ of the masked column: the value
    // is still NULL through the view, and the base is still closed.
    await expect(member.query(`SELECT "secret" FROM "journal"`)).rejects.toThrow(
      /permission denied/i,
    );
    const via = await member.query<{ secret: string | null; body: string | null }>(
      `SELECT "secret", "body" FROM "journal_v"`,
    );
    // The row is soft-deleted but the view has no deleted_at filter, so it is still
    // readable here — which is what makes the mask assertion meaningful.
    expect(via.rows[0]?.secret ?? null).toBeNull();
    expect(via.rows[0]?.body).toBe('edited after');

    owner.close();
  }, 180_000);
});
