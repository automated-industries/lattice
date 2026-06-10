import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import {
  CLOUD_INTERNAL_TABLE_DEFS,
  installRowPermsSchema,
} from '../../src/teams/internal-tables.js';
import { recordRowAcl, canAccessRow, visibleRowEdits } from '../../src/teams/row-access.js';
import { appendChangeEnvelope } from '../../src/teams/team-core.js';

/**
 * ACL coverage for the two read-side change-log GUI endpoints that an
 * adversarial review found bypassing row-level security:
 *   - GET /api/tables/:t/rows/:id/history  → gated on canAccessRow (404 on deny)
 *   - GET /api/tables/:t/last-edited        → filtered by visibleRowEdits
 * Those handlers only activate in team-cloud (Postgres) mode, but their ACL
 * logic is dialect-agnostic and lives in the helpers exercised here, so this
 * runs on SQLite and pins the security behaviour locally.
 */
const TEAM = 'team-1';
const ALICE = 'u-alice';
const BOB = 'u-bob';

const dbs: Lattice[] = [];
const dirs: string[] = [];

async function makeCloudWithTasks(): Promise<Lattice> {
  const dir = mkdtempSync(join(tmpdir(), 'row-endpoints-'));
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

async function addRow(db: Lattice, id: string, vis: 'private' | 'everyone'): Promise<void> {
  await db.upsert('tasks', { id, title: id });
  await recordRowAcl(db, TEAM, 'tasks', id, ALICE, vis);
  // a change-log entry so it appears in the /history + /last-edited scans
  await appendChangeEnvelope(db, {
    team_id: TEAM,
    table_name: 'tasks',
    pk: id,
    op: 'upsert',
    payload_json: JSON.stringify({ id, title: id }),
    owner_user_id: ALICE,
  });
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('GET /rows/:id/history — ACL gate (canAccessRow → 404 on deny)', () => {
  it('a non-owner is denied a private row but allowed an everyone row', async () => {
    const db = await makeCloudWithTasks();
    await addRow(db, 'priv', 'private');
    await addRow(db, 'evry', 'everyone');

    // The handler returns 404 exactly when canAccessRow is false.
    expect(await canAccessRow(db, TEAM, 'tasks', 'priv', BOB)).toBe(false); // → 404 for Bob
    expect(await canAccessRow(db, TEAM, 'tasks', 'priv', ALICE)).toBe(true); // owner sees history
    expect(await canAccessRow(db, TEAM, 'tasks', 'evry', BOB)).toBe(true); // everyone → ok
  });
});

describe('GET /last-edited — visibleRowEdits filters out rows the member cannot see', () => {
  it('omits private rows from a non-owner and includes everyone/owned rows', async () => {
    const db = await makeCloudWithTasks();
    await addRow(db, 'priv', 'private');
    await addRow(db, 'evry', 'everyone');

    const bob = await visibleRowEdits(db, TEAM, 'tasks', BOB);
    expect(Object.keys(bob).sort()).toEqual(['evry']); // private row hidden
    expect(bob.evry?.ownerUserId).toBe(ALICE);

    const alice = await visibleRowEdits(db, TEAM, 'tasks', ALICE);
    expect(Object.keys(alice).sort()).toEqual(['evry', 'priv']); // owner sees both
  });

  it('a custom grant exposes the row to the grantee but not to others', async () => {
    const db = await makeCloudWithTasks();
    await addRow(db, 'cust', 'private');
    // grant Bob directly via the ACL (custom)
    await recordRowAcl(db, TEAM, 'tasks', 'cust', ALICE, 'custom');
    await db.upsert('__lattice_row_grants', {
      team_id: TEAM,
      table_name: 'tasks',
      pk: 'cust',
      grantee_user_id: BOB,
      granted_by_user_id: ALICE,
      granted_at: new Date().toISOString(),
    });

    expect(Object.keys(await visibleRowEdits(db, TEAM, 'tasks', BOB))).toEqual(['cust']);
    expect(await visibleRowEdits(db, TEAM, 'tasks', 'u-carol')).toEqual({});
  });
});
