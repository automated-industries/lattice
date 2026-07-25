import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfig } from '../../src/gui/lifecycle.js';
import type { ActiveDb } from '../../src/gui/active-db.js';
import { applyDepsFor } from '../../src/gui/planner/run.js';

/**
 * The two PROPOSE-tier data-model appliers wired in 5.2.1 — `dedupRows` (→
 * findTableDuplicates + mergeDuplicates) and `mergeTables` (→ aiDeleteEntity
 * move_to). Before 5.2.1 both returned the "…apply is not wired in this build
 * yet" stub, so the Apply button was a documented-but-broken affordance. These
 * assert the real primitives run and errors surface (never a silent no-op).
 */

const dirs: string[] = [];
const actives: ActiveDb[] = [];

afterEach(() => {
  for (const a of actives.splice(0)) a.db.close();
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
      '',
    ].join('\n'),
    'utf8',
  );
  const active = await openConfig(configPath, join(root, 'context'), false);
  actives.push(active);
  return active;
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
});
