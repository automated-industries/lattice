import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerDirectViaPostgres, isPostgresUrl } from '../../src/teams/register-direct.js';
import { Lattice } from '../../src/lattice.js';
import { CLOUD_INTERNAL_TABLE_DEFS } from '../../src/teams/internal-tables.js';
import { hashToken } from '../../src/teams/tokens.js';

const dirs: string[] = [];

function tempSqliteUrl(): string {
  // The "cloud" doesn't have to be Postgres for the test — registerDirectViaPostgres
  // verifies the URL scheme before opening, so we feed in postgres-like
  // file URLs via a sibling helper that bypasses the scheme check. The
  // alternative would require a real Postgres in test env. We keep the
  // scheme guard as a separate isPostgresUrl test below.
  const dir = mkdtempSync(join(tmpdir(), 'register-direct-'));
  dirs.push(dir);
  return `${dir}/cloud.db`;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('isPostgresUrl', () => {
  it('accepts postgres:// and postgresql://', () => {
    expect(isPostgresUrl('postgres://user:pass@host/db')).toBe(true);
    expect(isPostgresUrl('postgresql://user:pass@host/db')).toBe(true);
    expect(isPostgresUrl('POSTGRES://user:pass@host/db')).toBe(true);
  });
  it('rejects http(s) and other schemes', () => {
    expect(isPostgresUrl('http://example.com')).toBe(false);
    expect(isPostgresUrl('https://example.com')).toBe(false);
    expect(isPostgresUrl('file:./local.db')).toBe(false);
    expect(isPostgresUrl('/tmp/local.db')).toBe(false);
  });
});

describe('registerDirectViaPostgres — scheme guard', () => {
  it('refuses any non-postgres URL up-front', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- the deprecated primitive itself is under test
      registerDirectViaPostgres('http://example.com', 'admin@example.com', 'Admin', 'Atlas'),
    ).rejects.toThrow(/must be a postgres/);
  });
});

/**
 * SQLite-backed analogue of the registerDirectViaPostgres flow. Runs the
 * exact same INSERT sequence against a SQLite "cloud" so we can verify
 * the invariants (single-user-bootstrap, identity row creation, token
 * minting + hashing) without standing up a real Postgres in CI. The
 * production helper has the postgres:// scheme guard layered on top of
 * this same logic; that guard is covered by the test block above.
 */
async function registerDirectAgainstSqlite(
  cloudUrl: string,
  email: string,
  name: string,
  teamName: string,
): Promise<{ user: { id: string }; team: { id: string }; raw_token: string }> {
  const db = new Lattice(cloudUrl);
  await db.init();
  for (const [t, def] of Object.entries(CLOUD_INTERNAL_TABLE_DEFS)) {
    await db.defineLate(t, def);
  }
  const existing = await db.query('__lattice_users', {
    filters: [{ col: 'deleted_at', op: 'isNull' }],
    limit: 1,
  });
  if (existing.length > 0) {
    db.close();
    throw new Error(
      'Registration is disabled. This cloud already has users — join via invitation.',
    );
  }
  const identity = (await db
    .get('__lattice_team_identity', 'singleton')
    .catch(() => null)) as unknown;
  if (identity) {
    db.close();
    throw new Error('This cloud already has a team. Use Connect to existing cloud instead.');
  }
  const now = new Date().toISOString();
  const userId = await db.insert('__lattice_users', {
    email,
    name,
    created_at: now,
    updated_at: now,
  });
  const { generateToken } = await import('../../src/teams/tokens.js');
  const { raw, hash } = generateToken();
  await db.insert('__lattice_api_tokens', {
    user_id: userId,
    token_hash: hash,
    name: `creator:${teamName}`,
    created_at: now,
  });
  const teamId = await db.insert('__lattice_team', {
    name: teamName,
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
  await db.insert('__lattice_team_identity', {
    id: 'singleton',
    team_id: teamId,
    team_name: teamName,
    creator_email: email,
    created_at: now,
  });
  db.close();
  return { user: { id: userId }, team: { id: teamId }, raw_token: raw };
}

describe('register-direct flow — invariants (SQLite analogue)', () => {
  it('writes the identity singleton + creator user + creator member + hashed token', async () => {
    const url = tempSqliteUrl();
    const result = await registerDirectAgainstSqlite(url, 'admin@example.com', 'Admin', 'Atlas');
    expect(result.raw_token).toMatch(/^lat_[a-f0-9]+$/);

    // Reopen + verify the data shape.
    const db = new Lattice(url);
    await db.init();
    for (const [t, def] of Object.entries(CLOUD_INTERNAL_TABLE_DEFS)) {
      await db.defineLate(t, def);
    }

    const users = (await db.query('__lattice_users', {})) as { id: string; email: string }[];
    expect(users).toHaveLength(1);
    expect(users[0]?.email).toBe('admin@example.com');

    const identity = (await db.get('__lattice_team_identity', 'singleton')) as {
      team_name: string;
      creator_email: string;
    } | null;
    expect(identity?.team_name).toBe('Atlas');
    expect(identity?.creator_email).toBe('admin@example.com');

    const members = (await db.query('__lattice_team_members', {})) as { role: string }[];
    expect(members).toHaveLength(1);
    expect(members[0]?.role).toBe('creator');

    const tokens = (await db.query('__lattice_api_tokens', {})) as { token_hash: string }[];
    expect(tokens).toHaveLength(1);
    // The stored token is the SHA-256 hash of the raw token returned to the
    // caller. The raw token is shown to the caller exactly once.
    expect(tokens[0]?.token_hash).toBe(hashToken(result.raw_token));
    db.close();
  });

  it('refuses a second register on a cloud that already has users', async () => {
    const url = tempSqliteUrl();
    await registerDirectAgainstSqlite(url, 'admin@example.com', 'Admin', 'Atlas');
    await expect(
      registerDirectAgainstSqlite(url, 'second@example.com', 'Second', 'Other'),
    ).rejects.toThrow(/already has users/);
  });
});
