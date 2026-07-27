/**
 * Marking a column secret must hide it on EVERY path a member can reach — not
 * only the base table's cell-masking view.
 *
 * Two confirmed leaks are pinned here, both exercised AS A SCOPED MEMBER (a
 * real, non-BYPASSRLS Postgres login role). An owner-connection read can never
 * catch either one, because the owner is allowed to see the secret.
 *
 *  1. A computed view compiled BEFORE the column was masked keeps selecting the
 *     raw base column, so the member reads the value through the computed view
 *     even though the base table masks it. Masking must recompile every
 *     dependent view (or refuse, naming them) — never report a column masked
 *     while a path still serves it.
 *
 *  2. The GUI audit log stores before/after row images. For a row the member can
 *     see, those images carry the secret column's value in cleartext. The stored
 *     image must stay whole (undo/redo needs it), but what is SERVED to a member
 *     has to be masked with the same audience decision the row read path makes.
 *
 * Postgres-gated: the whole class is invisible on SQLite (no roles, no masking
 * views), which is exactly why it shipped undetected.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { openConfig, disposeActive } from '../../src/gui/server.js';
import type { ActiveDb } from '../../src/gui/server.js';
import { createComputedTable } from '../../src/gui/computed-ops.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { setColumnAudience, directViewDependents } from '../../src/cloud/audience.js';
import {
  appendAudit,
  loadSecretColumns,
  maskAuditImages,
  parseAudit,
  SECRET_VALUE_MASK,
} from '../../src/gui/mutations.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { allAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';
import type { ComputedTableDef } from '../../src/config/types.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const dirs: string[] = [];
const actives: ActiveDb[] = [];
const pools: pg.Pool[] = [];
const databases: string[] = [];
const roles: string[] = [];

function dbUrl(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

afterEach(async () => {
  for (const a of actives.splice(0)) await disposeActive(a);
  for (const p of pools.splice(0)) await p.end();
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

function writeOwnerConfig(url: string): string {
  const root = mkdtempSync(join(tmpdir(), 'lattice-secleak-'));
  dirs.push(root);
  mkdirSync(join(root, 'context'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      `db: "${url}"`,
      '',
      'entities:',
      '  notes:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      body: { type: text }',
      '      secret: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: notes.md',
      '',
    ].join('\n'),
    'utf8',
  );
  return configPath;
}

async function freshDatabase(): Promise<string> {
  const dbname = `lattice_secleak_${randomBytes(4).toString('hex')}`;
  databases.push(dbname);
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE DATABASE "${dbname}"`);
  await admin.end();
  return dbname;
}

async function openSecuredOwner(dbname: string): Promise<ActiveDb> {
  const cfg = writeOwnerConfig(dbUrl(dbname));
  const owner = await openConfig(cfg, join(cfg, '..', 'context'), false);
  actives.push(owner);
  await owner.converged;
  await secureCloud(owner.db);
  return owner;
}

async function memberPoolFor(owner: ActiveDb, dbname: string): Promise<pg.Pool> {
  const role = `lm_secleak_${randomBytes(3).toString('hex')}`;
  roles.push(role);
  const pw = generateMemberPassword();
  await provisionMemberRole(owner.db, role, pw);
  const pool = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
  pools.push(pool);
  return pool;
}

/** `secret` aliased AND used in a calc — both must mask once the column is secret. */
const boardDef: ComputedTableDef = {
  base: 'notes',
  fields: {
    body: { kind: 'alias', source: 'body' },
    secret_alias: { kind: 'alias', source: 'secret' },
    secret_len: { kind: 'calc', expr: 'length(secret)', type: 'integer' },
  },
};

