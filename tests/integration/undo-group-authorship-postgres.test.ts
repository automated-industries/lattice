/**
 * A group undo may be performed ONLY by the session that authored the group —
 * proven against a REAL scoped member login role, not just the app layer.
 *
 * On a shared cloud a member connects as a scoped Postgres role under row-level
 * security; the owner connects as the BYPASSRLS role. The GUI audit log's RLS
 * SELECT policy is `row_id IS NULL OR lattice_row_visible(table_name, row_id)`, so
 * a member can read (a) every entry for a row it can see, AND (b) EVERY link/unlink
 * entry, because those carry a NULL row_id. That is the exact hole this test pins:
 * a member can SEE another user's operation group — including its NULL-row_id
 * link/unlink entries — and, without an app-layer authorship check, could POST
 * `undo-group/<owner's group>` and flip the owner's entries to undone on its scoped
 * connection (RLS makes an invisible row a silent 0-row no-op, never an error).
 *
 * The fix is app-layer and fail-closed: `undoGroup` refuses a group whose entries
 * carry a session id other than the caller's. RLS is what makes the entries
 * READABLE; the session-id gate is what stops the reversal. Both properties are
 * asserted here AS THE MEMBER, against the database.
 *
 * Postgres-gated (LATTICE_TEST_PG_URL). The app-layer counterparts
 * (tests/unit/bulk-undo-group.test.ts, tests/unit/unlink-undo-restores-edges.test.ts)
 * cover the same gate on SQLite and the "author CAN undo" direction.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import { secureCloud, reconcileCloudMemberAccess } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { runAsyncOrSync, allAsyncOrSync } from '../../src/db/adapter.js';
import { undoGroup, type MutationCtx } from '../../src/gui/mutations.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const databases: string[] = [];
const roles: string[] = [];
const pools: pg.Pool[] = [];

function dbUrl(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

afterEach(async () => {
  for (const p of pools.splice(0)) await p.end().catch(() => undefined);
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

function defineAudit(db: Lattice): void {
  db.define('_lattice_gui_audit', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      ts: 'TEXT',
      table_name: 'TEXT NOT NULL',
      row_id: 'TEXT',
      operation: 'TEXT NOT NULL',
      before_json: 'TEXT',
      after_json: 'TEXT',
      undone: 'INTEGER NOT NULL DEFAULT 0',
      session_id: 'TEXT',
      source: 'TEXT',
      op_group: 'TEXT',
    },
    render: () => '',
    outputFile: '.lattice-gui/audit.md',
  });
}

interface Cloud {
  owner: Lattice;
  dbname: string;
  role: string;
  pw: string;
}

/**
 * A cloud with one shared ('everyone') note n1 and two owner-authored operation
 * groups, both stamped with the OWNER's session id:
 *  - `g-owner` — a single `update` entry on n1 (row_id set, member-visible via
 *    'everyone'), cleanly reversible so the owner positive-control undo works.
 *  - `g-nullhole` — a single `link` entry with a NULL row_id, member-visible
 *    because the audit RLS lets ANY member read NULL-row entries. This is the
 *    load-bearing hole the fix closes; only its visibility + refusal are asserted
 *    (a raw NULL-row link is not reversible against a non-junction table, which is
 *    beside the authorization point).
 */
