/**
 * UNDOING a rename must not strip the table's cloud column masking.
 *
 * A rename is not one operation in this codebase — it is one operation with two
 * replays. The version history can put a rename back (undo) and apply it again
 * (redo), and each of those is itself a rename of the same table. They do not go
 * through the rename primitive: they edit the configuration document and emit an
 * `ALTER TABLE ... RENAME`, then re-open the workspace.
 *
 * On a secured cloud that is the identical failure the forward path was hardened
 * against, reached from a different button. A column the owner marked secret is
 * masked by a generated `<t>_v` view; the spec itself lives in
 * `__lattice_column_policy`, keyed BY TABLE NAME. A bare rename moves the table
 * and leaves both behind under the name it no longer has:
 *
 *   • the policy read under the new name comes back empty, which is
 *     indistinguishable from "this table has no secret columns";
 *   • the view is bound to the table by identity, not by name, so it keeps
 *     masking — under the old name, where nothing looks for it;
 *   • the re-open that follows reconciles member access, reads that empty
 *     policy, takes the unmasked branch, and GRANTS the member group raw SELECT
 *     on the base table.
 *
 * The member then reads the secret column in cleartext while the interface still
 * shows it as masked. Undo is a normal, expected thing to press.
 *
 * Postgres-only by construction: masking views, roles and grants do not exist on
 * SQLite, which is exactly why a SQLite suite cannot catch this.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { openConfig, disposeActive, applySchemaConfig } from '../../src/gui/lifecycle.js';
import type { ActiveDb } from '../../src/gui/active-db.js';
import { parseAudit, type AuditEntry } from '../../src/gui/mutations.js';
import { renameUserEntity } from '../../src/gui/schema-ops.js';
import { secureCloud, reconcileCloudMemberAccess } from '../../src/cloud/setup.js';
import { setColumnAudience } from '../../src/cloud/audience.js';
import { memberGroupFor } from '../../src/cloud/rls.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import type { Lattice } from '../../src/lattice.js';
import { allAsyncOrSync, getAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const dirs: string[] = [];
const actives: ActiveDb[] = [];
const pools: pg.Pool[] = [];
const databases: string[] = [];
const roles: string[] = [];

function dbUrl(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

afterEach(async () => {
  for (const a of actives.splice(0)) await disposeActive(a).catch(() => undefined);
  for (const p of pools.splice(0)) await p.end();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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

function writeOwnerConfig(url: string): string {
  const root = mkdtempSync(join(tmpdir(), 'lattice-rnmundo-'));
  dirs.push(root);
  mkdirSync(join(root, 'context'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      `db: "${url}"`,
      '',
      'entities:',
      '  journal:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      body: { type: text }',
      '      secret: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: journal.md',
      '',
    ].join('\n'),
    'utf8',
  );
  return configPath;
}

/** Does the member GROUP hold `priv` on `table` in the current schema? */
async function memberHasTablePriv(db: Lattice, table: string, priv: string): Promise<boolean> {
  const group = await memberGroupFor(db);
  const row = (await getAsyncOrSync(
    db.adapter,
    `SELECT has_table_privilege(?::text, format('%I.%I', current_schema(), ?::text), ?::text) AS ok`,
    [group, table, priv],
  )) as { ok?: unknown } | undefined;
  return row?.ok === true || row?.ok === 't';
}

/** Newest audit entry for an operation — the handle undo/redo needs. */
async function auditEntry(active: ActiveDb, operation: string): Promise<AuditEntry> {
  const rows = (await active.db.query('_lattice_gui_audit', {
    filters: [{ col: 'operation', op: 'eq', val: operation }],
    orderBy: 'ts',
    orderDir: 'desc',
    limit: 1,
  })) as Record<string, unknown>[];
  const row = rows[0];
  if (!row) throw new Error(`no audit entry recorded for ${operation}`);
  return parseAudit(row);
}

/** Replace the tracked ActiveDb with the one a replay re-opened. */
function swap(previous: ActiveDb, next: ActiveDb): ActiveDb {
  const idx = actives.indexOf(previous);
  if (idx >= 0) actives.splice(idx, 1, next);
  else actives.push(next);
  return next;
}

/** The column policy, as `table.column` pairs, whatever names it is keyed to. */
async function policyKeys(db: Lattice): Promise<string[]> {
  const rows = (await allAsyncOrSync(
    db.adapter,
    `SELECT "table_name", "column_name" FROM "__lattice_column_policy"
      ORDER BY "table_name", "column_name"`,
  )) as { table_name: string; column_name: string }[];
  return rows.map((r) => `${r.table_name}.${r.column_name}`);
}

/**
 * Every `<t>_v` read view standing in the schema.
 *
 * Under the fail-closed model EVERY member-readable table has one: it is the
 * member's only read path, not a marker that something on that table is masked.
 * So the list is no longer expected to hold exactly the masked tables — what a
 * rename has to get right is which NAME each view stands under. The view must
 * follow the table to the name it has now, and nothing may be left behind under
 * the name it used to have (a stranded view keeps masking the table under a name
 * every name-keyed lookup comes back empty for).
 */
