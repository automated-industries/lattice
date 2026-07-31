/**
 * Securing a table must not blind the role that owns it.
 *
 * `FORCE ROW LEVEL SECURITY` deliberately applies the policies to the table's
 * OWNER as well, and the row-visibility predicate answers from an ownership
 * record. So on a cloud whose owner is an ordinary non-BYPASSRLS role, "secure
 * this table" and "the owner can still read this table" are the same question,
 * and the answer depends entirely on ownership records existing by the time the
 * policies start applying. Get that order wrong and the owner sees zero rows,
 * permanently, with no error raised anywhere.
 *
 * The rest of the Postgres suite cannot ask this question: it connects as the
 * cluster's bootstrap superuser, which reads through every policy, so the rows
 * come back whether or not the ownership records were ever written. This test
 * connects as a realistic owner instead (provisionRestrictedOwner) and pins the
 * invariant for both ways a row acquires an ownership record — the backfill of
 * rows that predate securing, and the trigger on rows written afterwards.
 *
 * Writes here go through insert(), which emits a plain INSERT, and that is not
 * incidental. An INSERT carrying an ON CONFLICT clause is additionally re-checked
 * against the SELECT policy once the row lands, so the clause cannot be used to
 * probe for rows the caller may not see. The ownership record those policies read
 * is written by an AFTER INSERT trigger, which has not run at that point — so
 * upsert() of a NEW row into a secured table is refused outright for a
 * non-BYPASSRLS caller. That is a write-path defect, distinct from the read
 * invariant pinned here, and it is deliberately left for its own regression test
 * rather than folded in.
 *
 * Postgres-gated (real per-test cloud database + a real restricted owner role).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { memberGroupFor } from '../../src/cloud/rls.js';
import { getAsyncOrSync } from '../../src/db/adapter.js';
import { provisionRestrictedOwner } from './helpers/restricted-owner.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const databases: string[] = [];
const roles: string[] = [];
const opened: Lattice[] = [];

/** pg maps a Postgres `bool` to a JS boolean; tolerate the 't' / 1 spellings too,
 *  exactly as the product's own catalog checks do. */
const isTrue = (v: unknown): boolean => v === true || v === 't' || v === 1;

afterEach(async () => {
  for (const d of opened.splice(0)) {
    try {
      d.close();
    } catch {
      /* best-effort */
    }
  }
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  // Databases BEFORE roles: the restricted owner owns its database, and Postgres
  // refuses to drop a role that still owns one.
  for (const db of databases.splice(0)) {
    await admin
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db],
      )
      .catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${db}"`).catch(() => undefined);
  }
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  await admin.end();
});

describe.skipIf(!PG_URL)('restricted (non-BYPASSRLS) cloud owner', () => {
  it('still sees its own rows once the table is forced under row security', async () => {
    const dbname = `lattice_ro_${randomBytes(4).toString('hex')}`;
    const role = `lo_ro_${randomBytes(3).toString('hex')}`;
    databases.push(dbname);
    const url = await provisionRestrictedOwner(PG_URL!, dbname, role);
    roles.push(role);

    const owner = new Lattice(url);
    opened.push(owner);
    owner.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'notes.md',
    });
    await owner.init();

    // A row that predates securing — it gets its ownership record from the
    // backfill that securing performs.
    await owner.insert('notes', { id: 'n1', body: 'before' });

    await secureCloud(owner);
    // Securing mints the per-cloud member group, which is cluster-level and so
    // survives dropping the database. Track it for teardown.
    roles.push(await memberGroupFor(owner));

    // A row written afterwards — its ownership record comes from the trigger.
    await owner.insert('notes', { id: 'n2', body: 'after' });

    // Guard against a vacuous pass from either direction. If the connection were
    // superuser/BYPASSRLS, or if the table were not actually forced, the reads
    // below would succeed without saying anything about the invariant.
    const who = (await getAsyncOrSync(
      owner.adapter,
      `SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user`,
    )) as Record<string, unknown>;
    expect(isTrue(who.rolsuper)).toBe(false);
    expect(isTrue(who.rolbypassrls)).toBe(false);
    expect(isTrue(who.rolcreaterole)).toBe(true); // the owner gate reads this

    const rel = (await getAsyncOrSync(
      owner.adapter,
      `SELECT c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = 'notes'`,
    )) as Record<string, unknown>;
    expect(isTrue(rel.relrowsecurity)).toBe(true);
    expect(isTrue(rel.relforcerowsecurity)).toBe(true);

    // The invariant. Assert on COUNTS and VALUES, not on the absence of an
    // exception — this failure mode throws nothing, it just returns nothing.
    expect((await owner.get('notes', 'n1'))?.body).toBe('before');
    expect((await owner.get('notes', 'n2'))?.body).toBe('after');
    const all = await owner.query('notes', {});
    expect(all.map((r) => r.id).sort()).toEqual(['n1', 'n2']);
  });
});
