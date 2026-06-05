import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Deterministic LLM: fixed summary + a classifier result the test controls via
// `mockState.matches` (default: one match to the seeded project).
const mockState = vi.hoisted(() => ({
  matches: [{ table: 'projects', id: 'proj-1' }] as { table: string; id: string }[],
}));
vi.mock('../../src/gui/ai/chat.js', async (orig) => {
  const actual = await orig();
  return { ...actual, createAnthropicClient: () => ({}) };
});
vi.mock('../../src/gui/ai/summarize.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    summarizeText: () => Promise.resolve('a deterministic summary'),
    classifyLinks: () => Promise.resolve(mockState.matches),
  };
});

import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake';
  mockState.matches = [{ table: 'projects', id: 'proj-1' }];
});
afterEach(async () => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-aggr-'));
  dirs.push(root);
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  projects:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: projects.md',
      '',
    ].join('\n'),
  );
  const server = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    openBrowser: false,
  });
  servers.push(server);
  return server;
}

async function seedProject(url: string): Promise<void> {
  await fetch(`${url}/api/tables/projects/rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'proj-1', title: 'Quarterly plan' }),
  });
}

async function ingest(url: string): Promise<void> {
  await fetch(`${url}/api/ingest/text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Notes about the quarterly plan', title: 'memo' }),
  });
}

describe('inference aggressiveness', () => {
  it('defaults to 0.5 and round-trips through PUT /api/assistant/aggressiveness', async () => {
    const server = await boot();
    const initial = (await fetch(`${server.url}/api/assistant/config`).then((r) => r.json())) as {
      aggressiveness: number;
    };
    expect(initial.aggressiveness).toBe(0.5);

    const put = await fetch(`${server.url}/api/assistant/aggressiveness`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 0.8 }),
    });
    expect(put.ok).toBe(true);

    const after = (await fetch(`${server.url}/api/assistant/config`).then((r) => r.json())) as {
      aggressiveness: number;
    };
    expect(after.aggressiveness).toBe(0.8);

    // Out-of-range is rejected.
    const bad = await fetch(`${server.url}/api/assistant/aggressiveness`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 5 }),
    });
    expect(bad.status).toBe(400);
  });

  it('low aggressiveness does NOT auto-create a missing junction (suggests instead)', async () => {
    const server = await boot();
    await seedProject(server.url);
    // Conservative — below the 0.25 auto-junction threshold.
    await fetch(`${server.url}/api/assistant/aggressiveness`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 0.1 }),
    });

    await ingest(server.url);

    // No junction table was created.
    const res = await fetch(`${server.url}/api/tables/files_projects/rows`);
    expect(res.ok).toBe(false);
  });

  it('high aggressiveness auto-creates the missing junction and links', async () => {
    const server = await boot();
    await seedProject(server.url);
    await fetch(`${server.url}/api/assistant/aggressiveness`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 0.9 }),
    });

    await ingest(server.url);

    const links = (await fetch(`${server.url}/api/tables/files_projects/rows`).then((r) =>
      r.json(),
    )) as { rows: Record<string, unknown>[] };
    expect(links.rows).toHaveLength(1);
    expect(links.rows[0]).toMatchObject({ projects_id: 'proj-1' });

    // The junction creation is a revertible schema op in the audit history.
    const hist = (await fetch(`${server.url}/api/history`).then((r) => r.json())) as {
      entries: { operation: string; table_name: string }[];
    };
    expect(
      hist.entries.some(
        (e) => e.operation === 'schema.create_junction' && e.table_name === 'files_projects',
      ),
    ).toBe(true);
  });

  it('high aggressiveness auto-creates a new note when the source fits nothing', async () => {
    const server = await boot();
    await seedProject(server.url);
    mockState.matches = []; // classifier finds no existing record to link
    await fetch(`${server.url}/api/assistant/aggressiveness`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 0.9 }),
    });

    const ing = await fetch(`${server.url}/api/ingest/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'A standalone idea that maps to nothing yet', title: 'spark' }),
    });
    const { id: fileId } = (await ing.json()) as { id: string };

    // A new native `notes` object was created, linked back to the source file.
    const notes = (await fetch(`${server.url}/api/tables/notes/rows`).then((r) => r.json())) as {
      rows: Record<string, unknown>[];
    };
    expect(notes.rows).toHaveLength(1);
    expect(notes.rows[0]).toMatchObject({ title: 'spark', source_file_id: fileId });
  });

  it('low aggressiveness does NOT auto-create a note (just stores the source)', async () => {
    const server = await boot();
    mockState.matches = [];
    await fetch(`${server.url}/api/assistant/aggressiveness`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 0.1 }),
    });
    await fetch(`${server.url}/api/ingest/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Another standalone idea', title: 'spark2' }),
    });
    const notes = (await fetch(`${server.url}/api/tables/notes/rows`).then((r) => r.json())) as {
      rows: Record<string, unknown>[];
    };
    expect(notes.rows).toHaveLength(0);
  });
});
