/**
 * Step-2 perf contract: opening a cloud workspace must NOT block the switch on the
 * owner-side convergence (RLS / grants / native-entity adopt / schema publish). That
 * convergence runs in the BACKGROUND — the owner is BYPASSRLS, so the workspace is
 * fully usable the instant openConfig returns, and the convergence is exposed as
 * `active.converged` (a never-rejecting promise the GUI ignores + tests await).
 *
 * This pins: (A) the owner can read its table IMMEDIATELY after openConfig returns,
 * without awaiting convergence; and (B) `await active.converged` actually performs the
 * real reconcile (it re-grants a drifted member-group privilege) — proving the work
 * was deferred, not dropped.
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { openConfig, disposeActive } from '../../src/gui/lifecycle.js';
import { installCloudRls, memberGroupFor } from '../../src/cloud/rls.js';
import { registerPostgresPolyfills } from '../../src/db/postgres.js';
import { runAsyncOrSync, getAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const schemas: string[] = [];
const dirs: string[] = [];

function schemaUrl(schema: string): string {
  return `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const s of schemas.splice(0)) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  await admin.end();
});

describe.skipIf(!PG_URL)('cloud open backgrounds the owner convergence', () => {
  it('returns a usable workspace immediately; await active.converged re-converges drift', async () => {
    const schema = `bgc_${randomBytes(4).toString('hex')}`;
    schemas.push(schema);
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();

    // Pre-secure the cloud (so openConfig's background converge runs the owner cloud
    // block: cloudRlsInstalled && canManageRoles), with one user table.
    const setup = new Lattice(schemaUrl(schema));
    setup.define('note', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'note.md',
    });
    await setup.init();
    await registerPostgresPolyfills((sql) => runAsyncOrSync(setup.adapter, sql));
    await installCloudRls(setup);
    const group = await memberGroupFor(setup);
    // Secure the table + grant the member group, then DRIFT: revoke the SELECT grant.
    // reconcileCloudMemberAccess (in the background converge) must re-grant it.
    const { enableRlsForTable } = await import('../../src/cloud/rls.js');
    // Securing the table also builds `note_v` and grants the member group SELECT on
    // it. That view IS the member's read path — a member holds no table-level SELECT
    // on any base table — so the grant worth drifting is the one ON THE VIEW.
    await enableRlsForTable(setup, 'note', ['id']);
    await runAsyncOrSync(setup.adapter, `REVOKE SELECT ON "note_v" FROM ${group}`); // drift
    setup.close();

    const hasSelect = async (db: Lattice, rel: string): Promise<boolean> => {
      const row = (await getAsyncOrSync(
        db.adapter,
        `SELECT has_table_privilege($1, $2, 'SELECT') AS ok`,
        [group, rel],
      )) as { ok?: boolean } | undefined;
      return row?.ok === true;
    };
    // The drift is real before the open, or (B) below proves nothing.
    {
      const probe = new Lattice(schemaUrl(schema));
      await probe.init();
      expect(await hasSelect(probe, 'note_v')).toBe(false);
      probe.close();
    }

    // A workspace config pointing at the cloud schema.
    const root = mkdtempSync(join(tmpdir(), `bgc-${randomBytes(3).toString('hex')}-`));
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

    // (A) Usable immediately — the owner reads its table without awaiting convergence.
    expect(active.converged).toBeInstanceOf(Promise);
    const rows = await active.db.query('note', {});
    expect(Array.isArray(rows)).toBe(true);

    // (B) Awaiting convergence performs the real reconcile: the drifted member read
    // grant is restored. (Proves the convergence was deferred to the background, not
    // lost.)
    await active.converged;
    expect(await hasSelect(active.db, 'note_v')).toBe(true);
    // ...and restoring the read path never means handing back base SELECT. The
    // reconcile revokes it unconditionally, so a converge can only ever re-open the
    // view — the one relation that re-applies row visibility and cell masking.
    expect(await hasSelect(active.db, 'note')).toBe(false);
    expect(active.convergeWarnings).toEqual([]);

    await disposeActive(active);
  });
});
