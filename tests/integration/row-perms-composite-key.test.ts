import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import {
  CLOUD_INTERNAL_TABLE_DEFS,
  installRowPermsSchema,
} from '../../src/teams/internal-tables.js';
import { recordRowAcl, listVisibleRows, type RowVisibility } from '../../src/teams/row-access.js';

const TEAM = 'team-1';
const ALICE = 'user-alice';
const BOB = 'user-bob';

const dbs: Lattice[] = [];
const dirs: string[] = [];

async function makeCloud(): Promise<Lattice> {
  const dir = mkdtempSync(join(tmpdir(), 'row-composite-'));
  dirs.push(dir);
  const db = new Lattice(join(dir, 'cloud.db'));
  // A composite-PK shared table (the shape of a junction table like
  // project_meetings — no single `id` column).
  db.define('seats', {
    columns: { event_id: 'TEXT', seat_no: 'TEXT', holder: 'TEXT', deleted_at: 'TEXT' },
    primaryKey: ['event_id', 'seat_no'],
    render: () => '',
    outputFile: 'seats.md',
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

const ids = (rows: Row[]): string[] =>
  rows.map((r) => `${String(r.event_id)}/${String(r.seat_no)}`).sort();
type Row = Record<string, unknown>;

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('composite-key row permissions (2.2.1)', () => {
  it('insert returns a pk that encodes the FULL composite key (rows sharing the first column do not collide)', async () => {
    const db = await makeCloud();
    const pk1 = await db.insert('seats', { event_id: 'evt-1', seat_no: '1', holder: 'A' });
    const pk2 = await db.insert('seats', { event_id: 'evt-1', seat_no: '2', holder: 'B' });
    // Pre-2.2.1 these both returned 'evt-1' (first PK column only), so they
    // could not carry distinct ACL entries.
    expect(pk1).not.toEqual(pk2);
  });

  it('queryVisible keys on the full composite pk — per-row visibility within one event', async () => {
    const db = await makeCloud();
    await shareTable(db, 'seats', ALICE, 'private');
    const seatA = await db.insert('seats', { event_id: 'evt-1', seat_no: '1', holder: 'A' });
    const seatB = await db.insert('seats', { event_id: 'evt-1', seat_no: '2', holder: 'B' });
    await recordRowAcl(db, TEAM, 'seats', seatA, ALICE, 'everyone' as RowVisibility);
    await recordRowAcl(db, TEAM, 'seats', seatB, ALICE, 'private' as RowVisibility);

    // Both seats share event_id 'evt-1' but have different visibility. A
    // first-column-only key could not tell them apart.
    expect(ids(await listVisibleRows(db, TEAM, 'seats', ALICE))).toEqual(['evt-1/1', 'evt-1/2']);
    expect(ids(await listVisibleRows(db, TEAM, 'seats', BOB))).toEqual(['evt-1/1']); // everyone only
  });

  it('countVisibleMany counts composite-key rows per member, in one round-trip', async () => {
    const db = await makeCloud();
    await shareTable(db, 'seats', ALICE, 'private');
    const a = await db.insert('seats', { event_id: 'evt-1', seat_no: '1', holder: 'A' });
    const b = await db.insert('seats', { event_id: 'evt-1', seat_no: '2', holder: 'B' });
    await recordRowAcl(db, TEAM, 'seats', a, ALICE, 'everyone' as RowVisibility);
    await recordRowAcl(db, TEAM, 'seats', b, ALICE, 'private' as RowVisibility);

    expect(
      await db.countVisibleMany([{ table: 'seats', noAclVisible: false }], {
        teamId: TEAM,
        userId: ALICE,
      }),
    ).toEqual(new Map([['seats', 2]]));
    expect(
      await db.countVisibleMany([{ table: 'seats', noAclVisible: false }], {
        teamId: TEAM,
        userId: BOB,
      }),
    ).toEqual(new Map([['seats', 1]]));
  });

  it('does NOT crash on a table with no `id` column that was never registered (raw-SQL junction table)', async () => {
    const db = await makeCloud();
    // A physical table created outside Lattice's schema registry, composite
    // PK, no `id` column — getPrimaryKey() falls back to ['id'], which the
    // 2.2.0 query path turned into CAST(t."id" …) → "no such column: id".
    await db.adapter.runAsync(
      'CREATE TABLE project_meetings (project_id TEXT NOT NULL, meeting_id TEXT NOT NULL, PRIMARY KEY (project_id, meeting_id))',
    );
    await db.adapter.runAsync(
      "INSERT INTO project_meetings (project_id, meeting_id) VALUES ('p1','m1'), ('p1','m2')",
    );

    // An unkeyable table can carry no per-row ACL, so it behaves as a fully
    // shared ('everyone') table: visible when noAclVisible, empty otherwise —
    // and never throws.
    const visible = await db.queryVisible('project_meetings', {
      teamId: TEAM,
      userId: BOB,
      noAclVisible: true,
    });
    expect(visible.length).toBe(2);
    const hidden = await db.queryVisible('project_meetings', {
      teamId: TEAM,
      userId: BOB,
      noAclVisible: false,
    });
    expect(hidden.length).toBe(0);

    // countVisibleMany must survive the same table on a dashboard pass.
    const counts = await db.countVisibleMany([{ table: 'project_meetings', noAclVisible: true }], {
      teamId: TEAM,
      userId: BOB,
    });
    expect(counts.get('project_meetings')).toBe(2);
  });

  it('single-`id` tables are unchanged (back-compat)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'row-composite-id-'));
    dirs.push(dir);
    const db = new Lattice(join(dir, 'cloud.db'));
    db.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'tasks.md',
    });
    await db.init();
    for (const [t, def] of Object.entries(CLOUD_INTERNAL_TABLE_DEFS)) await db.defineLate(t, def);
    await installRowPermsSchema(db);
    dbs.push(db);
    await shareTable(db, 'tasks', ALICE, 'private');
    const id = await db.insert('tasks', { id: 'task-1', title: 'T' });
    expect(id).toBe('task-1'); // single-id serialization is the bare value
    await recordRowAcl(db, TEAM, 'tasks', id, ALICE, 'everyone' as RowVisibility);
    const seen = await listVisibleRows(db, TEAM, 'tasks', BOB);
    expect(seen.map((r) => String(r.id))).toEqual(['task-1']);
  });
});
