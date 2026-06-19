/**
 * 3.3.3 regression: an invited member's GUI silently degraded to read-only /
 * "save as document" because reconcileCloudMemberAccess never granted the member
 * group the GUI/identity bookkeeping tables, never granted EXECUTE on the SQLite
 * polyfills, and a cloud migrated from a pre-soft-delete SQLite was missing the
 * `deleted_at` column the render/counts filter on.
 *
 * This pins the converged member-access state: after reconcileCloudMemberAccess,
 * the lattice_members group can read/write the GUI meta + identity tables, can
 * EXECUTE the polyfills, and every user entity table has `deleted_at`.
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { installCloudRls, memberGroupFor } from '../../src/cloud/rls.js';
import { reconcileCloudMemberAccess } from '../../src/cloud/setup.js';
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
  for (const s of schemas.splice(0)) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  await admin.end();
});

describe.skipIf(!PG_URL)('3.3.3 cloud member provisioning grants', () => {
  async function ownerCloud(): Promise<Lattice> {
    const schema = `mp_${randomBytes(4).toString('hex')}`;
    schemas.push(schema);
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const o = new Lattice(schemaUrl(schema));
    dbs.push(o);
    // A user entity table deliberately created WITHOUT deleted_at — the pre-soft-
    // delete shape a migrated SQLite would have.
    o.define('projects', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: () => '',
      outputFile: 'projects.md',
    });
    await o.init();
    await registerPostgresPolyfills((sql) => runAsyncOrSync(o.adapter, sql));
    await installCloudRls(o);
    // The GUI lazily creates these on workspace open (here: simulate that the
    // owner opened the GUI once before inviting a member).
    await runAsyncOrSync(
      o.adapter,
      `CREATE TABLE "_lattice_gui_meta" (table_name TEXT PRIMARY KEY, icon TEXT)`,
    );
    await runAsyncOrSync(
      o.adapter,
      `CREATE TABLE "_lattice_gui_column_meta" (table_name TEXT, column_name TEXT, description TEXT)`,
    );
    await runAsyncOrSync(
      o.adapter,
      `CREATE TABLE "_lattice_gui_audit" (id TEXT PRIMARY KEY, session_id TEXT)`,
    );
    await runAsyncOrSync(
      o.adapter,
      `CREATE TABLE "__lattice_user_identity" (id TEXT PRIMARY KEY, display_name TEXT, email TEXT)`,
    );
    return o;
  }

  async function memberHasTablePriv(db: Lattice, table: string, priv: string): Promise<boolean> {
    const group = await memberGroupFor(db);
    const row = (await getAsyncOrSync(
      db.adapter,
      `SELECT has_table_privilege(?::text, format('%I.%I', current_schema(), ?::text), ?::text) AS ok`,
      [group, table, priv],
    )) as { ok?: unknown } | undefined;
    return row?.ok === true || row?.ok === 't';
  }

  async function columnExists(db: Lattice, table: string, column: string): Promise<boolean> {
    const row = (await getAsyncOrSync(
      db.adapter,
      `SELECT 1 AS ok FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ?::text AND column_name = ?::text`,
      [table, column],
    )) as { ok?: unknown } | undefined;
    return !!row;
  }

  it('grants the member group the GUI/identity tables, polyfill EXECUTE, and adds deleted_at', async () => {
    const o = await ownerCloud();
    const group = await memberGroupFor(o);
    const member = `lm_${randomBytes(4).toString('hex')}`;
    roles.push(member);
    await provisionMemberRole(o, member, generateMemberPassword());

    await reconcileCloudMemberAccess(o);

    // GUI bookkeeping + identity tables are now member-accessible.
    expect(await memberHasTablePriv(o, '_lattice_gui_meta', 'SELECT')).toBe(true);
    expect(await memberHasTablePriv(o, '_lattice_gui_meta', 'INSERT')).toBe(true);
    expect(await memberHasTablePriv(o, '_lattice_gui_column_meta', 'UPDATE')).toBe(true);
    expect(await memberHasTablePriv(o, '_lattice_gui_audit', 'INSERT')).toBe(true);
    // The audit table needs UPDATE (undo/redo/revert flips `undone`) and DELETE
    // (the redo-stack purge on a new mutation) too — gated by enableGuiAuditRls's
    // per-op RLS USING clauses. Without these the member's undo/redo + new-edit
    // paths fail with "permission denied for table _lattice_gui_audit".
    expect(await memberHasTablePriv(o, '_lattice_gui_audit', 'UPDATE')).toBe(true);
    expect(await memberHasTablePriv(o, '_lattice_gui_audit', 'DELETE')).toBe(true);
    expect(await memberHasTablePriv(o, '__lattice_user_identity', 'UPDATE')).toBe(true);

    // Polyfills are EXECUTE-able by the member group.
    const fnRow = (await getAsyncOrSync(
      o.adapter,
      `SELECT has_function_privilege(?::text, 'json_extract(text,text)', 'EXECUTE') AS je,
              has_function_privilege(?::text, 'strftime(text,text)', 'EXECUTE') AS sf`,
      [group, group],
    )) as { je?: unknown; sf?: unknown } | undefined;
    expect(fnRow?.je === true || fnRow?.je === 't').toBe(true);
    expect(fnRow?.sf === true || fnRow?.sf === 't').toBe(true);

    // The migrated entity table now has deleted_at.
    expect(await columnExists(o, 'projects', 'deleted_at')).toBe(true);
  });
});
