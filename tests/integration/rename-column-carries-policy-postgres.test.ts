/**
 * Renaming a COLUMN must not strip that column's cloud masking.
 *
 * What is load-bearing here: cloud column masking is recorded in
 * `__lattice_column_policy` keyed by (table_name, column_name) — BOTH names. The
 * `<t>_v` view a member reads the table through is generated FROM that policy.
 * So a rename that moves the physical column and nothing else strands the policy
 * under a column name the table no longer answers to; the next rebuild of the
 * view reads it back empty for the new name, decides the column is not masked,
 * and emits it in cleartext. A member then reads an owner-secret column in full.
 *
 * The table-level version of this was hardened; the column-level version was
 * not, and the structural guard that pins rename paths explicitly excluded
 * `RENAME COLUMN` — which is exactly why it shipped. This file is the missing
 * half: the same guard on the column statement, plus the end-to-end proof
 * through the real HTTP route.
 *
 * The safety net that rescues a lost TABLE policy cannot rescue this one. That
 * net re-reads the standing view's own definition and preserves any mask it
 * finds — but it keys on the OLD column name, which is no longer among the
 * table's physical columns, so the recovered mask is discarded as stale.
 * Carrying the policy is the only fix.
 *
 * The assertions here are on the VALUE a member reads and on the view's own
 * stored definition, never merely on privilege bits. Privilege bits are what
 * missed this class: after the leak the member's grants look entirely normal —
 * base SELECT still revoked, view SELECT still granted — because the view was
 * rebuilt successfully. It was just rebuilt without the mask.
 *
 * Postgres-only by construction: masking views, roles and grants do not exist on
 * SQLite, which is why a SQLite suite cannot catch this.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { openConfig, disposeActive, startGuiServer } from '../../src/gui/server.js';
import type { GuiServerHandle } from '../../src/gui/server.js';
import { dropColumnCarryingPolicy } from '../../src/gui/schema-ops.js';
import { secureCloud, reconcileCloudMemberAccess } from '../../src/cloud/setup.js';
import { setColumnAudience } from '../../src/cloud/audience.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { allAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const dirs: string[] = [];
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

/** A workspace config declaring `journal` — the rename route edits `fields`, so
 *  the entity has to be DECLARED, not merely introspected. */
