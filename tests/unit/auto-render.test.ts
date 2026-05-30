import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function makeDb(): Promise<{ db: Lattice; out: string }> {
  const base = mkdtempSync(join(tmpdir(), 'lattice-ar-'));
  dirs.push(base);
  const db = new Lattice(join(base, 'test.db'));
  db.define('notes', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
    render: (rows) => rows.map((r) => `- ${String(r.body)}`).join('\n'),
    outputFile: 'NOTES.md',
  });
  await db.init();
  return { db, out: join(base, 'context') };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('auto-render', () => {
  it('a bare Lattice does not auto-render on insert (zero overhead, no output)', async () => {
    const { db, out } = await makeDb();
    await db.insert('notes', { body: 'hi' });
    await wait(60);
    expect(existsSync(join(out, 'NOTES.md'))).toBe(false);
    db.close();
  });

  it('enableAutoRender coalesces a burst of inserts into a single render', async () => {
    const { db, out } = await makeDb();
    let renders = 0;
    db.on('render', () => {
      renders++;
    });
    db.enableAutoRender(out, { debounceMs: 80 });
    await db.insert('notes', { body: 'a' });
    await db.insert('notes', { body: 'b' });
    await db.insert('notes', { body: 'c' });
    expect(renders).toBe(0); // still debouncing
    await wait(220);
    expect(renders).toBe(1);
    expect(existsSync(join(out, 'NOTES.md'))).toBe(true);
    db.close();
  });

  it('close() cancels a pending auto-render', async () => {
    const { db, out } = await makeDb();
    let renders = 0;
    db.on('render', () => {
      renders++;
    });
    db.enableAutoRender(out, { debounceMs: 80 });
    await db.insert('notes', { body: 'x' });
    db.close();
    await wait(220);
    expect(renders).toBe(0);
  });
});
