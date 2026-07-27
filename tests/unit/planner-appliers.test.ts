import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfig, applySchemaConfig } from '../../src/gui/lifecycle.js';
import { parseAudit, type AuditEntry } from '../../src/gui/mutations.js';
import type { ActiveDb } from '../../src/gui/active-db.js';
import { applyDepsFor } from '../../src/gui/planner/run.js';
import { retypeSql } from '../../src/gui/planner/appliers.js';

/**
 * The PROPOSE-tier data-model appliers, wired to the real audited primitives:
 * `dedupRows` (→ findTableDuplicates + mergeDuplicates), `mergeTables` (→
 * aiDeleteEntity move_to), `renameTable` (→ RENAME DDL + config move, recorded
 * as the revertible rename op), `extractDimension` (→ createUserEntity +
 * createRow + addUserColumn + updateRow + createUserRelation) and
 * `retypeColumn` (dialect-split DDL + config field retype). Each of them once
 * returned the "…apply is not wired in this build yet" stub, so the Apply
 * button was a documented-but-broken affordance. These assert the real
 * primitives run, the change reverts, and errors surface (never a silent
 * no-op).
 */

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
  const root = mkdtempSync(join(tmpdir(), 'lattice-appliers-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  things:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      created_at: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: things.md',
      '  contacts:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: contacts.md',
      '  people:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: people.md',
      '  orders:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      code: { type: text }',
      '      status: { type: text }',
      '      qty: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: orders.md',
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

/** Revert one schema audit entry through the shared schema-revert path, keeping
 *  the reopened workspace registered for teardown. */
async function revertSchema(active: ActiveDb, entry: AuditEntry): Promise<ActiveDb> {
  const idx = actives.indexOf(active);
  const next = await applySchemaConfig(active, entry, 'inverse', false);
  if (idx >= 0) actives.splice(idx, 1, next);
  else actives.push(next);
  return next;
}

const liveIds = async (active: ActiveDb, table: string): Promise<string[]> => {
  const rows = await active.db.query(table, { filters: [{ col: 'deleted_at', op: 'isNull' }] });
  return rows.map((r) => String((r as Record<string, unknown>).id)).sort();
};

describe('data-model planner appliers (wired to real primitives)', () => {
  it('dedupRows is wired (not staged) and soft-deletes duplicate rows onto the oldest survivor', async () => {
    const active = await boot();
    await active.db.insert('things', {
      id: 't1',
      name: 'Acme',
      created_at: '2026-01-01T00:00:00Z',
    });
    await active.db.insert('things', {
      id: 't2',
      name: 'Acme',
      created_at: '2026-01-02T00:00:00Z',
    });
    await active.db.insert('things', {
      id: 't3',
      name: 'Other',
      created_at: '2026-01-03T00:00:00Z',
    });

    const r = await applyDepsFor(active, 'test-session').dedupRows('things');
    expect(r).toEqual({ ok: true }); // NOT { ok:false, error:'dedup apply is not wired…' }

    // t2 (a duplicate of t1 by name) is soft-deleted; t1 survivor + t3 kept.
    expect(await liveIds(active, 'things')).toEqual(['t1', 't3']);
  });

  it('dedupRows on a table with no duplicates still returns ok (wired, no-op)', async () => {
    const active = await boot();
    await active.db.insert('things', { id: 'a', name: 'A', created_at: '2026-01-01T00:00:00Z' });
    const r = await applyDepsFor(active, 's').dedupRows('things');
    expect(r).toEqual({ ok: true });
    expect(await liveIds(active, 'things')).toEqual(['a']);
  });

  it('mergeTables is wired and moves rows from the source into the target', async () => {
    const active = await boot();
    await active.db.insert('contacts', { id: 'c1', name: 'Ada' });
    const r = await applyDepsFor(active, 'test-session').mergeTables('contacts', 'people');
    expect(r.ok).toBe(true);
    const people = await active.db.query('people', {});
    expect(people.some((p) => String((p as Record<string, unknown>).name) === 'Ada')).toBe(true);
  });

  it('mergeTables surfaces an error for an unknown target (no silent success)', async () => {
    const active = await boot();
    await active.db.insert('contacts', { id: 'c1', name: 'Ada' });
    const r = await applyDepsFor(active, 's').mergeTables('contacts', 'no_such_table');
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  // ── canonical_rename ──────────────────────────────────────────────────────
  it('renameTable is wired: it renames physically + in config, and reverts cleanly', async () => {
    const active = await boot();
    await active.db.insert('orders', { id: 'o1', code: 'A-1', status: 'new', qty: '1' });

    const r = await applyDepsFor(active, 'sess').renameTable('orders', 'purchase_orders');
    expect(r).toEqual({ ok: true }); // NOT the staged stub

    expect(active.db.getRegisteredTableNames()).toContain('purchase_orders');
    expect(active.db.getRegisteredTableNames()).not.toContain('orders');
    expect(active.validTables.has('purchase_orders')).toBe(true);
    expect(active.validTables.has('orders')).toBe(false);
    expect(await active.db.query('purchase_orders', {})).toHaveLength(1);
    expect(readFileSync(active.configPath, 'utf8')).toContain('purchase_orders');

    // The rename is recorded as the shared revertible schema op, so the
    // existing history revert path puts it back — data intact.
    const reverted = await revertSchema(active, await auditEntry(active, 'schema.rename_entity'));
    expect(reverted.db.getRegisteredTableNames()).toContain('orders');
    expect(reverted.db.getRegisteredTableNames()).not.toContain('purchase_orders');
    expect(await reverted.db.query('orders', {})).toHaveLength(1);
  });

  it('renameTable refuses a name that is already taken (no silent success)', async () => {
    const active = await boot();
    const r = await applyDepsFor(active, 'sess').renameTable('orders', 'people');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already/i);
  });

  // ── extract_dimension ─────────────────────────────────────────────────────
  it('extractDimension is wired: it builds the dimension, links it, backfills, and reverts', async () => {
    const active = await boot();
    await active.db.insert('orders', { id: 'o1', code: 'A-1', status: 'new', qty: '1' });
    await active.db.insert('orders', { id: 'o2', code: 'A-2', status: 'shipped', qty: '2' });
    await active.db.insert('orders', { id: 'o3', code: 'A-3', status: 'new', qty: '3' });

    const r = await applyDepsFor(active, 'sess').extractDimension('orders', 'status', 'statuses');
    expect(r).toEqual({ ok: true }); // NOT the staged stub

    // One dimension row per distinct value.
    const dim = (await active.db.query('statuses', {})) as Record<string, unknown>[];
    expect(dim.map((d) => String(d.name)).sort()).toEqual(['new', 'shipped']);

    // The source table gained the FK column and every row is backfilled.
    const byName = new Map(dim.map((d) => [String(d.name), String(d.id)]));
    const orders = (await active.db.query('orders', {})) as Record<string, unknown>[];
    for (const o of orders) {
      expect(o.statuses_id).toBe(byName.get(String(o.status)));
    }

    // The relationship is declared in config, so the model actually normalizes.
    expect(readFileSync(active.configPath, 'utf8')).toMatch(/statuses/);

    // Every structural step reverts through the shared schema-revert path,
    // newest first — and no source row is lost along the way.
    let cur = await revertSchema(active, await auditEntry(active, 'schema.add_link'));
    cur = await revertSchema(cur, await auditEntry(cur, 'schema.create_entity'));
    const cfg = readFileSync(cur.configPath, 'utf8');
    expect(cfg).not.toMatch(/^\s{2}statuses:/m);
    expect(cfg).not.toMatch(/statuses_id/);
    expect(await cur.db.query('orders', {})).toHaveLength(3);
  });

  it('extractDimension refuses a column that does not exist (no silent success)', async () => {
    const active = await boot();
    const r = await applyDepsFor(active, 'sess').extractDimension('orders', 'nope', 'nopes');
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  // ── retype_column ─────────────────────────────────────────────────────────
  it('retypeColumn is wired: it retypes TEXT → integer, keeps values, and reverts', async () => {
    const active = await boot();
    await active.db.insert('orders', { id: 'o1', code: 'A-1', status: 'new', qty: '1' });
    await active.db.insert('orders', { id: 'o2', code: 'A-2', status: 'new', qty: '42' });
    await active.db.insert('orders', { id: 'o3', code: 'A-3', status: 'new', qty: '' });

    const r = await applyDepsFor(active, 'sess').retypeColumn('orders', 'qty', 'integer');
    expect(r).toEqual({ ok: true }); // NOT the staged stub

    expect(active.db.getRegisteredFieldTypes('orders')?.qty).toBe('integer');
    const rows = (await active.db.query('orders', { orderBy: 'id', orderDir: 'asc' })) as Record<
      string,
      unknown
    >[];
    expect(rows.map((x) => x.qty)).toEqual([1, 42, null]);
    // The other columns and the row identities survive the rebuild.
    expect(rows.map((x) => String(x.code))).toEqual(['A-1', 'A-2', 'A-3']);

    // The op is its own inverse: retyping back restores the text form.
    const back = await applyDepsFor(active, 'sess').retypeColumn('orders', 'qty', 'text');
    expect(back).toEqual({ ok: true });
    expect(active.db.getRegisteredFieldTypes('orders')?.qty).toBe('text');
    const after = (await active.db.query('orders', { orderBy: 'id', orderDir: 'asc' })) as Record<
      string,
      unknown
    >[];
    expect(after.map((x) => x.qty)).toEqual(['1', '42', null]);
  });

  it('retypeColumn refuses when a stored value cannot convert (never a silent zero)', async () => {
    const active = await boot();
    await active.db.insert('orders', { id: 'o1', code: 'A-1', status: 'new', qty: '1' });
    await active.db.insert('orders', { id: 'o2', code: 'A-2', status: 'new', qty: 'lots' });

    const r = await applyDepsFor(active, 'sess').retypeColumn('orders', 'qty', 'integer');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/lots/);
    // Nothing was rewritten.
    expect(active.db.getRegisteredFieldTypes('orders')?.qty).toBe('text');
    const rows = (await active.db.query('orders', { orderBy: 'id', orderDir: 'asc' })) as Record<
      string,
      unknown
    >[];
    expect(rows.map((x) => x.qty)).toEqual(['1', 'lots']);
  });

  it('retypeSql splits on dialect: Postgres ALTER COLUMN TYPE vs the SQLite column rebuild', () => {
    const pg = retypeSql('postgres', 'orders', 'qty', 'INTEGER', 'qty_lattice_retype');
    expect(pg).toHaveLength(1);
    expect(pg[0]).toBe(
      'ALTER TABLE "orders" ALTER COLUMN "qty" TYPE INTEGER USING ("qty"::INTEGER)',
    );

    // SQLite has no ALTER COLUMN TYPE — rebuild the column instead.
    const lite = retypeSql('sqlite', 'orders', 'qty', 'INTEGER', 'qty_lattice_retype');
    expect(lite.some((s) => /ALTER COLUMN/i.test(s))).toBe(false);
    expect(lite).toEqual([
      'ALTER TABLE "orders" ADD COLUMN "qty_lattice_retype" INTEGER',
      'UPDATE "orders" SET "qty_lattice_retype" = CAST("qty" AS INTEGER)',
      'ALTER TABLE "orders" DROP COLUMN "qty"',
      'ALTER TABLE "orders" RENAME COLUMN "qty_lattice_retype" TO "qty"',
    ]);
  });

  it('retypeSql builds the same shapes for a TEXT target (the reverse direction)', () => {
    expect(retypeSql('postgres', 'orders', 'qty', 'TEXT', 'qty_lattice_retype')).toEqual([
      'ALTER TABLE "orders" ALTER COLUMN "qty" TYPE TEXT USING ("qty"::TEXT)',
    ]);
    expect(retypeSql('sqlite', 'orders', 'qty', 'TEXT', 'qty_lattice_retype')).toEqual([
      'ALTER TABLE "orders" ADD COLUMN "qty_lattice_retype" TEXT',
      'UPDATE "orders" SET "qty_lattice_retype" = CAST("qty" AS TEXT)',
      'ALTER TABLE "orders" DROP COLUMN "qty"',
      'ALTER TABLE "orders" RENAME COLUMN "qty_lattice_retype" TO "qty"',
    ]);
  });
});
