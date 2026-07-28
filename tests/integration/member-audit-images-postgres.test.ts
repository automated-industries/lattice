/**
 * The GUI audit log holds whole ROW IMAGES, and a member holds a direct Postgres
 * session.
 *
 * `_lattice_gui_audit.before_json` / `after_json` are complete snapshots of the
 * recorded row — every column in cleartext, owner-masked ones included, written by
 * whichever connection made the change (the owner's writes carry the unmasked
 * values). The relation is legitimately member-readable: undo, redo, revert and the
 * version-history page all read it, and its RLS policy scopes each entry to a row the
 * member can already see.
 *
 * Row visibility is not the same question as column masking, and that is the whole
 * defect. An entry for a row a member may legitimately see still carries the columns
 * the mask exists to hide, so `SELECT before_json FROM _lattice_gui_audit` returned
 * owner-secret cleartext to any member. A serve-time mask
 * (`maskAuditImagesForViewer`) covered the GUI's own history responses and could not
 * cover this: a member issues the query itself, against Postgres, and the HTTP layer
 * is simply not in the path.
 *
 * So the assertions here are made AS THE MEMBER, against the database, and they are
 * about the string that comes back — never about a privilege bit or a helper in
 * isolation.
 *
 * Postgres-gated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud, reconcileCloudMemberAccess } from '../../src/cloud/setup.js';
import { setColumnAudience } from '../../src/cloud/audience.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { allAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

/** Owner-masked column value. It must not reach a member through the history. */
const SECRET = 'AUDIT-IMAGE-OWNER-EYES-ONLY-7714';

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

/** The GUI's audit-log definition, as `openConfig` registers it. */
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
 * A cloud with two entity tables — one MASKED (`journal.secret`), one not (`notes`) —
 * each with a row visible to everyone and an audit entry recording an owner edit to
 * it. Both arms matter: the masked one is the leak, and the unmasked one is what
 * proves the fix is a mask rather than a blanket withholding that would silently
 * break member undo and revert everywhere.
 */
