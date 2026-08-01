/**
 * A table that appears on a secured cloud AFTER the cutover must be secured
 * wherever it came from — the browser, a script using the library, or a CLI
 * command — not only when the browser happened to be the thing that made it.
 *
 * Two gaps are pinned here, both of which leave rows readable by people who
 * should not see them:
 *
 *   1. Registering a table at runtime (`defineLate`, the one call every
 *      table-creating path funnels through) left it with row security OFF: no
 *      per-row ownership, no member read view, and members holding whatever the
 *      database handed out by default. It was repaired only when a workspace
 *      owner next opened the browser UI, so a headless workspace stayed exposed
 *      indefinitely.
 *   2. Opening a workspace headlessly never registered the framework's own
 *      tables, so securing that workspace walked a table list that did not
 *      include the file index or the secret store — and skipped them silently.
 *
 * Postgres-gated (a real per-test cloud database plus a real member login role,
 * which is the only way to observe row security actually filtering).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { addWorkspace } from '../../src/framework/workspace.js';
import { ensureLatticeRoot } from '../../src/framework/lattice-root.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const databases: string[] = [];
const roles: string[] = [];
const opened: Lattice[] = [];
const dirs: string[] = [];
let savedRoot: string | undefined;

function dbUrl(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

/** A minimal declared table so the cloud cutover has something to secure. */
function defineNotes(db: Lattice): void {
  db.define('notes', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'notes.md',
  });
}

/** Row security state as Postgres itself reports it. */
async function rowSecurity(
  url: string,
  table: string,
): Promise<{ enabled: boolean; forced: boolean }> {
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const { rows } = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = $1`,
      [table],
    );
    const r = rows[0];
    return { enabled: !!r?.relrowsecurity, forced: !!r?.relforcerowsecurity };
  } finally {
    await admin.end();
  }
}

afterEach(async () => {
  for (const d of opened.splice(0)) {
    try {
      d.close();
    } catch {
      /* best-effort */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedRoot === undefined) delete process.env.LATTICE_ROOT;
  else process.env.LATTICE_ROOT = savedRoot;
  savedRoot = undefined;
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

/** A fresh, secured cloud database plus its owner connection. */
async function freshCloud(): Promise<{ owner: Lattice; dbname: string }> {
  const dbname = `lattice_rt_${randomBytes(4).toString('hex')}`;
  databases.push(dbname);
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE DATABASE "${dbname}"`);
  await admin.end();

  const owner = new Lattice(dbUrl(dbname), { encryptionKey: 'runtime-secure-test-key' });
  opened.push(owner);
  defineNotes(owner);
  await owner.init();
  await secureCloud(owner);
  return { owner, dbname };
}

