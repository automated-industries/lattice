import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/index.js';
import { organizeSource } from '../../src/ai/organize.js';
import type { LlmClient, TurnParams, TurnResult } from '../../src/gui/ai/chat.js';
import type { CatalogEntity } from '../../src/gui/ai/summarize.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake LLM: a fixed summary, and a canned classifier JSON response. */
function fakeClient(classifyJson: string): LlmClient {
  return {
    runTurn(params: TurnParams): Promise<TurnResult> {
      const isClassify = params.system.includes('existing records');
      const text = isClassify ? `\`\`\`json\n${classifyJson}\n\`\`\`` : 'A short factual summary.';
      return Promise.resolve({ stopReason: 'end_turn', text, toolUses: [] });
    },
  };
}

async function makeDb(): Promise<Lattice> {
  const base = mkdtempSync(join(tmpdir(), 'lattice-org-'));
  dirs.push(base);
  const db = new Lattice(join(base, 'db.sqlite'));
  const t = (cols: Record<string, string>, out: string) => ({
    columns: cols,
    render: () => '',
    outputFile: out,
  });
  db.define('files', t({ id: 'TEXT PRIMARY KEY', original_name: 'TEXT' }, '.s/files.md'));
  db.define('projects', t({ id: 'TEXT PRIMARY KEY', name: 'TEXT' }, '.s/projects.md'));
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
  db.define('notes', t({ id: 'TEXT PRIMARY KEY', title: 'TEXT', body: 'TEXT' }, '.s/notes.md'));
  await db.init();
  return db;
}

describe('organizeSource', () => {
  it('is a no-op when AI is disabled (no client)', async () => {
    const db = await makeDb();
    const fileId = await db.insert('files', { original_name: 'x.txt' });
    const res = await organizeSource(db, {
      fileId,
      text: 'hello',
      name: 'x.txt',
      catalog: [],
      client: null,
    });
    expect(res.skipped).toBe(true);
    expect(res.linked).toEqual([]);
    expect(res.created).toEqual([]);
    expect((await db.query('file_links')).length).toBe(0);
    db.close();
  });

  it('links the source into an existing record when one fits (no new object)', async () => {
    const db = await makeDb();
    const projId = await db.insert('projects', { name: 'Apollo' });
    const fileId = await db.insert('files', { original_name: 'spec.txt' });
    const catalog: CatalogEntity[] = [
      { table: 'projects', records: [{ id: projId, label: 'Apollo' }] },
    ];
    const client = fakeClient(JSON.stringify([{ table: 'projects', id: projId }]));
    const res = await organizeSource(db, {
      fileId,
      text: 'all about apollo',
      name: 'spec.txt',
      catalog,
      client,
    });
    expect(res.skipped).toBe(false);
    expect(res.linked).toEqual([{ table: 'projects', id: projId }]);
    expect(res.created).toEqual([]);
    expect(res.message).toMatch(/Linked it to 1 existing record/);
    expect(res.message).toMatch(/change any of this anytime/i);
    expect((await db.query('file_links')).length).toBe(1);
    expect((await db.query('notes')).length).toBe(0);
    db.close();
  });

  it('creates a fallback note ONLY when nothing fits', async () => {
    const db = await makeDb();
    const fileId = await db.insert('files', { original_name: 'random.txt' });
    const catalog: CatalogEntity[] = [{ table: 'projects', records: [] }];
    const client = fakeClient('[]'); // classifier finds nothing
    const res = await organizeSource(db, {
      fileId,
      text: 'unrelated content',
      name: 'random.txt',
      catalog,
      client,
    });
    expect(res.linked).toEqual([]);
    expect(res.created.length).toBe(1);
    expect(res.created[0]?.table).toBe('notes');
    expect(res.created[0]?.title).toBe('random');
    expect(res.message).toMatch(/Created a new note/);
    expect((await db.query('notes')).length).toBe(1);
    // the file is linked to the new note
    expect((await db.query('file_links')).length).toBe(1);
    db.close();
  });

  it('respects createIfNecessary: false (link-only, never creates)', async () => {
    const db = await makeDb();
    const fileId = await db.insert('files', { original_name: 'x.txt' });
    const client = fakeClient('[]');
    const res = await organizeSource(db, {
      fileId,
      text: 'content',
      name: 'x.txt',
      catalog: [{ table: 'projects', records: [] }],
      client,
      createIfNecessary: false,
    });
    expect(res.created).toEqual([]);
    expect((await db.query('notes')).length).toBe(0);
    db.close();
  });
});
