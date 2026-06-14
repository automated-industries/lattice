import { describe, it, expect, vi } from 'vitest';
import { updateRow, createRow, type MutationCtx } from '../../src/gui/mutations.js';

/**
 * Auto-create unknown columns at the GUI mutation boundary, so a caller (the
 * assistant) that writes a field the table lacks gets the data PERSISTED instead
 * of silently dropped + falsely reported as success. Internal tables are never
 * extended. On SQLite the cloud audience-view step is skipped (getDialect).
 */
function makeCtx(existing: Record<string, string>) {
  const cols: Record<string, string> = { ...existing };
  const stored: Record<string, unknown> = { id: '1', title: 'todo' };
  const addColumn = vi.fn((_t: string, c: string, ty: string) => {
    cols[c] = ty;
    return Promise.resolve();
  });
  const ctx = {
    db: {
      getRegisteredColumns: () => cols,
      getDialect: () => 'sqlite',
      getPrimaryKey: () => ['id'],
      addColumn,
      get: () => Promise.resolve({ ...stored }),
      update: (_t: string, _id: string, vals: Record<string, unknown>) => {
        Object.assign(stored, vals);
        return Promise.resolve();
      },
      insert: () => Promise.resolve('1'),
      query: () => Promise.resolve([]),
      delete: () => Promise.resolve(),
    },
    feed: { publish: vi.fn() },
    softDeletable: new Set<string>(),
    source: 'gui',
  } as unknown as MutationCtx;
  return { ctx, addColumn };
}

describe('3.1 — assistant writes auto-create missing columns (no silent drop)', () => {
  it('updateRow creates an unknown column (TEXT) and persists the value', async () => {
    const { ctx, addColumn } = makeCtx({ id: 'TEXT', title: 'TEXT' });
    await updateRow(ctx, 'insurance_policies', '1', { summary: 'a one-line summary' });
    expect(addColumn).toHaveBeenCalledWith('insurance_policies', 'summary', 'TEXT');
  });

  it('does NOT create a column that already exists', async () => {
    const { ctx, addColumn } = makeCtx({ id: 'TEXT', title: 'TEXT' });
    await updateRow(ctx, 'insurance_policies', '1', { title: 'changed' });
    expect(addColumn).not.toHaveBeenCalled();
  });

  it('infers INTEGER / REAL column types from numeric values', async () => {
    const { ctx, addColumn } = makeCtx({ id: 'TEXT', title: 'TEXT' });
    await updateRow(ctx, 'insurance_policies', '1', { count: 5, rate: 1.5 });
    expect(addColumn).toHaveBeenCalledWith('insurance_policies', 'count', 'INTEGER');
    expect(addColumn).toHaveBeenCalledWith('insurance_policies', 'rate', 'REAL');
  });

  it('never auto-extends internal bookkeeping tables', async () => {
    const { ctx, addColumn } = makeCtx({ id: 'TEXT' });
    await createRow(ctx, '__lattice_user_identity', { id: 'x', bogus: 'y' });
    expect(addColumn).not.toHaveBeenCalled();
  });

  it('createRow auto-creates a missing column before inserting', async () => {
    const { ctx, addColumn } = makeCtx({ id: 'TEXT', title: 'TEXT' });
    await createRow(ctx, 'insurance_policies', { id: '2', title: 't', summary: 's' });
    expect(addColumn).toHaveBeenCalledWith('insurance_policies', 'summary', 'TEXT');
  });
});
