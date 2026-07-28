/**
 * Renaming a table must NOT strip its cloud column masking.
 *
 * On a secured cloud, a column the owner marked secret is masked by a generated
 * `<t>_v` view: members read the view (the secret cell reads NULL) and base
 * SELECT is revoked from the member group so the mask can't be bypassed. The
 * masking spec itself is canonical in `__lattice_column_policy`, keyed BY TABLE
 * NAME — so a rename that doesn't carry the policy across leaves the spec keyed
 * to a name nothing answers to.
 *
 * That fails OPEN, in two compounding ways:
 *
 *  1. The rename regenerates the mask view under the NEW name. Regeneration
 *     reads the policy; an empty policy means "this table has no secret columns",
 *     so it DROPS the view and hands the member group raw SELECT on the base.
 *  2. The reopen that follows reconciles member access, which decides masked-ness
 *     the same way — finds nothing, takes the unmasked grant path, and re-grants
 *     base SELECT again.
 *
 * Either one silently gives every member cleartext read on a column the owner
 * marked secret, while the interface still shows the column as masked (its own
 * secret flag is repointed).
 *
 * The mask here is applied at RUNTIME (the "mark column secret" path), not
 * declared in the workspace configuration — that is the case a config-derived
 * check cannot see, and the one members are most exposed by.
 *
 * The last case here is the same shape from the other end: purging a table has
 * to take its name-keyed policy WITH it, or the next table to be given that name
 * inherits a dead table's sharing and masking.
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
import { readdirSync, readFileSync } from 'node:fs';
import { openConfig, disposeActive, startGuiServer } from '../../src/gui/server.js';
import type { ActiveDb, GuiServerHandle } from '../../src/gui/server.js';
import { renameUserEntity } from '../../src/gui/schema-ops.js';
import { applyRenameTable } from '../../src/gui/planner/appliers.js';
import { secureCloud, reconcileCloudMemberAccess } from '../../src/cloud/setup.js';
import { setColumnAudience } from '../../src/cloud/audience.js';
import { memberGroupFor } from '../../src/cloud/rls.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import type { Lattice } from '../../src/lattice.js';
import { allAsyncOrSync, getAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const dirs: string[] = [];
const actives: ActiveDb[] = [];
const servers: GuiServerHandle[] = [];
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
  for (const h of servers.splice(0)) await h.close();
  for (const a of actives.splice(0)) await disposeActive(a);
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-rnm-owner-'));
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

describe.skipIf(!PG_URL)('a masked table keeps its masking when it moves', () => {
  it('keeps the column masking that was applied to it under its old name', async () => {
    const dbname = `lattice_rnm_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    {
      const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
      await admin.query(`CREATE DATABASE "${dbname}"`);
      await admin.end();
    }

    const ownerCfg = writeOwnerConfig(dbUrl(dbname));
    const owner = await openConfig(ownerCfg, join(ownerCfg, '..', 'context'), false);
    actives.push(owner);
    await owner.converged;
    await secureCloud(owner.db);

    // Mark `secret` an owner-audience column at RUNTIME — the interface's "mark
    // column secret" path. This writes the policy row and builds `journal_v`, and
    // deliberately leaves the workspace configuration untouched.
    const cols = Object.keys(owner.db.getRegisteredColumns('journal')!);
    const pk = owner.db.getPrimaryKey('journal');
    await setColumnAudience(owner.db, 'journal', 'secret', 'owner', cols, pk);

    const sharedId = await owner.db.insertForcingVisibility(
      'journal',
      { body: 'shared note', secret: 'top-secret' },
      'everyone',
    );

    const role = `lm_rnm_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner.db, role, pw);
    await reconcileCloudMemberAccess(owner.db);

    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);

    // Baseline — the mask is real BEFORE the rename.
    expect(await memberHasTablePriv(owner.db, 'journal', 'SELECT')).toBe(false);
    await expect(member.query(`SELECT secret FROM "journal"`)).rejects.toThrow(
      /permission denied/i,
    );
    expect((await member.query(`SELECT secret FROM "journal_v"`)).rows).toEqual([{ secret: null }]);

    // ── the rename ────────────────────────────────────────────────────────────
    const renamed = await renameUserEntity(owner, 'journal', 'memos', 'sess');
    expect(renamed).toMatchObject({ ok: true });

    // The reopen the rename triggers reconciles member access; run the same
    // convergence here so the assertions cover the settled state, not a moment
    // in the middle of it.
    await reconcileCloudMemberAccess(owner.db);

    // The mask must have travelled with the table. Base SELECT stays revoked, so
    // the secret column is unreachable except through the regenerated view.
    expect(await memberHasTablePriv(owner.db, 'memos', 'SELECT')).toBe(false);
    await expect(member.query(`SELECT secret FROM "memos"`)).rejects.toThrow(/permission denied/i);

    // ...and the member can still READ the table under its new name, with the
    // secret cell masked to NULL and row visibility intact.
    expect(await memberHasTablePriv(owner.db, 'memos_v', 'SELECT')).toBe(true);
    const seen = await member.query<{ id: string; body: string; secret: string | null }>(
      `SELECT id, body, secret FROM "memos_v"`,
    );
    expect(seen.rows).toEqual([{ id: sharedId, body: 'shared note', secret: null }]);

    // The canonical policy is keyed to the new name — nothing is left behind
    // under the old one for a later same-named table to inherit.
    const policy = await allAsyncOrSync(
      owner.db.adapter,
      `SELECT "table_name", "column_name" FROM "__lattice_column_policy" ORDER BY "table_name"`,
    );
    expect(policy).toEqual([{ table_name: 'memos', column_name: 'secret' }]);
  }, 180_000);

  it('keeps the masking when the RESTRUCTURE planner is what renames it', async () => {
    // The data-model planner proposes a "canonical rename" for any table whose
    // name has whitespace or punctuation in it, and applying that proposal is a
    // second way for an owner to rename a table. It is the same rename, so it
    // has to carry the same masking — a rename that moves the table without its
    // column policy leaves the policy and the view stranded under the old name,
    // and the table then reads as having no secret columns at all.
    const dbname = `lattice_rnmp_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    {
      const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
      await admin.query(`CREATE DATABASE "${dbname}"`);
      await admin.end();
    }

    const ownerCfg = writeOwnerConfig(dbUrl(dbname));
    const owner = await openConfig(ownerCfg, join(ownerCfg, '..', 'context'), false);
    actives.push(owner);
    await owner.converged;
    await secureCloud(owner.db);

    const cols = Object.keys(owner.db.getRegisteredColumns('journal')!);
    const pk = owner.db.getPrimaryKey('journal');
    await setColumnAudience(owner.db, 'journal', 'secret', 'owner', cols, pk);

    const sharedId = await owner.db.insertForcingVisibility(
      'journal',
      { body: 'shared note', secret: 'top-secret' },
      'everyone',
    );

    const role = `lm_rnm_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner.db, role, pw);
    await reconcileCloudMemberAccess(owner.db);

    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);
    expect(await memberHasTablePriv(owner.db, 'journal', 'SELECT')).toBe(false);

    expect(await applyRenameTable(owner, 'journal', 'memos', 'sess')).toEqual({ ok: true });
    await reconcileCloudMemberAccess(owner.db);

    // Base SELECT stays revoked, the mask view moved with the table, and the
    // canonical policy is keyed to the name the table has now.
    expect(await memberHasTablePriv(owner.db, 'memos', 'SELECT')).toBe(false);
    await expect(member.query(`SELECT secret FROM "memos"`)).rejects.toThrow(/permission denied/i);
    expect((await member.query(`SELECT id, body, secret FROM "memos_v"`)).rows).toEqual([
      { id: sharedId, body: 'shared note', secret: null },
    ]);
    const policy = await allAsyncOrSync(
      owner.db.adapter,
      `SELECT "table_name", "column_name" FROM "__lattice_column_policy" ORDER BY "table_name"`,
    );
    expect(policy).toEqual([{ table_name: 'memos', column_name: 'secret' }]);
  }, 180_000);

  it('refuses rather than un-masking when the policy cannot follow the table', async () => {
    // Defense in depth for the same failure mode: regeneration reads the policy
    // under the NEW name, and an empty read is indistinguishable from "this table
    // has no secret columns" — which drops the view and grants members base
    // SELECT. If the policy did not travel for any reason, the rename must fail
    // loudly and leave the mask standing rather than quietly opening the column.
    const dbname = `lattice_rnm2_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    {
      const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
      await admin.query(`CREATE DATABASE "${dbname}"`);
      await admin.end();
    }

    const ownerCfg = writeOwnerConfig(dbUrl(dbname));
    const owner = await openConfig(ownerCfg, join(ownerCfg, '..', 'context'), false);
    actives.push(owner);
    await owner.converged;
    await secureCloud(owner.db);

    const cols = Object.keys(owner.db.getRegisteredColumns('journal')!);
    const pk = owner.db.getPrimaryKey('journal');
    await setColumnAudience(owner.db, 'journal', 'secret', 'owner', cols, pk);

    const role = `lm_rnm_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner.db, role, pw);
    await reconcileCloudMemberAccess(owner.db);

    // Simulate the policy failing to travel: a trigger that swallows the repoint
    // of this table's policy row, so the row stays keyed to the old name exactly
    // as it did before the cascade carried it.
    await runAsyncOrSync(
      owner.db.adapter,
      `CREATE FUNCTION lattice_test_pin_policy() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RETURN NULL; END $$;
       CREATE TRIGGER lattice_test_pin_policy
         BEFORE UPDATE ON "__lattice_column_policy"
         FOR EACH ROW EXECUTE FUNCTION lattice_test_pin_policy();`,
    );

    const renamed = await renameUserEntity(owner, 'journal', 'memos', 'sess');
    expect(renamed.ok).toBe(false);
    if (!renamed.ok) expect(renamed.error).toMatch(/mask|secret|polic/i);

    // Whatever the rename did or did not manage, members must NEVER have gained
    // cleartext read on the secret column.
    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);
    for (const name of ['journal', 'memos']) {
      const exists = (await getAsyncOrSync(
        owner.db.adapter,
        `SELECT to_regclass(?) IS NOT NULL AS ok`,
        [name],
      )) as { ok?: unknown } | undefined;
      if (exists?.ok !== true && exists?.ok !== 't') continue;
      expect(await memberHasTablePriv(owner.db, name, 'SELECT')).toBe(false);
      await expect(member.query(`SELECT secret FROM "${name}"`)).rejects.toThrow(
        /permission denied/i,
      );
    }
  }, 180_000);

  it('member reconciliation PRESERVES a mask whose column policy has gone missing', async () => {
    // The policy is not a reliable record of what is secret. Re-key it, restore an
    // older copy of the table, or simply lose the rows, and every name-keyed lookup
    // reads back "nothing is masked here" — indistinguishable from a table that
    // genuinely has no secret columns.
    //
    // Revoking base SELECT alone does NOT save you here, and that is the trap this
    // test exists to hold shut. With the old grant gone, the rebuild still derives
    // the view from the policy — so a lost policy regenerates `<t>_v` as a plain
    // pass-through and hands members the column in cleartext through the view
    // instead of the base table. The leak moves; it does not close. Measured
    // exactly that way: the member's read of `secret` went from NULL to the value.
    //
    // So the standing view's own definition is treated as evidence. Postgres stores
    // it, restoring the policy table cannot erase it, and it names precisely which
    // columns were guarded. A rebuild may preserve or tighten masking; only an
    // explicit audience change may relax it. Missing policy is never read as consent
    // to un-mask.
    const dbname = `lattice_rnm3_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    {
      const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
      await admin.query(`CREATE DATABASE "${dbname}"`);
      await admin.end();
    }

    const ownerCfg = writeOwnerConfig(dbUrl(dbname));
    const owner = await openConfig(ownerCfg, join(ownerCfg, '..', 'context'), false);
    actives.push(owner);
    await owner.converged;
    await secureCloud(owner.db);

    const cols = Object.keys(owner.db.getRegisteredColumns('journal')!);
    const pk = owner.db.getPrimaryKey('journal');
    await setColumnAudience(owner.db, 'journal', 'secret', 'owner', cols, pk);

    const role = `lm_rnm_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner.db, role, pw);

    // The policy is now keyed to a name no table answers to — exactly the state a
    // rename that carried the table but not its policy leaves behind. The masking
    // view still stands.
    await runAsyncOrSync(
      owner.db.adapter,
      `UPDATE "__lattice_column_policy" SET "table_name" = 'gone' WHERE "table_name" = 'journal'`,
    );

    const report = await reconcileCloudMemberAccess(owner.db);

    void report;

    // The rebuilt view still GUARDS the column — this is the assertion that fails
    // if masking is ever re-derived from the policy alone.
    const def = (
      (await allAsyncOrSync(
        owner.db.adapter,
        `SELECT pg_get_viewdef(c.oid, true) AS def
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema() AND c.relkind = 'v' AND c.relname = 'journal_v'`,
      )) as { def?: string }[]
    )[0]?.def;
    expect(def).toBeTruthy();
    expect(def).toMatch(/lattice_is_owner\('journal'/i);

    // ...the base table stays closed...
    expect(await memberHasTablePriv(owner.db, 'journal', 'SELECT')).toBe(false);
    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);
    await expect(member.query(`SELECT secret FROM "journal"`)).rejects.toThrow(
      /permission denied/i,
    );

    // ...and the value the member CAN reach, through the view, is still masked.
    // Asserted on the value rather than on privileges, because privilege bits are
    // exactly what missed this: they were all correct while the view served the
    // secret in cleartext.
    const seen = await member.query<{ secret: string | null }>(`SELECT secret FROM "journal_v"`);
    for (const r of seen.rows) expect(r.secret).toBeNull();

    // The recovered mask is written back, so the next rebuild does not depend on
    // the view surviving.
    const policy = (await allAsyncOrSync(
      owner.db.adapter,
      `SELECT "column_name" FROM "__lattice_column_policy" WHERE "table_name" = 'journal'`,
    )) as { column_name: string }[];
    expect(policy.map((r) => r.column_name)).toContain('secret');
  }, 180_000);

  it('member reconciliation REPAIRS a table whose mask was left under an older name', async () => {
    // A rename that moved the table and left the whole mask behind — policy AND
    // view, both under the name it used to have — records nothing for the new
    // name and leaves no `<new>_v`, so every name-keyed lookup comes back empty
    // and the table reads as simply unmasked. That is the state every un-hardened
    // rename left, and workspaces are already in it.
    //
    // What the rename could not move is the view's binding: Postgres attaches a
    // view to the table it selects FROM by identity, so the stale `<old>_v` is
    // still reading this table under its new name, and resolving it says so.
    //
    // Reconciliation used to REFUSE such a table — withhold new grants and leave
    // the mask exactly as it stood. That never un-leaked anything: it declined to
    // make things worse while the exposure already standing stayed standing. It
    // now REPAIRS instead: re-attach the stranded policy to the name the table has
    // now, drop the stale view, rebuild `<new>_v` from the recovered policy, and
    // re-issue the grants. The repair is still REPORTED in `skipped[]` — an owner
    // has to know a rename damaged their masking, not least because a renamed
    // COLUMN cannot be recovered from the view alone.
    const dbname = `lattice_rnm5_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    {
      const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
      await admin.query(`CREATE DATABASE "${dbname}"`);
      await admin.end();
    }

    const ownerCfg = writeOwnerConfig(dbUrl(dbname));
    const role = `lm_rnm_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    {
      const owner = await openConfig(ownerCfg, join(ownerCfg, '..', 'context'), false);
      await owner.converged;
      await secureCloud(owner.db);
      const cols = Object.keys(owner.db.getRegisteredColumns('journal')!);
      const pk = owner.db.getPrimaryKey('journal');
      await setColumnAudience(owner.db, 'journal', 'secret', 'owner', cols, pk);
      await provisionMemberRole(owner.db, role, pw);
      await reconcileCloudMemberAccess(owner.db);

      // A rename that carried nothing with it — exactly what the un-hardened
      // paths did, and what an already-drifted workspace looks like today.
      await runAsyncOrSync(owner.db.adapter, `ALTER TABLE "journal" RENAME TO "memos"`);
      await disposeActive(owner);
    }
    writeFileSync(
      ownerCfg,
      [
        `db: "${dbUrl(dbname)}"`,
        '',
        'entities:',
        '  memos:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      body: { type: text }',
        '      secret: { type: text }',
        '      deleted_at: { type: text }',
        '    outputFile: memos.md',
        '',
      ].join('\n'),
      'utf8',
    );

    const owner = await openConfig(ownerCfg, join(ownerCfg, '..', 'context'), false);
    actives.push(owner);
    // The open's own convergence reconciles member access, so the repair happens
    // THERE — it is the first pass to see the drift. Its report is surfaced on the
    // workspace as `convergeWarnings`, which is what an owner is shown.
    await owner.converged;

    // Reported, loudly and by name — never silently, because a rename that also
    // renamed a COLUMN leaves masking the view cannot recover.
    const repaired = owner.convergeWarnings.find((w) => w.table === 'memos');
    expect(repaired?.reason).toMatch(/journal_v/);
    expect(repaired?.reason).toMatch(/re-attached|rebuilt/i);

    // The stale view is gone — nothing is left masking this table under a name it
    // no longer answers to.
    const stale = (await getAsyncOrSync(
      owner.db.adapter,
      `SELECT to_regclass('journal_v') AS reg`,
    )) as { reg?: unknown } | undefined;
    expect(stale?.reg ?? null).toBeNull();

    // The policy was re-attached to the name the table has NOW, so every
    // name-keyed lookup finds it again.
    const policy = await allAsyncOrSync(
      owner.db.adapter,
      `SELECT "table_name", "column_name" FROM "__lattice_column_policy" ORDER BY "table_name"`,
    );
    expect(policy).toEqual([{ table_name: 'memos', column_name: 'secret' }]);

    // ...and the view rebuilt under the new name MASKS the recovered column: the
    // secret is behind the owner-audience guard, keyed to the name the table has
    // now, while the ordinary columns pass through.
    //
    // Asserted on the view's definition rather than on a masked row, because a
    // bare `ALTER TABLE … RENAME` strands more than the column policy: the
    // per-table RLS trigger still stamps ownership under the OLD name, so every
    // row in this workspace is visible to nobody (fail-closed, and out of this
    // repair's scope — the hardened rename path carries the trigger, which the
    // first test in this file proves). With no visible row, a "the secret reads
    // NULL" assertion would pass on an empty result whether the mask worked or
    // not. The definition is the honest evidence here.
    const viewDef = (
      (await allAsyncOrSync(
        owner.db.adapter,
        `SELECT pg_get_viewdef('memos_v'::regclass, true) AS def`,
      )) as { def: string }[]
    )[0]!.def;
    expect(viewDef).toMatch(/lattice_is_owner\('memos'/); // the guard, under the CURRENT name
    expect(viewDef).toMatch(/THEN secret/); // ...and it is the secret column it guards
    expect(viewDef).toMatch(/FROM memos\b/); // reading the table, not a stale name

    // The member holds the read path the repair rebuilt — the view is granted and
    // queryable, so the repair restored access rather than merely locking up.
    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);
    expect(await memberHasTablePriv(owner.db, 'memos_v', 'SELECT')).toBe(true);
    await expect(member.query(`SELECT id, body, secret FROM "memos_v"`)).resolves.toBeTruthy();

    // The base table stays closed throughout — the repair restores the READ PATH,
    // never base SELECT. (Asserted on the secret column: a member keeps
    // column-level SELECT on the primary key so its own writes can name a row.)
    expect(await memberHasTablePriv(owner.db, 'memos', 'SELECT')).toBe(false);
    await expect(member.query(`SELECT secret FROM "memos"`)).rejects.toThrow(/permission denied/i);

    // Repairing is idempotent: the settled state has nothing left to report.
    const again = await reconcileCloudMemberAccess(owner.db);
    expect(again.skipped).toEqual([]);
    expect(await memberHasTablePriv(owner.db, 'memos', 'SELECT')).toBe(false);
  }, 180_000);

  it('purging a table takes its cloud sharing and column policy with it', async () => {
    // The same "policy keyed by a name" shape, from the other end. Purging drops
    // the table but the policy rows keyed to its name outlive it — and a later
    // table created with that name inherits them wholesale: its rows are stamped
    // with the dead table's default visibility and its standing table share makes
    // every one of them readable by the whole team, none of which the new table's
    // owner ever asked for.
    const dbname = `lattice_rnm4_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    {
      const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
      await admin.query(`CREATE DATABASE "${dbname}"`);
      await admin.end();
    }

    const ownerCfg = writeOwnerConfig(dbUrl(dbname));
    {
      const owner = await openConfig(ownerCfg, join(ownerCfg, '..', 'context'), false);
      await owner.converged;
      await secureCloud(owner.db);
      const cols = Object.keys(owner.db.getRegisteredColumns('journal')!);
      const pk = owner.db.getPrimaryKey('journal');
      await setColumnAudience(owner.db, 'journal', 'secret', 'owner', cols, pk);
      await runAsyncOrSync(
        owner.db.adapter,
        `SELECT lattice_share_table('journal','everyone',NULL)`,
      );
      await disposeActive(owner);
    }

    const handle = await startGuiServer({
      configPath: ownerCfg,
      outputDir: join(ownerCfg, '..', 'context'),
      port: 0,
      host: '127.0.0.1',
      openBrowser: false,
    });
    servers.push(handle);
    await handle.whenConverged();

    const call = async (path: string, method: string, body?: unknown): Promise<number> => {
      const res = await fetch(`${handle.url}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return res.status;
    };
    expect(await call('/api/schema/entities/journal', 'DELETE')).toBe(200);
    expect(await call('/api/schema/purge', 'POST', { type: 'table', name: 'journal' })).toBe(200);

    // Nothing keyed to the purged name may survive it, or the next table to take
    // that name starts life shared and pre-masked by a table it never was.
    const probe = new pg.Pool({ connectionString: dbUrl(dbname), max: 1 });
    pools.push(probe);
    for (const store of [
      '__lattice_column_policy',
      '__lattice_table_policy',
      '__lattice_table_shares',
      '__lattice_table_share_grants',
      '__lattice_owners',
      '__lattice_row_grants',
    ]) {
      const left = await probe.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${store}" WHERE "table_name" = 'journal'`,
      );
      expect({ store, rows: Number(left.rows[0]!.n) }).toEqual({ store, rows: 0 });
    }
    const view = await probe.query(`SELECT to_regclass('journal_v') AS v`);
    expect(view.rows[0]).toEqual({ v: null });
  }, 180_000);
});

/**
 * The structural half of the same fix, and the only part that keeps holding once
 * this file is no longer being read.
 *
 * Renaming a table is not one statement. Everything that decides who may read it
 * — the per-table sharing, the row grants, the ownership rows, and the per-column
 * masking spec the `<t>_v` view is generated from — is keyed by the table's NAME,
 * so a rename that emits a bare `ALTER TABLE ... RENAME` and nothing else strands
 * all of it under a name the table no longer has. The table then reads as having
 * no secret columns, and the next member reconciliation grants direct read on it.
 *
 * That is not a bug that was fixed once: it was written independently three times,
 * because renaming LOOKS like one statement. So the guard is on the statement, not
 * on any one call site. A table-level rename may be emitted only from the shared
 * primitive that brackets it with the policy carry, or from the internal
 * bookkeeping migrations that rename `__lattice_*` tables (which carry no policy
 * because no member ever reads them).
 *
 * A new file failing this test is not a formatting nit — it is a fourth rename
 * path, and it is a data-exposure bug on a hosted workspace. Route it through
 * `renameTablesCarryingPolicy` instead.
 */
describe('a table rename is emitted only where the policy travels with it', () => {
  const SRC = join(import.meta.dirname, '..', '..', 'src');

  /** Source files that emit a table-level RENAME (never `RENAME COLUMN`). */
  function filesEmittingTableRename(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        filesEmittingTableRename(full, out);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const text = readFileSync(full, 'utf8');
      const emits = text
        .split('\n')
        .some((line) => /ALTER\s+TABLE.*RENAME\s+TO/i.test(line) && !/RENAME\s+COLUMN/i.test(line));
      if (emits) out.push(full.slice(SRC.length + 1).replace(/\\/g, '/'));
    }
    return out;
  }

  it('has no rename path outside the shared primitive', () => {
    expect(filesEmittingTableRename(SRC).sort()).toEqual(
      [
        // The shared primitive itself: brackets the DDL with the snapshot + carry.
        'gui/schema-ops.ts',
        // Replaying a rename backwards/forwards from the version history. Its DDL
        // is handed to the shared primitive rather than executed directly.
        'gui/lifecycle.ts',
        // Internal bookkeeping tables only — never a user table, never masked.
        'lifecycle/pre-init.ts',
        'search/embeddings.ts',
      ].sort(),
    );
  });
});
