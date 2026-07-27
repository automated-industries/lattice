/**
 * Migrating a LOCAL workspace to a cloud must carry its chat history across in a
 * READABLE state.
 *
 * A local workspace is single-user and has no identity to stamp, so every thread
 * and message it writes has `owner_user_id = NULL`. On a cloud the read path
 * requires that column: the app filters `owner_user_id = session_user`, and a
 * RESTRICTIVE, fail-closed RLS policy treats a NULL owner as owned by NO ONE.
 * Copied verbatim, the history would land present-but-permanently-invisible —
 * the rows exist, and nobody, including their author, can ever read them.
 *
 * So the migration claims ownerless chat rows for the migrating owner on the way
 * in. It only ever fills a NULL: a row that already names an author keeps it, so
 * this can never reassign one person's conversations to another.
 *
 * The claim has TWO halves and both are pinned here. Making the history readable
 * again is only correct if it stays readable to EXACTLY ONE person: widening a
 * NULL owner into something every member matches would equally "fix" the missing
 * history while publishing every private conversation to the whole team. So the
 * last test reads the migrated cloud as a DIFFERENT member, through that member's
 * own scoped login role — never the owner connection, which is BYPASSRLS and
 * therefore proves nothing about what a teammate can see.
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL (the stamp is a no-op off
 * Postgres, where there is no session_user and no per-user chat scoping).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { getAsyncOrSync } from '../../src/db/adapter.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import {
  migrateLatticeData,
  openTargetLatticeForMigration,
} from '../../src/framework/cloud-migration.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const ENC_KEY = 'chat-owner-migration-key';

const dirs: string[] = [];
const opened: Lattice[] = [];
const databases: string[] = [];
const roles: string[] = [];

function urlForDb(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user !== undefined) u.username = user;
  if (password !== undefined) u.password = password;
  return u.toString();
}

async function freshTargetDb(): Promise<string> {
  const dbname = `lattice_chat_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbname}"`);
  await admin.end();
  databases.push(dbname);
  return dbname;
}

/** A local (SQLite) workspace with the native tables registered. */
async function openLocalSource(): Promise<Lattice> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-chatmig-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(configPath, ['db: ./data/source.db', '', 'entities: {}'].join('\n'));
  const db = new Lattice({ config: configPath }, { encryptionKey: ENC_KEY });
  registerNativeEntities(db);
  await db.init();
  opened.push(db);
  return db;
}

afterEach(async () => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      /* best-effort */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const dbname of databases.splice(0)) {
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbname}" WITH (FORCE)`);
    await admin.end();
  }
  // Login roles are cluster-wide, so they outlive the per-test database and must
  // be cleaned up explicitly. Dropped AFTER the database so the grants that
  // depended on it are already gone and DROP ROLE has nothing blocking it.
  for (const role of roles.splice(0)) {
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    await admin.end();
  }
});

