/**
 * Per-user chat isolation on a team cloud (2.2.1).
 *
 * On a shared-Postgres team cloud, two members each run their own local
 * `lattice gui` against the same database. Before 2.2.1 the chat read routes
 * queried chat_threads / chat_messages with no per-user filter, so member B
 * could list and replay member A's assistant conversations. This suite boots
 * the GUI as member B against a cloud seeded with member A's chats and asserts
 * B sees only their own.
 *
 * Postgres-gated (team context only resolves on a postgres cloud). Runs in
 * CI's ubuntu+postgres job; skipped locally without LATTICE_TEST_PG_URL.
 *
 * The local single-user case (no team context → all chats visible) is covered
 * by gui-chat-threads.test.ts and the back-compat test at the bottom here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import {
  CLOUD_INTERNAL_TABLE_DEFS,
  installRowPermsSchema,
} from '../../src/teams/internal-tables.js';
import { NATIVE_ENTITY_DEFS } from '../../src/framework/native-entities.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const runId = randomBytes(4).toString('hex');
const SCHEMA = `chat_iso_${runId}`;
const TEAM = `team-${runId}`;
const ALICE = 'user-alice';
const BOB = 'user-bob';
const ALICE_EMAIL = `alice-${runId}@example.com`;
const BOB_EMAIL = `bob-${runId}@example.com`;

const schemaUrl = PG_URL
  ? `${PG_URL}${PG_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`
  : '';

const dirs: string[] = [];
let aliceServer: GuiServerHandle | null = null;
let bobServer: GuiServerHandle | null = null;
let admin: pg.Pool | null = null;
let savedConfigDir: string | undefined;

function bootDir(who: string, email: string): string {
  const cfgDir = mkdtempSync(join(tmpdir(), `chat-iso-cfg-${who}-${runId}-`));
  dirs.push(cfgDir);
  writeFileSync(join(cfgDir, 'identity.json'), JSON.stringify({ display_name: who, email }));
  const root = mkdtempSync(join(tmpdir(), `chat-iso-${who}-${runId}-`));
  dirs.push(root);
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      `db: ${schemaUrl}`,
      '',
      'entities:',
      '  notes:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      body: { type: text }',
      '    render: default-list',
      '    outputFile: notes.md',
    ].join('\n'),
  );
  mkdirSync(join(root, 'context'), { recursive: true });
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  return configPath;
}

describe.skipIf(!PG_URL)('chat isolation on a team cloud (Postgres)', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);

    // Seed the cloud: identity, members, and one chat thread per member.
    const db = new Lattice(schemaUrl);
    await db.init();
    for (const [t, def] of Object.entries(CLOUD_INTERNAL_TABLE_DEFS)) await db.defineLate(t, def);
    await installRowPermsSchema(db);
    // The native chat tables (with the 2.2.1 owner_user_id column) — defineLate
    // so the seeding connection can write them.
    await db.defineLate('chat_threads', NATIVE_ENTITY_DEFS.chat_threads);
    await db.defineLate('chat_messages', NATIVE_ENTITY_DEFS.chat_messages);

    const now = new Date().toISOString();
    for (const [id, email, name] of [
      [ALICE, ALICE_EMAIL, 'Alice'],
      [BOB, BOB_EMAIL, 'Bob'],
    ]) {
      await db.upsert('__lattice_users', { id, email, name, created_at: now, updated_at: now });
      await db.upsert('__lattice_team_members', {
        team_id: TEAM,
        user_id: id,
        role: id === ALICE ? 'creator' : 'member',
        joined_at: now,
      });
    }
    await db.upsert('__lattice_team_identity', {
      id: 'singleton',
      team_id: TEAM,
      team_name: 'chat-iso',
      creator_email: ALICE_EMAIL,
      created_at: now,
    });
    // Alice's private conversation.
    await db.insert('chat_threads', {
      id: 'thread-alice',
      title: 'Alice secret plan',
      owner_user_id: ALICE,
    });
    await db.insert('chat_messages', {
      thread_id: 'thread-alice',
      owner_user_id: ALICE,
      role: 'user',
      content_json: JSON.stringify({ text: 'alice-only message' }),
      source: 'gui',
    });
    // Bob's own conversation.
    await db.insert('chat_threads', { id: 'thread-bob', title: 'Bob notes', owner_user_id: BOB });
    db.close();

    savedConfigDir = process.env.LATTICE_CONFIG_DIR;
    const aCfg = bootDir('alice', ALICE_EMAIL);
    aliceServer = await startGuiServer({
      configPath: aCfg,
      outputDir: join(aCfg, '..', 'context'),
      port: 0,
      openBrowser: false,
    });
    const bCfg = bootDir('bob', BOB_EMAIL);
    bobServer = await startGuiServer({
      configPath: bCfg,
      outputDir: join(bCfg, '..', 'context'),
      port: 0,
      openBrowser: false,
    });
  }, 60_000);

  afterAll(async () => {
    if (aliceServer) await aliceServer.close();
    if (bobServer) await bobServer.close();
    if (savedConfigDir === undefined) delete process.env.LATTICE_CONFIG_DIR;
    else process.env.LATTICE_CONFIG_DIR = savedConfigDir;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await admin.end();
    }
  }, 30_000);

  it('the thread list returns only the operator’s own threads', async () => {
    const bob = (await fetch(`${bobServer!.url}/api/chat/threads`).then((r) => r.json())) as {
      threads: { id: string }[];
    };
    const bobIds = bob.threads.map((t) => t.id);
    expect(bobIds).toContain('thread-bob');
    expect(bobIds).not.toContain('thread-alice'); // the leak

    const alice = (await fetch(`${aliceServer!.url}/api/chat/threads`).then((r) => r.json())) as {
      threads: { id: string }[];
    };
    const aliceIds = alice.threads.map((t) => t.id);
    expect(aliceIds).toContain('thread-alice');
    expect(aliceIds).not.toContain('thread-bob');
  });

  it('a member cannot replay another member’s thread by id', async () => {
    // Bob requests Alice's thread directly — must come back empty (denied
    // reads are indistinguishable from missing).
    const denied = (await fetch(`${bobServer!.url}/api/chat/threads/thread-alice/messages`).then(
      (r) => r.json(),
    )) as { messages: { text: string }[] };
    expect(denied.messages).toEqual([]);

    // Alice can replay her own.
    const own = (await fetch(`${aliceServer!.url}/api/chat/threads/thread-alice/messages`).then(
      (r) => r.json(),
    )) as { messages: { text: string }[] };
    expect(own.messages.map((m) => m.text)).toContain('alice-only message');
  });
});

describe('chat (local single-user DB) — back-compat', () => {
  const localDirs: string[] = [];
  const localServers: GuiServerHandle[] = [];
  afterAll(async () => {
    for (const s of localServers.splice(0)) await s.close();
    for (const d of localDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('NULL-owner threads stay visible when there is no team context', async () => {
    const root = mkdtempSync(join(tmpdir(), `chat-local-${runId}-`));
    localDirs.push(root);
    const configPath = join(root, 'lattice.config.yml');
    writeFileSync(
      configPath,
      [
        'db: ./data/test.db',
        '',
        'entities:',
        '  notes:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      body: { type: text }',
        '    render: default-list',
        '    outputFile: notes.md',
      ].join('\n'),
    );
    const server = await startGuiServer({
      configPath,
      outputDir: join(root, 'context'),
      port: 0,
      openBrowser: false,
    });
    localServers.push(server);
    // Insert a thread with no owner (the local / pre-2.2.1 shape).
    await fetch(`${server.url}/api/tables/chat_threads/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'local-1', title: 'Local chat' }),
    });
    const list = (await fetch(`${server.url}/api/chat/threads`).then((r) => r.json())) as {
      threads: { id: string }[];
    };
    expect(list.threads.map((t) => t.id)).toContain('local-1');
  });
});
