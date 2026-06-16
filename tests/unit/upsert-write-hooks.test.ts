import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/index.js';
import type { WriteHookContext } from '../../src/types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function makeDb(): Promise<Lattice> {
  const base = mkdtempSync(join(tmpdir(), 'lattice-upsert-hooks-'));
  dirs.push(base);
  const db = new Lattice(join(base, 'test.db'));
  db.define('items', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      name: 'TEXT NOT NULL',
      status: 'TEXT',
    },
    render: () => '',
    outputFile: 'ITEMS.md',
  });
  await db.init();
  return db;
}

describe('upsert() fires write hooks', () => {
  it('fires a hook on a fresh upsert (no prior row)', async () => {
    const db = await makeDb();
    const calls: WriteHookContext[] = [];
    db.defineWriteHook({
      table: 'items',
      on: ['insert', 'update', 'delete'],
      handler: (ctx) => {
        calls.push(ctx);
      },
    });
    const id = await db.upsert('items', { name: 'foo', status: 'open' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.table).toBe('items');
    // upsert classifies as 'update' (matches the audit op already emitted by
    // this code path; insert-vs-update detection isn't portably cheap across
    // SQLite/Postgres). Callers needing strict insert semantics use insert().
    expect(calls[0]?.op).toBe('update');
    expect(calls[0]?.pk).toBe(id);
    expect(calls[0]?.row).toMatchObject({ name: 'foo', status: 'open' });
    db.close();
  });

  it('fires a hook on a conflict-update upsert', async () => {
    const db = await makeDb();
    const id = await db.insert('items', { name: 'bar', status: 'open' });
    const calls: WriteHookContext[] = [];
    db.defineWriteHook({
      table: 'items',
      on: ['insert', 'update', 'delete'],
      handler: (ctx) => {
        calls.push(ctx);
      },
    });
    await db.upsert('items', { id, name: 'bar', status: 'done' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.op).toBe('update');
    expect(calls[0]?.pk).toBe(id);
    expect(calls[0]?.row).toMatchObject({ status: 'done' });
    db.close();
  });

  it('hook does not fire when on: list excludes update', async () => {
    const db = await makeDb();
    const calls: WriteHookContext[] = [];
    db.defineWriteHook({
      table: 'items',
      on: ['delete'],
      handler: (ctx) => {
        calls.push(ctx);
      },
    });
    await db.upsert('items', { name: 'baz' });
    expect(calls).toHaveLength(0);
    db.close();
  });
});
