/**
 * SECURITY REGRESSION — chat is private to its author on a cloud.
 *
 * A teammate invited to a cloud could read EVERY other member's assistant chats.
 * Two compounding bugs:
 *   (A) the GUI chat reads removed app-layer owner filtering, "trusting Postgres
 *       RLS" — but the app connects as a BYPASSRLS role, so RLS never filters the
 *       owner's connection (owner saw all members' chats), and
 *   (B) new threads landed with owner_user_id = NULL (world-readable), because the
 *       create path stamped null.
 *
 * The invariant this test pins: a chat row created by user A is IMPOSSIBLE for
 * user B to read — at BOTH layers:
 *   1. Postgres RLS: a member-role connection SELECTs only its own chat rows; a
 *      NULL-owner row and another member's rows are invisible (RESTRICTIVE policy,
 *      fail-closed on NULL — enableChatPrivacyRls).
 *   2. App layer: the GUI chat endpoints filter by the connected user's identity
 *      and fail closed — so even the BYPASSRLS owner connection only ever returns
 *      its own chats.
 *
 * Postgres-gated (real per-test cloud database + a real member login role).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { runAsyncOrSync } from '../../src/db/adapter.js';
import { addWorkspace, resolveWorkspacePaths } from '../../src/framework/workspace.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const servers: GuiServerHandle[] = [];
const dirs: string[] = [];
const databases: string[] = [];
const roles: string[] = [];

function dbUrl(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

/** Define the two native chat tables (minimal shape) so secureCloud secures them. */
function defineChatTables(db: Lattice): void {
  db.define('chat_threads', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      title: 'TEXT',
      owner_user_id: 'TEXT',
      created_at: 'TEXT',
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: 'chat_threads.md',
  });
  db.define('chat_messages', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      thread_id: 'TEXT',
      owner_user_id: 'TEXT',
      role: 'TEXT',
      content_json: 'TEXT',
      created_at: 'TEXT',
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: 'chat_messages.md',
  });
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  for (const db of databases.splice(0)) {
    await admin
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db],
      )
      .catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${db}"`).catch(() => undefined);
  }
  await admin.end();
});

