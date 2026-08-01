/**
 * Links and definitions, performed with no server in the process.
 *
 * Nesting one table inside another, un-nesting it, and saying what a column
 * MEANS used to be reachable only by sending yourself an HTTP request: the work
 * lived inside the request handlers, so a script, a command, or a job could not
 * do any of it. These pin the extracted operations directly — no adapter, no
 * port — and, more importantly, pin the two properties that are easy to lose in
 * a move like that:
 *
 *   A LINK IS BOTH HALVES. The foreign-key column and the belongsTo relation
 *   over it are added together and removed together. A column nothing reads and
 *   a relation pointing at a missing column are both silent, and both are what
 *   you get if one half is dropped.
 *
 *   REMOVING A LINK KEEPS THE VALUES. The declaration goes; the column and its
 *   contents stay, which is the whole reason the recorded op can be reverted
 *   without a snapshot. The reverse of that — reusing the left-behind column for
 *   a NEW link — would resurrect the old foreign keys under a fresh relation, so
 *   the naming has to step past it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfig, applySchemaConfig } from '../../src/gui/lifecycle.js';
import { parseAudit, type AuditEntry } from '../../src/gui/mutations.js';
import type { ActiveDb } from '../../src/gui/active-db.js';
import { addUserLink, removeUserLink, setColumnMeta } from '../../src/gui/schema-ops.js';
import { upsertTableMeta } from '../../src/gui/column-descriptions.js';

const dirs: string[] = [];
const actives: ActiveDb[] = [];

afterEach(() => {
  for (const a of actives.splice(0)) {
    try {
      a.db.close();
    } catch {
      // already disposed by a revert-driven reopen in the test body
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<ActiveDb> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-links-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  customers:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: customers.md',
      '  orders:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      code: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: orders.md',
      '  suppliers:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: suppliers.md',
      '',
    ].join('\n'),
    'utf8',
  );
  const active = await openConfig(configPath, join(root, 'context'), false);
  actives.push(active);
  return active;
}

/** Newest audit entry for an operation — the handle a revert needs. */
async function auditEntry(active: ActiveDb, operation: string): Promise<AuditEntry> {
  const rows = (await active.db.query('_lattice_gui_audit', {
    filters: [{ col: 'operation', op: 'eq', val: operation }],
    orderBy: 'ts',
    orderDir: 'desc',
    limit: 1,
  })) as Record<string, unknown>[];
  const row = rows[0];
  if (!row) throw new Error(`no audit entry recorded for ${operation}`);
  return parseAudit(row);
}

/** Revert one schema entry through the shared path, keeping the reopened
 *  workspace registered for teardown. */
async function revertSchema(active: ActiveDb, entry: AuditEntry): Promise<ActiveDb> {
  const idx = actives.indexOf(active);
  const next = await applySchemaConfig(active, entry, 'inverse', false);
  if (idx >= 0) actives.splice(idx, 1, next);
  else actives.push(next);
  return next;
}

describe('adding a link, headlessly', () => {
  it('adds the foreign-key column AND the relation, and records one reversible op', async () => {
    const active = await boot();

    const outcome = await addUserLink(active, 'orders', 'customers', 'test-session');

    expect(outcome).toEqual({ ok: true, column: 'customers_id' });
    // The column is live on the database, not just declared.
    expect(await active.db.introspectColumns('orders')).toContain('customers_id');
    // BOTH halves are in the configuration.
    const cfg = readFileSync(active.configPath, 'utf8');
    expect(cfg).toMatch(/customers_id/);
    expect(cfg).toMatch(/belongsTo/);

    // One op, carrying the field AND the relation, so the inverse can take both.
    const entry = await auditEntry(active, 'schema.add_link');
    const after = JSON.parse(entry.after_json ?? '{}') as Record<string, unknown>;
    expect(after.entity).toBe('orders');
    expect(after.column).toBe('customers_id');
    expect(after.relationName).toBe('customers');
    expect(after.relation).toEqual({
      type: 'belongsTo',
      table: 'customers',
      foreignKey: 'customers_id',
    });

    // Undo removes both halves.
    const reverted = await revertSchema(active, entry);
    const undone = readFileSync(reverted.configPath, 'utf8');
    expect(undone).not.toMatch(/customers_id/);
    expect(undone).not.toMatch(/belongsTo/);
  });

  it('refuses a second link to the same table rather than making a duplicate column', async () => {
    const active = await boot();
    await addUserLink(active, 'orders', 'customers', 's');

    const again = await addUserLink(active, 'orders', 'customers', 's');

    expect(again).toEqual({ ok: false, error: expect.stringContaining('already links') });
  });

  it('refuses mutual nesting — two tables can never contain each other', async () => {
    const active = await boot();
    await addUserLink(active, 'orders', 'customers', 's');

    const back = await addUserLink(active, 'customers', 'orders', 's');

    expect(back).toEqual({
      ok: false,
      error: expect.stringContaining('cannot be nested into each other'),
    });
  });

  it('refuses a table this workspace does not have (no silent success)', async () => {
    const active = await boot();

    expect(await addUserLink(active, 'orders', 'nope', 's')).toEqual({
      ok: false,
      error: 'Target entity must exist',
    });
    expect(await addUserLink(active, 'nope', 'orders', 's')).toEqual({
      ok: false,
      error: 'Unknown entity: nope',
    });
  });
});

