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
import { upgradeLegacyData } from '../../src/framework/data-upgrade.js';
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
      validTables: new Set(['files', 'dashboards']),
      junctionTables: new Set(),
      softDeletable: new Set(['files', 'dashboards']),
      htmlAuthor: (spec: string) =>
        Promise.resolve(`<!doctype html><html><body>${spec}</body></html>`),
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

  it('dashboards follow the same per-row visibility as any record', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `dsh_${tag}`;
    const member = `lm_dsh_${tag}`;
    schemas.push(schema);
    roles.push(member);
    const { o, ctx } = await ownerCloud(schema);

    const ownerPool = new pg.Pool({ connectionString: schemaUrl(schema), max: 1 });
    pools.push(ownerPool);
    await ownerPool.query(`SELECT lattice_set_table_default_visibility('dashboards', 'everyone')`);

    const shared = await executeFunction(ctx, 'create_dashboard', {
      title: 'Team View',
      spec: 'a shared dashboard',
    });
    const priv = await executeFunction({ ...ctx, privateMode: true }, 'create_dashboard', {
      title: 'My View',
      spec: 'a private dashboard',
    });
    expect(shared.ok).toBe(true);
    expect(priv.ok).toBe(true);
    const sharedId = (shared.result as { id: string }).id;
    const privId = (priv.result as { id: string }).id;

    const memberPw = generateMemberPassword();
    await provisionMemberRole(o, member, memberPw);
    const M = memberPool(schema, member, memberPw);

    const visible = (await M.query('SELECT id FROM dashboards')).rows.map(
      (r) => r.id as string,
    );
    expect(visible).toContain(sharedId);
    expect(visible).not.toContain(privId);
  });

  it('migration preserves a member-owned private html artifact (no re-owning to the owner)', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `mig_${tag}`;
    const member = `lm_mig_${tag}`;
    schemas.push(schema);
    roles.push(member);
    const { o } = await ownerCloud(schema);

    const memberPw = generateMemberPassword();
    await provisionMemberRole(o, member, memberPw);

    const ownerPool = new pg.Pool({ connectionString: schemaUrl(schema), max: 1 });
    pools.push(ownerPool);
    // A legacy member-authored PRIVATE html artifact: insert the row, then
    // point its ownership bookkeeping at the member (the pre-5.0 state a
    // member's private-mode create_html_file produced).
    await ownerPool.query(
      `INSERT INTO files (id, original_name, mime, extracted_text, artifact_type)
       VALUES ('mine', 'Mine.html', 'text/html', '<html><body>mine</body></html>', 'html')`,
    );
    await ownerPool.query(
      `UPDATE __lattice_owners SET owner_role = $1, visibility = 'private'
        WHERE table_name = 'files' AND pk = 'mine'`,
      [member],
    );

    // The OWNER's next open runs the migration (BYPASSRLS — it sees the row).
    await upgradeLegacyData(o);

    // Moved: same id, files row hard-deleted.
    expect((await ownerPool.query(`SELECT count(*)::int n FROM files WHERE id = 'mine'`)).rows[0].n).toBe(0);
    expect((await ownerPool.query(`SELECT count(*)::int n FROM dashboards WHERE id = 'mine'`)).rows[0].n).toBe(1);
    // Ownership preserved — the dashboards ownership trigger's owner-stamp was
    // overwritten with the source row's member owner + private visibility.
    const own = (
      await ownerPool.query(
        `SELECT owner_role, visibility FROM __lattice_owners WHERE table_name = 'dashboards' AND pk = 'mine'`,
      )
    ).rows[0];
    expect(own.owner_role).toBe(member);
    expect(own.visibility).toBe('private');
    // No stale files-side bookkeeping.
    expect(
      (
        await ownerPool.query(
          `SELECT count(*)::int n FROM __lattice_owners WHERE table_name = 'files' AND pk = 'mine'`,
        )
      ).rows[0].n,
    ).toBe(0);
    // The member still sees their page; it stays private (visible to them, not everyone).
    const M = memberPool(schema, member, memberPw);
    const mine = (await M.query(`SELECT id FROM dashboards`)).rows.map((r) => r.id as string);
    expect(mine).toContain('mine');
  });
});
