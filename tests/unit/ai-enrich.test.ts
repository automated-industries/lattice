import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/index.js';
import { enrichKnowledge } from '../../src/ai/enrich.js';
import type { LlmClient, TurnParams, TurnResult } from '../../src/ai/llm-client.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeClient(body: string): LlmClient {
  return {
    runTurn(_p: TurnParams): Promise<TurnResult> {
      return Promise.resolve({ stopReason: 'end_turn', text: body, toolUses: [] });
    },
  };
}

async function makeDb(): Promise<Lattice> {
  const base = mkdtempSync(join(tmpdir(), 'lattice-enrich-'));
  dirs.push(base);
  const db = new Lattice(join(base, 'db.sqlite'));
  const t = (cols: Record<string, string>, out: string) => ({
    columns: cols,
    render: () => '',
    outputFile: out,
  });
  db.define('files', t({ id: 'TEXT PRIMARY KEY', extracted_text: 'TEXT' }, '.s/files.md'));
  db.define('notes', t({ id: 'TEXT PRIMARY KEY', title: 'TEXT', body: 'TEXT' }, '.s/notes.md'));
  db.define(
    'file_links',
    t(
      {
        id: 'TEXT PRIMARY KEY',
        file_id: 'TEXT',
        table_name: 'TEXT',
        row_id: 'TEXT',
        relevance: 'TEXT',
      },
      '.s/links.md',
    ),
  );
  await db.init();
  return db;
}

describe('enrichKnowledge', () => {
  it('is a no-op without a client', async () => {
    const db = await makeDb();
    const r = await enrichKnowledge(db, { client: null });
    expect(r.skipped).toBe(true);
    expect(r.enriched).toEqual([]);
    db.close();
  });

  it('rewrites a thin-bodied note from its 2+ linked sources', async () => {
    const db = await makeDb();
    const note = await db.insert('notes', { title: 'Apollo', body: 'stub' });
    const f1 = await db.insert('files', {
      extracted_text: 'Apollo launched in 1969 with a large rocket.',
    });
    const f2 = await db.insert('files', {
      extracted_text: 'The Apollo program landed humans on the moon.',
    });
    for (const fid of [f1, f2]) {
      await db.insert('file_links', {
        file_id: fid,
        table_name: 'notes',
        row_id: note,
        relevance: 'primary',
      });
    }
    const longBody = 'Apollo was a crewed spaceflight program. '.repeat(30);
    const r = await enrichKnowledge(db, { client: fakeClient(longBody) });
    expect(r.skipped).toBe(false);
    expect(r.enriched).toContain(note);
    const updated = await db.get('notes', note);
    expect(String(updated?.body).length).toBeGreaterThan(100);
    db.close();
  });

  it('skips objects with fewer than minSources links', async () => {
    const db = await makeDb();
    const note = await db.insert('notes', { title: 'Solo', body: 'x' });
    const f1 = await db.insert('files', { extracted_text: 'one source only' });
    await db.insert('file_links', {
      file_id: f1,
      table_name: 'notes',
      row_id: note,
      relevance: 'primary',
    });
    const r = await enrichKnowledge(db, { client: fakeClient('much longer body '.repeat(20)) });
    expect(r.enriched).toEqual([]);
    db.close();
  });
});