describe.skipIf(!PG_URL)('cloud chat isolation (security regression)', () => {
  it('a member can never read another user’s or a NULL-owner chat — RLS + app layer', async () => {
    // ── Owner secures a fresh cloud with the two chat tables.
    const dbname = `lattice_chat_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE DATABASE "${dbname}"`);
    await admin.end();

    const owner = new Lattice(dbUrl(dbname));
    defineChatTables(owner);
    await owner.init();
    await secureCloud(owner);

    // The owner's connection identity (what the app stamps + filters on).
    const ownerSU = (
      (await owner.adapter.getAsync?.('SELECT session_user AS u')) as { u: string } | undefined
    )?.u;
    expect(ownerSU).toBeTruthy();

    // Owner-owned thread + a NULL-owner thread (the orphaned/leaky shape), plus
    // the owner's ASSISTANT (AI) reply — the protection must cover AI responses
    // (chat_messages), not just the human-authored threads.
    await owner.insert('chat_threads', {
      id: 't-owner',
      title: 'Owner chat',
      owner_user_id: ownerSU,
    });
    await owner.insert('chat_messages', {
      id: 'm-owner-ai',
      thread_id: 't-owner',
      role: 'assistant',
      content_json: JSON.stringify({ text: 'SECRET ai answer for the owner' }),
      owner_user_id: ownerSU,
    });
    await runAsyncOrSync(
      owner.adapter,
      `INSERT INTO "chat_threads" ("id","title","owner_user_id") VALUES ('t-null','Orphan chat',NULL)`,
    );
    await runAsyncOrSync(
      owner.adapter,
      `INSERT INTO "chat_messages" ("id","thread_id","role","content_json","owner_user_id") VALUES ('m-null-ai','t-null','assistant','{"text":"orphan ai answer"}',NULL)`,
    );

    // ── Provision a real member login role.
    const role = `lm_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner, role, pw);
    owner.close();

    // ── The member inserts THEIR OWN thread through their own connection, so its
    //    ownership record (owner_role) + owner_user_id are both the member.
    const memberPool = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    await memberPool.query(
      `INSERT INTO "chat_threads" ("id","title","owner_user_id") VALUES ('t-member','Member chat',session_user)`,
    );
    await memberPool.query(
      `INSERT INTO "chat_messages" ("id","thread_id","role","content_json","owner_user_id") VALUES ('m-member-ai','t-member','assistant','{"text":"member ai answer"}',session_user)`,
    );

    // 1) RLS LAYER: the member-role connection sees ONLY its own thread + message.
    const seen = await memberPool.query<{ id: string }>(
      `SELECT id FROM "chat_threads" ORDER BY id`,
    );
    const seenIds = seen.rows.map((r) => r.id);
    expect(seenIds).toEqual(['t-member']);
    expect(seenIds).not.toContain('t-owner'); // another user's chat — invisible
    expect(seenIds).not.toContain('t-null'); // NULL owner — invisible (fail-closed)

    // AI responses (chat_messages) are isolated the same way — the member never
    // sees the owner's assistant reply nor the NULL-owner one.
    const msgs = await memberPool.query<{ id: string }>(
      `SELECT id FROM "chat_messages" ORDER BY id`,
    );
    const msgIds = msgs.rows.map((r) => r.id);
    expect(msgIds).toEqual(['m-member-ai']);
    expect(msgIds).not.toContain('m-owner-ai'); // owner's AI answer — invisible
    expect(msgIds).not.toContain('m-null-ai'); // NULL owner AI answer — invisible
    await memberPool.end();

    // 2) APP LAYER (member GUI): /api/chat/threads returns only the member's.
    const memberGui = await bootGui(dbname, role, pw);
    const memberList = (await (await fetch(`${memberGui.url}/api/chat/threads`)).json()) as {
      threads: { id: string }[];
    };
    expect(memberList.threads.map((t) => t.id)).toEqual(['t-member']);

    // Even guessing the owner's thread id, the member reads NONE of its messages
    // (AI responses included) — the message endpoint scopes by owner too.
    const stolen = (await (
      await fetch(`${memberGui.url}/api/chat/threads/t-owner/messages`)
    ).json()) as { messages: unknown[] };
    expect(stolen.messages).toEqual([]);

    // 3) APP LAYER under BYPASSRLS (owner GUI): the owner connects as a BYPASSRLS
    //    role, so RLS does not filter it — the app-layer owner filter must. The
    //    owner sees ONLY their own chat, never the member's or the NULL-owner one.
    const ownerGui = await bootGui(dbname);
    const ownerList = (await (await fetch(`${ownerGui.url}/api/chat/threads`)).json()) as {
      threads: { id: string }[];
    };
    expect(ownerList.threads.map((t) => t.id)).toEqual(['t-owner']);
    expect(ownerList.threads.map((t) => t.id)).not.toContain('t-member');
    expect(ownerList.threads.map((t) => t.id)).not.toContain('t-null');
  });
});

async function bootGui(dbname: string, user?: string, password?: string): Promise<GuiServerHandle> {
  const tmp = mkdtempSync(join(tmpdir(), `chat-iso-${randomBytes(3).toString('hex')}-`));
  dirs.push(tmp);
  const root = join(tmp, '.lattice');
  const ws = addWorkspace(root, {
    displayName: 'Chat Cloud',
    db: dbUrl(dbname, user, password),
    makeActive: true,
  });
  const paths = resolveWorkspacePaths(root, ws);
  mkdirSync(paths.contextDir, { recursive: true });
  const gui = await startGuiServer({
    configPath: paths.configPath,
    outputDir: paths.contextDir,
    port: 0,
    openBrowser: false,
  });
  servers.push(gui);
  return gui;
}
