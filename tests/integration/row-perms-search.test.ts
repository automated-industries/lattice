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
  filterVisiblePks,
  type RowVisibility,
} from '../../src/teams/row-access.js';
import { filterSearchGroupsByAcl } from '../../src/gui/search-acl.js';
import { fullTextSearch } from '../../src/search/fts.js';

const TEAM = 'team-1';
const ALICE = 'user-alice';
const BOB = 'user-bob';
const CAROL = 'user-carol';

const dbs: Lattice[] = [];
const dirs: string[] = [];

async function makeCloudWithTasks(): Promise<Lattice> {
  const dir = mkdtempSync(join(tmpdir(), 'row-search-'));
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

async function addTask(
  db: Lattice,
  id: string,
  title: string,
  owner: string,
  vis: RowVisibility,
): Promise<void> {
  await db.upsert('tasks', { id, title });
  await recordRowAcl(db, TEAM, 'tasks', id, owner, vis);
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('filterVisiblePks', () => {
  it('returns exactly the accessible subset, batched', async () => {
    const db = await makeCloudWithTasks();
    await shareTable(db, 'tasks', ALICE, 'private');
    await addTask(db, 't-priv', 'secret plan', ALICE, 'private');
    await addTask(db, 't-every', 'public plan', ALICE, 'everyone');
    await addTask(db, 't-custom', 'shared plan', ALICE, 'private');
    await addRowGrant(db, TEAM, 'tasks', 't-custom', BOB, ALICE); // → custom + grant BOB

    const all = ['t-priv', 't-every', 't-custom'];
    expect([...(await filterVisiblePks(db, TEAM, 'tasks', ALICE, all))].sort()).toEqual([
      't-custom',
      't-every',
      't-priv',
    ]); // owner sees all
    expect([...(await filterVisiblePks(db, TEAM, 'tasks', BOB, all))].sort()).toEqual([
      't-custom',
      't-every',
    ]); // everyone + granted
    expect([...(await filterVisiblePks(db, TEAM, 'tasks', CAROL, all))].sort()).toEqual([
      't-every',
    ]); // everyone only
  });

  it('no-ACL legacy pks inherit the table default', async () => {
    const db = await makeCloudWithTasks();
    await shareTable(db, 'tasks', ALICE, 'everyone');
    await db.upsert('tasks', { id: 'legacy-1', title: 'L1' }); // no ACL entry

    expect(await filterVisiblePks(db, TEAM, 'tasks', BOB, ['legacy-1'])).toEqual(
      new Set(['legacy-1']),
    );

    const db2 = await makeCloudWithTasks();
    await shareTable(db2, 'tasks', ALICE, 'private');
    await db2.upsert('tasks', { id: 'legacy-2', title: 'L2' });
    expect(await filterVisiblePks(db2, TEAM, 'tasks', BOB, ['legacy-2'])).toEqual(new Set());
    // …but the table owner still sees their never-narrowed rows
    expect(await filterVisiblePks(db2, TEAM, 'tasks', ALICE, ['legacy-2'])).toEqual(
      new Set(['legacy-2']),
    );
  });

  it('an empty user identity sees only everyone-visible rows', async () => {
    const db = await makeCloudWithTasks();
    await shareTable(db, 'tasks', ALICE, 'private');
    await addTask(db, 't-every', 'public', ALICE, 'everyone');
    await addTask(db, 't-custom', 'custom', ALICE, 'custom');

    expect(await filterVisiblePks(db, TEAM, 'tasks', '', ['t-every', 't-custom'])).toEqual(
      new Set(['t-every']),
    );
  });
});

describe('filterSearchGroupsByAcl (the /api/search + assistant search post-filter)', () => {
  it('drops hits the member cannot see and recomputes counts', async () => {
    const db = await makeCloudWithTasks();
    await shareTable(db, 'tasks', ALICE, 'private');
    await addTask(db, 't-priv', 'project alpha secret', ALICE, 'private');
    await addTask(db, 't-every', 'project alpha public', ALICE, 'everyone');
    await addTask(db, 't-custom', 'project alpha custom', ALICE, 'private');
    await addRowGrant(db, TEAM, 'tasks', 't-custom', BOB, ALICE);

    const raw = await fullTextSearch(db.adapter, ['tasks'], { query: 'alpha' });
    expect(raw.groups[0]?.hits).toHaveLength(3); // unfiltered FTS sees everything

    const forBob = await filterSearchGroupsByAcl(db, TEAM, BOB, raw);
    expect(forBob.groups).toHaveLength(1);
    expect(forBob.groups[0]?.hits.map((h) => h.id).sort()).toEqual(['t-custom', 't-every']);
    expect(forBob.groups[0]?.count).toBe(2);

    const forCarol = await filterSearchGroupsByAcl(db, TEAM, CAROL, raw);
    expect(forCarol.groups[0]?.hits.map((h) => h.id)).toEqual(['t-every']);
  });

  it('drops a group entirely when none of its hits are visible', async () => {
    const db = await makeCloudWithTasks();
    await shareTable(db, 'tasks', ALICE, 'private');
    await addTask(db, 't-priv', 'project beta secret', ALICE, 'private');

    const raw = await fullTextSearch(db.adapter, ['tasks'], { query: 'beta' });
    expect(raw.groups).toHaveLength(1);

    const forBob = await filterSearchGroupsByAcl(db, TEAM, BOB, raw);
    expect(forBob.groups).toEqual([]); // a denied row is indistinguishable from missing
  });

  it('owner search results pass through unchanged', async () => {
    const db = await makeCloudWithTasks();
    await shareTable(db, 'tasks', ALICE, 'private');
    await addTask(db, 't-priv', 'gamma secret', ALICE, 'private');
    await addTask(db, 't-every', 'gamma public', ALICE, 'everyone');

    const raw = await fullTextSearch(db.adapter, ['tasks'], { query: 'gamma' });
    const forAlice = await filterSearchGroupsByAcl(db, TEAM, ALICE, raw);
    expect(forAlice.groups[0]?.hits.map((h) => h.id).sort()).toEqual(['t-every', 't-priv']);
  });
});
