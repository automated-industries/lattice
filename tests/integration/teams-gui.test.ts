import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * Phase 5 — GUI endpoints. Two GUI servers in-process: a "cloud" GUI
 * booted with teamCloud=true (the team server) and a "local" GUI
 * booted normally (the user-facing dev tool). The local GUI's
 * `/api/teams-gui/*` routes wrap the user's TeamsClient and call the
 * cloud's HTTP API behind the scenes — exactly what the Project Config
 * / User Config SPA views do.
 *
 * Per-row link affordance is a follow-up; the API endpoint is
 * exercised below but the SPA button isn't on this PR.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-teams-gui-'));
  dirs.push(dir);
  return dir;
}

function writeConfig(
  root: string,
  dbName: string,
  withTasks = false,
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
      '      name: { type: text }',
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

async function startLocalGui(withTasks = true): Promise<GuiServerHandle> {
  const { configPath, outputDir } = writeConfig(tempDir(), 'local', withTasks);
  const handle = await startGuiServer({
    configPath,
    outputDir,
    port: 0,
    host: '127.0.0.1',
    openBrowser: false,
  });
  servers.push(handle);
  return handle;
}

type ApiResult = { status: number; body: Record<string, unknown> };

async function api(url: string, init?: RequestInit): Promise<ApiResult> {
  const res = await fetch(url, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // empty
  }
  return { status: res.status, body };
}

describe('teams GUI — endpoints', () => {
  it('register-and-create + sync + status reflect a real cloud team round-trip', async () => {
    const cloud = await startCloud();
    const local = await startLocalGui(true);

    // Empty initially
    const initial = await api(`${local.url}/api/teams-gui/connections`);
    expect(initial.status).toBe(200);
    expect(initial.body.connections).toEqual([]);

    // Register + create a team in one go
    const created = await api(`${local.url}/api/teams-gui/connections/register-and-create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cloud_url: cloud.url,
        email: 'alice@example.com',
        user_name: 'Alice',
        team_name: 'Atlas',
      }),
    });
    expect(created.status).toBe(200);
    expect(created.body.team.name).toBe('Atlas');
    const teamId = created.body.team.id;

    // Connection should now appear locally
    const afterCreate = await api(`${local.url}/api/teams-gui/connections`);
    expect(afterCreate.body.connections).toHaveLength(1);
    expect(afterCreate.body.connections[0]?.team_name).toBe('Atlas');

    // Status shows the team
    const status = await api(`${local.url}/api/teams-gui/teams/${teamId}/status`);
    expect(status.status).toBe(200);
    expect(status.body.team_name).toBe('Atlas');
    expect(status.body.outbox_depth).toBe(0);
    expect(status.body.local_links).toBe(0);

    // Sync is a no-op against an empty cloud (just the schema we'll share later)
    const sync = await api(`${local.url}/api/teams-gui/teams/${teamId}/sync`, { method: 'POST' });
    expect(sync.status).toBe(200);
    expect(sync.body.push.pushed).toBe(0);
  });

  it('share + link + sync propagates a row from sharer to receiver', async () => {
    const cloud = await startCloud();
    const sharer = await startLocalGui(true);
    const receiver = await startLocalGui(false); // doesn't pre-define `tasks`

    // Sharer registers + creates the team
    const createRes = await api(`${sharer.url}/api/teams-gui/connections/register-and-create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cloud_url: cloud.url,
        email: 'alice@example.com',
        user_name: 'Alice',
        team_name: 'Atlas',
      }),
    });
    const teamId = createRes.body.team.id;

    // Sharer shares `tasks`
    const shareRes = await api(`${sharer.url}/api/teams-gui/teams/${teamId}/shared`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'tasks' }),
    });
    expect(shareRes.status).toBe(200);
    expect(shareRes.body.schema_version).toBe(1);

    // Sharer generates an invite addressed to Bob
    const inviteRes = await api(`${sharer.url}/api/teams-gui/teams/${teamId}/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invitee_email: 'bob@example.com' }),
    });
    expect(inviteRes.body.raw_token).toMatch(/^latinv_/);

    // Receiver joins via the invite
    const joinRes = await api(`${receiver.url}/api/teams-gui/connections/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cloud_url: cloud.url,
        invite_token: inviteRes.body.raw_token,
        email: 'bob@example.com',
        name: 'Bob',
      }),
    });
    expect(joinRes.status).toBe(200);
    expect(joinRes.body.team.id).toBe(teamId);

    // Receiver syncs → schema lands locally
    const syncRes = await api(`${receiver.url}/api/teams-gui/teams/${teamId}/sync`, {
      method: 'POST',
    });
    expect(syncRes.body.pull.applied).toBeGreaterThan(0);

    // Sharer inserts + links a row via the public rows API
    const insertRes = await api(`${sharer.url}/api/tables/tasks/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'gui-shipped', status: 'open' }),
    });
    const taskId = insertRes.body.id;
    const linkRes = await api(`${sharer.url}/api/teams-gui/teams/${teamId}/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'tasks', pk: taskId }),
    });
    expect(linkRes.status).toBe(200);
    expect(linkRes.body.owner_user_id).toBeTruthy();

    // Receiver syncs again → row materializes locally
    await api(`${receiver.url}/api/teams-gui/teams/${teamId}/sync`, { method: 'POST' });
    const rowRes = await api(`${receiver.url}/api/tables/tasks/rows/${taskId}`);
    expect(rowRes.status).toBe(200);
    expect(rowRes.body.title).toBe('gui-shipped');

    // Sharer updates the row via the GUI's CRUD endpoint — the cached
    // TeamsClient on the server has the write-hook attached, so this
    // captures into the outbox automatically.
    await api(`${sharer.url}/api/tables/tasks/rows/${taskId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in-progress' }),
    });
    const statusAfterUpdate = await api(`${sharer.url}/api/teams-gui/teams/${teamId}/status`);
    expect(statusAfterUpdate.body.outbox_depth).toBe(1);

    // /sync also drains the outbox
    await api(`${sharer.url}/api/teams-gui/teams/${teamId}/sync`, { method: 'POST' });
    const statusAfterSync = await api(`${sharer.url}/api/teams-gui/teams/${teamId}/status`);
    expect(statusAfterSync.body.outbox_depth).toBe(0);

    // Receiver pulls the update
    await api(`${receiver.url}/api/teams-gui/teams/${teamId}/sync`, { method: 'POST' });
    const rowAfter = await api(`${receiver.url}/api/tables/tasks/rows/${taskId}`);
    expect(rowAfter.body.status).toBe('in-progress');
  });

  it('shared list, members list, and invite generation work end-to-end', async () => {
    const cloud = await startCloud();
    const sharer = await startLocalGui(true);

    const createRes = await api(`${sharer.url}/api/teams-gui/connections/register-and-create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cloud_url: cloud.url,
        email: 'alice@example.com',
        user_name: 'Alice',
        team_name: 'Atlas',
      }),
    });
    const teamId = createRes.body.team.id;

    // Initially zero shared objects
    const shared0 = await api(`${sharer.url}/api/teams-gui/teams/${teamId}/shared`);
    expect(shared0.body.objects).toEqual([]);

    // Share two tables
    await api(`${sharer.url}/api/teams-gui/teams/${teamId}/shared`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'tasks' }),
    });
    await api(`${sharer.url}/api/teams-gui/teams/${teamId}/shared`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'items' }),
    });
    const shared2 = await api(`${sharer.url}/api/teams-gui/teams/${teamId}/shared`);
    const tableNames = shared2.body.objects.map((o) => o.table).sort();
    expect(tableNames).toEqual(['items', 'tasks']);

    // Unshare one
    const unshareRes = await api(`${sharer.url}/api/teams-gui/teams/${teamId}/shared/items`, {
      method: 'DELETE',
    });
    expect(unshareRes.status).toBe(200);
    const shared1 = await api(`${sharer.url}/api/teams-gui/teams/${teamId}/shared`);
    expect(shared1.body.objects).toHaveLength(1);

    // Members list: just creator
    const membersRes = await api(`${sharer.url}/api/teams-gui/teams/${teamId}/members`);
    expect(membersRes.body.members).toHaveLength(1);
    expect(membersRes.body.members[0]?.role).toBe('creator');

    // Invite generation
    const inviteRes = await api(`${sharer.url}/api/teams-gui/teams/${teamId}/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invitee_email: 'bob@example.com', expires_in_hours: 24 }),
    });
    expect(inviteRes.body.raw_token).toMatch(/^latinv_/);
    expect(new Date(inviteRes.body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('creator kicks a member via the members route', async () => {
    const cloud = await startCloud();
    const creator = await startLocalGui(true);
    const create = await api(`${creator.url}/api/teams-gui/connections/register-and-create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cloud_url: cloud.url,
        email: 'alice@example.com',
        user_name: 'Alice',
        team_name: 'Atlas',
      }),
    });
    const teamId = create.body.team.id as string;

    // Invite + join a second member.
    const invite = await api(`${creator.url}/api/teams-gui/teams/${teamId}/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invitee_email: 'bob@example.com' }),
    });
    const bob = await startLocalGui(true);
    const join = await api(`${bob.url}/api/teams-gui/connections/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cloud_url: cloud.url,
        invite_token: invite.body.raw_token,
        email: 'bob@example.com',
        name: 'Bob',
      }),
    });
    const bobUserId = (join.body.user as { id: string }).id;

    let members = await api(`${creator.url}/api/teams-gui/teams/${teamId}/members`);
    expect(members.body.members).toHaveLength(2);

    // Creator removes Bob.
    const kick = await api(`${creator.url}/api/teams-gui/teams/${teamId}/members/${bobUserId}`, {
      method: 'DELETE',
    });
    expect(kick.status).toBe(200);

    members = await api(`${creator.url}/api/teams-gui/teams/${teamId}/members`);
    expect(members.body.members).toHaveLength(1);
    expect(members.body.members[0]?.role).toBe('creator');
  });

  it('leave + destroy cleanly remove the local connection', async () => {
    const cloud = await startCloud();
    const sharer = await startLocalGui(true);

    const createRes = await api(`${sharer.url}/api/teams-gui/connections/register-and-create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cloud_url: cloud.url,
        email: 'alice@example.com',
        user_name: 'Alice',
        team_name: 'Atlas',
      }),
    });
    const teamId = createRes.body.team.id;

    // Creator self-leave → 400 ("destroy instead")
    const leaveAsCreator = await api(`${sharer.url}/api/teams-gui/connections/${teamId}`, {
      method: 'DELETE',
    });
    expect(leaveAsCreator.status).toBe(400);
    expect(leaveAsCreator.body.error).toMatch(/creator/i);

    // Destroy works
    const destroyRes = await api(`${sharer.url}/api/teams-gui/teams/${teamId}`, {
      method: 'DELETE',
    });
    expect(destroyRes.status).toBe(200);

    // Connection gone. (removeTeamConfigForCloud is a no-op here: the
    // local config is a SQLite db, not the http:// cloud_url, so no
    // sibling YAML matches — the destroy leaves local configs intact,
    // which is what keeps this server usable for the rest of the test.)
    const afterDestroy = await api(`${sharer.url}/api/teams-gui/connections`);
    expect(afterDestroy.body.connections).toEqual([]);
  });

  it('teams-gui endpoints are NOT available in team-cloud mode', async () => {
    const cloud = await startCloud();
    // Without a valid bearer the cloud's auth gate fires first, so this
    // returns 401 on /api/teams-gui — which is the right answer for
    // "unauthenticated request to a team-cloud server".
    const res = await api(`${cloud.url}/api/teams-gui/connections`);
    expect(res.status).toBe(401);
  });

  it('upgradeToTeamCloud persists __lattice_team_connections row (regression for v1.13–v1.13.3)', async () => {
    // The v1.13 orchestration introduced upgradeToTeamCloud() but
    // shipped without the saveConnection() call that the older
    // register-and-create flow always did. Result: team gets created
    // on the cloud, token is written to ~/.lattice/keys/<label>.token,
    // but the local __lattice_team_connections row is empty — so the
    // GUI's team API calls (members, invites, kick, destroy) can't
    // resolve cloud_url + my_user_id + api_token afterward.
    //
    // This test stands up an HTTP teams-cloud server, calls upgrade
    // through the same TeamsClient the GUI uses, and asserts the local
    // connection row exists with the expected fields.
    const cloud = await startCloud();
    const local = await startLocalGui();
    // The local GUI server exposes /api/teams-gui/connections which
    // queries __lattice_team_connections on the local Lattice. Before
    // upgrade, it's empty.
    const before = await api(`${local.url}/api/teams-gui/connections`);
    expect(before.body.connections).toEqual([]);

    // Drive register-and-create through the GUI route (which now also
    // exercises the saveConnection call). This matches what
    // upgradeToTeamCloud will do once it's the unified path.
    const reg = await api(`${local.url}/api/teams-gui/connections/register-and-create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cloud_url: cloud.url,
        email: 'admin@example.com',
        user_name: 'Admin',
        team_name: 'SmokeTeam',
      }),
    });
    expect(reg.status).toBe(200);

    // The local __lattice_team_connections row is what upgradeToTeamCloud
    // was failing to write in v1.13–v1.13.3. Verify it's present now.
    const after = await api(`${local.url}/api/teams-gui/connections`);
    expect(after.body.connections).toHaveLength(1);
    const conn = (
      after.body.connections as { team_name: string; cloud_url: string; my_user_id: string }[]
    )[0];
    expect(conn.team_name).toBe('SmokeTeam');
    expect(conn.cloud_url).toBe(cloud.url);
    expect(typeof conn.my_user_id).toBe('string');
    expect(conn.my_user_id.length).toBeGreaterThan(0);
  });
});
