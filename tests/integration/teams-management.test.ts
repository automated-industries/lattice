import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { Lattice } from '../../src/lattice.js';
import { TeamsClient, TeamsHttpError } from '../../src/teams/client.js';

/**
 * End-to-end Phase 2 integration: one cloud lattice + two local lattices.
 *
 * Flow exercised:
 *   1. Alice registers on the fresh cloud (bootstrap).
 *   2. Alice creates "Atlas" team — becomes creator.
 *   3. Alice generates an invitation token.
 *   4. Bob (separate local lattice) redeems the invite — becomes member.
 *   5. Both `list` the team via local connections.
 *   6. Bob lists Atlas members — sees Alice (creator) + Bob (member).
 *   7. Bob attempts to invite — 403 (member, not creator).
 *   8. Bob leaves Atlas — kick-self succeeds for non-creators.
 *   9. Alice destroys Atlas — soft-delete + local connection removed.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-teams-mgmt-'));
  dirs.push(dir);
  return dir;
}

function writeConfig(root: string, dbName: string): { configPath: string; outputDir: string } {
  const outputDir = join(root, 'context');
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      `db: ./data/${dbName}.db`,
      '',
      'entities:',
      '  items:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text, required: true }',
      '    outputFile: items.md',
    ].join('\n'),
  );
  return { configPath, outputDir };
}

afterEach(async () => {
  for (const h of servers.splice(0)) await h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startCloud(): Promise<GuiServerHandle> {
  const { configPath, outputDir } = writeConfig(tempDir(), 'cloud');
  const handle = await startGuiServer({
    configPath,
    outputDir,
    port: 0,
    host: '127.0.0.1',
    teamCloud: true,
    openBrowser: false,
  });
  servers.push(handle);
  return handle;
}

async function openLocalClient(): Promise<{ db: Lattice; client: TeamsClient }> {
  const { configPath } = writeConfig(tempDir(), 'local');
  const db = new Lattice({ config: configPath });
  await db.init();
  const client = new TeamsClient(db);
  return { db, client };
}

describe('teams management — end-to-end', () => {
  it('runs the full create → invite → join → list → leave → destroy round-trip', async () => {
    const cloud = await startCloud();

    // Alice (creator) local lattice
    const alice = await openLocalClient();
    // Bob (invitee) local lattice
    const bob = await openLocalClient();

    try {
      // 1. Alice registers (bootstrap)
      const aliceReg = await alice.client.register(cloud.url, 'alice@example.com', 'Alice');
      expect(aliceReg.user.email).toBe('alice@example.com');
      expect(aliceReg.raw_token).toMatch(/^lat_/);
      const aliceToken = aliceReg.raw_token;

      // Second registration must fail — bootstrap-only
      await expect(
        alice.client.register(cloud.url, 'mallory@example.com', 'Mallory'),
      ).rejects.toMatchObject({ status: 403 });

      // 2. Alice creates Atlas team
      const atlas = await alice.client.createTeam(cloud.url, aliceToken, 'Atlas');
      expect(atlas.name).toBe('Atlas');
      expect(atlas.role).toBe('creator');
      await alice.client.saveConnection({
        team_id: atlas.id,
        team_name: atlas.name,
        cloud_url: cloud.url,
        my_user_id: aliceReg.user.id,
        api_token: aliceToken,
      });

      // 3. Alice generates an invitation addressed to Bob
      const invite = await alice.client.invite(cloud.url, aliceToken, atlas.id, 'bob@example.com');
      expect(invite.raw_token).toMatch(/^latinv_/);
      expect(invite.team_name).toBe('Atlas');
      expect(invite.invitee_email).toBe('bob@example.com');

      // 4. Bob redeems the invitation
      const bobJoin = await bob.client.redeemInvite(
        cloud.url,
        invite.raw_token,
        'bob@example.com',
        'Bob',
      );
      expect(bobJoin.team.name).toBe('Atlas');
      expect(bobJoin.user.email).toBe('bob@example.com');
      expect(bobJoin.raw_token).toMatch(/^lat_/);
      await bob.client.saveConnection({
        team_id: bobJoin.team.id,
        team_name: bobJoin.team.name,
        cloud_url: cloud.url,
        my_user_id: bobJoin.user.id,
        api_token: bobJoin.raw_token,
      });

      // Same invitation cannot be redeemed twice — once Bob has used
      // it, even the original invitee gets 401 ("already used").
      await expect(
        bob.client.redeemInvite(cloud.url, invite.raw_token, 'eve@example.com', 'Eve'),
      ).rejects.toMatchObject({ status: 401 });

      // 5. Both locals show Atlas in their connections
      expect((await alice.client.listConnections()).map((c) => c.team_name)).toEqual(['Atlas']);
      expect((await bob.client.listConnections()).map((c) => c.team_name)).toEqual(['Atlas']);

      // 6. Bob lists members — sees both
      const members = await bob.client.listMembers(cloud.url, bobJoin.raw_token, atlas.id);
      expect(members).toHaveLength(2);
      const roles = members.map((m) => m.role).sort();
      expect(roles).toEqual(['creator', 'member']);

      // 7. Bob tries to invite — 403
      await expect(
        bob.client.invite(cloud.url, bobJoin.raw_token, atlas.id, 'carol@example.com'),
      ).rejects.toMatchObject({ status: 403 });

      // 7b. Bob tries to destroy — 403
      await expect(
        bob.client.deleteTeam(cloud.url, bobJoin.raw_token, atlas.id),
      ).rejects.toMatchObject({ status: 403 });

      // 8. Bob leaves Atlas (kick-self as non-creator)
      await bob.client.kickMember(cloud.url, bobJoin.raw_token, atlas.id, bobJoin.user.id);
      await bob.client.deleteConnection(atlas.id);
      expect(await bob.client.listConnections()).toEqual([]);

      // After leaving, Bob can't list members
      await expect(
        bob.client.listMembers(cloud.url, bobJoin.raw_token, atlas.id),
      ).rejects.toMatchObject({ status: 403 });

      // Alice's member list now shows only herself
      const remaining = await alice.client.listMembers(cloud.url, aliceToken, atlas.id);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.role).toBe('creator');

      // 9. Alice destroys Atlas — soft-delete; her listTeams becomes empty
      await alice.client.deleteTeam(cloud.url, aliceToken, atlas.id);
      const teamsAfter = await alice.client.listTeams(cloud.url, aliceToken);
      expect(teamsAfter).toEqual([]);

      // Destroying twice is a 403 (creator role still applies but team is
      // already deleted — get returns null, so the handler 404s).
      await expect(alice.client.deleteTeam(cloud.url, aliceToken, atlas.id)).rejects.toMatchObject({
        status: 404,
      });

      // Alice removes her local connection too
      await alice.client.deleteConnection(atlas.id);
      expect(await alice.client.listConnections()).toEqual([]);
    } finally {
      alice.db.close();
      bob.db.close();
    }
  });

  it('creator cannot kick themselves', async () => {
    const cloud = await startCloud();
    const alice = await openLocalClient();
    try {
      const reg = await alice.client.register(cloud.url, 'alice@example.com', 'Alice');
      const team = await alice.client.createTeam(cloud.url, reg.raw_token, 'Atlas');
      await expect(
        alice.client.kickMember(cloud.url, reg.raw_token, team.id, reg.user.id),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      alice.db.close();
    }
  });

  it('invitation tokens never authenticate as bearer tokens', async () => {
    const cloud = await startCloud();
    const alice = await openLocalClient();
    try {
      const reg = await alice.client.register(cloud.url, 'alice@example.com', 'Alice');
      const team = await alice.client.createTeam(cloud.url, reg.raw_token, 'Atlas');
      const invite = await alice.client.invite(
        cloud.url,
        reg.raw_token,
        team.id,
        'bob@example.com',
      );
      // Try to use the latinv_-prefixed token as a bearer
      await expect(alice.client.listTeams(cloud.url, invite.raw_token)).rejects.toMatchObject({
        status: 401,
      });
    } finally {
      alice.db.close();
    }
  });

  it('revoking a token immediately rejects further requests', async () => {
    const cloud = await startCloud();
    const alice = await openLocalClient();
    try {
      const reg = await alice.client.register(cloud.url, 'alice@example.com', 'Alice');
      // Mint a second token directly via the public HTTP API.
      const mintRes = await fetch(`${cloud.url}/api/auth/tokens`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${reg.raw_token}`,
        },
        body: JSON.stringify({ name: 'second' }),
      });
      expect(mintRes.status).toBe(201);
      const secondToken = (await mintRes.json()) as { id: string; raw_token: string };

      // Revoke the second token (using itself, which is allowed —
      // tokens can self-revoke).
      const revokeRes = await fetch(`${cloud.url}/api/auth/tokens/${secondToken.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${secondToken.raw_token}` },
      });
      expect(revokeRes.status).toBe(200);

      // The revoked token must now be rejected
      await expect(alice.client.listTeams(cloud.url, secondToken.raw_token)).rejects.toMatchObject({
        status: 401,
      });
      // The bootstrap token still works
      const teams = await alice.client.listTeams(cloud.url, reg.raw_token);
      expect(teams).toEqual([]);
    } finally {
      alice.db.close();
    }
  });

  it('findConnectionByName errors on ambiguous names', async () => {
    const cloud = await startCloud();
    const alice = await openLocalClient();
    try {
      const reg = await alice.client.register(cloud.url, 'alice@example.com', 'Alice');
      const a = await alice.client.createTeam(cloud.url, reg.raw_token, 'Same');
      // Manually plant a second connection row with the same name to simulate
      // joining a same-named team on a different cloud.
      await alice.client.saveConnection({
        team_id: a.id,
        team_name: 'Same',
        cloud_url: cloud.url,
        my_user_id: reg.user.id,
        api_token: reg.raw_token,
      });
      await alice.client.saveConnection({
        team_id: 'fake-team-id-on-other-cloud',
        team_name: 'Same',
        cloud_url: 'http://other.example.com',
        my_user_id: 'other-user',
        api_token: 'lat_other',
      });
      await expect(alice.client.findConnectionByName('Same')).rejects.toThrow(
        /Ambiguous team name/,
      );
    } finally {
      alice.db.close();
    }
  });
});

// Helper to make TeamsHttpError matchable in expect — keep at module scope so
// the tree-shaker doesn't drop it.
void TeamsHttpError;
