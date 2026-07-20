/**
 * A scoped cloud MEMBER must be able to make the everyday GUI writes — add a
 * note, add a brand-new field, hard-delete a row they own, and undo/redo — all
 * through the SAME mutation primitives the GUI server uses, running as the
 * member's own non-BYPASSRLS Postgres login role.
 *
 * Three distinct member-write failures are pinned here, each of which throws on
 * the pre-fix code and passes after:
 *
 *   1. Hard delete — deleteRow removed the base row (whose AFTER DELETE trigger
 *      drops the ownership record) BEFORE writing the delete-audit entry, so the
 *      audit INSERT's WITH CHECK (lattice_row_visible) was false and the whole
 *      delete threw. Fixed by writing the audit row first (atomically with the
 *      delete on a cloud).
 *   2. Undo/redo + redo-stack purge — these UPDATE / DELETE the audit table, but
 *      the member group only had SELECT, INSERT on it. Fixed by widening the
 *      grant (gated by the per-op RLS USING clauses).
 *   3. Add a new field — createRow auto-adds a missing column via ALTER TABLE,
 *      which a scoped member can't run. Fixed by routing the member's column add
 *      through an owner-side SECURITY DEFINER helper.
 *
 * Postgres-gated (real per-test cloud database + a real member login role).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import {
  createRow,
  updateRow,
  deleteRow,
  undoLast,
  type MutationCtx,
} from '../../src/gui/mutations.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const databases: string[] = [];
const roles: string[] = [];
const opened: Lattice[] = [];

function dbUrl(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

/** A minimal user table the member writes into. */
function defineNotes(db: Lattice): void {
  db.define('notes', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      body: 'TEXT',
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: 'notes.md',
  });
}

/** The GUI audit log, matching the server's definition (ts has a SQLite-only
 *  default; the mutation primitives set ts explicitly). */
function defineAudit(db: Lattice): void {
  db.define('_lattice_gui_audit', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      ts: "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      table_name: 'TEXT NOT NULL',
      row_id: 'TEXT',
      operation: 'TEXT NOT NULL',
      before_json: 'TEXT',
      after_json: 'TEXT',
      undone: 'INTEGER NOT NULL DEFAULT 0',
      session_id: 'TEXT',
      source: 'TEXT',
    },
    render: () => '',
    outputFile: '_audit.md',
  });
}

/** A MutationCtx over a member connection, tagged with a session id so the
 *  undo/redo + redo-stack-purge paths are session-scoped (the GUI's contract). */
function memberCtx(db: Lattice, sessionId: string): MutationCtx {
  return {
    db,
    feed: new FeedBus(),
    softDeletable: new Set<string>(['notes']),
    source: 'gui',
    sessionId,
  };
}

afterEach(async () => {
  for (const d of opened.splice(0)) {
    try {
      d.close();
    } catch {
      /* best-effort */
    }
  }
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

describe.skipIf(!PG_URL)('cloud member writes (regression)', () => {
  /** Secure a fresh cloud, mint a member, and open a SECOND Lattice as that
   *  member. Returns the member-scoped Lattice + the row owner's pre-shared notes. */
  async function setup(): Promise<{ owner: Lattice; member: Lattice; role: string }> {
    const dbname = `lattice_mw_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE DATABASE "${dbname}"`);
    await admin.end();

    const owner = new Lattice(dbUrl(dbname));
    opened.push(owner);
    defineNotes(owner);
    defineAudit(owner);
    await owner.init();
    await secureCloud(owner); // installs RLS + member grants + audit policies

    // Default new-row visibility for `notes` is 'private', and a member only sees
    // its OWN rows. The member creates + owns the rows it writes below, so no
    // owner-side sharing is needed.
    const role = `lm_mw_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner, role, pw);

    const member = new Lattice(dbUrl(dbname, role, pw));
    opened.push(member);
    defineNotes(member);
    defineAudit(member);
    await member.init(); // auto-detects the scoped member (introspect-only)
    return { owner, member, role };
  }

  it('1. member createRow using only existing columns succeeds', async () => {
    const { member } = await setup();
    const ctx = memberCtx(member, 'sess-1');
    const { id, row } = await createRow(ctx, 'notes', { id: 'n1', body: 'hello' });
    expect(id).toBe('n1');
    expect(row?.body).toBe('hello');
    // Member can read its own row back.
    const back = await member.get('notes', 'n1');
    expect(back?.body).toBe('hello');
  });

  it('2. member createRow that introduces a NEW field succeeds + the column is readable', async () => {
    const { member } = await setup();
    const ctx = memberCtx(member, 'sess-2');
    // `priority` is not on the table — the write must add the column (via the
    // owner-side DEFINER helper, since a member can't ALTER) and persist it.
    const { id, row } = await createRow(ctx, 'notes', {
      id: 'n2',
      body: 'with new field',
      priority: 5,
    });
    expect(id).toBe('n2');
    expect(Number(row?.priority)).toBe(5);
    // The column actually exists and the member can read it back.
    const back = await member.get('notes', 'n2');
    expect(Number(back?.priority)).toBe(5);
  });

  it('3. member updateRow then undoLast succeeds (audit UPDATE)', async () => {
    const { member } = await setup();
    const ctx = memberCtx(member, 'sess-3');
    await createRow(ctx, 'notes', { id: 'n3', body: 'v1' });
    await updateRow(ctx, 'notes', 'n3', { body: 'v2' });
    const undone = await undoLast(ctx); // flips the UPDATE audit entry's `undone`
    expect(undone).not.toBeNull();
    expect(undone?.operation).toBe('update');
    // The inverse restored the prior value.
    const back = await member.get('notes', 'n3');
    expect(back?.body).toBe('v1');
  });

  it('4. member createRow while an undone entry exists purges the redo stack (audit DELETE)', async () => {
    const { member } = await setup();
    const ctx = memberCtx(member, 'sess-4');
    await createRow(ctx, 'notes', { id: 'n4a', body: 'first' });
    await undoLast(ctx); // leaves an undone entry in the session's redo stack
    // A new mutation must purge that undone entry (DELETE on the audit table).
    const { id } = await createRow(ctx, 'notes', { id: 'n4b', body: 'second' });
    expect(id).toBe('n4b');
  });

  it('5. member hard-deletes a row they own (deleteRow hard=true)', async () => {
    const { member } = await setup();
    const ctx = memberCtx(member, 'sess-5');
    await createRow(ctx, 'notes', { id: 'n5', body: 'to delete' });
    await deleteRow(ctx, 'notes', 'n5', true); // hard delete — throws pre-fix
    const back = await member.get('notes', 'n5');
    expect(back).toBeNull();
  });
});
