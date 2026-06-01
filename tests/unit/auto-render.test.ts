import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
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
  db.define('note_tags', {
    columns: { note_id: 'TEXT', tag: 'TEXT' },
    render: () => '',
    outputFile: 'TAGS.md',
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
    vi.useFakeTimers();
    try {
      db.enableAutoRender(out, { debounceMs: 80 });
      await db.insert('notes', { body: 'a' });
      await db.insert('notes', { body: 'b' });
      await db.insert('notes', { body: 'c' });
      expect(renders).toBe(0); // still debouncing
      await vi.advanceTimersByTimeAsync(120);
      expect(renders).toBe(1); // coalesced into exactly one render
    } finally {
      vi.useRealTimers();
    }
    expect(existsSync(join(out, 'NOTES.md'))).toBe(true);
    db.close();
  });

  it('link() triggers an auto-render so relation rollups stay current', async () => {
    const { db, out } = await makeDb();
    let renders = 0;
    db.on('render', () => {
      renders++;
    });
    vi.useFakeTimers();
    try {
      db.enableAutoRender(out, { debounceMs: 80 });
      await db.link('note_tags', { note_id: 'n1', tag: 'x' });
      expect(renders).toBe(0);
      await vi.advanceTimersByTimeAsync(120);
      expect(renders).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    db.close();
  });

  it('close() cancels a pending auto-render', async () => {
    const { db, out } = await makeDb();
    let renders = 0;
    db.on('render', () => {
      renders++;
    });
    vi.useFakeTimers();
    try {
      db.enableAutoRender(out, { debounceMs: 80 });
      await db.insert('notes', { body: 'x' });
      db.close();
      await vi.advanceTimersByTimeAsync(120);
      expect(renders).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
