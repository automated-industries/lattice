/**
 * Direct-Postgres team operations.
 *
 * The HTTP TeamsClient methods (`listMembers`, `invite`, `kickMember`,
 * `destroyTeam`) need direct-Postgres equivalents because the Fetch
 * API refuses URLs with embedded credentials — when the GUI's cloud
 * connection is `postgres://...`, the HTTP path can never succeed.
 *
 * The direct path uses the operator's local Lattice (which IS the
 * cloud Lattice when connected directly) and runs the same Lattice
 * queries the server's HTTP handlers would. These tests exercise the
 * direct helpers against an SQLite-backed "cloud" so they run in CI
 * without a Postgres service container.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { CLOUD_INTERNAL_TABLE_DEFS } from '../../src/teams/internal-tables.js';
import {
  destroyTeamDirect,
  inviteDirect,
  kickMemberDirect,
  listMembersDirect,
  redeemInviteDirect,
  recordObjectOwner,
  listObjectOwners,
  reconcileObjectOwners,
  resolveUserIdByEmail,
} from '../../src/teams/direct-ops.js';

const dirs: string[] = [];

async function makeCloudLattice(): Promise<{ db: Lattice; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'direct-ops-'));
  dirs.push(dir);
  const db = new Lattice(`${dir}/cloud.db`);
  await db.init();
  for (const [t, def] of Object.entries(CLOUD_INTERNAL_TABLE_DEFS)) {
    await db.defineLate(t, def);
  }
  return {
    db,
    cleanup: () => {
      db.close();
    },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('direct-ops — listMembersDirect', () => {
  it('joins __lattice_team_members with __lattice_users and returns email + name + role', async () => {
    const { db, cleanup } = await makeCloudLattice();
    const now = new Date().toISOString();
    const userId = await db.insert('__lattice_users', {
      email: 'creator@example.com',
      name: 'Creator',
      created_at: now,
      updated_at: now,
    });
    const teamId = await db.insert('__lattice_team', {
      name: 'Atlas',
      created_by_user_id: userId,
      created_at: now,
      updated_at: now,
    });
    await db.insert('__lattice_team_members', {
      team_id: teamId,
      user_id: userId,
      role: 'creator',
      joined_at: now,
    });

    const members = await listMembersDirect(db, teamId);
    expect(members).toHaveLength(1);
    expect(members[0]?.email).toBe('creator@example.com');
    expect(members[0]?.name).toBe('Creator');
    expect(members[0]?.role).toBe('creator');
    expect(members[0]?.user_id).toBe(userId);

    cleanup();
  });

  it('excludes soft-deleted users', async () => {
    const { db, cleanup } = await makeCloudLattice();
    const now = new Date().toISOString();
    const userId = await db.insert('__lattice_users', {
      email: 'gone@example.com',
      name: 'Gone',
      created_at: now,
      updated_at: now,
      deleted_at: now,
    });
    const teamId = await db.insert('__lattice_team', {
      name: 'Atlas',
      created_by_user_id: userId,
      created_at: now,
      updated_at: now,
    });
    await db.insert('__lattice_team_members', {
      team_id: teamId,
      user_id: userId,
      role: 'creator',
      joined_at: now,
    });

    expect(await listMembersDirect(db, teamId)).toEqual([]);
    cleanup();
  });
});

describe('direct-ops — inviteDirect', () => {
  it('issues a latinv_-prefixed token, hashes it into __lattice_invitations, and returns expiry', async () => {
    const { db, cleanup } = await makeCloudLattice();
    const now = new Date().toISOString();
    const userId = await db.insert('__lattice_users', {
      email: 'creator@example.com',
      name: 'Creator',
      created_at: now,
      updated_at: now,
    });
    const teamId = await db.insert('__lattice_team', {
      name: 'Atlas',
      created_by_user_id: userId,
      created_at: now,
      updated_at: now,
    });

    const invite = await inviteDirect(db, teamId, userId, 'invitee@example.com', 24);
    expect(invite.raw_token).toMatch(/^latinv_/);
    expect(invite.team_name).toBe('Atlas');
    expect(invite.invitee_email).toBe('invitee@example.com');

    // Verify the row was inserted with a hashed (not raw) token.
    const stored = (await db.query('__lattice_invitations', {})) as { token_hash: string }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.token_hash).not.toBe(invite.raw_token);
    expect(stored[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/); // sha256 hex

    cleanup();
  });

  it('refuses to issue an invite for a non-existent / soft-deleted team', async () => {
    const { db, cleanup } = await makeCloudLattice();
    await expect(
      inviteDirect(db, 'no-such-team', 'no-such-user', 'invitee@example.com'),
    ).rejects.toThrow(/Team not found/);
    cleanup();
  });
});

describe('direct-ops — kickMemberDirect + destroyTeamDirect', () => {
  it('removes a member row + soft-deletes the team identity', async () => {
    const { db, cleanup } = await makeCloudLattice();
    const now = new Date().toISOString();
    const creatorId = await db.insert('__lattice_users', {
      email: 'c@example.com',
      name: 'C',
      created_at: now,
      updated_at: now,
    });
    const memberId = await db.insert('__lattice_users', {
      email: 'm@example.com',
      name: 'M',
      created_at: now,
      updated_at: now,
    });
    const teamId = await db.insert('__lattice_team', {
      name: 'Atlas',
      created_by_user_id: creatorId,
      created_at: now,
      updated_at: now,
    });
    await db.insert('__lattice_team_members', {
      team_id: teamId,
      user_id: creatorId,
      role: 'creator',
      joined_at: now,
    });
    await db.insert('__lattice_team_members', {
      team_id: teamId,
      user_id: memberId,
      role: 'member',
      joined_at: now,
    });
    await db.insert('__lattice_team_identity', {
      id: 'singleton',
      team_id: teamId,
      team_name: 'Atlas',
      creator_email: 'c@example.com',
      created_at: now,
    });

    await kickMemberDirect(db, teamId, memberId);
    expect(await listMembersDirect(db, teamId)).toHaveLength(1);
    expect((await listMembersDirect(db, teamId))[0]?.role).toBe('creator');

    await destroyTeamDirect(db);
    // Identity gone → team is destroyed from the GUI's perspective.
    const identity = await db.get('__lattice_team_identity', 'singleton').catch(() => null);
    expect(identity).toBeNull();

    cleanup();
  });
});

describe('direct-ops — redeemInviteDirect scheme guard', () => {
  it('refuses non-postgres URLs up-front (Fetch-API-compatible error message)', async () => {
    await expect(
      redeemInviteDirect('http://example.com', 'latinv_dead', 'a@b.com', 'A'),
    ).rejects.toThrow(/must be a postgres/);
    await expect(
      redeemInviteDirect('/tmp/local.db', 'latinv_dead', 'a@b.com', 'A'),
    ).rejects.toThrow(/must be a postgres/);
  });
});

describe('direct-ops — object ownership', () => {
  const TEAM = 'team-1';

  it('records an owner and reads it back', async () => {
    const { db, cleanup } = await makeCloudLattice();
    await recordObjectOwner(db, TEAM, 'Projects', 'user-a');
    const owners = await listObjectOwners(db, TEAM);
    expect(owners.get('Projects')).toBe('user-a');
    cleanup();
  });

  it('is first-writer-wins — a later record does NOT reassign ownership', async () => {
    const { db, cleanup } = await makeCloudLattice();
    await recordObjectOwner(db, TEAM, 'Projects', 'user-a');
    // A reconcile or a second create must not steal the table from its
    // original owner.
    await recordObjectOwner(db, TEAM, 'Projects', 'user-b');
    const owners = await listObjectOwners(db, TEAM);
    expect(owners.get('Projects')).toBe('user-a');
    cleanup();
  });

  it('scopes owners by team_id', async () => {
    const { db, cleanup } = await makeCloudLattice();
    await recordObjectOwner(db, 'team-1', 'Shared', 'user-a');
    await recordObjectOwner(db, 'team-2', 'Shared', 'user-b');
    expect((await listObjectOwners(db, 'team-1')).get('Shared')).toBe('user-a');
    expect((await listObjectOwners(db, 'team-2')).get('Shared')).toBe('user-b');
    cleanup();
  });

  it('reconcile assigns unowned candidates to the creator but leaves owned ones alone', async () => {
    const { db, cleanup } = await makeCloudLattice();
    // member already owns one table; the rest are unowned (e.g. natives).
    await recordObjectOwner(db, TEAM, 'MemberTable', 'member-1');
    await reconcileObjectOwners(db, TEAM, 'creator-1', [
      'MemberTable',
      'files',
      'secrets',
      'OwnerTable',
    ]);
    const owners = await listObjectOwners(db, TEAM);
    expect(owners.get('MemberTable')).toBe('member-1'); // untouched
    expect(owners.get('files')).toBe('creator-1');
    expect(owners.get('secrets')).toBe('creator-1');
    expect(owners.get('OwnerTable')).toBe('creator-1');
    cleanup();
  });

  it('reconcile is a no-op when the creator id is empty (degrade safely)', async () => {
    const { db, cleanup } = await makeCloudLattice();
    await reconcileObjectOwners(db, TEAM, '', ['files', 'secrets']);
    expect((await listObjectOwners(db, TEAM)).size).toBe(0);
    cleanup();
  });

  it('resolveUserIdByEmail is case-insensitive and skips soft-deleted users', async () => {
    const { db, cleanup } = await makeCloudLattice();
    const now = new Date().toISOString();
    const id = await db.insert('__lattice_users', {
      email: 'Owner@Example.com',
      name: 'Owner',
      created_at: now,
      updated_at: now,
    });
    await db.insert('__lattice_users', {
      email: 'gone@example.com',
      name: 'Gone',
      created_at: now,
      updated_at: now,
      deleted_at: now,
    });
    expect(await resolveUserIdByEmail(db, 'owner@example.com')).toBe(id);
    expect(await resolveUserIdByEmail(db, 'gone@example.com')).toBeNull();
    expect(await resolveUserIdByEmail(db, '')).toBeNull();
    cleanup();
  });
});
