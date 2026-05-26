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
