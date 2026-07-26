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
import {
  migrateLatticeData,
  openTargetLatticeForMigration,
} from '../../src/framework/cloud-migration.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const ENC_KEY = 'chat-owner-migration-key';

const dirs: string[] = [];
const opened: Lattice[] = [];
const databases: string[] = [];

function urlForDb(dbname: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
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
});