async function ownerAuthoredGroup(): Promise<Cloud> {
  const dbname = `lattice_ug_${randomBytes(4).toString('hex')}`;
  databases.push(dbname);
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE DATABASE "${dbname}"`);
  await admin.end();

  const owner = new Lattice(dbUrl(dbname));
  owner.define('notes', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'notes.md',
  });
  defineAudit(owner);
  await owner.init();
  await owner.upsert('notes', { id: 'n1', body: 'edited-body' });

  // The owner's changes, recorded exactly as the mutation chokepoint would: an
  // `update` on n1 (its own reversible group) and a NULL-row `link` entry (its own
  // group, used only to prove the row_id-NULL visibility hole + refusal). Both
  // carry the owner's session id.
  await owner.insert('_lattice_gui_audit', {
    id: 'g-upd',
    ts: new Date().toISOString(),
    table_name: 'notes',
    row_id: 'n1',
    operation: 'update',
    before_json: JSON.stringify({ id: 'n1', body: 'original-body' }),
    after_json: JSON.stringify({ id: 'n1', body: 'edited-body' }),
    undone: 0,
    session_id: 'owner-session',
    source: 'gui',
    op_group: 'g-owner',
  });
  await owner.insert('_lattice_gui_audit', {
    id: 'g-link',
    ts: new Date().toISOString(),
    table_name: 'notes',
    row_id: null,
    operation: 'link',
    before_json: null,
    after_json: JSON.stringify({ id: 'e1', a: 'n1', b: 'x9' }),
    undone: 0,
    session_id: 'owner-session',
    source: 'gui',
    op_group: 'g-nullhole',
  });

  await secureCloud(owner);
  await runAsyncOrSync(owner.adapter, `SELECT lattice_set_row_visibility(?, ?, 'everyone')`, [
    'notes',
    'n1',
  ]);

  const role = `lug_${randomBytes(3).toString('hex')}`;
  roles.push(role);
  const pw = generateMemberPassword();
  await provisionMemberRole(owner, role, pw);
  await reconcileCloudMemberAccess(owner);
  return { owner, dbname, role, pw };
}

function mctx(db: Lattice, sessionId: string): MutationCtx {
  return { db, feed: new FeedBus(), softDeletable: new Set(['notes']), source: 'gui', sessionId };
}

describe.skipIf(!PG_URL)('group undo is authorship-scoped on a real member connection', () => {
  it("refuses a member's undo of the owner's group, flips nothing, and the entries were readable", async () => {
    const { owner, dbname, role, pw } = await ownerAuthoredGroup();

    const member = new Lattice(dbUrl(dbname, role, pw));
    member.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'notes.md',
    });
    defineAudit(member);
    await member.init();
    expect(member.isCloudMemberOpen()).toBe(true);

    // ATTACK SURFACE: the member really can READ the owner's groups — the
    // row-scoped update (n1 is 'everyone') AND, crucially, the NULL-row link entry,
    // which RLS lets any member read regardless of ownership. If it couldn't, the
    // refusals below would be about empty sets.
    const seeGroup = async (g: string): Promise<Record<string, unknown>[]> =>
      (await member.query('_lattice_gui_audit', {
        filters: [{ col: 'op_group', op: 'eq', val: g }],
        orderBy: 'id',
      })) as Record<string, unknown>[];
    const upd = await seeGroup('g-owner');
    expect(upd.map((e) => String(e.id))).toEqual(['g-upd']);
    const nullHole = await seeGroup('g-nullhole');
    expect(nullHole.map((e) => String(e.id))).toEqual(['g-link']); // NULL-row entry is readable
    for (const e of [...upd, ...nullHole]) {
      expect(String(e.session_id)).toBe('owner-session');
    }

    // THE FIX: the member's scoped undo of a group it did not author is refused —
    // for the row-scoped group AND the NULL-row link group — not a silent RLS no-op.
    expect(await undoGroup(mctx(member, 'member-session'), 'g-owner')).toMatchObject({
      ok: false,
      reason: 'forbidden',
    });
    expect(await undoGroup(mctx(member, 'member-session'), 'g-nullhole')).toMatchObject({
      ok: false,
      reason: 'forbidden',
    });

    // NOTHING was flipped — read back AS THE OWNER (BYPASSRLS), the ground truth.
    const afterMember = (await allAsyncOrSync(
      owner.adapter,
      `SELECT "id", "undone" FROM "_lattice_gui_audit" ORDER BY "id"`,
    )) as { id: string; undone: number }[];
    expect(afterMember.every((r) => r.undone === 0)).toBe(true);
    expect((await owner.get('notes', 'n1'))?.body).toBe('edited-body');

    member.close();

    // POSITIVE control: the AUTHOR's session is NOT refused — it undoes its own
    // group (the update inverse restores n1's prior body).
    const allowed = await undoGroup(mctx(owner, 'owner-session'), 'g-owner');
    expect(allowed).toMatchObject({ ok: true });
    expect((await owner.get('notes', 'n1'))?.body).toBe('original-body');
    const afterOwner = (await allAsyncOrSync(
      owner.adapter,
      `SELECT "undone" FROM "_lattice_gui_audit" WHERE "op_group" = 'g-owner'`,
    )) as { undone: number }[];
    expect(afterOwner.every((r) => r.undone === 1)).toBe(true);

    owner.close();
  }, 180_000);
});
