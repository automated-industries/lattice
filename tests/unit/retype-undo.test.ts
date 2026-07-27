import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfig, applySchemaConfig } from '../../src/gui/lifecycle.js';
import { parseAudit, type AuditEntry } from '../../src/gui/mutations.js';
import type { ActiveDb } from '../../src/gui/active-db.js';
import { applyRetypeColumn } from '../../src/gui/planner/appliers.js';

/**
 * A column retype must be reversible from history like every other schema op.
 *
 * It is the one op that cannot be replayed from a config diff: it moves the
 * column's storage class and rewrites every value, so the revert has to run the
 * applier again rather than edit the config document. Before this was wired,
 * `applySchemaConfig` had no case for it and Undo failed outright with "Cannot
 * revert unknown schema op" — leaving retype as the only schema change the
 * history could not reverse.
 */

const dirs: string[] = [];
const actives: ActiveDb[] = [];

afterEach(() => {
  for (const a of actives.splice(0)) {
    try {
      a.db.close();
    } catch {
      // already disposed by a revert-driven reopen
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<ActiveDb> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-retype-undo-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  orders:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      code: { type: text }',
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

async function revert(active: ActiveDb, entry: AuditEntry): Promise<ActiveDb> {
  const idx = actives.indexOf(active);
  const next = await applySchemaConfig(active, entry, 'inverse', false);
  if (idx >= 0) actives.splice(idx, 1, next);
  else actives.push(next);
  return next;
}

const qtyOf = async (active: ActiveDb): Promise<unknown[]> => {
  const rows = (await active.db.query('orders', {
    filters: [{ col: 'deleted_at', op: 'isNull' }],
    orderBy: 'code',
  })) as Record<string, unknown>[];
  return rows.map((r) => r.qty);
};

describe('a column retype is reversible from history', () => {
  it('undoes a text→integer retype, restoring the declared type and the values', async () => {
    let active = await boot();
    await active.db.insert('orders', { id: 'o1', code: 'A', qty: '3' });
    await active.db.insert('orders', { id: 'o2', code: 'B', qty: '11' });

    const applied = await applyRetypeColumn(active, 'orders', 'qty', 'integer', 's1');
    expect(applied.ok).toBe(true);
    expect(active.db.getRegisteredFieldTypes('orders')?.qty).toBe('integer');
    expect(await qtyOf(active)).toEqual([3, 11]);

    // The whole point: this used to throw "Cannot revert unknown schema op".
    const entry = await auditEntry(active, 'schema.retype_column');
    active = await revert(active, entry);

    expect(active.db.getRegisteredFieldTypes('orders')?.qty).toBe('text');
    // Values survive the round trip — an undo that restored the type but lost
    // the data would be worse than no undo at all.
    expect((await qtyOf(active)).map(String)).toEqual(['3', '11']);
  });

  it('surfaces an incomplete retype entry loudly instead of reporting a no-op success', async () => {
    const active = await boot();
    await applyRetypeColumn(active, 'orders', 'qty', 'integer', 's1');
    const entry = await auditEntry(active, 'schema.retype_column');

    // A truncated payload must fail out loud rather than "succeed" having done
    // nothing — a silent no-op would leave the user believing the undo worked.
    await expect(
      applySchemaConfig(active, { ...entry, before_json: '{}' }, 'inverse', false),
    ).rejects.toThrow(/incomplete/i);
  });
});

describe('a column add is reversible from history', () => {
  it('undoes an add_column instead of throwing on an unusable payload', async () => {
    let active = await boot();
    const { addUserColumn } = await import('../../src/gui/schema-ops.js');
    const added = await addUserColumn(active, 'orders', 'note', 's1');
    expect(added.ok).toBe(true);
    const colsOf = (a: ActiveDb): string[] =>
      Object.keys(a.db.getRegisteredColumns('orders') ?? {});
    expect(colsOf(active)).toContain('note');

    // The audit payload previously omitted `entity` and `fieldDef`, which the
    // revert path reads — so Undo threw rather than removing the column.
    const entry = await auditEntry(active, 'schema.add_column');
    active = await revert(active, entry);

    expect(colsOf(active)).not.toContain('note');
  });
});
