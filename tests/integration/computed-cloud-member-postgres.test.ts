/**
 * Computed tables on a secured team cloud, exercised AS A MEMBER: the owner
 * creates a computed table through the audited ops layer, and a scoped member
 * (a real non-BYPASSRLS Postgres login role) then
 *
 *   1. SELECTs the view and sees ONLY its visible rows — the view compiles
 *      with `lattice_row_visible` predicates, so the view-owner's rights can't
 *      leak invisible base rows through it;
 *   2. cannot read the `__lattice_ai_map` bookkeeping table directly;
 *   3. hydrates the published computed definitions (a member GUI lists them,
 *      and its introspect-only open registers the granted view); and
 *   4. is refused by every mutating computed-table route (owner-gated — these
 *      paths write the owner's config and run DDL, which RLS does not cover).
 *
 * Postgres-gated (per-test database + a provisioned member role).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { openConfig, disposeActive, startGuiServer } from '../../src/gui/server.js';
import type { ActiveDb, GuiServerHandle } from '../../src/gui/server.js';
import { createComputedTable } from '../../src/gui/computed-ops.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import type { ComputedTableDef } from '../../src/config/types.js';

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
  for (const s of servers.splice(0)) await s.close();
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

/** A config file whose db: is `url`, with `entities` for the owner, bare for a member. */
function writeConfig(prefix: string, url: string, withEntities: boolean): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(root);
  mkdirSync(join(root, 'context'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  const lines = [`db: "${url}"`, ''];
  if (!withEntities) {
    // A joined member's generated config: no layout yet — hydration fills it.
    lines.push('entities: {}', '');
  } else {
    lines.push(
      'entities:',
      '  notes:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      body: { type: text }',
      '      priority: { type: integer }',
      '      deleted_at: { type: text }',
      '    outputFile: notes.md',
      '',
    );
  }
  writeFileSync(configPath, lines.join('\n'), 'utf8');
  return configPath;
}

const boardDef: ComputedTableDef = {
  base: 'notes',
  fields: {
    body: { kind: 'alias', source: 'body' },
    urgent: { kind: 'calc', expr: 'priority >= 3', type: 'boolean' },
    gist: { kind: 'ai_transform', inputs: ['body'], prompt: 'Summarize.' },
  },
};

describe.skipIf(!PG_URL)('computed tables — cloud member access', () => {
  it('member reads only visible rows through the view, never the AI bookkeeping, and cannot mutate', async () => {
    const dbname = `lattice_cct_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    {
      const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
      await admin.query(`CREATE DATABASE "${dbname}"`);
      await admin.end();
    }

    // Owner: open the workspace, secure the cloud, then create the computed
    // table through the audited ops layer (grants member SELECT + publishes
    // the shared schema, computed definitions included).
    const ownerCfg = writeConfig('lattice-cct-owner-', dbUrl(dbname), true);
    const owner = await openConfig(ownerCfg, join(ownerCfg, '..', 'context'), false);
    actives.push(owner);
    await owner.converged;
    await secureCloud(owner.db);
    await createComputedTable(owner, 'note_board', boardDef, 'sess');

    // One member-visible row, one owner-private row.
    const sharedId = await owner.db.insertForcingVisibility(
      'notes',
      { body: 'shared note', priority: 5 },
      'everyone',
    );
    await owner.db.insertForcingVisibility(
      'notes',
      { body: 'private note', priority: 1 },
      'private',
    );

    // Provision a scoped member and attack over a raw connection.
    const role = `lm_cct_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner.db, role, pw);
    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);

    // (1) The view row-filters per viewer even though it runs with the
    // owner's rights — only the shared row comes back.
    const seen = await member.query(`SELECT id, body FROM "note_board" ORDER BY body`);
    expect(seen.rows).toHaveLength(1);
    expect(seen.rows[0]).toMatchObject({ id: sharedId, body: 'shared note' });

    // (2) The AI bookkeeping is not directly readable by members.
    await expect(member.query(`SELECT * FROM "__lattice_ai_map"`)).rejects.toThrow(
      /permission denied/,
    );

    // (3) A member GUI hydrates the published computed definitions and lists
    // them; its introspect-only open registers the granted view as computed.
    const memberCfg = writeConfig('lattice-cct-member-', dbUrl(dbname, role, pw), false);
    const gui = await startGuiServer({
      configPath: memberCfg,
      outputDir: join(memberCfg, '..', 'context'),
      port: 0,
      openBrowser: false,
    });
    servers.push(gui);

    const list = (await (await fetch(`${gui.url}/api/computed-tables`)).json()) as {
      tables: { name: string; def: ComputedTableDef }[];
    };
    expect(list.tables.map((t) => t.name)).toEqual(['note_board']);
    expect(list.tables[0]!.def).toEqual(boardDef);

    const entities = (await (await fetch(`${gui.url}/api/entities`)).json()) as {
      tables: { name: string; computedTable?: boolean }[];
    };
    expect(entities.tables.find((t) => t.name === 'note_board')?.computedTable).toBe(true);

    // (4) Every mutating computed-table route is owner-gated for the member.
    const post = await fetch(`${gui.url}/api/computed-tables`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'member_board',
        def: { base: 'notes', fields: { b: { kind: 'alias', source: 'body' } } },
      }),
    });
    expect(post.status).toBe(403);
    const put = await fetch(`${gui.url}/api/computed-tables/note_board`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: boardDef }),
    });
    expect(put.status).toBe(403);
    const del = await fetch(`${gui.url}/api/computed-tables/note_board`, { method: 'DELETE' });
    expect(del.status).toBe(403);

    // The owner's definition survived every refused mutation.
    const still = (await (await fetch(`${gui.url}/api/computed-tables`)).json()) as {
      tables: unknown[];
    };
    expect(still.tables).toHaveLength(1);
  }, 120_000);
});