async function maskViews(db: Lattice): Promise<string[]> {
  const rows = (await allAsyncOrSync(
    db.adapter,
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind = 'v' AND c.relname LIKE '%\\_v'
      ORDER BY 1`,
  )) as { name: string }[];
  return rows.map((r) => r.name);
}

describe.skipIf(!PG_URL)('undoing and redoing a rename keeps the masking with the table', () => {
  it('a masked table stays masked through undo and redo of its rename', async () => {
    const dbname = `lattice_rnmu_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    {
      const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
      await admin.query(`CREATE DATABASE "${dbname}"`);
      await admin.end();
    }

    const ownerCfg = writeOwnerConfig(dbUrl(dbname));
    let owner = await openConfig(ownerCfg, join(ownerCfg, '..', 'context'), false);
    actives.push(owner);
    await owner.converged;
    await secureCloud(owner.db);

    // Mark `secret` an owner-audience column at RUNTIME — the interface's "mark
    // column secret" path, which writes the policy row and builds `journal_v`
    // and deliberately leaves the workspace configuration untouched.
    const cols = Object.keys(owner.db.getRegisteredColumns('journal')!);
    const pk = owner.db.getPrimaryKey('journal');
    await setColumnAudience(owner.db, 'journal', 'secret', 'owner', cols, pk);

    const sharedId = await owner.db.insertForcingVisibility(
      'journal',
      { body: 'shared note', secret: 'top-secret' },
      'everyone',
    );

    const role = `lm_rnmu_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner.db, role, pw);
    await reconcileCloudMemberAccess(owner.db);

    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);

    // Baseline — the mask is real.
    expect(await memberHasTablePriv(owner.db, 'journal', 'SELECT')).toBe(false);
    await expect(member.query(`SELECT secret FROM "journal"`)).rejects.toThrow(
      /permission denied/i,
    );

    // Forward: the hardened rename primitive carries the mask across.
    expect(await renameUserEntity(owner, 'journal', 'memos', 'sess')).toMatchObject({ ok: true });
    await reconcileCloudMemberAccess(owner.db);
    expect(await memberHasTablePriv(owner.db, 'memos', 'SELECT')).toBe(false);

    // ── UNDO ────────────────────────────────────────────────────────────────
    const renameEntry = await auditEntry(owner, 'schema.rename_entity');
    owner = swap(owner, await applySchemaConfig(owner, renameEntry, 'inverse', false));
    await owner.converged;

    // The table answers to `journal` again — and so must everything that decides
    // who may read it. The policy and the masking view have to be keyed to the
    // name the table has NOW; left under `memos` they say nothing about
    // `journal`, and the table reads as having no secret columns at all.
    expect(owner.db.getRegisteredTableNames()).toContain('journal');

    // The leak, stated directly and first: the member must NEVER hold base
    // SELECT on the table its secret column lives in.
    expect(await memberHasTablePriv(owner.db, 'journal', 'SELECT')).toBe(false);
    await expect(member.query(`SELECT secret FROM "journal"`)).rejects.toThrow(
      /permission denied/i,
    );
    expect(await policyKeys(owner.db)).toEqual(['journal.secret']);
    // The read view moved back with the table: it stands under the name the table
    // answers to NOW, and nothing is stranded under the one it just left.
    const undoneViews = await maskViews(owner.db);
    expect(undoneViews).toContain('journal_v');
    expect(undoneViews).not.toContain('memos_v');

    // ...and the member can still read the table, with the secret cell masked.
    expect((await member.query(`SELECT id, body, secret FROM "journal_v"`)).rows).toEqual([
      { id: sharedId, body: 'shared note', secret: null },
    ]);

    // Reconciliation on the settled state must not undo any of that either.
    const report = await reconcileCloudMemberAccess(owner.db);
    expect(report.skipped.map((s) => s.table)).not.toContain('journal');
    expect(await memberHasTablePriv(owner.db, 'journal', 'SELECT')).toBe(false);

    // ── REDO ────────────────────────────────────────────────────────────────
    // The forward replay is a rename too, and has exactly the same hole.
    owner = swap(owner, await applySchemaConfig(owner, renameEntry, 'forward', false));
    await owner.converged;

    expect(owner.db.getRegisteredTableNames()).toContain('memos');
    expect(await policyKeys(owner.db)).toEqual(['memos.secret']);
    const redoneViews = await maskViews(owner.db);
    expect(redoneViews).toContain('memos_v');
    expect(redoneViews).not.toContain('journal_v');
    expect(await memberHasTablePriv(owner.db, 'memos', 'SELECT')).toBe(false);
    await expect(member.query(`SELECT secret FROM "memos"`)).rejects.toThrow(/permission denied/i);
    expect((await member.query(`SELECT id, body, secret FROM "memos_v"`)).rows).toEqual([
      { id: sharedId, body: 'shared note', secret: null },
    ]);

    await reconcileCloudMemberAccess(owner.db);
    expect(await memberHasTablePriv(owner.db, 'memos', 'SELECT')).toBe(false);
  }, 240_000);
});
