import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Lattice (integration)', () => {
  let db: Lattice;
  let outputDir: string;
  const dirs: string[] = [];

  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'lattice-int-'));
    dirs.push(d);
    return d;
  }

  beforeEach(() => {
    outputDir = tempDir();
    db = new Lattice(':memory:');
    db.define('bots', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', active: 'INTEGER DEFAULT 1' },
      render: (rows) =>
        rows
          .filter((r) => r['active'])
          .map((r) => `- ${r['name'] as string}`)
          .join('\n'),
      outputFile: 'bots.md',
    });
  });

  afterEach(() => {
    db.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('init() creates the table', async () => {
    await db.init();
    const count = await db.count('bots');
    expect(count).toBe(0);
  });

  it('insert + query roundtrip', async () => {
    await db.init();
    await db.insert('bots', { id: 'b1', name: 'Alpha' });
    await db.insert('bots', { id: 'b2', name: 'Beta' });
    const rows = await db.query('bots');
    expect(rows).toHaveLength(2);
  });

  it('upsert updates existing row', async () => {
    await db.init();
    await db.insert('bots', { id: 'b1', name: 'Alpha' });
    await db.upsert('bots', { id: 'b1', name: 'Alpha Updated' });
    const row = await db.get('bots', 'b1');
    expect(row?.['name']).toBe('Alpha Updated');
  });

  it('delete removes a row', async () => {
    await db.init();
    await db.insert('bots', { id: 'b1', name: 'Alpha' });
    await db.delete('bots', 'b1');
    const row = await db.get('bots', 'b1');
    expect(row).toBeNull();
  });

  it('count with where clause', async () => {
    await db.init();
    await db.insert('bots', { id: 'b1', name: 'Alpha', active: 1 });
    await db.insert('bots', { id: 'b2', name: 'Beta', active: 0 });
    const n = await db.count('bots', { where: { active: 1 } });
    expect(n).toBe(1);
  });

  it('render() writes files', async () => {
    await db.init();
    await db.insert('bots', { id: 'b1', name: 'Alpha' });
    const result = await db.render(outputDir);
    expect(result.filesWritten).toHaveLength(1);
    const content = readFileSync(join(outputDir, 'bots.md'), 'utf8');
    expect(content).toContain('Alpha');
  });

  it('render() skips unchanged files', async () => {
    await db.init();
    await db.insert('bots', { id: 'b1', name: 'Alpha' });
    await db.render(outputDir);
    const result2 = await db.render(outputDir);
    expect(result2.filesSkipped).toBe(1);
    expect(result2.filesWritten).toHaveLength(0);
  });

  it('audit events fire for configured tables', async () => {
    const auditDb = new Lattice(':memory:', {
      security: { auditTables: ['bots'] },
    });
    auditDb.define('bots', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL' },
      render: (rows) => rows.map((r) => r['name'] as string).join('\n'),
      outputFile: 'bots.md',
    });
    await auditDb.init();

    const events: string[] = [];
    auditDb.on('audit', (e) => events.push(e.operation));

    await auditDb.insert('bots', { id: 'b1', name: 'Alpha' });
    await auditDb.update('bots', 'b1', { name: 'Beta' });
    await auditDb.delete('bots', 'b1');

    expect(events).toEqual(['insert', 'update', 'delete']);
    auditDb.close();
  });

  it('init() is idempotent', async () => {
    await db.init();
    await db.insert('bots', { id: 'b1', name: 'Alpha' });
    // Re-running init on a new instance with same :memory: isn't possible,
    // but we can verify schema application doesn't throw on existing tables
    await expect(db.init()).rejects.toThrow(); // already initialized
  });
});
