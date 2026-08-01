/**
 * The lineage lock must not blind the role that writes lineage.
 *
 * `__lattice_lineage` is locked with row security and NO policies: nothing
 * matches, so every role the policies apply to reads zero rows and can insert
 * nothing. `FORCE ROW LEVEL SECURITY` is the clause that extends "the policies
 * apply to you" to the table's own OWNER — and the owner is the only role that
 * ever writes this table. On a cloud whose owner is an ordinary non-BYPASSRLS
 * role, forcing it therefore locks out the sole legitimate writer: every import
 * and file extraction aborts at its `recordLineage` call, AFTER the table and
 * its rows have already landed, so a half-applied import is reported as a
 * failure.
 *
 * The rest of the Postgres suite cannot ask this question — it connects as the
 * cluster's bootstrap superuser, which reads and writes through every policy, so
 * the insert succeeds whether or not the table is forced. This test connects as
 * a realistic owner instead (provisionRestrictedOwner) and pins the WRITE
 * invariant the restricted-owner read suite deliberately left for its own test.
 *
 * Both halves are pinned here, because dropping the force clause is only correct
 * if it costs nothing: the lock still has to deny a non-owner. The second case
 * hands a non-owner role the stray `GRANT` this lock exists to survive and
 * asserts it still reads zero rows and still cannot insert.
 *
 * Postgres-gated (real per-test cloud database + a real restricted owner role).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { installCloudRls, memberGroupFor } from '../../src/cloud/rls.js';
import { openConfig, disposeActive } from '../../src/gui/lifecycle.js';
import { registerPostgresPolyfills } from '../../src/db/postgres.js';
import { generateMemberPassword } from '../../src/cloud/members.js';
import { recordLineage, LINEAGE_TABLE } from '../../src/gui/lineage-store.js';
import { getAsyncOrSync, allAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';
import { provisionRestrictedOwner } from './helpers/restricted-owner.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const databases: string[] = [];
const roles: string[] = [];
const schemas: string[] = [];
const dirs: string[] = [];
const opened: Lattice[] = [];

/** pg maps a Postgres `bool` to a JS boolean; tolerate the 't' / 1 spellings too,
 *  exactly as the product's own catalog checks do. */
const isTrue = (v: unknown): boolean => v === true || v === 't' || v === 1;

