import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { Lattice } from '../../src/lattice.js';
import { TeamsClient } from '../../src/teams/client.js';

/**
 * Email-bound identity assertions for the Phase 5 redesign.
 *
 * Covers the security-relevant pieces of the team auth model:
 *   - Invitations carry an `invitee_email` and reject redemption by
 *     anyone else.
 *   - Creating a team mirrors into the singleton `__lattice_team_identity`
 *     and rejects a second `createTeam` call with 409 (one-team-per-DB).
 *   - GET /api/team returns the identity + member list for an
 *     authenticated member.
 *   - DELETE /api/team requires the creator and drops the identity row
 *     so the singleton invitation/get routes return "no team enabled".
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lattice-team-email-'));
  dirs.push(d);
  return d;
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

async function openLocal(): Promise<{ db: Lattice; client: TeamsClient }> {
  const { configPath } = writeConfig(tempDir(), 'local');
  const db = new Lattice({ config: configPath });
  await db.init();
  return { db, client: new TeamsClient(db) };
}

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

async function api(url: string, token: string | null, init: RequestInit = {}): Promise<ApiResult> {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body) headers.set('content-type', 'application/json');
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe('email-bound identity + one-team-per-DB', () => {
  it('invitations are bound to an email; redeem with a different email returns 403', async () => {
    const cloud = await startCloud();
    const alice = await openLocal();
    try {
      const reg = await alice.client.register(cloud.url, 'alice@example.com', 'Alice');
      const team = await alice.client.createTeam(cloud.url, reg.raw_token, 'Atlas');
      const invite = await alice.client.invite(
        cloud.url,
        reg.raw_token,
        team.id,
        'bob@example.com',
      );
      expect(invite.invitee_email).toBe('bob@example.com');

      // Eve tries to redeem an invitation addressed to Bob — 403.
      const eve = await openLocal();
      try {
        await expect(
          eve.client.redeemInvite(cloud.url, invite.raw_token, 'eve@example.com', 'Eve'),
        ).rejects.toMatchObject({ status: 403 });

        // Bob (the real invitee) succeeds.
        const join = await eve.client.redeemInvite(
          cloud.url,
          invite.raw_token,
          'bob@example.com',
          'Bob',
        );
        expect(join.user.email).toBe('bob@example.com');
      } finally {
        eve.db.close();
      }
    } finally {
      alice.db.close();
    }
  });

  it('email match is case-insensitive', async () => {
    const cloud = await startCloud();
    const alice = await openLocal();
    try {
      const reg = await alice.client.register(cloud.url, 'alice@example.com', 'Alice');
      const team = await alice.client.createTeam(cloud.url, reg.raw_token, 'Atlas');
      const invite = await alice.client.invite(
        cloud.url,
        reg.raw_token,
        team.id,
        'BOB@example.com',
      );

      const bob = await openLocal();
      try {
        // Redeem with the same address but lower-cased local part.
        const join = await bob.client.redeemInvite(
          cloud.url,
          invite.raw_token,
          'bob@example.com',
          'Bob',
        );
        expect(join.user.email).toBe('bob@example.com');
      } finally {
        bob.db.close();
      }
    } finally {
      alice.db.close();
    }
  });

  it('POST /api/teams populates __lattice_team_identity; second createTeam → 409', async () => {
    const cloud = await startCloud();
    const alice = await openLocal();
    try {
      const reg = await alice.client.register(cloud.url, 'alice@example.com', 'Alice');
      await alice.client.createTeam(cloud.url, reg.raw_token, 'Atlas');

      const teamRes = await api(`${cloud.url}/api/team`, reg.raw_token);
      expect(teamRes.status).toBe(200);
      expect(teamRes.body.enabled).toBe(true);
      expect(teamRes.body.team_name).toBe('Atlas');
      expect(teamRes.body.creator_email).toBe('alice@example.com');
      const members = teamRes.body.members as { email: string; role: string }[];
      expect(members).toHaveLength(1);
      expect(members[0]?.email).toBe('alice@example.com');
      expect(members[0]?.role).toBe('creator');

      // Second createTeam returns 409 — DB already has a team.
      await expect(alice.client.createTeam(cloud.url, reg.raw_token, 'Beta')).rejects.toMatchObject(
        { status: 409 },
      );
    } finally {
      alice.db.close();
    }
  });

  it('POST /api/team/invitations is a singleton convenience alias', async () => {
    const cloud = await startCloud();
    const alice = await openLocal();
    try {
      const reg = await alice.client.register(cloud.url, 'alice@example.com', 'Alice');
      await alice.client.createTeam(cloud.url, reg.raw_token, 'Atlas');

      const invRes = await api(`${cloud.url}/api/team/invitations`, reg.raw_token, {
        method: 'POST',
        body: JSON.stringify({ invitee_email: 'carol@example.com' }),
      });
      expect(invRes.status).toBe(201);
      expect(invRes.body.invitee_email).toBe('carol@example.com');
      expect(typeof invRes.body.raw_token).toBe('string');
    } finally {
      alice.db.close();
    }
  });

  it('DELETE /api/team drops the singleton; second create works after destroy', async () => {
    const cloud = await startCloud();
    const alice = await openLocal();
    try {
      const reg = await alice.client.register(cloud.url, 'alice@example.com', 'Alice');
      await alice.client.createTeam(cloud.url, reg.raw_token, 'Atlas');

      const delRes = await api(`${cloud.url}/api/team`, reg.raw_token, { method: 'DELETE' });
      expect(delRes.status).toBe(200);
      expect(delRes.body.ok).toBe(true);

      // /api/team now reports no team enabled.
      const get = await api(`${cloud.url}/api/team`, reg.raw_token);
      expect(get.body.enabled).toBe(false);

      // A fresh createTeam call works again because the singleton was dropped.
      const next = await alice.client.createTeam(cloud.url, reg.raw_token, 'Beta');
      expect(next.name).toBe('Beta');
    } finally {
      alice.db.close();
    }
  });

  it('register requires email — empty string returns 400', async () => {
    const cloud = await startCloud();
    const local = await openLocal();
    try {
      await expect(local.client.register(cloud.url, '', 'NoEmail')).rejects.toMatchObject({
        status: 400,
      });
    } finally {
      local.db.close();
    }
  });
});
