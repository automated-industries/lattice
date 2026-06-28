/**
 * SECURITY REGRESSION — the GUI audit log is scoped by ROW VISIBILITY on a cloud.
 *
 * `_lattice_gui_audit` powers undo/redo + the version-history page and is granted
 * to members, but its `before_json` / `after_json` carry the RAW row data of every
 * mutation (every column in cleartext, including ones a member can't otherwise
 * see). With only a member GRANT and no RLS, a member's version-history read
 * returned EVERY member's edits — a P0 data leak.
 *
 * The visibility model this test pins (confirmed with the product owner): a member
 * may see an audit entry for a row IFF they can currently SEE that row
 * (`lattice_row_visible` — shared/owned/everyone). Schema-level entries (`row_id`
 * IS NULL, e.g. a table create) carry no row data and are visible to all members.
 * An audit entry for a PRIVATE row the member can't see is invisible.
 *
 * Postgres-gated (real per-test cloud database + a real member login role).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { runAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const databases: string[] = [];
const roles: string[] = [];

function dbUrl(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

/** A minimal user table the audit entries reference. */
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

/** The GUI audit log (no created_by — the new model keys off the underlying row). */
function defineAudit(db: Lattice): void {
  db.define('_lattice_gui_audit', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      table_name: 'TEXT NOT NULL',
      row_id: 'TEXT',
      operation: 'TEXT NOT NULL',
      before_json: 'TEXT',
      after_json: 'TEXT',
      session_id: 'TEXT',
      source: 'TEXT',
    },
    render: () => '',
    outputFile: '_audit.md',
  });
}

afterEach(async () => {
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

describe.skipIf(!PG_URL)('cloud GUI audit isolation (security regression)', () => {
  it('a member sees audit entries only for rows it can see (shared / schema-level), not private ones', async () => {
    const dbname = `lattice_audit_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE DATABASE "${dbname}"`);
    await admin.end();

    const owner = new Lattice(dbUrl(dbname));
    defineNotes(owner);
    defineAudit(owner);
    await owner.init();
    await secureCloud(owner); // installs the row-visibility RLS + member grants

    // Two notes the OWNER creates: one left private (default), one shared to all.
    await owner.insert('notes', { id: 'n_priv', body: 'private note' });
    await owner.insert('notes', { id: 'n_shared', body: 'shared note' });
    await runAsyncOrSync(
      owner.adapter,
      `SELECT lattice_set_row_visibility('notes','n_shared','everyone')`,
    );

    // Audit entries: one for the private note, one for the shared note, one
    // schema-level (row_id IS NULL — carries no row data).
    await runAsyncOrSync(
      owner.adapter,
      `INSERT INTO "_lattice_gui_audit" ("id","table_name","row_id","operation","before_json","after_json")
       VALUES ('a_priv','notes','n_priv','update','{"body":"old"}','{"body":"private note"}')`,
    );
    await runAsyncOrSync(
      owner.adapter,
      `INSERT INTO "_lattice_gui_audit" ("id","table_name","row_id","operation","before_json","after_json")
       VALUES ('a_shared','notes','n_shared','update','{"body":"old"}','{"body":"shared note"}')`,
    );
    await runAsyncOrSync(
      owner.adapter,
      `INSERT INTO "_lattice_gui_audit" ("id","table_name","row_id","operation")
       VALUES ('a_schema','notes',NULL,'create_entity')`,
    );

    // Provision a real member login role.
    const role = `lm_aud_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner, role, pw);
    owner.close();

    // The member sees the schema-level entry (no row data) + the shared row's
    // entry (it can see that row), but NOT the private row's entry.
    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    const seen = (
      await member.query<{ id: string }>(`SELECT id FROM "_lattice_gui_audit" ORDER BY id`)
    ).rows.map((r) => r.id);
    expect(seen).toEqual(['a_schema', 'a_shared']);
    expect(seen).not.toContain('a_priv'); // private row not visible → its history is hidden
    await member.end();
  });
});
