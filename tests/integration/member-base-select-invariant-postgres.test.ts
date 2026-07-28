/**
 * THE invariant, asserted after every step of an arbitrary schema-editing sequence:
 *
 *   A cloud member holds table-level SELECT on ZERO base tables, and can never read
 *   the VALUE of a column the owner marked secret.
 *
 * Four separate P0 leaks in this area shipped, were fixed, and re-opened, because
 * every one of them was a different PATH to the same statement — `GRANT SELECT ON
 * <base> TO <member group>` — or, once that was removed, to a mask view rebuilt
 * without its mask. Each fix closed one path. This test does not care about paths:
 * it drives real entry points in sequence and re-checks the invariant after each,
 * so a fifth path fails here the first time anyone writes it.
 *
 * Two things it asserts that privilege bits alone cannot, and both matter because
 * privilege bits are exactly what missed these:
 *
 *  - the VALUE. A view can be rebuilt perfectly successfully, granted correctly,
 *    with every privilege bit unchanged, and simply not carry the CASE guard any
 *    more. That is what a lost column policy did, and what a column rename did. The
 *    only assertion that catches it is reading the cell as the member and finding
 *    NULL.
 *  - USABILITY. An invariant of the form "the member can read nothing" is trivially
 *    satisfiable by revoking everything, and a security fix that quietly bricks
 *    member writes is not a fix — one did exactly that, and it went unnoticed
 *    because the tests asserted privileges and never performed a member write.
 *
 * Postgres-gated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud, reconcileCloudMemberAccess } from '../../src/cloud/setup.js';
import { setColumnAudience } from '../../src/cloud/audience.js';
import { memberGroupFor } from '../../src/cloud/rls.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { allAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';
import { openConfig, disposeActive, type ActiveDb } from '../../src/gui/lifecycle.js';
import { renameUserEntity, renameUserColumn } from '../../src/gui/schema-ops.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const SECRET = 'INVARIANT-EYES-ONLY';
const actives: ActiveDb[] = [];
const dirs: string[] = [];
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
  for (const a of actives.splice(0)) await disposeActive(a).catch(() => undefined);
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

/** No member group holds table-level SELECT on ANY base table. */
async function assertNoMemberBaseSelect(db: Lattice, where: string): Promise<void> {
  const group = await memberGroupFor(db);
  const rows = (await allAsyncOrSync(
    db.adapter,
    // pg_class directly, NOT information_schema.role_table_grants — the latter is
    // filtered to roles the CURRENT user belongs to and silently under-reports.
    // relkind='r' only: views are the intended read path. `_`-prefixed bookkeeping
    // is legitimately granted (see MEMBER_READABLE_BOOKKEEPING).
    `SELECT c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relkind = 'r'
        AND c.relname NOT LIKE '\\_%'
        AND has_table_privilege(CAST(? AS text), c.oid, 'SELECT')
      ORDER BY 1`,
    [group],
  )) as { name: string }[];
  // Reported as an object so a failure names the step, not just the table list.
  expect({ where, leaking: rows.map((r) => r.name) }).toEqual({ where, leaking: [] });
}

