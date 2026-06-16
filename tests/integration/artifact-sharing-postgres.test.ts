/**
 * Regression — assistant-created markdown artifacts are ordinary `files` rows
 * and follow the SAME sharing rules as any file:
 *  - created in "private mode" ⇒ stamped private, NOT visible to a member;
 *  - created normally on a shared files table ⇒ visible to a member.
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { executeFunction, type DispatchCtx } from '../../src/gui/ai/dispatch.js';
import { FeedBus } from '../../src/gui/feed.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const pools: pg.Pool[] = [];
const dbs: Lattice[] = [];
const schemas: string[] = [];
const roles: string[] = [];

function schemaUrl(schema: string): string {
  return `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}
function memberPool(schema: string, role: string, password: string): pg.Pool {
  const u = new URL(PG_URL!);
  u.username = role;
  u.password = password;
  u.searchParams.set('options', `-c search_path=${schema}`);
  const p = new pg.Pool({ connectionString: u.toString(), max: 1 });
  pools.push(p);
  return p;
}

afterEach(async () => {
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      /* best-effort */
    }
  }
  for (const p of pools.splice(0)) await p.end();
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const s of schemas.splice(0)) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  await admin.end();
});

describe.skipIf(!PG_URL)('artifact sharing follows file visibility', () => {
  async function ownerCloud(schema: string): Promise<{ o: Lattice; ctx: DispatchCtx }> {
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const o = new Lattice(schemaUrl(schema), { encryptionKey: 'artifact-test-key' });
    dbs.push(o);
    registerNativeEntities(o);
    o.define('_lattice_gui_audit', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        ts: "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        table_name: 'TEXT NOT NULL',
        row_id: 'TEXT',
        operation: 'TEXT NOT NULL',
        before_json: 'TEXT',
        after_json: 'TEXT',
        undone: 'INTEGER NOT NULL DEFAULT 0',
      },
      render: () => '',
      outputFile: '.lattice-gui/audit.md',
    });
    await o.init();
    await secureCloud(o);
    const ctx: DispatchCtx = {
      db: o,
      feed: new FeedBus(),
      validTables: new Set(['files']),
      junctionTables: new Set(),
      softDeletable: new Set(['files']),
    };
    return { o, ctx };
  }

  it('shares a normal artifact with members but keeps a private-mode one owner-only', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `art_${tag}`;
    const member = `lm_art_${tag}`;
    schemas.push(schema);
    roles.push(member);
    const { o, ctx } = await ownerCloud(schema);

    // Owner shares the files table so a normal (non-private) artifact is visible.
    const ownerPool = new pg.Pool({ connectionString: schemaUrl(schema), max: 1 });
    pools.push(ownerPool);
    await ownerPool.query(`SELECT lattice_set_table_default_visibility('files', 'everyone')`);

    const shared = await executeFunction(ctx, 'create_artifact', {
      title: 'Shared',
      content: '# shared\n',
    });
    const priv = await executeFunction({ ...ctx, privateMode: true }, 'create_artifact', {
      title: 'Secret',
      content: '# secret\n',
    });
    expect(shared.ok).toBe(true);
    expect(priv.ok).toBe(true);
    const sharedId = (shared.result as { id: string }).id;
    const privId = (priv.result as { id: string }).id;

    const memberPw = generateMemberPassword();
    await provisionMemberRole(o, member, memberPw);
    const M = memberPool(schema, member, memberPw);

    const visible = (await M.query('SELECT id FROM files')).rows.map((r) => r.id as string);
    expect(visible).toContain(sharedId);
    expect(visible).not.toContain(privId);
    // Both exist for the owner.
    expect((await ownerPool.query('SELECT count(*)::int n FROM files')).rows[0].n).toBe(2);
  });
});
