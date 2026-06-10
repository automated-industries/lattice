import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import {
  CLOUD_INTERNAL_TABLE_DEFS,
  installRowPermsSchema,
} from '../../src/teams/internal-tables.js';
import { recordRowAcl, addRowGrant, type RowVisibility } from '../../src/teams/row-access.js';

const TEAM = 'team-1';
const ALICE = 'user-alice';
const BOB = 'user-bob';

const dbs: Lattice[] = [];
const dirs: string[] = [];

async function makeCloudWithTasks(): Promise<Lattice> {
  const dir = mkdtempSync(join(tmpdir(), 'row-counts-'));
  dirs.push(dir);
  const db = new Lattice(join(dir, 'cloud.db'));
  db.define('tasks', {
    columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'tasks.md',
  });
  db.define('notes', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
    render: () => '',
    outputFile: 'notes.md',
  });
  await db.init();
  for (const [t, def] of Object.entries(CLOUD_INTERNAL_TABLE_DEFS)) {
    await db.defineLate(t, def);
  }
  await installRowPermsSchema(db);
  dbs.push(db);
  return db;
}

async function addTask(db: Lattice, id: string, owner: string, vis: RowVisibility): Promise<void> {
  await db.upsert('tasks', { id, title: id });
  await recordRowAcl(db, TEAM, 'tasks', id, owner, vis);
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Lattice.countVisibleMany', () => {
  it('counts exactly the rows each user may see, in one statement', async () => {
    const db = await makeCloudWithTasks();
    await addTask(db, 't-priv', ALICE, 'private');
    await addTask(db, 't-every', ALICE, 'everyone');
    await addTask(db, 't-custom', ALICE, 'private');
    await addRowGrant(db, TEAM, 'tasks', 't-custom', BOB, ALICE); // → custom + grant BOB

    const specs = [{ table: 'tasks', noAclVisible: false }];
    expect(await db.countVisibleMany(specs, { teamId: TEAM, userId: ALICE })).toEqual(
      new Map([['tasks', 3]]), // owner sees all
    );
    expect(await db.countVisibleMany(specs, { teamId: TEAM, userId: BOB })).toEqual(
      new Map([['tasks', 2]]), // everyone + granted; the private row is not even counted
    );
    expect(await db.countVisibleMany(specs, { teamId: TEAM, userId: 'user-carol' })).toEqual(
      new Map([['tasks', 1]]), // everyone only
    );
  });

  it('noAclVisible counts legacy no-ACL rows; without it they are invisible', async () => {
    const db = await makeCloudWithTasks();
    await db.upsert('tasks', { id: 'legacy-1', title: 'L1' }); // pre-2.2 row, no ACL entry
    await db.upsert('tasks', { id: 'legacy-2', title: 'L2' });

    expect(
      await db.countVisibleMany([{ table: 'tasks', noAclVisible: true }], {
        teamId: TEAM,
        userId: BOB,
      }),
    ).toEqual(new Map([['tasks', 2]]));
    expect(
      await db.countVisibleMany([{ table: 'tasks', noAclVisible: false }], {
        teamId: TEAM,
        userId: BOB,
      }),
    ).toEqual(new Map([['tasks', 0]]));
  });

  it('excludes soft-deleted rows where the table has deleted_at', async () => {
    const db = await makeCloudWithTasks();
    await addTask(db, 'a', ALICE, 'everyone');
    await addTask(db, 'b', ALICE, 'everyone');
    await db.update('tasks', 'b', { deleted_at: new Date().toISOString() });

    expect(
      await db.countVisibleMany([{ table: 'tasks', noAclVisible: false }], {
        teamId: TEAM,
        userId: BOB,
      }),
    ).toEqual(new Map([['tasks', 1]]));
  });

  it('counts many tables in one call and caps the pass at 50 (overflow logged, absent)', async () => {
    const db = await makeCloudWithTasks();
    await addTask(db, 't1', ALICE, 'everyone');
    await db.upsert('notes', { id: 'n1', body: 'x' });

    const both = await db.countVisibleMany(
      [
        { table: 'tasks', noAclVisible: false },
        { table: 'notes', noAclVisible: true },
      ],
      { teamId: TEAM, userId: BOB },
    );
    expect(both).toEqual(
      new Map([
        ['tasks', 1],
        ['notes', 1],
      ]),
    );

    // Over-cap: only the first 50 specs are answered; the rest are absent
    // (the GUI renders "—"), and the cap is logged — never silent.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manySpecs = [
      { table: 'tasks', noAclVisible: false },
      ...Array.from({ length: 50 }, () => ({ table: 'notes', noAclVisible: true })),
    ];
    const capped = await db.countVisibleMany(manySpecs, { teamId: TEAM, userId: BOB });
    expect(capped.size).toBeLessThanOrEqual(50);
    expect(warn).toHaveBeenCalledOnce();
  });
});