function schemaUrl(schema: string): string {
  return `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

/** The two catalog flags for the lineage table, as booleans. */
async function lineageSecurity(db: Lattice): Promise<{ enabled: boolean; forced: boolean }> {
  const rel = (await getAsyncOrSync(
    db.adapter,
    `SELECT c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname = $1`,
    [LINEAGE_TABLE],
  )) as Record<string, unknown> | undefined;
  return {
    enabled: isTrue(rel?.relrowsecurity),
    forced: isTrue(rel?.relforcerowsecurity),
  };
}

afterEach(async () => {
  for (const d of opened.splice(0)) {
    try {
      d.close();
    } catch {
      /* best-effort */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const s of schemas.splice(0)) {
    await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => undefined);
  }
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

describe.skipIf(!PG_URL)('the lineage lock', () => {
  it('lets a restricted (non-BYPASSRLS) owner record and read lineage, and still denies a stray-granted non-owner', async () => {
    const dbname = `lattice_lin_${randomBytes(4).toString('hex')}`;
    const role = `lo_lin_${randomBytes(3).toString('hex')}`;
    const stray = `lo_str_${randomBytes(3).toString('hex')}`;
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

    await secureCloud(owner);
    // Securing mints the per-cloud member group, which is cluster-level and so
    // survives dropping the database. Track it for teardown.
    roles.push(await memberGroupFor(owner));

    // Guard against a vacuous pass. If the connection were superuser/BYPASSRLS the
    // write below would succeed while saying nothing about the invariant, and if
    // the lock were not installed at all it would succeed for the wrong reason.
    const who = (await getAsyncOrSync(
      owner.adapter,
      `SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user`,
    )) as Record<string, unknown>;
    expect(isTrue(who.rolsuper)).toBe(false);
    expect(isTrue(who.rolbypassrls)).toBe(false);
    expect(isTrue(who.rolcreaterole)).toBe(true); // the owner gate reads this
    expect((await lineageSecurity(owner)).enabled).toBe(true); // the lock IS installed

    // THE INVARIANT: the owner records a lineage edge — the call every import and
    // file extraction makes once the rows have landed — and reads it back. Both
    // halves matter: forcing the table makes the insert throw, and were it to
    // land anyway the select would return nothing.
    await recordLineage(owner.adapter, [
      {
        objectTable: 'notes',
        objectId: '*',
        sourceKind: 'import',
        sourceId: 'notes.csv',
        tier: 'derived',
        relation: 'materialized_from',
      },
    ]);
    const mine = await allAsyncOrSync(
      owner.adapter,
      `SELECT "object_table", "source_kind", "source_id" FROM "${LINEAGE_TABLE}"`,
    );
    expect(mine).toEqual([
      { object_table: 'notes', source_kind: 'import', source_id: 'notes.csv' },
    ]);

    // The lock still does its job. Hand a non-owner login role the stray GRANT
    // this lock exists to survive, and it reads nothing and writes nothing.
    const strayPassword = generateMemberPassword(); // hex — always safe to interpolate
    await runAsyncOrSync(
      owner.adapter,
      `CREATE ROLE "${stray}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${strayPassword}'`,
    );
    roles.push(stray);
    await runAsyncOrSync(owner.adapter, `GRANT CONNECT ON DATABASE "${dbname}" TO "${stray}"`);
    await runAsyncOrSync(owner.adapter, `GRANT USAGE ON SCHEMA public TO "${stray}"`);
    await runAsyncOrSync(owner.adapter, `GRANT SELECT, INSERT ON "${LINEAGE_TABLE}" TO "${stray}"`);

    const strayUrl = new URL(url);
    strayUrl.username = stray;
    strayUrl.password = strayPassword;
    const strayPool = new pg.Pool({ connectionString: strayUrl.toString(), max: 1 });
    try {
      const seen = await strayPool.query(`SELECT * FROM "${LINEAGE_TABLE}"`);
      expect(seen.rows).toEqual([]); // the owner's edge is there; this role sees none of it
      await expect(
        strayPool.query(
          `INSERT INTO "${LINEAGE_TABLE}"
             ("id","object_table","object_id","source_kind","tier","relation","created_at")
           VALUES ('x','notes','*','import','derived','materialized_from','2026-01-01T00:00:00.000Z')`,
        ),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await strayPool.end();
    }
  });

  it('lifts the force clause on a cloud that was already secured with it', async () => {
    const schema = `lin_${randomBytes(4).toString('hex')}`;
    schemas.push(schema);
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();

    // A cloud secured by an earlier release: the lineage lock carries FORCE, and
    // nothing re-runs `secureCloud` on an existing cloud, so only the owner-open
    // converge can reach it.
    const setup = new Lattice(schemaUrl(schema));
    setup.define('note', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'note.md',
    });
    await setup.init();
    await registerPostgresPolyfills((sql) => runAsyncOrSync(setup.adapter, sql));
    await installCloudRls(setup);
    await secureCloud(setup);
    await runAsyncOrSync(setup.adapter, `ALTER TABLE "${LINEAGE_TABLE}" FORCE ROW LEVEL SECURITY`);
    expect(await lineageSecurity(setup)).toEqual({ enabled: true, forced: true }); // the drift is real
    setup.close();

    const root = mkdtempSync(join(tmpdir(), `lin-${randomBytes(3).toString('hex')}-`));
    dirs.push(root);
    const configPath = join(root, 'lattice.config.yml');
    writeFileSync(
      configPath,
      [
        `db: ${schemaUrl(schema)}`,
        '',
        'entities:',
        '  note:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      body: { type: text }',
        '    render: default-list',
        '    outputFile: note.md',
      ].join('\n'),
    );
    const outputDir = join(root, 'context');
    mkdirSync(outputDir, { recursive: true });

    const active = await openConfig(configPath, outputDir);
    await active.converged;
    // Converged back to enabled-but-not-forced: the lock is intact and the owner
    // can write through it again.
    expect(await lineageSecurity(active.db)).toEqual({ enabled: true, forced: false });
    expect(active.convergeWarnings).toEqual([]);
    await disposeActive(active);
  });
});
