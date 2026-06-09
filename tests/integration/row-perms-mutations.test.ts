import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import {
  CLOUD_INTERNAL_TABLE_DEFS,
  installRowPermsSchema,
} from '../../src/teams/internal-tables.js';
import { createRow, updateRow, deleteRow, type MutationCtx } from '../../src/gui/mutations.js';
import { executeFunction, type DispatchCtx } from '../../src/gui/ai/dispatch.js';
import {
  resolveRowAcl,
  setRowVisibility,
  RowAccessError,
} from '../../src/teams/row-access.js';

const TEAM = 'team-1';
const ALICE = 'user-alice';
const BOB = 'user-bob';

const dbs: Lattice[] = [];
const dirs: string[] = [];

async function makeCloudWithTasks(): Promise<Lattice> {
  const dir = mkdtempSync(join(tmpdir(), 'row-mut-'));
  dirs.push(dir);
  const db = new Lattice(join(dir, 'cloud.db'));
  db.define('tasks', {
    columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'tasks.md',
    fts: { fields: ['title'] },
  });
  // The shared GUI mutation primitives append to this audit table.
  db.define('_lattice_gui_audit', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      ts: "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      table_name: 'TEXT NOT NULL',
      row_id: 'TEXT',
      operation: 'TEXT NOT NULL',
      before_json: 'TEXT',
      after_json: 'TEXT',
      undone: 'INTEGER NOT NULL DEFAULT 0',
    },
    render: () => '',
    outputFile: '.lattice-gui/audit.md',
  });
  await db.init();
  for (const [t, def] of Object.entries(CLOUD_INTERNAL_TABLE_DEFS)) {
    await db.defineLate(t, def);
  }
  await installRowPermsSchema(db);
  // share `tasks`, default visibility private, owned by Alice
  const now = new Date().toISOString();
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
  dbs.push(db);
  return db;
}

function mctxFor(db: Lattice, userId: string): MutationCtx {
  return {
    db,
    feed: new FeedBus(),
    softDeletable: new Set(['tasks']),
    source: 'gui',
    team: { teamId: TEAM, myUserId: userId },
  };
}

function dctxFor(db: Lattice, userId: string): DispatchCtx {
  return {
    db,
    feed: new FeedBus(),
    validTables: new Set(['tasks']),
    junctionTables: new Set(),
    softDeletable: new Set(['tasks']),
    team: { teamId: TEAM, myUserId: userId },
  };
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('row-perms mutation enforcement (HTTP layer)', () => {
  it('createRow records an ACL with owner = creator and the table default visibility', async () => {
    const db = await makeCloudWithTasks();
    const { id } = await createRow(mctxFor(db, ALICE), 'tasks', { title: 'A' });
    expect(await resolveRowAcl(db, TEAM, 'tasks', id)).toEqual({
      ownerUserId: ALICE,
      visibility: 'private',
    });
  });

  it('non-owner update/delete throw RowAccessError; owner succeeds', async () => {
    const db = await makeCloudWithTasks();
    const { id } = await createRow(mctxFor(db, ALICE), 'tasks', { title: 'A' });

    await expect(updateRow(mctxFor(db, BOB), 'tasks', id, { title: 'X' })).rejects.toThrow(
      RowAccessError,
    );
    await expect(deleteRow(mctxFor(db, BOB), 'tasks', id, false)).rejects.toThrow(RowAccessError);

    await updateRow(mctxFor(db, ALICE), 'tasks', id, { title: 'Y' }); // owner ok
    expect((await db.get('tasks', id))?.title).toBe('Y');
  });
});

describe('row-perms ASSISTANT enforcement (regression: dispatch must not bypass the ACL)', () => {
  it('list_rows / get_row / update_row / delete_row honor the row ACL for the assistant', async () => {
    const db = await makeCloudWithTasks();
    // Alice creates a private row and an everyone row.
    const priv = (await createRow(mctxFor(db, ALICE), 'tasks', { title: 'secret' })).id;
    const pub = (await createRow(mctxFor(db, ALICE), 'tasks', { title: 'public' })).id;
    await setRowVisibility(db, TEAM, 'tasks', pub, ALICE, 'everyone');

    // Bob's assistant lists rows → sees only the everyone row, NOT the private one.
    const listed = await executeFunction(dctxFor(db, BOB), 'list_rows', { table: 'tasks' });
    expect(listed.ok).toBe(true);
    const listedIds = (listed.result as { id: string }[]).map((r) => r.id);
    expect(listedIds).toContain(pub);
    expect(listedIds).not.toContain(priv);

    // Bob's assistant get_row on the private row → not found (hide existence).
    const got = await executeFunction(dctxFor(db, BOB), 'get_row', { table: 'tasks', id: priv });
    expect(got).toEqual({ ok: false, error: 'Row not found' });

    // Bob's assistant update_row on the private row → enforcement fires, no write.
    const upd = await executeFunction(dctxFor(db, BOB), 'update_row', {
      table: 'tasks',
      id: priv,
      values: { title: 'hacked' },
    });
    expect(upd.ok).toBe(false);
    expect((await db.get('tasks', priv))?.title).toBe('secret'); // unchanged

    // Bob's assistant delete_row on the private row → enforcement fires, row survives.
    const del = await executeFunction(dctxFor(db, BOB), 'delete_row', {
      table: 'tasks',
      id: priv,
    });
    expect(del.ok).toBe(false);
    expect(await db.get('tasks', priv)).not.toBeNull();
  });

  it('search post-filters hits so the assistant never surfaces a row the user cannot see', async () => {
    const db = await makeCloudWithTasks();
    const priv = (await createRow(mctxFor(db, ALICE), 'tasks', { title: 'pineapple' })).id;
    await createRow(mctxFor(db, ALICE), 'tasks', { title: 'pineapple public' }).then((r) =>
      setRowVisibility(db, TEAM, 'tasks', r.id, ALICE, 'everyone'),
    );

    // Alice (owner) sees both hits.
    const aliceHits = await executeFunction(dctxFor(db, ALICE), 'search', { query: 'pineapple' });
    const aliceIds = ((aliceHits.result as { groups: { hits: { id: string }[] }[] }).groups ?? [])
      .flatMap((g) => g.hits)
      .map((h) => h.id);
    expect(aliceIds).toContain(priv);

    // Bob does NOT get the private hit.
    const bobHits = await executeFunction(dctxFor(db, BOB), 'search', { query: 'pineapple' });
    const bobIds = ((bobHits.result as { groups: { hits: { id: string }[] }[] }).groups ?? [])
      .flatMap((g) => g.hits)
      .map((h) => h.id);
    expect(bobIds).not.toContain(priv);
  });
});