describe.skipIf(!PG_URL)('a member never holds base SELECT, through any sequence', () => {
  it('holds after renames, a column rename, a drop, and injected 5.4-style drift', async () => {
    const dbname = `lattice_inv_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE DATABASE "${dbname}"`);
    await admin.end();

    // ── The cloud itself, built by an owner connection, then opened as a workspace
    //    the way a person opens one (the GUI discovers the schema by introspection).
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
    // Masked at RUNTIME, the case a config-derived check cannot see.
    await setColumnAudience(
      owner,
      'journal',
      'secret',
      'owner',
      ['id', 'body', 'secret', 'deleted_at'],
      ['id'],
    );

    const role = `lm_inv_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner, role, pw);
    await assertNoMemberBaseSelect(owner, 'after securing + masking');

    const cfgRoot = mkdtempSync(join(tmpdir(), `inv-owner-${randomBytes(3).toString('hex')}-`));
    dirs.push(cfgRoot);
    mkdirSync(join(cfgRoot, 'context'), { recursive: true });
    const cfgPath = join(cfgRoot, 'lattice.config.yml');
    writeFileSync(
      cfgPath,
      [
        `db: "${dbUrl(dbname)}"`,
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
    const active = await openConfig(cfgPath, join(cfgRoot, 'context'), false);
    actives.push(active);
    await active.converged;

    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);

    /** As the member: the secret cell reads NULL through the view, and the base is closed. */
    const assertSecretUnreadable = async (table: string, col: string, where: string) => {
      await expect(member.query(`SELECT "${col}" FROM "${table}"`)).rejects.toThrow(
        /permission denied/i,
      );
      const via = await member.query<Record<string, unknown>>(
        `SELECT "${col}" AS c FROM "${table}_v"`,
      );
      for (const r of via.rows) expect({ where, cell: r.c }).toEqual({ where, cell: null });
    };
    await assertSecretUnreadable('journal', 'secret', 'baseline');

    // ── Drift injection: the state every 5.4-or-earlier tenant can already be in.
    //    All raw SQL, deliberately bypassing every primitive.
    await runAsyncOrSync(
      owner.adapter,
      `UPDATE "__lattice_column_policy" SET "table_name" = 'gone' WHERE "table_name" = 'journal'`,
    );
    const group = await memberGroupFor(owner);
    await runAsyncOrSync(owner.adapter, `GRANT SELECT ON "journal" TO ${group}`);

    // The injected grant is real — proving the next assertion is not vacuous.
    const leaked = (await allAsyncOrSync(
      owner.adapter,
      `SELECT has_table_privilege(CAST(? AS text), 'journal', 'SELECT') AS ok`,
      [group],
    )) as { ok?: unknown }[];
    expect(leaked[0]?.ok).toBe(true);

    // ── The heal. Refusing to widen would leave the injected exposure standing;
    //    the pass has to actively take it away.
    await reconcileCloudMemberAccess(owner);
    await assertNoMemberBaseSelect(owner, 'after reconcile healed injected drift');
    await assertSecretUnreadable('journal', 'secret', 'after heal');

    // ── A sequence of real schema edits, invariant re-checked after every one.
    // The same primitives the HTTP routes call — one per identity change, which is
    // where every one of these leaks lived.
    const steps: [string, () => Promise<unknown>][] = [
      ['rename the masked table', () => renameUserEntity(active, 'journal', 'memos', 'sess')],
      [
        'rename the masked column',
        () => renameUserColumn(active, 'memos', 'secret', 'hush', () => undefined),
      ],
      ['rename the table a second time', () => renameUserEntity(active, 'memos', 'diary', 'sess')],
    ];

    for (const [label, run] of steps) {
      // Assert the step actually HAPPENED. A silently-refused rename would leave the
      // invariant trivially true and the test quietly meaningless — the same shape of
      // false green this area keeps producing.
      await expect(run(), `step "${label}" did not succeed`).resolves.toBeTruthy();
      await assertNoMemberBaseSelect(owner, label);
    }

    // The mask followed the table AND the column through every move. Asserted on the
    // value, because a rebuilt-but-unguarded view passes every privilege check.
    await assertSecretUnreadable('diary', 'hush', 'after rename sequence');

    // ── Usability, in the same loop: without this the invariant is satisfiable by
    //    revoking everything, and a fix that bricks member writes would look green.
    const readable = await member.query(`SELECT id, body FROM "diary_v"`);
    expect(readable.rows.length).toBeGreaterThan(0);
    await expect(
      member.query(`UPDATE "diary" SET "body" = 'edited by member' WHERE "id" = 'j1'`),
    ).resolves.toBeTruthy();

    // ── And a final reconcile is a no-op: the heal converged rather than oscillating.
    const report = await reconcileCloudMemberAccess(owner);
    await assertNoMemberBaseSelect(owner, 'after idempotent re-reconcile');
    expect(report.skipped.filter((s) => /refus/i.test(s.reason))).toEqual([]);

    owner.close();
  }, 300_000);
});
