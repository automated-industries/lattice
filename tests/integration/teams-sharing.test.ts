import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { Lattice } from '../../src/lattice.js';
import { TeamsClient } from '../../src/teams/client.js';
import {
  serializeSchema,
  parseColumnType,
  renderColumnType,
  diffSchemaForAdditive,
  TeamsSchemaConflictError,
  type SchemaSpec,
} from '../../src/teams/schema-spec.js';

/**
 * Phase 3 sharing integration: one cloud lattice + two locals.
 *
 * Sharer (Alice) registers + creates "Atlas" team + shares a `tasks`
 * table. Receiver (Bob) joins via invite + `syncSharedSchemas` and
 * gets the table auto-registered with the same shape. A schema-version
 * bump (Alice adds a column + re-shares) propagates additively to Bob
 * via ALTER TABLE. A PK mismatch on Bob's side raises a typed conflict.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-teams-share-'));
  dirs.push(dir);
  return dir;
}

function writeConfig(
  root: string,
  dbName: string,
  extraEntities = '',
): { configPath: string; outputDir: string } {
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
      extraEntities,
    ]
      .filter((l) => l !== '')
      .join('\n'),
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

async function openLocal(extraEntities = ''): Promise<{ db: Lattice; client: TeamsClient }> {
  const { configPath } = writeConfig(tempDir(), 'local', extraEntities);
  const db = new Lattice({ config: configPath });
  await db.init();
  const client = new TeamsClient(db);
  return { db, client };
}

describe('teams sharing — schema-spec helpers', () => {
  it('parseColumnType handles common Lattice declarations', () => {
    expect(parseColumnType('TEXT')).toEqual({ type: 'TEXT' });
    expect(parseColumnType('TEXT NOT NULL')).toEqual({ type: 'TEXT', notNull: true });
    expect(parseColumnType('TEXT PRIMARY KEY')).toEqual({ type: 'TEXT', pk: true });
    expect(parseColumnType('INTEGER NOT NULL')).toEqual({ type: 'INTEGER', notNull: true });
    expect(parseColumnType("TEXT DEFAULT 'open'")).toEqual({
      type: 'TEXT',
      default: "'open'",
    });
    expect(parseColumnType('VARCHAR(50) NOT NULL')).toEqual({ type: 'TEXT', notNull: true });
    expect(parseColumnType('BIGINT')).toEqual({ type: 'INTEGER' });
  });

  it('renderColumnType emits dialect-appropriate SQL', () => {
    expect(renderColumnType({ type: 'TEXT', notNull: true }, 'sqlite')).toBe('TEXT NOT NULL');
    expect(renderColumnType({ type: 'JSONB' }, 'sqlite')).toBe('TEXT');
    expect(renderColumnType({ type: 'JSONB' }, 'postgres')).toBe('JSONB');
    expect(renderColumnType({ type: 'BLOB' }, 'postgres')).toBe('BYTEA');
    expect(renderColumnType({ type: 'INTEGER', pk: true }, 'sqlite')).toBe('INTEGER PRIMARY KEY');
  });

  it('serializeSchema round-trips a Lattice TableDefinition', () => {
    const def = {
      columns: {
        id: 'TEXT PRIMARY KEY',
        title: 'TEXT NOT NULL',
        status: "TEXT DEFAULT 'open'",
        score: 'INTEGER',
      },
      render: () => '',
      outputFile: 'tasks.md',
    };
    const spec = serializeSchema(def, ['id']);
    expect(spec.primaryKey).toBe('id');
    expect(spec.columns.title).toEqual({ type: 'TEXT', notNull: true });
    expect(spec.columns.status).toEqual({ type: 'TEXT', default: "'open'" });
    expect(spec.columns.score).toEqual({ type: 'INTEGER' });
  });

  it('diffSchemaForAdditive reports cloud-only columns + PK conflicts', () => {
    const spec: SchemaSpec = {
      columns: {
        id: { type: 'TEXT', pk: true },
        title: { type: 'TEXT', notNull: true },
        score: { type: 'INTEGER' },
      },
      primaryKey: 'id',
      schemaVersion: 1,
    };
    const { addColumns } = diffSchemaForAdditive('tasks', spec, ['id', 'title'], ['id']);
    expect(addColumns).toEqual(['score']);

    expect(() => diffSchemaForAdditive('tasks', spec, ['id', 'title'], ['title'])).toThrow(
      TeamsSchemaConflictError,
    );
  });
});

describe('teams sharing — end-to-end propagation', () => {
  async function bootstrapAlice(cloud: GuiServerHandle): Promise<{
    alice: Awaited<ReturnType<typeof openLocal>>;
    aliceToken: string;
    teamId: string;
  }> {
    const alice = await openLocal(
      [
        '  tasks:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      title: { type: text, required: true }',
        '      status: { type: text }',
        '    outputFile: tasks.md',
      ].join('\n'),
    );
    const reg = await alice.client.register(cloud.url, 'alice@example.com', 'Alice');
    const team = await alice.client.createTeam(cloud.url, reg.raw_token, 'Atlas');
    await alice.client.saveConnection({
      team_id: team.id,
      team_name: team.name,
      cloud_url: cloud.url,
      my_user_id: reg.user.id,
      api_token: reg.raw_token,
    });
    return { alice, aliceToken: reg.raw_token, teamId: team.id };
  }

  async function inviteAndJoinBob(
    cloud: GuiServerHandle,
    aliceClient: TeamsClient,
    aliceToken: string,
    teamId: string,
  ): Promise<Awaited<ReturnType<typeof openLocal>>> {
    const invite = await aliceClient.invite(cloud.url, aliceToken, teamId);
    const bob = await openLocal(); // Bob's local doesn't declare `tasks` — relies on sync
    const join = await bob.client.redeemInvite(
      cloud.url,
      invite.raw_token,
      'bob@example.com',
      'Bob',
    );
    await bob.client.saveConnection({
      team_id: join.team.id,
      team_name: join.team.name,
      cloud_url: cloud.url,
      my_user_id: join.user.id,
      api_token: join.raw_token,
    });
    return bob;
  }

  it('shares + auto-registers a table on a receiver lattice', async () => {
    const cloud = await startCloud();
    const { alice, aliceToken, teamId } = await bootstrapAlice(cloud);
    const bob = await inviteAndJoinBob(cloud, alice.client, aliceToken, teamId);

    try {
      // Alice serializes the `tasks` definition + shares
      const tasksCols = alice.db.getRegisteredColumns('tasks');
      expect(tasksCols).not.toBeNull();
      const spec = serializeSchema(
        { columns: tasksCols!, render: () => '', outputFile: 'tasks.md' },
        alice.db.getPrimaryKey('tasks'),
      );
      const shareRes = await alice.client.shareObject(cloud.url, aliceToken, teamId, 'tasks', spec);
      expect(shareRes.schema_version).toBe(1);

      // Bob's lattice has no `tasks` yet — adapter returns empty cols.
      expect(await bob.db.introspectColumns('tasks')).toEqual([]);

      // Sync → Bob's lattice now has tasks with the same shape
      const bobConn = (await bob.client.listConnections())[0]!;
      const syncResult = await bob.client.syncSharedSchemas(bobConn);
      expect(syncResult.applied).toHaveLength(1);
      expect(syncResult.applied[0]?.table).toBe('tasks');
      expect(syncResult.conflicts).toHaveLength(0);

      const bobCols = await bob.db.introspectColumns('tasks');
      expect(bobCols.sort()).toEqual(['id', 'status', 'title']);

      // Bob can insert into tasks via the auto-registered schema
      const taskId = await bob.db.insert('tasks', { title: 'first', status: 'open' });
      const row = await bob.db.get('tasks', taskId);
      expect(row?.title).toBe('first');

      // Second sync is a no-op
      const secondSync = await bob.client.syncSharedSchemas(bobConn);
      expect(secondSync.applied).toHaveLength(0);
    } finally {
      alice.db.close();
      bob.db.close();
    }
  });

  it('propagates additive schema changes via ALTER TABLE on the receiver', async () => {
    const cloud = await startCloud();
    const { alice, aliceToken, teamId } = await bootstrapAlice(cloud);
    const bob = await inviteAndJoinBob(cloud, alice.client, aliceToken, teamId);

    try {
      // Initial share with 3 columns
      const cols1 = alice.db.getRegisteredColumns('tasks')!;
      const spec1 = serializeSchema(
        { columns: cols1, render: () => '', outputFile: 'tasks.md' },
        alice.db.getPrimaryKey('tasks'),
      );
      await alice.client.shareObject(cloud.url, aliceToken, teamId, 'tasks', spec1);

      // Bob syncs — gets tasks with 3 cols
      const bobConn = (await bob.client.listConnections())[0]!;
      await bob.client.syncSharedSchemas(bobConn);
      expect((await bob.db.introspectColumns('tasks')).sort()).toEqual(['id', 'status', 'title']);

      // Alice re-shares with a new column added to the spec (simulating schema evolution)
      const spec2: SchemaSpec = {
        ...spec1,
        columns: {
          ...spec1.columns,
          assignee: { type: 'TEXT' },
          score: { type: 'INTEGER' },
        },
      };
      const res2 = await alice.client.shareObject(cloud.url, aliceToken, teamId, 'tasks', spec2);
      expect(res2.schema_version).toBe(2);

      // Bob syncs again — ALTER TABLE adds the new columns
      const syncResult = await bob.client.syncSharedSchemas(bobConn);
      expect(syncResult.applied[0]?.schema_version).toBe(2);
      expect((await bob.db.introspectColumns('tasks')).sort()).toEqual([
        'assignee',
        'id',
        'score',
        'status',
        'title',
      ]);

      // Bob can write to the new columns via Lattice
      const id = await bob.db.insert('tasks', {
        title: 'task with extras',
        assignee: 'bob',
        score: 5,
      });
      const row = (await bob.db.get('tasks', id)) as { assignee: string; score: number } | null;
      expect(row?.assignee).toBe('bob');
      expect(row?.score).toBe(5);
    } finally {
      alice.db.close();
      bob.db.close();
    }
  });

  it('surfaces a TeamsSchemaConflictError when the receiver has a different PK', async () => {
    const cloud = await startCloud();
    const { alice, aliceToken, teamId } = await bootstrapAlice(cloud);

    // Bob registers a `tasks` table with a DIFFERENT PK column locally.
    const bob = await openLocal(
      [
        '  tasks:',
        '    fields:',
        '      slug: { type: text, primaryKey: true }',
        '      title: { type: text, required: true }',
        '    outputFile: tasks.md',
      ].join('\n'),
    );
    // Bob joins via invite
    const invite = await alice.client.invite(cloud.url, aliceToken, teamId);
    const join = await bob.client.redeemInvite(
      cloud.url,
      invite.raw_token,
      'bob@example.com',
      'Bob',
    );
    await bob.client.saveConnection({
      team_id: join.team.id,
      team_name: join.team.name,
      cloud_url: cloud.url,
      my_user_id: join.user.id,
      api_token: join.raw_token,
    });

    try {
      // Alice shares her tasks (PK = id)
      const cols = alice.db.getRegisteredColumns('tasks')!;
      const spec = serializeSchema(
        { columns: cols, render: () => '', outputFile: 'tasks.md' },
        alice.db.getPrimaryKey('tasks'),
      );
      await alice.client.shareObject(cloud.url, aliceToken, teamId, 'tasks', spec);

      // Bob syncs — PK mismatch surfaces as a conflict (not a thrown error,
      // since syncSharedSchemas catches per-table and reports in result).
      const bobConn = (await bob.client.listConnections())[0]!;
      const result = await bob.client.syncSharedSchemas(bobConn);
      expect(result.applied).toHaveLength(0);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.table).toBe('tasks');
      expect(result.conflicts[0]?.reason).toMatch(/PK column mismatch|cloud PK|local/i);

      // Direct applyCloudSchemaLocally still throws the typed error
      await expect(bob.client.applyCloudSchemaLocally('tasks', spec)).rejects.toThrow(
        TeamsSchemaConflictError,
      );
    } finally {
      alice.db.close();
      bob.db.close();
    }
  });

  it('streams schema + unshare envelopes via /changes', async () => {
    const cloud = await startCloud();
    const { alice, aliceToken, teamId } = await bootstrapAlice(cloud);

    try {
      // Share tasks
      const cols = alice.db.getRegisteredColumns('tasks')!;
      const spec = serializeSchema(
        { columns: cols, render: () => '', outputFile: 'tasks.md' },
        alice.db.getPrimaryKey('tasks'),
      );
      await alice.client.shareObject(cloud.url, aliceToken, teamId, 'tasks', spec);

      // Pull changes — should see one 'schema' envelope
      const first = await alice.client.fetchChangeBatch(cloud.url, aliceToken, teamId, 0);
      expect(first.envelopes).toHaveLength(1);
      expect(first.envelopes[0]?.op).toBe('schema');
      expect(first.envelopes[0]?.table_name).toBe('tasks');
      const firstSeq = first.envelopes[0]!.seq;

      // Unshare
      await alice.client.unshareObject(cloud.url, aliceToken, teamId, 'tasks');

      // Pull since firstSeq — should see one 'unshare' envelope
      const second = await alice.client.fetchChangeBatch(cloud.url, aliceToken, teamId, firstSeq);
      expect(second.envelopes).toHaveLength(1);
      expect(second.envelopes[0]?.op).toBe('unshare');
      expect(second.envelopes[0]?.table_name).toBe('tasks');
      expect(second.envelopes[0]!.seq).toBeGreaterThan(firstSeq);

      // listSharedObjects no longer includes tasks
      const objects = await alice.client.listSharedObjects(cloud.url, aliceToken, teamId);
      expect(objects).toHaveLength(0);
    } finally {
      alice.db.close();
    }
  });

  it('non-members cannot share, list, or pull changes', async () => {
    const cloud = await startCloud();
    const { alice, teamId } = await bootstrapAlice(cloud);
    // An invalid bearer token gets rejected by the auth gate before any
    // membership check runs — confirms the team-only routes don't leak.
    const stranger = await openLocal();
    try {
      await expect(
        stranger.client.shareObject(cloud.url, 'lat_unknown', teamId, 'tasks', {
          columns: { id: { type: 'TEXT', pk: true } },
          primaryKey: 'id',
          schemaVersion: 1,
        }),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        stranger.client.listSharedObjects(cloud.url, 'lat_unknown', teamId),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        stranger.client.fetchChangeBatch(cloud.url, 'lat_unknown', teamId, 0),
      ).rejects.toMatchObject({ status: 401 });
    } finally {
      alice.db.close();
      stranger.db.close();
    }
  });
});
