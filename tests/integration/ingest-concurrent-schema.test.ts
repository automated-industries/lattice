import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfig, type ActiveDb } from '../../src/gui/server.js';
import { createUserEntity, createFileJunction } from '../../src/gui/schema-ops.js';

/**
 * Parallel folder ingest (INGEST_CONCURRENCY files at once) runs the real schema
 * ops — createUserEntity / createFileJunction — from multiple in-flight files on
 * the SAME synchronous SQLite connection. This is the exact scenario the user
 * asked to prove safe: "two files creating the same/different new object
 * simultaneously." Each op is a check-then-CREATE that straddles awaits; without
 * the Lattice schema lock two concurrent callers for the same new entity both pass
 * the "not registered" check and both run CREATE TABLE, and the loser throws "table
 * already exists". These tests drive the production ops against a real ActiveDb
 * (openConfig, auto-render OFF) and assert the concurrent path converges to ONE
 * table and never throws. See tests/unit/schema-lock.test.ts for the primitive.
 */

const dirs: string[] = [];
const dbs: ActiveDb[] = [];

afterEach(() => {
  for (const a of dbs.splice(0)) a.db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<ActiveDb> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-ingest-concurrent-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  people:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: people.md',
      '',
    ].join('\n'),
    'utf8',
  );
  const active = await openConfig(configPath, join(root, 'context'), false);
  dbs.push(active);
  // openConfig kicks off background owner-side convergence (adoptNativeEntities etc.)
  // that opens its own db.transaction(). In production, ingest happens long after the
  // workspace is open + converged, so they never overlap; here the test fires ops
  // immediately, so wait for convergence to settle first. This isolates the test to the
  // real target — concurrent createUserEntity/createFileJunction racing each OTHER.
  await active.converged;
  return active;
}

/** How many of `name` are registered right now (native + user + junction names). */
function tableCount(active: ActiveDb, name: string): number {
  return active.db.getRegisteredTableNames().filter((t) => t === name).length;
}

describe('concurrent ingest schema ops — same/different new object at once', () => {
  it('two files extracting the SAME new entity → one table, both resolve to it, no throw', async () => {
    const active = await boot();
    const outcomes = await Promise.allSettled([
      createUserEntity(active, 'invoices', ['amount', 'vendor'], 'sess-a'),
      createUserEntity(active, 'invoices', ['amount', 'vendor'], 'sess-b'),
    ]);
    // Neither call throws — the loser reuses instead of colliding on CREATE TABLE.
    for (const o of outcomes) expect(o.status).toBe('fulfilled');
    const names = outcomes.map((o) => (o.status === 'fulfilled' ? o.value : null));
    expect(names).toEqual(['invoices', 'invoices']);
    // Exactly ONE physical/registered `invoices` table.
    expect(tableCount(active, 'invoices')).toBe(1);
    expect(active.validTables.has('invoices')).toBe(true);
    // Exactly ONE create audit op was recorded — the loser REUSED the table rather
    // than re-running the whole create body (config write + secure + audit). This is
    // the deterministic correctness guard: without the lock, both callers get past the
    // existence check and each records its own schema.create_entity op (IF NOT EXISTS
    // stops the raw CREATE from throwing, but the duplicate bookkeeping still happens).
    const audit = (await active.db.query('_lattice_gui_audit', {})) as {
      operation?: string;
      table_name?: string;
    }[];
    const creates = audit.filter(
      (a) => a.operation === 'schema.create_entity' && a.table_name === 'invoices',
    );
    expect(creates.length).toBe(1);
    // The table is writable and consistent.
    const id = await active.db.insert('invoices', { name: 'Acme', amount: '100' });
    expect(typeof id).toBe('string');
  });

  it('two files extracting DIFFERENT new entities at once → both tables created', async () => {
    const active = await boot();
    const outcomes = await Promise.allSettled([
      createUserEntity(active, 'invoices', ['amount'], 'sess-a'),
      createUserEntity(active, 'receipts', ['total'], 'sess-b'),
      createUserEntity(active, 'contracts', ['party'], 'sess-c'),
    ]);
    for (const o of outcomes) expect(o.status).toBe('fulfilled');
    for (const t of ['invoices', 'receipts', 'contracts']) {
      expect(active.validTables.has(t)).toBe(true);
      expect(tableCount(active, t)).toBe(1);
    }
  });

  it('two files auto-linking to the SAME new entity → one files_<entity> junction, no throw', async () => {
    const active = await boot();
    const entity = await createUserEntity(active, 'vendors', ['name'], 'sess');
    expect(entity).toBe('vendors');
    const outcomes = await Promise.allSettled([
      createFileJunction(active, 'vendors', 'sess-a'),
      createFileJunction(active, 'vendors', 'sess-b'),
    ]);
    for (const o of outcomes) expect(o.status).toBe('fulfilled');
    // Both resolve to the same mapping; the junction is created exactly once.
    for (const o of outcomes) {
      if (o.status === 'fulfilled') expect(o.value?.junction).toBe('files_vendors');
    }
    expect(tableCount(active, 'files_vendors')).toBe(1);
    expect(active.junctionTables.has('files_vendors')).toBe(true);
  });

  it('a wider fan-out (8 files, same entity) still converges to one table', async () => {
    const active = await boot();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, (_v, i) =>
        createUserEntity(active, 'orders', ['sku', 'qty'], `sess-${String(i)}`),
      ),
    );
    for (const o of outcomes) expect(o.status).toBe('fulfilled');
    for (const o of outcomes) {
      if (o.status === 'fulfilled') expect(o.value).toBe('orders');
    }
    expect(tableCount(active, 'orders')).toBe(1);
  });
});