async function auditedCloud(): Promise<Cloud> {
  const dbname = `lattice_aud_${randomBytes(4).toString('hex')}`;
  databases.push(dbname);
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE DATABASE "${dbname}"`);
  await admin.end();

  const owner = new Lattice(dbUrl(dbname));
  owner.define('journal', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', secret: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'journal.md',
  });
  owner.define('notes', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'notes.md',
  });
  defineAudit(owner);
  await owner.init();
  await owner.upsert('journal', { id: 'j1', body: 'quarterly review', secret: SECRET });
  await owner.upsert('notes', { id: 'n1', body: 'open note' });
  // The images the OWNER's edits recorded — full cleartext, which is what makes undo
  // work and what must not be handed to a member wholesale.
  await owner.insert('_lattice_gui_audit', {
    id: 'a-masked',
    ts: new Date().toISOString(),
    table_name: 'journal',
    row_id: 'j1',
    operation: 'update',
    before_json: JSON.stringify({ id: 'j1', body: 'quarterly review', secret: SECRET }),
    after_json: JSON.stringify({ id: 'j1', body: 'revised', secret: SECRET }),
    undone: 0,
    session_id: 'owner-session',
    source: 'gui',
  });
  await owner.insert('_lattice_gui_audit', {
    id: 'b-open',
    ts: new Date().toISOString(),
    table_name: 'notes',
    row_id: 'n1',
    operation: 'update',
    before_json: JSON.stringify({ id: 'n1', body: 'open note' }),
    after_json: JSON.stringify({ id: 'n1', body: 'edited note' }),
    undone: 0,
    session_id: 'owner-session',
    source: 'gui',
  });
  await owner.insert('_lattice_gui_audit', {
    id: 'c-schema',
    ts: new Date().toISOString(),
    table_name: 'journal',
    row_id: null,
    operation: 'schema.add_column',
    before_json: null,
    after_json: JSON.stringify({ column: 'secret', type: 'TEXT' }),
    undone: 0,
    session_id: 'owner-session',
    source: 'gui',
  });
  await secureCloud(owner);
  for (const [t, pk] of [
    ['journal', 'j1'],
    ['notes', 'n1'],
  ] as const) {
    await runAsyncOrSync(owner.adapter, `SELECT lattice_set_row_visibility(?, ?, 'everyone')`, [
      t,
      pk,
    ]);
  }
  await setColumnAudience(
    owner,
    'journal',
    'secret',
    'owner',
    ['id', 'body', 'secret', 'deleted_at'],
    ['id'],
  );

  const role = `lau_${randomBytes(3).toString('hex')}`;
  roles.push(role);
  const pw = generateMemberPassword();
  await provisionMemberRole(owner, role, pw);
  await reconcileCloudMemberAccess(owner);
  return { owner, dbname, role, pw };
}

describe.skipIf(!PG_URL)('member reads of the GUI audit log', () => {
  it('cannot read an owner-masked column out of the stored images with a plain SELECT', async () => {
    const { owner, dbname, role, pw } = await auditedCloud();
    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);

    // The image really does hold the masked value in clear, and the row really is
    // visible to this member — otherwise everything below is about an empty table.
    const stored = (await allAsyncOrSync(
      owner.adapter,
      `SELECT "before_json" AS b FROM "_lattice_gui_audit" WHERE "id" = 'a-masked'`,
    )) as { b?: unknown }[];
    expect(String(stored[0]?.b ?? '')).toContain(SECRET);
    const row = await member.query<{ body: string | null; secret: string | null }>(
      `SELECT "body", "secret" FROM "journal_v" WHERE "id" = 'j1'`,
    );
    expect(row.rows[0]?.body).toBe('quarterly review'); // the row is readable…
    expect(row.rows[0]?.secret ?? null).toBeNull(); // …and the column is masked.

    // THE PROPERTY, stated as the value that comes back rather than as a privilege:
    // the member's own query, against the relation, for the column. Both the explicit
    // column and the `SELECT *` the query layer emits.
    const readRaw = async (sql: string): Promise<{ text: string; refused: boolean }> => {
      try {
        const r = await member.query(sql);
        return { text: JSON.stringify(r.rows), refused: false };
      } catch (e) {
        return { text: (e as Error).message, refused: /permission denied/i.test(String(e)) };
      }
    };
    for (const sql of [
      `SELECT "before_json" FROM "_lattice_gui_audit"`,
      `SELECT * FROM "_lattice_gui_audit"`,
      `SELECT "after_json" FROM "_lattice_gui_audit" WHERE "table_name" = 'journal'`,
    ]) {
      const got = await readRaw(sql);
      expect(got.text, `a member read the masked cleartext with: ${sql}`).not.toContain(SECRET);
      expect(got.refused, `a member must be refused the raw images: ${sql}`).toBe(true);
    }

    // The read path the member DOES have withholds the image rather than erroring:
    // the entry still appears (who edited what, and when, is not the secret), the
    // payload does not.
    const via = await member.query<{
      id: string;
      operation: string;
      before_json: string | null;
      after_json: string | null;
    }>(`SELECT "id", "operation", "before_json", "after_json" FROM "_lattice_gui_audit_v"
         ORDER BY "id"`);
    const masked = via.rows.find((r) => r.id === 'a-masked');
    expect(masked, 'the entry itself stays visible').toBeDefined();
    expect(masked!.operation).toBe('update');
    expect(masked!.before_json ?? null).toBeNull();
    expect(masked!.after_json ?? null).toBeNull();
    for (const r of via.rows) {
      expect(`${r.before_json ?? ''}${r.after_json ?? ''}`).not.toContain(SECRET);
    }

    // The OWNER is unaffected — the images are what undo/redo/revert restore from, so
    // masking at rest was never an option.
    const asOwner = (await allAsyncOrSync(
      owner.adapter,
      `SELECT "before_json" AS b FROM "_lattice_gui_audit_v" WHERE "id" = 'a-masked'`,
    )) as { b?: unknown }[];
    expect(String(asOwner[0]?.b ?? '')).toContain(SECRET);

    owner.close();
  }, 180_000);

  it('still serves images for a table with no mask, and for schema entries', async () => {
    // The half that keeps the fix honest. Withholding every image from every
    // non-owner would pass the leak test above and quietly break a member's undo and
    // revert on every shared row in the workspace — the image is what the restore
    // reads. So the withholding is scoped to tables that actually carry a mask, read
    // out of the standing `<t>_v` definition (the artifact that ENFORCES the mask),
    // never out of the losable column policy.
    const { owner, dbname, role, pw } = await auditedCloud();
    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);

    const via = await member.query<{ id: string; before_json: string | null }>(
      `SELECT "id", "before_json", "after_json" FROM "_lattice_gui_audit_v" ORDER BY "id"`,
    );
    const open = via.rows.find((r) => r.id === 'b-open');
    expect(open, 'an entry on an unmasked table is still served').toBeDefined();
    expect(open!.before_json ?? '').toContain('open note');

    // A schema/data-model entry carries a definition, not a row snapshot, so there is
    // no cell to mask and it passes through (row_id IS NULL) — even though it is
    // recorded against `journal`, which IS masked. That is the branch: the withholding
    // keys on the entry having row data, not on the table having a mask.
    const schema = via.rows.find((r) => r.id === 'c-schema');
    expect(schema).toBeDefined();
    const after = (
      await member.query<{ a: string | null }>(
        `SELECT "after_json" AS a FROM "_lattice_gui_audit_v" WHERE "id" = 'c-schema'`,
      )
    ).rows[0]?.a;
    expect(after ?? '').toContain('"column":"secret"');

    owner.close();
  }, 180_000);

  it("routes a member's Lattice reads to the mask view, and keeps undo/redo writable", async () => {
    // The narrowed grant is only safe if the member's own query layer lands on the
    // view — `db.query` emits `SELECT *`, which is exactly what the base now refuses.
    // And the undo/redo/purge writes must keep working: they UPDATE and DELETE by id,
    // which Postgres will not allow without SELECT on the columns their WHERE names.
    // Asserted by performing them, not by reading grants.
    const { owner, dbname, role, pw } = await auditedCloud();
    owner.close();

    const member = new Lattice(dbUrl(dbname, role, pw));
    member.define('journal', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', secret: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'journal.md',
    });
    member.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'notes.md',
    });
    defineAudit(member);
    await member.init();
    expect(member.isCloudMemberOpen()).toBe(true);
    expect(member.memberReadRelation('_lattice_gui_audit')).toBe('_lattice_gui_audit_v');

    const entries = (await member.query('_lattice_gui_audit', {
      orderBy: 'id',
    })) as Record<string, unknown>[];
    expect(entries.map((e) => String(e.id))).toEqual(['a-masked', 'b-open', 'c-schema']);
    expect(JSON.stringify(entries)).not.toContain(SECRET);
    // …and the unmasked table's image survived the round trip through the view.
    expect(String(entries[1]?.before_json ?? '')).toContain('open note');

    // Undo flips `undone`; the redo-stack purge deletes. Both are member writes on
    // the BASE table, and both need SELECT on the key column they filter by.
    await member.update('_lattice_gui_audit', 'a-masked', { undone: 1 });
    const afterUpdate = (await member.query('_lattice_gui_audit', {
      filters: [{ col: 'id', op: 'eq', val: 'a-masked' }],
    })) as Record<string, unknown>[];
    expect(Number(afterUpdate[0]?.undone)).toBe(1);

    await member.delete('_lattice_gui_audit', 'a-masked');
    const afterDelete = (await member.query('_lattice_gui_audit', {
      orderBy: 'id',
    })) as Record<string, unknown>[];
    expect(afterDelete.map((e) => String(e.id))).toEqual(['b-open', 'c-schema']);

    member.close();
  }, 180_000);
});
