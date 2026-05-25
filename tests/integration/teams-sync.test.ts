import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { Lattice } from '../../src/lattice.js';
import { TeamsClient } from '../../src/teams/client.js';
import { serializeSchema } from '../../src/teams/schema-spec.js';

/**
 * Phase 4 end-to-end sync: two locals + one cloud in-process.
 *
 * Alice (creator) shares `tasks` and links a row. Bob (member) syncs
 * the schema + pulls the link envelope + sees the row. Alice updates
 * the linked row; the write-hook drops to the outbox; drainOutbox
 * pushes; Bob pulls again and sees the update. Replay guard prevents
 * Bob's pull from re-pushing to the cloud. Non-owners can't push or
 * unlink. Kicking Alice auto-unlinks her rows everywhere.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-teams-sync-'));
  dirs.push(dir);
  return dir;
}

function writeConfig(
  root: string,
  dbName: string,
  withTasks = true,
): { configPath: string; outputDir: string } {
  const outputDir = join(root, 'context');
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  const tasksDef = withTasks
    ? [
        '  tasks:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      title: { type: text, required: true }',
        '      status: { type: text }',
        '      score: { type: integer }',
        '    outputFile: tasks.md',
      ]
    : [];
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
      ...tasksDef,
    ].join('\n'),
  );
  return { configPath, outputDir };
}

afterEach(async () => {
  for (const h of servers.splice(0)) await h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startCloud(): Promise<GuiServerHandle> {
  const { configPath, outputDir } = writeConfig(tempDir(), 'cloud', false);
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

async function openLocal(withTasks = true): Promise<{ db: Lattice; client: TeamsClient }> {
  const { configPath } = writeConfig(tempDir(), 'local', withTasks);
  const db = new Lattice({ config: configPath });
  await db.init();
  const client = new TeamsClient(db);
  return { db, client };
}

async function bootstrapTeamWithTasks(cloud: GuiServerHandle): Promise<{
  alice: Awaited<ReturnType<typeof openLocal>>;
  aliceToken: string;
  teamId: string;
  aliceUserId: string;
}> {
  const alice = await openLocal();
  const reg = await alice.client.register(cloud.url, 'alice@example.com', 'Alice');
  const team = await alice.client.createTeam(cloud.url, reg.raw_token, 'Atlas');
  await alice.client.saveConnection({
    team_id: team.id,
    team_name: team.name,
    cloud_url: cloud.url,
    my_user_id: reg.user.id,
    api_token: reg.raw_token,
  });
  // Share `tasks`
  const cols = alice.db.getRegisteredColumns('tasks');
  if (!cols) throw new Error('tasks not registered');
  const spec = serializeSchema(
    { columns: cols, render: () => '', outputFile: 'tasks.md' },
    alice.db.getPrimaryKey('tasks'),
  );
  await alice.client.shareObject(cloud.url, reg.raw_token, team.id, 'tasks', spec);
  return {
    alice,
    aliceToken: reg.raw_token,
    teamId: team.id,
    aliceUserId: reg.user.id,
  };
}

async function inviteAndJoinBob(
  cloud: GuiServerHandle,
  aliceClient: TeamsClient,
  aliceToken: string,
  teamId: string,
  bobWithTasks = false,
): Promise<{ bob: Awaited<ReturnType<typeof openLocal>>; bobUserId: string }> {
  const invite = await aliceClient.invite(cloud.url, aliceToken, teamId);
  const bob = await openLocal(bobWithTasks);
  const join = await bob.client.redeemInvite(cloud.url, invite.raw_token, 'bob@example.com', 'Bob');
  await bob.client.saveConnection({
    team_id: join.team.id,
    team_name: join.team.name,
    cloud_url: cloud.url,
    my_user_id: join.user.id,
    api_token: join.raw_token,
  });
  return { bob, bobUserId: join.user.id };
}

describe('teams sync — end-to-end', () => {
  it('links a row, pushes updates, and propagates to a receiver', async () => {
    const cloud = await startCloud();
    const { alice, aliceToken, teamId } = await bootstrapTeamWithTasks(cloud);
    const { bob } = await inviteAndJoinBob(cloud, alice.client, aliceToken, teamId);

    try {
      const aliceConn = (await alice.client.listConnections())[0]!;
      const bobConn = (await bob.client.listConnections())[0]!;

      // Bob pulls — picks up the schema envelope
      const bobInitialPull = await bob.client.pullChanges(bobConn);
      expect(bobInitialPull.applied).toBeGreaterThan(0);
      expect(await bob.db.introspectColumns('tasks')).toContain('title');

      // Alice inserts a row + links it
      const taskId = await alice.db.insert('tasks', {
        title: 'first task',
        status: 'open',
        score: 1,
      });
      const linkRes = await alice.client.linkRow(aliceConn, 'tasks', taskId);
      expect(linkRes.owner_user_id).toBeTruthy();

      // Bob pulls — receives link + upsert envelopes; row materializes
      const bobPull = await bob.client.pullChanges(bobConn);
      expect(bobPull.applied).toBeGreaterThanOrEqual(2); // link + upsert
      const bobRow = (await bob.db.get('tasks', taskId)) as {
        title: string;
        status: string;
      } | null;
      expect(bobRow?.title).toBe('first task');

      // Bob's local also has the link recorded so updates are tracked
      const bobLinks = (await bob.db.query('__lattice_local_links', {
        filters: [{ col: 'pk', op: 'eq', val: taskId }],
      })) as { owner_user_id: string }[];
      expect(bobLinks).toHaveLength(1);
      expect(bobLinks[0]?.owner_user_id).toBe(linkRes.owner_user_id);

      // Alice updates the row → write-hook drops to outbox → drain → cloud
      await alice.db.update('tasks', taskId, { status: 'in-progress', score: 7 });
      const aliceStatus = await alice.client.getStatus(aliceConn);
      expect(aliceStatus.outbox_depth).toBe(1);
      const drainRes = await alice.client.drainOutbox(aliceConn);
      expect(drainRes.pushed).toBe(1);
      expect(drainRes.failed).toBe(0);
      const aliceStatus2 = await alice.client.getStatus(aliceConn);
      expect(aliceStatus2.outbox_depth).toBe(0);

      // Bob pulls — sees the update
      await bob.client.pullChanges(bobConn);
      const bobRow2 = (await bob.db.get('tasks', taskId)) as {
        title: string;
        status: string;
        score: number;
      } | null;
      expect(bobRow2?.status).toBe('in-progress');
      expect(bobRow2?.score).toBe(7);
    } finally {
      alice.db.close();
      bob.db.close();
    }
  });

  it("Bob's pull does not re-push pulled changes (replay guard)", async () => {
    const cloud = await startCloud();
    const { alice, aliceToken, teamId } = await bootstrapTeamWithTasks(cloud);
    const { bob } = await inviteAndJoinBob(cloud, alice.client, aliceToken, teamId);

    try {
      const aliceConn = (await alice.client.listConnections())[0]!;
      const bobConn = (await bob.client.listConnections())[0]!;

      // Alice links a row
      const taskId = await alice.db.insert('tasks', { title: 'replay-test', status: 'open' });
      await alice.client.linkRow(aliceConn, 'tasks', taskId);

      // Bob pulls everything. During pull, _isReplaying = true so the
      // upsert + link envelopes do NOT add to Bob's outbox.
      await bob.client.pullChanges(bobConn);
      const bobStatus = await bob.client.getStatus(bobConn);
      expect(bobStatus.outbox_depth).toBe(0);
    } finally {
      alice.db.close();
      bob.db.close();
    }
  });

  it('non-owner cannot push updates or unlink', async () => {
    const cloud = await startCloud();
    const { alice, aliceToken, teamId } = await bootstrapTeamWithTasks(cloud);
    const { bob } = await inviteAndJoinBob(cloud, alice.client, aliceToken, teamId);

    try {
      const aliceConn = (await alice.client.listConnections())[0]!;
      const bobConn = (await bob.client.listConnections())[0]!;

      const taskId = await alice.db.insert('tasks', { title: 'ownership', status: 'open' });
      await alice.client.linkRow(aliceConn, 'tasks', taskId);
      await bob.client.pullChanges(bobConn);

      // Bob tries to unlink → 403 (not owner)
      await expect(bob.client.unlinkRow(bobConn, 'tasks', taskId)).rejects.toMatchObject({
        status: 403,
      });
      // Bob tries to push a row update directly via the raw HTTP API → 403
      const pushRes = await fetch(`${cloud.url}/api/teams/${teamId}/objects/tasks/rows`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bobConn.api_token}`,
        },
        body: JSON.stringify({ pk: taskId, payload: { id: taskId, title: 'hijacked' } }),
      });
      expect(pushRes.status).toBe(403);
    } finally {
      alice.db.close();
      bob.db.close();
    }
  });

  it("Bob's local writes to a row he doesn't own are not pushed to the cloud", async () => {
    const cloud = await startCloud();
    const { alice, aliceToken, teamId } = await bootstrapTeamWithTasks(cloud);
    const { bob } = await inviteAndJoinBob(cloud, alice.client, aliceToken, teamId);

    try {
      const aliceConn = (await alice.client.listConnections())[0]!;
      const bobConn = (await bob.client.listConnections())[0]!;

      const taskId = await alice.db.insert('tasks', { title: 'alice-owned', status: 'open' });
      await alice.client.linkRow(aliceConn, 'tasks', taskId);
      // Bob pulls to materialize the row + the link metadata
      await bob.client.pullChanges(bobConn);
      // Bob has to re-attach hooks since he's a fresh TeamsClient session
      await bob.client.attachWriteHooks();

      // Bob writes to the row locally — hook fires, but ownership check
      // filters it out (Bob's not the owner), so no outbox entry.
      await bob.db.update('tasks', taskId, { status: 'bob-tried' });
      const bobStatus = await bob.client.getStatus(bobConn);
      expect(bobStatus.outbox_depth).toBe(0);

      // On next pull, Alice's authoritative version overwrites Bob's local change.
      // (Alice hasn't changed it; the cloud still has status='open'.)
      await bob.client.pullChanges(bobConn);
      // No new envelopes since Alice hasn't pushed — Bob's local row stays
      // at 'bob-tried' until something invalidates it. Phase 5 will surface
      // ownership in the UI; Phase 4 just documents the divergence.
      const bobRow = (await bob.db.get('tasks', taskId)) as { status: string } | null;
      expect(bobRow?.status).toBe('bob-tried');
    } finally {
      alice.db.close();
      bob.db.close();
    }
  });

  it('unlinking propagates: cloud + sharer-local + receiver-local all drop the row', async () => {
    const cloud = await startCloud();
    const { alice, aliceToken, teamId } = await bootstrapTeamWithTasks(cloud);
    const { bob } = await inviteAndJoinBob(cloud, alice.client, aliceToken, teamId);

    try {
      const aliceConn = (await alice.client.listConnections())[0]!;
      const bobConn = (await bob.client.listConnections())[0]!;

      const taskId = await alice.db.insert('tasks', { title: 'unlink-me', status: 'open' });
      await alice.client.linkRow(aliceConn, 'tasks', taskId);
      await bob.client.pullChanges(bobConn);
      expect(await bob.db.get('tasks', taskId)).not.toBeNull();

      // Alice unlinks
      await alice.client.unlinkRow(aliceConn, 'tasks', taskId);

      // Bob pulls — sees the unlink envelope. Default behaviour: hard-
      // delete the row from local mirror.
      await bob.client.pullChanges(bobConn);
      expect(await bob.db.get('tasks', taskId)).toBeNull();
      const bobLinks = await bob.db.count('__lattice_local_links');
      expect(bobLinks).toBe(0);
    } finally {
      alice.db.close();
      bob.db.close();
    }
  });

  it('kicking a member auto-unlinks all their owned rows on every receiver', async () => {
    const cloud = await startCloud();
    const { alice, aliceToken, teamId } = await bootstrapTeamWithTasks(cloud);
    const { bob, bobUserId } = await inviteAndJoinBob(
      cloud,
      alice.client,
      aliceToken,
      teamId,
      true, // Bob's local needs the tasks table so he can link rows
    );

    try {
      const aliceConn = (await alice.client.listConnections())[0]!;
      const bobConn = (await bob.client.listConnections())[0]!;

      // Bob pulls the schema so his local has tasks
      await bob.client.pullChanges(bobConn);

      // Bob links two rows of his own
      const t1 = await bob.db.insert('tasks', { title: 'bob-1', status: 'open' });
      const t2 = await bob.db.insert('tasks', { title: 'bob-2', status: 'open' });
      await bob.client.linkRow(bobConn, 'tasks', t1);
      await bob.client.linkRow(bobConn, 'tasks', t2);

      // Alice pulls — sees Bob's rows
      await alice.client.pullChanges(aliceConn);
      expect(await alice.db.get('tasks', t1)).not.toBeNull();
      expect(await alice.db.get('tasks', t2)).not.toBeNull();

      // Alice kicks Bob
      const kickRes = await fetch(`${cloud.url}/api/teams/${teamId}/members/${bobUserId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${aliceConn.api_token}` },
      });
      const kickBody = (await kickRes.json()) as { ok: boolean; unlinked_rows: number };
      expect(kickRes.status).toBe(200);
      expect(kickBody.unlinked_rows).toBe(2);

      // Alice pulls — sees unlink envelopes, drops Bob's rows
      await alice.client.pullChanges(aliceConn);
      expect(await alice.db.get('tasks', t1)).toBeNull();
      expect(await alice.db.get('tasks', t2)).toBeNull();
    } finally {
      alice.db.close();
      bob.db.close();
    }
  });

  it('outbox pushes are dropped (deleted) on success and survive on failure', async () => {
    const cloud = await startCloud();
    const { alice, teamId } = await bootstrapTeamWithTasks(cloud);

    try {
      const aliceConn = (await alice.client.listConnections())[0]!;
      const taskId = await alice.db.insert('tasks', { title: 'drain', status: 'open' });
      await alice.client.linkRow(aliceConn, 'tasks', taskId);

      // Three sequential updates → three outbox entries
      await alice.db.update('tasks', taskId, { status: 'a' });
      await alice.db.update('tasks', taskId, { status: 'b' });
      await alice.db.update('tasks', taskId, { status: 'c' });
      const statusBefore = await alice.client.getStatus(aliceConn);
      expect(statusBefore.outbox_depth).toBe(3);

      const drainRes = await alice.client.drainOutbox(aliceConn);
      expect(drainRes.pushed).toBe(3);
      expect(drainRes.failed).toBe(0);
      const statusAfter = await alice.client.getStatus(aliceConn);
      expect(statusAfter.outbox_depth).toBe(0);

      // Track a failing push: tear the cloud down, then add an outbox entry
      // manually, then drain.
      await servers.splice(0)[0]?.close();
      await alice.db.update('tasks', taskId, { status: 'd' });
      const drainFail = await alice.client.drainOutbox(aliceConn);
      expect(drainFail.pushed).toBe(0);
      expect(drainFail.failed).toBe(1);
      const statusAfterFail = await alice.client.getStatus(aliceConn);
      expect(statusAfterFail.outbox_depth).toBe(1);
      expect(statusAfterFail.outbox_failing).toBe(1);

      // teamId is unused in the assertion paths but lint can be picky
      // about destructuring; reference it to satisfy strict mode.
      expect(teamId).toBeTruthy();
    } finally {
      alice.db.close();
    }
  });
});