describe.skipIf(!PG_URL)('a table created outside the browser is secured too', () => {
  it('registering a table at runtime secures it, with no browser involved', async () => {
    const { owner, dbname } = await freshCloud();

    // The library path: register a brand-new table on an already-secured cloud.
    // Nothing about this call goes anywhere near the browser server.
    await owner.defineLate('widgets', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'widgets.md',
    });

    const sec = await rowSecurity(dbUrl(dbname), 'widgets');
    expect(sec.enabled).toBe(true);
    expect(sec.forced).toBe(true);
  });

  it('a member cannot read the rows of a runtime-created table they do not own', async () => {
    const { owner, dbname } = await freshCloud();
    await owner.defineLate('widgets', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'widgets.md',
    });
    await owner.insert('widgets', { id: 'w1', name: 'owner-only' });

    const role = `lm_rt_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner, role, pw);

    // The member's read path for any secured table is its companion read
    // relation. It has to EXIST (otherwise the member has no read path at all)
    // and it has to hide a row the member does not own.
    const conn = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    try {
      const { rows } = await conn.query(`SELECT * FROM "widgets_v"`);
      expect(rows).toEqual([]);
    } finally {
      await conn.end();
    }
  });

  it('renaming a table re-registers it without treating it as a new one', async () => {
    const { owner, dbname } = await freshCloud();
    const def = {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'widgets.md',
    };
    await owner.defineLate('widgets', def);
    await owner.insert('widgets', { id: 'w1', name: 'renamed later' });

    // What renaming a table does, reduced to the part that matters here: the
    // table moves, the workspace re-registers it under its new name, and the
    // records of who owns its rows are carried across to that name. The table is
    // NOT new — it is the same table, with the same rows and the same owners —
    // so registering it must not lay down a second set of ownership records. It
    // did, and the carry then collided with them and failed the whole rename.
    const admin = new pg.Pool({ connectionString: dbUrl(dbname), max: 1 });
    try {
      await admin.query(`ALTER TABLE "widgets" RENAME TO "gadgets"`);
      owner.unregisterTable('widgets');
      await owner.defineLate('gadgets', { ...def, outputFile: 'gadgets.md' });
      await admin.query(
        `UPDATE "__lattice_owners" SET "table_name" = 'gadgets' WHERE "table_name" = 'widgets'`,
      );
      const { rows } = await admin.query<{ table_name: string; pk: string }>(
        `SELECT "table_name", "pk" FROM "__lattice_owners" WHERE "pk" = 'w1'`,
      );
      expect(rows).toEqual([{ table_name: 'gadgets', pk: 'w1' }]);
    } finally {
      await admin.end();
    }
  });

  it('securing a headlessly-opened workspace covers the file index and the secret store', async () => {
    const dbname = `lattice_rt_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE DATABASE "${dbname}"`);
    await admin.end();

    const base = mkdtempSync(join(tmpdir(), 'lattice-rt-ws-'));
    dirs.push(base);
    savedRoot = process.env.LATTICE_ROOT;
    process.env.LATTICE_ROOT = join(base, '.lattice');
    const root = ensureLatticeRoot(base);
    addWorkspace(root, { displayName: 'Headless', db: dbUrl(dbname) });

    // No browser, no CLI — the library's own workspace open.
    const db = await Lattice.openWorkspace({ root, autoRender: false });
    opened.push(db);
    await secureCloud(db);

    for (const table of ['files', 'secrets']) {
      const sec = await rowSecurity(dbUrl(dbname), table);
      expect({ table, ...sec }).toEqual({ table, enabled: true, forced: true });
    }
  });
});

describe.skipIf(!PG_URL)('securing only applies to relations that own their rows', () => {
  it('registering a view neither fails nor claims ownership of anything', async () => {
    const { owner, dbname } = await freshCloud();
    await owner.insert('notes', { id: 'n1', body: 'east' });

    // A view is registered through the same call every table goes through — an
    // import that reconstructs one does exactly this, after it has already
    // written its rows. Securing has nothing to do here: a view stores no rows
    // of its own, and the tables underneath it are secured in their own right.
    const admin = new pg.Pool({ connectionString: dbUrl(dbname), max: 1 });
    try {
      await admin.query(`CREATE VIEW "notes_east" AS SELECT * FROM "notes"`);
    } finally {
      await admin.end();
    }

    await expect(
      owner.defineLate('notes_east', {
        columns: { id: 'TEXT', body: 'TEXT', deleted_at: 'TEXT' },
        render: () => '',
        outputFile: 'notes-east.md',
      }),
    ).resolves.toBeDefined();

    // No ownership records keyed to a relation that can never have an owner.
    const check = new pg.Pool({ connectionString: dbUrl(dbname), max: 1 });
    try {
      const { rows } = await check.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "__lattice_owners" WHERE "table_name" = 'notes_east'`,
      );
      expect(rows[0]?.n).toBe('0');
    } finally {
      await check.end();
    }
    expect(owner.getRegisteredTableNames()).toContain('notes_east');
  });

  it('a table keyed on a column other than id is secured on that column', async () => {
    const { owner, dbname } = await freshCloud();

    // The key is declared the other way a definition can declare one: inside the
    // column's own type, rather than in a separate `primaryKey` field. Read only
    // from the separate field, this table looked keyed on `id` — a column it does
    // not have — and every expression built from that key named a missing column.
    await owner.defineLate('parts', {
      columns: { sku: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'parts.md',
    });

    expect(owner.getPrimaryKey('parts')).toEqual(['sku']);
    const sec = await rowSecurity(dbUrl(dbname), 'parts');
    expect(sec).toEqual({ enabled: true, forced: true });
  });

  it('a table that could not be secured stays loud instead of quietly unprotected', async () => {
    const { owner, dbname } = await freshCloud();

    // A table with no key at all cannot be given per-row ownership, so securing
    // it fails. What must NOT happen is the first attempt failing and the second
    // one reporting success over a table with row security still off — which is
    // what an already-registered early return did.
    const def = {
      columns: { label: 'TEXT', deleted_at: 'TEXT' },
      primaryKey: [] as unknown as string,
      render: () => '',
      outputFile: 'unkeyed.md',
    };
    // An empty key list is rejected before anything is created; use the shape a
    // caller actually hits instead — a definition whose declared key column is
    // absent from the table.
    delete (def as { primaryKey?: unknown }).primaryKey;
    const admin = new pg.Pool({ connectionString: dbUrl(dbname), max: 1 });
    try {
      // The table exists with no `id`; the definition claims `id` as its key.
      await admin.query(`CREATE TABLE "unkeyed" ("label" TEXT, "deleted_at" TEXT)`);
    } finally {
      await admin.end();
    }

    await expect(owner.defineLate('unkeyed', def)).rejects.toThrow();
    // Dropped from the registry, so the next attempt runs the whole path again
    // and fails again — rather than returning early over an unprotected table.
    expect(owner.getRegisteredTableNames()).not.toContain('unkeyed');
    await expect(owner.defineLate('unkeyed', def)).rejects.toThrow();
    const sec = await rowSecurity(dbUrl(dbname), 'unkeyed');
    expect(sec.enabled).toBe(false);
  });
});