function writeOwnerConfig(url: string): string {
  const root = mkdtempSync(join(tmpdir(), 'lattice-rncol-'));
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

/**
 * A secured cloud with `journal.secret` masked at RUNTIME (the "mark column
 * secret" path — the case a config-derived check cannot see), one row shared
 * with everyone, and a real scoped member role provisioned against it.
 */
async function maskedCloudWithMember(): Promise<{
  configPath: string;
  dbname: string;
  role: string;
  password: string;
  rowId: string;
}> {
  const dbname = `lattice_rncol_${randomBytes(4).toString('hex')}`;
  databases.push(dbname);
  {
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE DATABASE "${dbname}"`);
    await admin.end();
  }
  const configPath = writeOwnerConfig(dbUrl(dbname));
  const owner = await openConfig(configPath, join(configPath, '..', 'context'), false);
  await owner.converged;
  await secureCloud(owner.db);

  const cols = Object.keys(owner.db.getRegisteredColumns('journal')!);
  const pk = owner.db.getPrimaryKey('journal');
  await setColumnAudience(owner.db, 'journal', 'secret', 'owner', cols, pk);

  const rowId = await owner.db.insertForcingVisibility(
    'journal',
    { body: 'shared note', secret: 'top-secret' },
    'everyone',
  );

  const role = `lm_rnc_${randomBytes(3).toString('hex')}`;
  roles.push(role);
  const password = generateMemberPassword();
  await provisionMemberRole(owner.db, role, password);
  await reconcileCloudMemberAccess(owner.db);
  await disposeActive(owner);
  return { configPath, dbname, role, password, rowId };
}

describe.skipIf(!PG_URL)('a masked column keeps its masking when it is renamed', () => {
  it('carries the column policy through the real rename route', async () => {
    const { configPath, dbname, role, password, rowId } = await maskedCloudWithMember();

    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, password), max: 1 });
    pools.push(member);
    const probe = new pg.Pool({ connectionString: dbUrl(dbname), max: 1 });
    pools.push(probe);

    // ── baseline: the mask is real BEFORE the rename ─────────────────────────
    expect((await member.query(`SELECT secret FROM "journal_v"`)).rows).toEqual([{ secret: null }]);
    await expect(member.query(`SELECT secret FROM "journal"`)).rejects.toThrow(
      /permission denied/i,
    );

    // ── the rename, through the route a person actually clicks ───────────────
    const handle = await startGuiServer({
      configPath,
      outputDir: join(configPath, '..', 'context'),
      port: 0,
      host: '127.0.0.1',
      openBrowser: false,
    });
    servers.push(handle);
    await handle.whenConverged();

    const res = await fetch(`${handle.url}/api/schema/entities/journal/columns/secret/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'hush' }),
    });
    expect(res.status, await res.text()).toBe(200);
    // The route reopens the workspace, which reconciles member access — settle it
    // so the assertions below cover the final state rather than a moment inside it.
    await handle.whenConverged();

    // ── the column is still masked, under its new name ───────────────────────
    //
    // On the VALUE, because that is what leaked. Before the carry this returned
    // the cleartext secret while every privilege bit still looked correct.
    const seen = await member.query<{ id: string; body: string; hush: string | null }>(
      `SELECT id, body, hush FROM "journal_v"`,
    );
    expect(seen.rows).toEqual([{ id: rowId, body: 'shared note', hush: null }]);

    // ...and on the view's own stored definition, which is where the mask either
    // is or is not. A rebuilt-but-unmasked view has no owner predicate in it.
    const def = await probe.query<{ def: string }>(
      `SELECT pg_get_viewdef('journal_v'::regclass, true) AS def`,
    );
    expect(def.rows[0]!.def).toMatch(/lattice_is_owner/);

    // The base table stays unreachable, so there is no second path to the column.
    await expect(member.query(`SELECT hush FROM "journal"`)).rejects.toThrow(/permission denied/i);

    // The canonical policy is keyed to the new column name — nothing stranded
    // under the old one for a later column of that name to inherit.
    const after = await openConfig(configPath, join(configPath, '..', 'context'), false);
    const policy = await allAsyncOrSync(
      after.db.adapter,
      `SELECT "table_name", "column_name", "audience" FROM "__lattice_column_policy"`,
    );
    await disposeActive(after);
    expect(policy).toEqual([{ table_name: 'journal', column_name: 'hush', audience: 'owner' }]);
  }, 180_000);

  it('drops a column with its policy, and can drop one at all on a cloud', async () => {
    // Two properties in one, because on a cloud they are the same statement.
    //
    // EVERY table is read through a `<t>_v` view now, and Postgres refuses to
    // drop a column another relation depends on — so a bare DROP COLUMN fails
    // outright on every table on every cloud. And the column's masking policy is
    // keyed by its name: left behind, it describes a column that does not exist,
    // and the next column given that name inherits a mask nobody wrote for it.
    const { configPath, dbname, role, password } = await maskedCloudWithMember();
    const probe = new pg.Pool({ connectionString: dbUrl(dbname), max: 1 });
    pools.push(probe);
    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, password), max: 1 });
    pools.push(member);

    const active = await openConfig(configPath, join(configPath, '..', 'context'), false);
    await active.converged;
    await dropColumnCarryingPolicy(active.db, 'journal', 'secret');
    const policy = await allAsyncOrSync(
      active.db.adapter,
      `SELECT "table_name", "column_name" FROM "__lattice_column_policy"`,
    );
    await disposeActive(active);

    // The policy row went with the column.
    expect(policy).toEqual([]);

    // The column is physically gone...
    const cols = await probe.query<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'journal'`,
    );
    expect(cols.rows.map((r) => r.name)).not.toContain('secret');

    // ...and the member read view came back, without it. A dropped column must
    // not take the whole table's read path down with it.
    const def = await probe.query<{ def: string }>(
      `SELECT pg_get_viewdef('journal_v'::regclass, true) AS def`,
    );
    expect(def.rows[0]!.def).not.toMatch(/\bsecret\b/);
    expect((await member.query(`SELECT body FROM "journal_v"`)).rows).toEqual([
      { body: 'shared note' },
    ]);
  }, 180_000);
});

/**
 * The structural half of the same fix, and the only part that keeps holding once
 * this file is no longer being read.
 *
 * Renaming a column is not one statement either. The cloud's per-column masking
 * policy is keyed by (table, column) — BOTH names — and the `<t>_v` view every
 * member reads the table through is generated from it. A rename that emits a
 * bare column-level `ALTER TABLE ... RENAME` and nothing else strands that
 * policy under a column name the table no longer has, the table then reads as
 * having nothing secret on it, and the next rebuild of the view hands every
 * member the column in cleartext.
 *
 * The guard is on the STATEMENT rather than on any one call site, for the same
 * reason its table-level sibling is: renaming LOOKS like one statement, so the
 * paths get written independently. The table-level guard deliberately excluded
 * `RENAME COLUMN`, and that exclusion is precisely how this shipped — so the
 * column statement gets its own allowlist here.
 *
 * A new file failing this test is not a formatting nit — it is another rename
 * path, and on a hosted workspace it is a data-exposure bug. Route it through
 * `renameColumnsCarryingPolicy` instead.
 */
describe('a column rename is emitted only where the policy travels with it', () => {
  const SRC = join(import.meta.dirname, '..', '..', 'src');

  /** Source files that emit a column-level `ALTER TABLE ... RENAME COLUMN`. */
  function filesEmittingColumnRename(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        filesEmittingColumnRename(full, out);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const text = readFileSync(full, 'utf8');
      const emits = text.split('\n').some((line) => /ALTER\s+TABLE.*RENAME\s+COLUMN/i.test(line));
      if (emits) out.push(full.slice(SRC.length + 1).replace(/\\/g, '/'));
    }
    return out;
  }

  it('has no column-rename path outside the shared primitive', () => {
    expect(filesEmittingColumnRename(SRC).sort()).toEqual(
      [
        // The shared primitives themselves: the column carry, and the table carry
        // that also moves a link table's `<table>_id` key column.
        'gui/schema-ops.ts',
        // Replaying a rename backwards/forwards from the version history. Its DDL
        // is handed to the shared carry rather than executed directly.
        'gui/lifecycle.ts',
        // The SQLite-only column rebuild behind a retype (add temp, copy, drop,
        // rename into place). The Postgres branch returns before it, so this SQL
        // never runs on a cloud and there is no policy to carry — the column keeps
        // its name throughout.
        'gui/planner/appliers.ts',
      ].sort(),
    );
  });
});
