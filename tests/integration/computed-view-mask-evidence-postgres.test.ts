/**
 * A computed view must not become a way around the mask when the column policy
 * goes missing.
 *
 * A computed table is a Postgres VIEW, and member reconciliation grants members
 * SELECT on every one of them. Whether that view reads the masked table's `<t>_v`
 * or its BASE table is decided once, at compile time, from `__lattice_column_policy`
 * — and that policy is losable: restore a database without it, or mis-key it with a
 * rename, and it reads back "nothing is masked here".
 *
 * So the dangerous sequence is: policy lost, then ANY recompilation — a definition
 * edit, or the open path's content-hash migration — and the projection is rebuilt
 * reading the base table. The mask on `<t>_v` is still standing and still looks
 * correct; the value simply arrives through the other door. This is the same defect
 * that made the masked view itself rebuild unmasked, one path further out, and it
 * would have been missed by every check that inspects `<t>_v`.
 *
 * The fix consults the standing views as evidence alongside the policy, so a table
 * whose `<t>_v` guards anything counts as masked no matter what the policy says. The
 * union only ever ADDS tables, so it cannot un-mask anything.
 *
 * Postgres-gated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { setColumnAudience } from '../../src/cloud/audience.js';
import { runAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const SECRET = 'COMPUTED-EYES-ONLY';
const databases: string[] = [];

function dbUrl(dbname: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  return u.toString();
}

afterEach(async () => {
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
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

describe.skipIf(!PG_URL)('a lost column policy cannot un-mask a computed projection', () => {
  it('still reports the table as masked when only the view says so', async () => {
    const dbname = `lattice_cvm_${randomBytes(4).toString('hex')}`;
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
    await setColumnAudience(
      owner,
      'journal',
      'secret',
      'owner',
      ['id', 'body', 'secret', 'deleted_at'],
      ['id'],
    );

    // Sanity: with the policy intact, the compiler knows the table is masked, so a
    // computed projection over it would be compiled to read `journal_v`.
    const withPolicy =
      (await (
        owner as unknown as {
          computedCloudOption: (o: { introspectOnly?: boolean }) => Promise<{
            maskedTables?: Set<string>;
          }>;
        }
      ).computedCloudOption({})) ?? {};
    expect([...(withPolicy.maskedTables ?? [])]).toContain('journal');

    // ── Lose the policy. This is the realistic shape: not a rename, not a name
    //    mismatch — the rows are simply gone, as a partial restore leaves them.
    //    Every name-keyed lookup now reads back "nothing is masked here".
    await runAsyncOrSync(
      owner.adapter,
      `DELETE FROM "__lattice_column_policy" WHERE "table_name" = 'journal'`,
    );

    // The masking view is untouched and still guards the column — it is the only
    // surviving record of what was secret.
    const def = (
      await owner.adapter.allAsync!(
        `SELECT pg_get_viewdef(c.oid, true) AS def FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema() AND c.relkind = 'v' AND c.relname = 'journal_v'`,
      )
    )[0] as { def?: string } | undefined;
    expect(def?.def ?? '').toMatch(/lattice_is_owner/i);

    // ── The assertion. Without the view-evidence union this returns a set that does
    //    NOT contain `journal`, and the next recompilation points the projection at
    //    the base table — serving the secret to every member who can read the view.
    const afterLoss =
      (await (
        owner as unknown as {
          computedCloudOption: (o: { introspectOnly?: boolean }) => Promise<{
            maskedTables?: Set<string>;
          }>;
        }
      ).computedCloudOption({})) ?? {};
    expect([...(afterLoss.maskedTables ?? [])]).toContain('journal');

    owner.close();
  }, 180_000);
});