describe.skipIf(!PG_URL)('migrating chat history to a cloud', () => {
  it('claims ownerless local history for the migrating owner', async () => {
    const source = await openLocalSource();
    process.env.LATTICE_ENCRYPTION_KEY = ENC_KEY;

    // A local workspace stamps no owner — this is what the bug fed on.
    await source.insert('chat_threads', { id: 't1', title: 'Q3 numbers' });
    await source.insert('chat_messages', {
      id: 'm1',
      thread_id: 't1',
      role: 'user',
      content_json: JSON.stringify({ text: 'hello' }),
    });
    const localThread = (await source.get('chat_threads', 't1')) as Record<string, unknown>;
    expect(localThread.owner_user_id ?? null).toBeNull();

    const dbname = await freshTargetDb();
    const target = await openTargetLatticeForMigration(
      join(dirs[0]!, 'lattice.config.yml'),
      urlForDb(dbname),
      ENC_KEY,
    );
    opened.push(target);

    await migrateLatticeData(source, target);

    // The rows carry the target's identity, so the owner can actually read them.
    const owner = (
      (await getAsyncOrSync(target.adapter, 'SELECT session_user AS u')) as
        | { u: string }
        | undefined
    )?.u;
    expect(owner).toBeTruthy();

    const thread = (await target.get('chat_threads', 't1')) as Record<string, unknown>;
    expect(thread.owner_user_id).toBe(owner);
    const msg = (await target.get('chat_messages', 'm1')) as Record<string, unknown>;
    expect(msg.owner_user_id).toBe(owner);
    // The content itself survives unchanged.
    expect(thread.title).toBe('Q3 numbers');
    expect(msg.content_json).toBe(JSON.stringify({ text: 'hello' }));
  });

  it('never reassigns history that already names an author', async () => {
    const source = await openLocalSource();
    process.env.LATTICE_ENCRYPTION_KEY = ENC_KEY;

    // A row that already has an owner (e.g. re-migrating an already-scoped cloud)
    // must keep it — claiming is a fill, never an overwrite.
    await source.insert('chat_threads', {
      id: 't2',
      title: 'Someone else',
      owner_user_id: 'another_member',
    });

    const dbname = await freshTargetDb();
    const target = await openTargetLatticeForMigration(
      join(dirs[0]!, 'lattice.config.yml'),
      urlForDb(dbname),
      ENC_KEY,
    );
    opened.push(target);

    await migrateLatticeData(source, target);

    const thread = (await target.get('chat_threads', 't2')) as Record<string, unknown>;
    expect(thread.owner_user_id).toBe('another_member');
  });

  it('leaves migrated history unreadable to a different member of the same cloud', async () => {
    // The privacy half of the guarantee. Restoring readability is only correct if
    // it restores it to EXACTLY the migrating owner — a claim that stamped a
    // value every member matches, or one that skipped the per-author lock, would
    // make the history reappear for its author AND publish it to the whole team.
    // That regression is invisible to any assertion made on the owner's
    // connection, so this one is made through a real member login role.
    const source = await openLocalSource();
    process.env.LATTICE_ENCRYPTION_KEY = ENC_KEY;

    await source.insert('chat_threads', { id: 't-private', title: 'Compensation review' });
    await source.insert('chat_messages', {
      id: 'm-private',
      thread_id: 't-private',
      role: 'assistant',
      content_json: JSON.stringify({ text: 'CONFIDENTIAL assistant answer' }),
    });

    const dbname = await freshTargetDb();
    const target = await openTargetLatticeForMigration(
      join(dirs[0]!, 'lattice.config.yml'),
      urlForDb(dbname),
      ENC_KEY,
    );
    opened.push(target);

    await migrateLatticeData(source, target);
    // Mirror the real migrate-to-cloud flow: the migrating owner secures the cloud
    // immediately after the copy, which is what installs the fail-closed
    // per-author chat policy and mints the member group the invite grants against.
    await secureCloud(target);

    const owner = (
      (await getAsyncOrSync(target.adapter, 'SELECT session_user AS u')) as
        | { u: string }
        | undefined
    )?.u;
    expect(owner).toBeTruthy();

    // Positive control: the rows really did land, really are the owner's, and the
    // secure pass did not hide them from their author. Without this, "the member
    // sees nothing" could pass simply because the migration dropped the history.
    const migrated = (await target.get('chat_threads', 't-private')) as Record<string, unknown>;
    expect(migrated.owner_user_id).toBe(owner);
    expect(migrated.title).toBe('Compensation review');

    // A second person joins the cloud with their own scoped login role.
    const role = `lm_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const password = generateMemberPassword();
    await provisionMemberRole(target, role, password);
    const memberUrl = urlForDb(dbname, role, password);

    const member = new pg.Pool({ connectionString: memberUrl, max: 1 });
    try {
      // Sanity: this connection really is a different identity from the owner's,
      // otherwise the invisibility below would be meaningless.
      const who = await member.query<{ u: string }>('SELECT session_user AS u');
      expect(who.rows[0]?.u).toBe(role);
      expect(who.rows[0]?.u).not.toBe(owner);

      // A chat of the member's own, written through their own connection. This is
      // the control that makes every "sees nothing" assertion below load-bearing:
      // the same connection, the same table and the same query DO return a row the
      // member is entitled to, so an empty result for the migrated rows is the
      // ownership check biting — not a missing grant, an unreachable table, or a
      // migration that quietly dropped the history.
      await member.query(
        `INSERT INTO "chat_threads" ("id","title","owner_user_id") VALUES ('t-mine','My own chat',session_user)`,
      );
      await member.query(
        `INSERT INTO "chat_messages" ("id","thread_id","role","content_json","owner_user_id")
         VALUES ('m-mine','t-mine','assistant','{"text":"my own answer"}',session_user)`,
      );

      // Unqualified reads return the member's own chat and nothing else.
      const threads = await member.query<{ id: string }>(
        'SELECT id FROM "chat_threads" ORDER BY id',
      );
      expect(threads.rows.map((r) => r.id)).toEqual(['t-mine']);
      const messages = await member.query<{ id: string }>(
        'SELECT id FROM "chat_messages" ORDER BY id',
      );
      expect(messages.rows.map((r) => r.id)).toEqual(['m-mine']);

      // Naming the migrated rows directly reveals nothing either — neither the
      // title nor the assistant's answer, which is the payload that has to stay
      // secret even from someone who already knows the id.
      const byId = await member.query<{ title: string }>(
        `SELECT title FROM "chat_threads" WHERE id = 't-private'`,
      );
      expect(byId.rows).toEqual([]);
      const body = await member.query<{ content_json: string }>(
        `SELECT content_json FROM "chat_messages" WHERE id = 'm-private'`,
      );
      expect(body.rows).toEqual([]);

      // Nor does an aggregate leak the existence of the migrated conversation.
      const counted = await member.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "chat_messages"`,
      );
      expect(counted.rows[0]?.n).toBe(1);
    } finally {
      await member.end();
    }

    // And the owner still reads their own migrated history — the isolation above
    // is not the whole cloud being locked down, it is scoped to the other member.
    const stillOwned = (await target.get('chat_messages', 'm-private')) as Record<string, unknown>;
    expect(stillOwned.content_json).toBe(JSON.stringify({ text: 'CONFIDENTIAL assistant answer' }));
  });
});
