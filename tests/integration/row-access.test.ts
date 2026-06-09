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
  resolveRowAcl,
  canAccessRow,
  isRowOwner,
  tableDefaultVisibility,
  tableOwner,
  recordRowAcl,
  setRowVisibility,
  addRowGrant,
  removeRowGrant,
  setTableDefaultVisibility,
  RowOwnerOnlyError,
  type TableDefaultVisibility,
} from '../../src/teams/row-access.js';

const TEAM = 'team-1';
const ALICE = 'user-alice';
const BOB = 'user-bob';
const CAROL = 'user-carol';

const dbs: Lattice[] = [];
const dirs: string[] = [];

async function makeCloud(): Promise<Lattice> {
  const dir = mkdtempSync(join(tmpdir(), 'row-access-'));
  dirs.push(dir);
  const db = new Lattice(join(dir, 'cloud.db'));
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
  defaultVis: TableDefaultVisibility,
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

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('row-access authorization matrix', () => {
  it('owner can always access their row (any visibility)', async () => {
    const db = await makeCloud();
    await shareTable(db, 'tasks', ALICE, 'private');
    await recordRowAcl(db, TEAM, 'tasks', 'r1', ALICE, 'private');

    expect(await canAccessRow(db, TEAM, 'tasks', 'r1', ALICE)).toBe(true);
    expect(await isRowOwner(db, TEAM, 'tasks', 'r1', ALICE)).toBe(true);
    expect(await isRowOwner(db, TEAM, 'tasks', 'r1', BOB)).toBe(false);
  });

  it('private row is hidden from non-owners', async () => {
    const db = await makeCloud();
    await shareTable(db, 'tasks', ALICE, 'private');
    await recordRowAcl(db, TEAM, 'tasks', 'r1', ALICE, 'private');

    expect(await canAccessRow(db, TEAM, 'tasks', 'r1', BOB)).toBe(false);
    expect(await canAccessRow(db, TEAM, 'tasks', 'r1', CAROL)).toBe(false);
  });

  it('everyone row is visible to all members', async () => {
    const db = await makeCloud();
    await shareTable(db, 'tasks', ALICE, 'private');
    await recordRowAcl(db, TEAM, 'tasks', 'r1', ALICE, 'everyone');

    expect(await canAccessRow(db, TEAM, 'tasks', 'r1', ALICE)).toBe(true);
    expect(await canAccessRow(db, TEAM, 'tasks', 'r1', BOB)).toBe(true);
    expect(await canAccessRow(db, TEAM, 'tasks', 'r1', CAROL)).toBe(true);
  });

  it('custom row is visible only to grantees (and the owner)', async () => {
    const db = await makeCloud();
    await shareTable(db, 'tasks', ALICE, 'private');
    await recordRowAcl(db, TEAM, 'tasks', 'r1', ALICE, 'private');
    await addRowGrant(db, TEAM, 'tasks', 'r1', BOB, ALICE);

    // grant flipped the row to custom
    expect((await resolveRowAcl(db, TEAM, 'tasks', 'r1')).visibility).toBe('custom');
    expect(await canAccessRow(db, TEAM, 'tasks', 'r1', BOB)).toBe(true); // grantee
    expect(await canAccessRow(db, TEAM, 'tasks', 'r1', CAROL)).toBe(false); // not granted
    expect(await canAccessRow(db, TEAM, 'tasks', 'r1', ALICE)).toBe(true); // owner

    // removing the grant hides it again
    await removeRowGrant(db, TEAM, 'tasks', 'r1', BOB, ALICE);
    expect(await canAccessRow(db, TEAM, 'tasks', 'r1', BOB)).toBe(false);
  });

  it('a row with no ACL entry inherits the table default (everyone) and the table owner', async () => {
    const db = await makeCloud();
    await shareTable(db, 'docs', ALICE, 'everyone');

    const acl = await resolveRowAcl(db, TEAM, 'docs', 'ghost');
    expect(acl).toEqual({ ownerUserId: ALICE, visibility: 'everyone' });
    expect(await canAccessRow(db, TEAM, 'docs', 'ghost', BOB)).toBe(true);
    expect(await isRowOwner(db, TEAM, 'docs', 'ghost', ALICE)).toBe(true);
  });

  it('a row with no ACL entry in a private-default table is owner-only', async () => {
    const db = await makeCloud();
    await shareTable(db, 'tasks', ALICE, 'private');

    const acl = await resolveRowAcl(db, TEAM, 'tasks', 'ghost');
    expect(acl).toEqual({ ownerUserId: ALICE, visibility: 'private' });
    expect(await canAccessRow(db, TEAM, 'tasks', 'ghost', BOB)).toBe(false);
    expect(await canAccessRow(db, TEAM, 'tasks', 'ghost', ALICE)).toBe(true);
  });

  it('tableDefaultVisibility reflects the shared-object default and falls back to private', async () => {
    const db = await makeCloud();
    await shareTable(db, 'docs', ALICE, 'everyone');
    await shareTable(db, 'tasks', ALICE, 'private');

    expect(await tableDefaultVisibility(db, TEAM, 'docs')).toBe('everyone');
    expect(await tableDefaultVisibility(db, TEAM, 'tasks')).toBe('private');
    // unshared table → conservative default
    expect(await tableDefaultVisibility(db, TEAM, 'nope')).toBe('private');
  });

  it('tableOwner resolves from object_owners then shared created_by', async () => {
    const db = await makeCloud();
    const now = new Date().toISOString();
    // shared row only, no object_owners entry → falls back to created_by
    await db.upsert('__lattice_shared_objects', {
      team_id: TEAM,
      table_name: 'orphan',
      schema_spec_json: '{}',
      schema_version: 1,
      created_by_user_id: CAROL,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      default_row_visibility: 'private',
    });
    expect(await tableOwner(db, TEAM, 'orphan')).toBe(CAROL);
  });
});

describe('row-access owner gating', () => {
  it('setRowVisibility: owner can, non-owner throws RowOwnerOnlyError', async () => {
    const db = await makeCloud();
    await shareTable(db, 'tasks', ALICE, 'private');
    await recordRowAcl(db, TEAM, 'tasks', 'r1', ALICE, 'private');

    await expect(setRowVisibility(db, TEAM, 'tasks', 'r1', BOB, 'everyone')).rejects.toThrow(
      RowOwnerOnlyError,
    );
    await setRowVisibility(db, TEAM, 'tasks', 'r1', ALICE, 'everyone');
    expect((await resolveRowAcl(db, TEAM, 'tasks', 'r1')).visibility).toBe('everyone');
  });

  it('addRowGrant / removeRowGrant are owner-only', async () => {
    const db = await makeCloud();
    await shareTable(db, 'tasks', ALICE, 'private');
    await recordRowAcl(db, TEAM, 'tasks', 'r1', ALICE, 'private');

    await expect(addRowGrant(db, TEAM, 'tasks', 'r1', BOB, CAROL)).rejects.toThrow(
      RowOwnerOnlyError,
    );
    await addRowGrant(db, TEAM, 'tasks', 'r1', BOB, ALICE);
    await expect(removeRowGrant(db, TEAM, 'tasks', 'r1', BOB, CAROL)).rejects.toThrow(
      RowOwnerOnlyError,
    );
    await removeRowGrant(db, TEAM, 'tasks', 'r1', BOB, ALICE); // owner ok
  });

  it('setTableDefaultVisibility is table-owner-only', async () => {
    const db = await makeCloud();
    await shareTable(db, 'tasks', ALICE, 'private');

    await expect(setTableDefaultVisibility(db, TEAM, 'tasks', BOB, 'everyone')).rejects.toThrow(
      RowOwnerOnlyError,
    );
    await setTableDefaultVisibility(db, TEAM, 'tasks', ALICE, 'everyone');
    expect(await tableDefaultVisibility(db, TEAM, 'tasks')).toBe('everyone');
  });

  it('recordRowAcl sets owner + visibility and is idempotent on the row PK', async () => {
    const db = await makeCloud();
    await shareTable(db, 'tasks', ALICE, 'private');
    await recordRowAcl(db, TEAM, 'tasks', 'r1', ALICE, 'private');
    await recordRowAcl(db, TEAM, 'tasks', 'r1', ALICE, 'everyone'); // re-record

    const acl = await resolveRowAcl(db, TEAM, 'tasks', 'r1');
    expect(acl).toEqual({ ownerUserId: ALICE, visibility: 'everyone' });
    const rows = await db.query('__lattice_row_acl', {
      filters: [
        { col: 'team_id', op: 'eq', val: TEAM },
        { col: 'table_name', op: 'eq', val: 'tasks' },
        { col: 'pk', op: 'eq', val: 'r1' },
      ],
    });
    expect(rows.length).toBe(1); // upsert, not a duplicate
  });
});