describe.skipIf(!PG_URL)('secret columns — every member-reachable path', () => {
  it('recompiles a PRE-EXISTING computed view when its source column becomes secret', async () => {
    const dbname = await freshDatabase();
    const owner = await openSecuredOwner(dbname);

    const sharedId = await owner.db.insertForcingVisibility(
      'notes',
      { body: 'shared note', secret: 'top-secret' },
      'everyone',
    );

    // The computed view is built FIRST, against the UNMASKED column — this is the
    // ordering the shipped code got wrong. It compiles `FROM "notes"`.
    await createComputedTable(owner, 'note_board', boardDef, 'sess');
    expect(await directViewDependents(owner.db, 'notes')).toContain('note_board');

    // NOW the owner marks the column secret.
    const cols = Object.keys(owner.db.getRegisteredColumns('notes')!);
    const pk = owner.db.getPrimaryKey('notes');
    await setColumnAudience(owner.db, 'notes', 'secret', 'owner', cols, pk);

    // No view may read the base table directly any more — the masking view is the
    // only reader, so there is no path around the mask.
    expect(await directViewDependents(owner.db, 'notes')).toEqual([]);

    const member = await memberPoolFor(owner, dbname);

    // The member still sees the shared row and its unmasked column, but the secret
    // reads NULL through BOTH the alias and the calc over it.
    const seen = await member.query<{
      id: string;
      body: string;
      secret_alias: string | null;
      secret_len: number | null;
    }>(`SELECT id, body, secret_alias, secret_len FROM "note_board"`);
    expect(seen.rows).toEqual([
      { id: sharedId, body: 'shared note', secret_alias: null, secret_len: null },
    ]);

    // Belt and braces: the base column stays unreachable to the member.
    await expect(member.query(`SELECT secret FROM "notes"`)).rejects.toThrow(/permission denied/i);

    // The owner is unaffected — the mask is per-viewer, not a blanket NULL.
    const ownerPool = new pg.Pool({ connectionString: dbUrl(dbname), max: 1 });
    pools.push(ownerPool);
    const ownerSeen = await ownerPool.query<{ secret_alias: string | null }>(
      `SELECT secret_alias FROM "note_board"`,
    );
    expect(ownerSeen.rows).toEqual([{ secret_alias: 'top-secret' }]);

    // Un-masking moves the dependents back: the mask view is about to disappear
    // and Postgres refuses to drop a view something still reads, so the
    // projections must be rebuilt onto the base table BEFORE the drop.
    await setColumnAudience(owner.db, 'notes', 'secret', '', cols, pk);
    const afterClear = await member.query<{ secret_alias: string | null }>(
      `SELECT secret_alias FROM "note_board"`,
    );
    expect(afterClear.rows).toEqual([{ secret_alias: 'top-secret' }]);
  }, 120_000);

  it('refuses to mask a column when a dependent view cannot be recompiled', async () => {
    const dbname = await freshDatabase();
    const owner = await openSecuredOwner(dbname);
    await owner.db.insertForcingVisibility(
      'notes',
      { body: 'shared note', secret: 'top-secret' },
      'everyone',
    );

    // A hand-written view Lattice does not manage: it can never be recompiled to
    // read through the mask, so the masking operation must REFUSE and name it
    // rather than report the column masked while this view still serves it.
    await runAsyncOrSync(
      owner.db.adapter,
      `CREATE VIEW "hand_rolled" AS SELECT id, secret FROM "notes"`,
    );

    const cols = Object.keys(owner.db.getRegisteredColumns('notes')!);
    const pk = owner.db.getPrimaryKey('notes');
    await expect(setColumnAudience(owner.db, 'notes', 'secret', 'owner', cols, pk)).rejects.toThrow(
      /hand_rolled/,
    );

    // And it refused BEFORE changing anything: the column is still unmasked, so
    // the owner is never told "masked" while a path serves the value.
    const policy = await allAsyncOrSync(
      owner.db.adapter,
      `SELECT "column_name" FROM "__lattice_column_policy" WHERE "table_name" = 'notes'`,
    );
    expect(policy).toEqual([]);
    // ...and no masking view was created, so nothing reports the column masked.
    const maskView = await allAsyncOrSync(
      owner.db.adapter,
      `SELECT to_regclass('"notes_v"') AS reg`,
    );
    expect((maskView as { reg: string | null }[])[0]!.reg).toBeNull();
  }, 120_000);

  it('masks secret columns out of audit images served to a viewer', async () => {
    const dbname = await freshDatabase();
    const owner = await openSecuredOwner(dbname);

    const sharedId = await owner.db.insertForcingVisibility(
      'notes',
      { body: 'v1', secret: 'top-secret' },
      'everyone',
    );

    // A row edit, audited exactly as the GUI audits it: the before/after images
    // capture the secret column's value in cleartext.
    await appendAudit(
      owner.db,
      owner.feed,
      'notes',
      sharedId,
      'update',
      { id: sharedId, body: 'v1', secret: 'top-secret' },
      { id: sharedId, body: 'v2', secret: 'still-secret' },
      'gui',
      'sess',
    );

    // The column becomes secret AFTER the audit row was written — the ordering
    // that makes a write-time scrub useless and forces a serve-time mask.
    const cols = Object.keys(owner.db.getRegisteredColumns('notes')!);
    const pk = owner.db.getPrimaryKey('notes');
    await setColumnAudience(owner.db, 'notes', 'secret', 'owner', cols, pk);

    const stored = (
      await owner.db.query('_lattice_gui_audit', {
        filters: [{ col: 'operation', op: 'eq', val: 'update' }],
      })
    ).map(parseAudit);
    expect(stored).toHaveLength(1);

    // What is STORED keeps the full image — undo/redo restores the real value.
    expect(stored[0]!.before_json).toContain('top-secret');
    expect(stored[0]!.after_json).toContain('still-secret');

    // What is SERVED masks the secret column and nothing else.
    const secretCols = await loadSecretColumns(owner.db);
    expect(secretCols.get('notes')).toEqual(new Set(['secret']));

    const served = maskAuditImages(stored, secretCols);
    expect(JSON.parse(served[0]!.before_json!)).toEqual({
      id: sharedId,
      body: 'v1',
      secret: SECRET_VALUE_MASK,
    });
    expect(JSON.parse(served[0]!.after_json!)).toEqual({
      id: sharedId,
      body: 'v2',
      secret: SECRET_VALUE_MASK,
    });

    // The stored rows are untouched by the serve-time mask (it copies).
    expect(stored[0]!.before_json).toContain('top-secret');

    // A schema entry's payload is a data-model document, not a row snapshot — a
    // column NAME there is not a value to mask, so it passes through whole.
    const schemaEntry = {
      ...stored[0]!,
      operation: 'schema.add_column',
      before_json: null,
      after_json: JSON.stringify({ table: 'notes', secret: 'text' }),
    };
    expect(maskAuditImages([schemaEntry], secretCols)[0]!.after_json).toBe(schemaEntry.after_json);

    // A table with no secret columns is passed through untouched.
    const otherTable = { ...stored[0]!, table_name: 'other' };
    expect(maskAuditImages([otherTable], secretCols)[0]!.before_json).toBe(otherTable.before_json);
  }, 120_000);
});
