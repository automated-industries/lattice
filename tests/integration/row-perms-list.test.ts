import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import {
  CLOUD_INTERNAL_TABLE_DEFS,
  installRowPermsSchema,
} from '../../src/teams/internal-tables.js';
import {
  recordRowAcl,
  addRowGrant,
  listVisibleRows,
  setTableDefaultVisibility,
  type RowVisibility,
} from '../../src/teams/row-access.js';

const TEAM = 'team-1';
const ALICE = 'user-alice';
const BOB = 'user-bob';
const CAROL = 'user-carol';

const dbs: Lattice[] = [];
const dirs: string[] = [];

async function makeCloudWithTasks(): Promise<Lattice> {
  const dir = mkdtempSync(join(tmpdir(), 'row-list-'));
  dirs.push(dir);
  const db = new Lattice(join(dir, 'cloud.db'));
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
  dbs.push(db);
  return db;
}

async function shareTable(
  db: Lattice,
  table: string,
  owner: string,
  defaultVis: 'private' | 'everyone',
): Promise<void> {
  const now = new Date().toISOString();
  await db.upsert('__lattice_shared_objects', {
    team_id: TEAM,
    table_name: table,
    schema_spec_json: '{}',
    schema_version: 1,
    created_by_user_id: owner,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    default_row_visibility: defaultVis,
  });
  await db.upsert('__lattice_object_owners', {
    team_id: TEAM,
    table_name: table,
    owner_user_id: owner,
    created_at: now,
  });
}

async function addTask(db: Lattice, id: string, owner: string, vis: RowVisibility): Promise<void> {
  await db.upsert('tasks', { id, title: id });
  await recordRowAcl(db, TEAM, 'tasks', id, owner, vis);
}

const ids = (rows: { id?: unknown }[]): string[] => rows.map((r) => String(r.id)).sort();

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('listVisibleRows', () => {
  it('returns exactly the rows each user may see', async () => {
    const db = await makeCloudWithTasks();
    await shareTable(db, 'tasks', ALICE, 'private');
    await addTask(db, 't-priv', ALICE, 'private');
    await addTask(db, 't-every', ALICE, 'everyone');
    await addTask(db, 't-custom', ALICE, 'private');
    await addRowGrant(db, TEAM, 'tasks', 't-custom', BOB, ALICE); // → custom + grant BOB

    expect(ids(await listVisibleRows(db, TEAM, 'tasks', ALICE))).toEqual([
      't-custom',
      't-every',
      't-priv',
    ]); // owner sees all
    expect(ids(await listVisibleRows(db, TEAM, 'tasks', BOB))).toEqual(['t-custom', 't-every']); // everyone + granted
    expect(ids(await listVisibleRows(db, TEAM, 'tasks', CAROL))).toEqual(['t-every']); // everyone only
  });

  it('no-ACL legacy rows: everyone-default visible to all; private-default owner-only', async () => {
    const db = await makeCloudWithTasks();
    await shareTable(db, 'tasks', ALICE, 'everyone');
    // legacy rows: inserted WITHOUT an ACL entry (pre-2.2 data)
    await db.upsert('tasks', { id: 'legacy-1', title: 'L1' });
    await db.upsert('tasks', { id: 'legacy-2', title: 'L2' });

    expect(ids(await listVisibleRows(db, TEAM, 'tasks', BOB))).toEqual(['legacy-1', 'legacy-2']);

    // owner narrows the table default → others lose the legacy rows, owner keeps them
    await setTableDefaultVisibility(db, TEAM, 'tasks', ALICE, 'private');
    expect(await listVisibleRows(db, TEAM, 'tasks', BOB)).toEqual([]);
    expect(ids(await listVisibleRows(db, TEAM, 'tasks', ALICE))).toEqual(['legacy-1', 'legacy-2']);
  });

  it('excludes soft-deleted rows by default; trash view shows them', async () => {
    const db = await makeCloudWithTasks();
    await shareTable(db, 'tasks', ALICE, 'everyone');
    await addTask(db, 'a', ALICE, 'everyone');
    await addTask(db, 'b', ALICE, 'everyone');
    await db.update('tasks', 'b', { deleted_at: new Date().toISOString() });

    expect(ids(await listVisibleRows(db, TEAM, 'tasks', BOB))).toEqual(['a']);
    expect(ids(await listVisibleRows(db, TEAM, 'tasks', BOB, { deleted: 'only' }))).toEqual(['b']);
    expect(ids(await listVisibleRows(db, TEAM, 'tasks', BOB, { deleted: 'any' }))).toEqual([
      'a',
      'b',
    ]);
  });

  it('filters in SQL — a large private set returns none for non-owners, all for the owner', async () => {
    const db = await makeCloudWithTasks();
    await shareTable(db, 'tasks', ALICE, 'private');
    for (let i = 0; i < 25; i++) await addTask(db, `p${String(i)}`, ALICE, 'private');

    expect(await listVisibleRows(db, TEAM, 'tasks', BOB)).toEqual([]);
    expect((await listVisibleRows(db, TEAM, 'tasks', ALICE)).length).toBe(25);
    // pagination composes with the visibility predicate
    expect((await listVisibleRows(db, TEAM, 'tasks', ALICE, { limit: 10 })).length).toBe(10);
  });
});
