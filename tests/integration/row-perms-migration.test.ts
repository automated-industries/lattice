import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import {
  CLOUD_INTERNAL_TABLE_DEFS,
  installRowPermsSchema,
} from '../../src/teams/internal-tables.js';
import { resolveRowAcl } from '../../src/teams/row-access.js';

const TEAM = 'team-1';
const ALICE = 'user-alice';

const dbs: Lattice[] = [];
const dirs: string[] = [];

/**
 * A team cloud with the internal tables registered but the 2.2 row-perms
 * migration NOT yet run — simulates a pre-2.2 cloud about to upgrade.
 */
async function preUpgradeCloud(): Promise<Lattice> {
  const dir = mkdtempSync(join(tmpdir(), 'row-perms-mig-'));
  dirs.push(dir);
  const db = new Lattice(join(dir, 'cloud.db'));
  await db.init();
  for (const [t, def] of Object.entries(CLOUD_INTERNAL_TABLE_DEFS)) {
    await db.defineLate(t, def);
  }
  dbs.push(db);
  return db;
}

async function recordShare(
  db: Lattice,
  table: string,
  owner: string,
  deletedAt: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  // NOTE: default_row_visibility intentionally omitted — pre-upgrade the
  // column does not exist yet.
  await db.upsert('__lattice_shared_objects', {
    team_id: TEAM,
    table_name: table,
    schema_spec_json: '{}',
    schema_version: 1,
    created_by_user_id: owner,
    created_at: now,
    updated_at: now,
    deleted_at: deletedAt,
  });
  await db.upsert('__lattice_object_owners', {
    team_id: TEAM,
    table_name: table,
    owner_user_id: owner,
    created_at: now,
  });
}

async function defaultVisOf(db: Lattice, table: string): Promise<unknown> {
  const rows = await db.query('__lattice_shared_objects', {
    filters: [
      { col: 'team_id', op: 'eq', val: TEAM },
      { col: 'table_name', op: 'eq', val: table },
    ],
  });
  return rows[0]?.default_row_visibility;
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('row-perms migration / upgrade backfill', () => {
  it('adds the new column + ACL tables on upgrade', async () => {
    const db = await preUpgradeCloud();
    // pre-upgrade: column does not exist yet
    expect(await db.introspectColumns('__lattice_shared_objects')).not.toContain(
      'default_row_visibility',
    );

    await installRowPermsSchema(db);

    expect(await db.introspectColumns('__lattice_shared_objects')).toContain(
      'default_row_visibility',
    );
    expect(await db.introspectColumns('__lattice_change_log')).toContain('recipient_user_id');
    expect(await db.introspectColumns('__lattice_row_acl')).toEqual(
      expect.arrayContaining(['team_id', 'table_name', 'pk', 'owner_user_id', 'visibility']),
    );
    expect(await db.introspectColumns('__lattice_row_grants')).toEqual(
      expect.arrayContaining(['grantee_user_id', 'granted_by_user_id']),
    );
  });

  it('backfills already-shared tables to everyone; leaves soft-deleted shares + new shares private', async () => {
    const db = await preUpgradeCloud();
    await recordShare(db, 'tasks', ALICE, null); // live pre-2.2 share
    await recordShare(db, 'archived', ALICE, new Date().toISOString()); // soft-deleted share

    await installRowPermsSchema(db);

    // live pre-existing share → flipped to everyone (nothing disappears on upgrade)
    expect(await defaultVisOf(db, 'tasks')).toBe('everyone');
    // soft-deleted share → not backfilled, gets the column default
    expect(await defaultVisOf(db, 'archived')).toBe('private');

    // a brand-new share created AFTER the upgrade is born private
    await db.upsert('__lattice_shared_objects', {
      team_id: TEAM,
      table_name: 'fresh',
      schema_spec_json: '{}',
      schema_version: 1,
      created_by_user_id: ALICE,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    });
    expect(await defaultVisOf(db, 'fresh')).toBe('private');
  });

  it('pre-2.2 rows (no ACL entry) resolve to everyone + table owner after backfill', async () => {
    const db = await preUpgradeCloud();
    await recordShare(db, 'tasks', ALICE, null);
    await installRowPermsSchema(db);

    const acl = await resolveRowAcl(db, TEAM, 'tasks', 'legacy-row');
    expect(acl).toEqual({ ownerUserId: ALICE, visibility: 'everyone' });
  });

  it('is idempotent: re-running does not throw and does not clobber an owner-narrowed default', async () => {
    const db = await preUpgradeCloud();
    await recordShare(db, 'tasks', ALICE, null);
    await installRowPermsSchema(db);
    expect(await defaultVisOf(db, 'tasks')).toBe('everyone');

    // owner narrows the table back to private after upgrade
    await db.update(
      '__lattice_shared_objects',
      { team_id: TEAM, table_name: 'tasks' },
      { default_row_visibility: 'private' },
    );

    // re-running the upgrade must be a no-op (migration already applied)
    await installRowPermsSchema(db);
    await installRowPermsSchema(db);
    expect(await defaultVisOf(db, 'tasks')).toBe('private'); // NOT reset to everyone
  });
});
