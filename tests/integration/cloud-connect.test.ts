import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { probeCloud } from '../../src/framework/cloud-connect.js';

const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lattice-probe-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('probeCloud()', () => {
  it('returns reachable: true + isCloud: false for a fresh SQLite target', async () => {
    const root = tempDir();
    const dbPath = join(root, 'fresh.db');
    const url = `file:${dbPath}`;
    const result = await probeCloud(url);
    expect(result.reachable).toBe(true);
    expect(result.isCloud).toBe(false);
    expect(result.dialect).toBe('sqlite');
  });

  it('a SQLite file is never a cloud, even with user tables present', async () => {
    // v3: a cloud is Postgres-with-RLS only. SQLite is always a private local
    // store, so probeCloud short-circuits it to isCloud:false without opening.
    // (Postgres isCloud:true detection — __lattice_owners present — is covered by
    // the PG-gated cloud-rls-postgres acceptance test.)
    const root = tempDir();
    const dbPath = join(root, 'local.db');
    const url = `file:${dbPath}`;
    const seedDb = new Lattice(url);
    seedDb.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
      primaryKey: 'id',
      render: () => '',
      outputFile: 'notes.md',
    });
    await seedDb.init();
    await seedDb.insert('notes', { id: 'n1', body: 'hi' });
    seedDb.close();

    const result = await probeCloud(url);
    expect(result.reachable).toBe(true);
    expect(result.isCloud).toBe(false);
    expect(result.dialect).toBe('sqlite');
  });

  it('returns reachable: false for an unreachable Postgres URL', async () => {
    // Port 1 is closed
    const result = await probeCloud('postgres://u:p@127.0.0.1:1/x');
    expect(result.reachable).toBe(false);
    expect(result.dialect).toBe('postgres');
    expect(typeof result.error).toBe('string');
  });

  it('classifies postgres:// URLs as dialect=postgres regardless of reachability', async () => {
    const result = await probeCloud('postgres://localhost:5/whatever');
    expect(result.dialect).toBe('postgres');
  });

  it('classifies non-postgres URLs as dialect=sqlite', async () => {
    const result = await probeCloud(`file:${tempDir()}/x.db`);
    expect(result.dialect).toBe('sqlite');
  });

  it('never throws — errors surface in result.error', async () => {
    // Pass a garbage URL — should resolve, not reject
    const result = await probeCloud('postgres://malformed@@@/x');
    expect(result.reachable).toBe(false);
    expect(typeof result.error).toBe('string');
  });
});