describe('removing a link, headlessly', () => {
  it('drops the declaration, keeps the values, and reverts with them intact', async () => {
    const active = await boot();
    await active.db.insert('customers', { id: 'c1', name: 'Ada' });
    await addUserLink(active, 'orders', 'customers', 's');
    await active.db.insert('orders', { id: 'o1', code: 'A-1', customers_id: 'c1' });

    const removed = await removeUserLink(active, 'orders', 'customers_id', 's');

    if (!removed.ok) throw new Error(`removing the link was refused: ${removed.error}`);
    expect(removed.target).toBe('customers');
    expect(removed.undoId).toBeTruthy();
    // The declaration is gone…
    expect(readFileSync(active.configPath, 'utf8')).not.toMatch(/customers_id/);
    // …and the column is still physically there, holding its foreign keys, which
    // is the only reason the revert below needs no snapshot.
    expect(await active.db.introspectColumns('orders')).toContain('customers_id');

    const reverted = await revertSchema(active, await auditEntry(active, 'schema.delete_link'));
    expect(readFileSync(reverted.configPath, 'utf8')).toMatch(/customers_id/);
    const rows = (await reverted.db.query('orders', {})) as Record<string, unknown>[];
    expect(rows[0]?.customers_id).toBe('c1');
  });

  it('a new link steps past the column a removed one left behind', async () => {
    // The trap: `addColumn` skips a column that is already there, so reusing the
    // name would adopt the removed link's foreign keys under a freshly declared
    // relation — old values appearing under a link the user just made.
    const active = await boot();
    await addUserLink(active, 'orders', 'customers', 's');
    await active.db.insert('orders', { id: 'o1', code: 'A-1', customers_id: 'stale' });
    await removeUserLink(active, 'orders', 'customers_id', 's');

    const second = await addUserLink(active, 'orders', 'customers', 's');

    expect(second).toEqual({ ok: true, column: 'customers_id_2' });
    const rows = (await active.db.query('orders', {})) as Record<string, unknown>[];
    expect(rows[0]?.customers_id_2 ?? null).toBeNull();
  });

  it('refuses a column that is not a link (no silent success)', async () => {
    const active = await boot();

    expect(await removeUserLink(active, 'orders', 'code', 's')).toEqual({
      ok: false,
      error: 'Not a link column: code',
    });
    expect(await removeUserLink(active, 'nope', 'code', 's')).toEqual({
      ok: false,
      error: 'Unknown entity: nope',
    });
  });
});

describe('definitions and masking, headlessly', () => {
  const columnMeta = async (
    active: ActiveDb,
    table: string,
    column: string,
  ): Promise<Record<string, unknown> | undefined> =>
    (
      (await active.db.query('_lattice_gui_column_meta', {
        filters: [
          { col: 'table_name', op: 'eq', val: table },
          { col: 'column_name', op: 'eq', val: column },
        ],
      })) as Record<string, unknown>[]
    )[0];

  it('writes a column definition, and clears it with an empty one', async () => {
    const active = await boot();

    expect(
      await setColumnMeta(active, 'orders', 'code', { description: 'The order number.' }),
    ).toEqual({ ok: true });
    expect((await columnMeta(active, 'orders', 'code'))?.description).toBe('The order number.');

    await setColumnMeta(active, 'orders', 'code', { description: '' });
    expect((await columnMeta(active, 'orders', 'code'))?.description).toBeNull();
  });

  it('marks a column secret, and stops', async () => {
    const active = await boot();

    await setColumnMeta(active, 'orders', 'code', { secret: true });
    expect((await columnMeta(active, 'orders', 'code'))?.secret).toBe(1);

    await setColumnMeta(active, 'orders', 'code', { secret: false });
    expect((await columnMeta(active, 'orders', 'code'))?.secret).toBe(0);
  });

  it('refuses secrecy where it would be meaningless, and says which case it is', async () => {
    const active = await boot();
    await addUserLink(active, 'orders', 'customers', 's');

    expect(await setColumnMeta(active, 'orders', 'id', { secret: true })).toEqual({
      ok: false,
      error: '"id" is a system column and cannot be marked secret',
    });
    expect(await setColumnMeta(active, 'orders', 'customers_id', { secret: true })).toEqual({
      ok: false,
      error: 'Link (foreign-key) columns cannot be marked secret',
    });
    // A definition is fine on any column, including those two.
    expect(
      await setColumnMeta(active, 'orders', 'customers_id', { description: 'Who ordered.' }),
    ).toEqual({ ok: true });
  });

  it('refuses a table this workspace does not have, and a patch that says nothing', async () => {
    const active = await boot();

    expect(await setColumnMeta(active, 'nope', 'code', { description: 'x' })).toEqual({
      ok: false,
      error: 'Unknown table: nope',
    });
    // An empty patch is a caller mistake, not a no-op that reports success.
    expect(await setColumnMeta(active, 'orders', 'code', {})).toEqual({
      ok: false,
      error: 'nothing to update (expected secret or description)',
    });
  });

  it('sets a table icon and description without a browser', async () => {
    const active = await boot();

    await upsertTableMeta(active.db, 'orders', {
      icon: '📦',
      description: 'Things people bought.',
    });

    const row = (await active.db.get('_lattice_gui_meta', 'orders')) as Record<string, unknown>;
    expect(row.icon).toBe('📦');
    expect(row.description).toBe('Things people bought.');
  });
});
