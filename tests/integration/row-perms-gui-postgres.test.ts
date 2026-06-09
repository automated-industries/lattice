/**
 * Route-level row-permission enforcement against a REAL Postgres team cloud.
 *
 * Everything before this suite tested the row ACL at the helper layer
 * (SQLite, direct function calls). This is the first end-to-end check of the
 * GUI server's team mode, which only activates on a Postgres-backed
 * workspace: it seeds a cloud (users, members, team identity, shared table,
 * rows at each visibility), boots one GUI server as the OWNER and one as the
 * MEMBER against the same cloud, and asserts over HTTP that
 *
 *   1. `/api/entities` dashboard counts include only ACL-visible rows
 *      (a physical count would leak the existence/volume of private rows);
 *   2. `/api/search` hits are ACL-filtered (the REST search post-filter);
 *   3. `/api/tables/:t/rows` lists exactly the visible set (sanity);
 *   4. the grant/revoke endpoints the detail-view grants checklist posts to
 *      actually flip what the member receives (owner-gated end to end).
 *
 * Isolation: each run works in its own Postgres SCHEMA via the connection
 * string's `options=-c search_path=…`, so parallel test files (and stale
 * state from prior runs) never see this suite's tables or its
 * `__lattice_team_identity` singleton. The schema is created before and
 * dropped after — it is exclusively this suite's throwaway namespace.
 *
 * How to run locally:
 *   LATTICE_TEST_PG_URL=postgres://... npm test
 *
 * Without the env var the suite skips. CI provides a postgres:16 service
 * container so this always runs there.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import {
  CLOUD_INTERNAL_TABLE_DEFS,
  installRowPermsSchema,
} from '../../src/teams/internal-tables.js';
import { recordRowAcl, addRowGrant } from '../../src/teams/row-access.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const runId = randomBytes(4).toString('hex');
const SCHEMA = `rp_gui_${runId}`;
const TEAM = `team-${runId}`;
const ALICE = 'user-alice';
const BOB = 'user-bob';
const ALICE_EMAIL = `alice-${runId}@example.com`;
const BOB_EMAIL = `bob-${runId}@example.com`;

// Every connection from this string lands in the suite's own schema.
const schemaUrl = PG_URL
  ? `${PG_URL}${PG_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(
      `-c search_path=${SCHEMA}`,
    )}`
  : '';

const dirs: string[] = [];
let aliceServer: GuiServerHandle | null = null;
let bobServer: GuiServerHandle | null = null;
let admin: pg.Pool | null = null;
let savedConfigDir: string | undefined;

function writeWorkspace(who: string, email: string): string {
  // Each operator gets their own machine config dir (identity.json drives who
  // the GUI resolves as) and their own workspace root pointing at the SAME
  // cloud schema.
  const cfgDir = mkdtempSync(join(tmpdir(), `rp-gui-cfg-${who}-${runId}-`));
  dirs.push(cfgDir);
  writeFileSync(join(cfgDir, 'identity.json'), JSON.stringify({ display_name: who, email }));
  const root = mkdtempSync(join(tmpdir(), `rp-gui-${who}-${runId}-`));
  dirs.push(root);
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      `db: ${schemaUrl}`,
      '',
      'entities:',
      '  tasks:',
      '    fields:',
      '      id: { type: text, primaryKey: true }',
      '      title: { type: text }',
      '      deleted_at: { type: datetime }',
      '    render: default-list',
      '    outputFile: tasks.md',
    ].join('\n'),
  );
  mkdirSync(join(root, 'context'), { recursive: true });
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  return configPath;
}

async function seedCloud(): Promise<void> {
  const db = new Lattice(schemaUrl);
  db.define('tasks', {
    columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'tasks.md',
  });
  await db.init();
  for (const [t, def] of Object.entries(CLOUD_INTERNAL_TABLE_DEFS)) {
    await db.defineLate(t, def);
  }
  await installRowPermsSchema(db);

  const now = new Date().toISOString();
  await db.upsert('__lattice_users', {
    id: ALICE,
    email: ALICE_EMAIL,
    name: 'Alice',
    created_at: now,
    updated_at: now,
  });
  await db.upsert('__lattice_users', {
    id: BOB,
    email: BOB_EMAIL,
    name: 'Bob',
    created_at: now,
    updated_at: now,
  });
  await db.upsert('__lattice_team_identity', {
    id: 'singleton',
    team_id: TEAM,
    team_name: 'rp-harness',
    creator_email: ALICE_EMAIL,
    created_at: now,
  });
  await db.upsert('__lattice_team_members', {
    team_id: TEAM,
    user_id: ALICE,
    role: 'creator',
    joined_at: now,
  });
  await db.upsert('__lattice_team_members', {
    team_id: TEAM,
    user_id: BOB,
    role: 'member',
    joined_at: now,
  });
  await db.upsert('__lattice_shared_objects', {
    team_id: TEAM,
    table_name: 'tasks',
    schema_spec_json: '{}',
    schema_version: 1,
    created_by_user_id: ALICE,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    default_row_visibility: 'private',
  });
  await db.upsert('__lattice_object_owners', {
    team_id: TEAM,
    table_name: 'tasks',
    owner_user_id: ALICE,
    created_at: now,
  });

  // Three rows, one per visibility: the unique token makes search assertions
  // unambiguous even if the schema ever leaked into another namespace.
  await db.upsert('tasks', { id: 't-priv', title: `glacier-${runId} secret` });
  await recordRowAcl(db, TEAM, 'tasks', 't-priv', ALICE, 'private');
  await db.upsert('tasks', { id: 't-every', title: `glacier-${runId} public` });
  await recordRowAcl(db, TEAM, 'tasks', 't-every', ALICE, 'everyone');
  await db.upsert('tasks', { id: 't-custom', title: `glacier-${runId} shared` });
  await recordRowAcl(db, TEAM, 'tasks', 't-custom', ALICE, 'private');
  await addRowGrant(db, TEAM, 'tasks', 't-custom', BOB, ALICE); // → custom + grant BOB
  db.close();
}

describe.skipIf(!PG_URL)('GUI team mode — row permissions over HTTP (Postgres)', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await seedCloud();

    savedConfigDir = process.env.LATTICE_CONFIG_DIR;
    // The GUI resolves the operator from the machine identity file at boot.
    // Boot the OWNER first, then the MEMBER (each boot mirrors its identity
    // into the cloud's identity row; each server's team context is resolved
    // at its own boot, so the two coexist).
    const aliceConfig = writeWorkspace('alice', ALICE_EMAIL);
    aliceServer = await startGuiServer({
      configPath: aliceConfig,
      outputDir: join(aliceConfig, '..', 'context'),
      port: 0,
      openBrowser: false,
    });
    const bobConfig = writeWorkspace('bob', BOB_EMAIL);
    bobServer = await startGuiServer({
      configPath: bobConfig,
      outputDir: join(bobConfig, '..', 'context'),
      port: 0,
      openBrowser: false,
    });
  }, 60_000);

  afterAll(async () => {
    if (aliceServer) await aliceServer.close();
    if (bobServer) await bobServer.close();
    if (savedConfigDir === undefined) delete process.env.LATTICE_CONFIG_DIR;
    else process.env.LATTICE_CONFIG_DIR = savedConfigDir;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (admin) {
      // This suite's own throwaway namespace — created in beforeAll above.
      await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await admin.end();
    }
  }, 30_000);

  it('dashboard counts only the rows the member can see', async () => {
    const entities = (await fetch(`${bobServer!.url}/api/entities`).then((r) => r.json())) as {
      tables: { name: string; rowCount: number | null; shared?: boolean }[];
    };
    const tasks = entities.tables.find((t) => t.name === 'tasks');
    expect(tasks).toBeDefined();
    expect(tasks!.shared).toBe(true);
    // 3 physical rows; Bob may see 2 (everyone + custom-granted). A physical
    // count here would tell Bob a hidden row exists.
    expect(tasks!.rowCount).toBe(2);
  });

  it('search returns only ACL-visible hits', async () => {
    const result = (await fetch(
      `${bobServer!.url}/api/search?q=${encodeURIComponent(`glacier-${runId}`)}`,
    ).then((r) => r.json())) as {
      groups: { table: string; hits: { id: string }[] }[];
    };
    const group = result.groups.find((g) => g.table === 'tasks');
    expect(group).toBeDefined();
    expect(group!.hits.map((h) => h.id).sort()).toEqual(['t-custom', 't-every']);
  });

  it('row list returns exactly the visible set', async () => {
    const payload = (await fetch(`${bobServer!.url}/api/tables/tasks/rows`).then((r) =>
      r.json(),
    )) as {
      rows: { id: string }[];
    };
    expect(payload.rows.map((r) => r.id).sort()).toEqual(['t-custom', 't-every']);
  });

  it('owner grants + revokes via the endpoints the grants checklist uses', async () => {
    const bobRows = async (): Promise<string[]> => {
      const payload = (await fetch(`${bobServer!.url}/api/tables/tasks/rows`).then((r) =>
        r.json(),
      )) as { rows: { id: string }[] };
      return payload.rows.map((r) => r.id);
    };

    // Owner creates a row; the table default (private) applies → Bob can't see it.
    const created = (await fetch(`${aliceServer!.url}/api/tables/tasks/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 't-flow', title: `glacier-${runId} flow` }),
    }).then((r) => r.json())) as { id: string };
    expect(created.id).toBe('t-flow');
    expect(await bobRows()).not.toContain('t-flow');

    // Owner's single-row GET exposes the grantee list (it never reaches non-owners).
    const beforeGrant = (await fetch(`${aliceServer!.url}/api/tables/tasks/rows/t-flow`).then((r) =>
      r.json(),
    )) as { _access?: { ownedByMe: boolean; grantees?: string[] } };
    expect(beforeGrant._access?.ownedByMe).toBe(true);
    expect(beforeGrant._access?.grantees ?? []).toEqual([]);

    // Grant Bob (what checking his box in the grants checklist posts) → visible.
    const grant = await fetch(`${aliceServer!.url}/api/tables/tasks/rows/t-flow/grants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: BOB }),
    });
    expect(grant.status).toBe(200);
    expect(await bobRows()).toContain('t-flow');

    // Member must NOT be able to grant on a row they don't own (403, owner-only).
    const bobGrant = await fetch(`${bobServer!.url}/api/tables/tasks/rows/t-flow/grants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: BOB }),
    });
    expect(bobGrant.status).toBe(403);

    // Revoke (unchecking the box) → gone again.
    const revoke = await fetch(
      `${aliceServer!.url}/api/tables/tasks/rows/t-flow/grants/${encodeURIComponent(BOB)}`,
      { method: 'DELETE' },
    );
    expect(revoke.status).toBe(200);
    expect(await bobRows()).not.toContain('t-flow');
  });
});
