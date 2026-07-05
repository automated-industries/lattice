import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Deterministic LLM: fixed summary + classify/extract results the test controls
// via `mockState` (defaults: one classify match, no extracted objects).
const mockState = vi.hoisted(() => ({
  matches: [{ table: 'projects', id: 'proj-1' }] as { table: string; id: string }[],
  objects: [] as {
    entity: string;
    isNew: boolean;
    columns: string[];
    values: Record<string, string>;
    label: string;
  }[],
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
    extractObjects: () => Promise.resolve(mockState.objects),
  };
});

import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { seedClaudeOAuth } from '../helpers/claude-auth.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  // Isolate the machine config dir (master key + assistant credentials) to a
  // temp dir so booting the GUI server here never touches the real ~/.lattice
  // or reads a developer's real stored key.
  savedEnv.LATTICE_CONFIG_DIR = process.env.LATTICE_CONFIG_DIR;
  savedEnv.LATTICE_ENCRYPTION_KEY = process.env.LATTICE_ENCRYPTION_KEY;
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-aggr-cfg-'));
  dirs.push(cfgDir);
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'aggr-test-key';
  // Claude access is OAuth-only: the ingest routes are gated behind a connected
  // subscription. Seed one into the isolated config dir (which must already be
  // set — the credential store is keyed off LATTICE_CONFIG_DIR) so the gated
  // /api/ingest/* calls below authenticate. The token never reaches a real
  // endpoint: the model calls are mocked out above.
  seedClaudeOAuth();
  mockState.matches = [{ table: 'projects', id: 'proj-1' }];
  mockState.objects = [];
});
afterEach(async () => {
  if (savedEnv.LATTICE_CONFIG_DIR === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = savedEnv.LATTICE_CONFIG_DIR;
  if (savedEnv.LATTICE_ENCRYPTION_KEY === undefined) delete process.env.LATTICE_ENCRYPTION_KEY;
  else process.env.LATTICE_ENCRYPTION_KEY = savedEnv.LATTICE_ENCRYPTION_KEY;
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
  it('defaults to 0.85 and round-trips through PUT /api/assistant/aggressiveness', async () => {
    const server = await boot();
    const initial = (await fetch(`${server.url}/api/assistant/config`).then((r) => r.json())) as {
      aggressiveness: number;
    };
    expect(initial.aggressiveness).toBe(0.85);

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

  it('builds a NEW entity + row + link from a document (Context Constructor)', async () => {
    const server = await boot();
    mockState.matches = []; // nothing existing to link
    mockState.objects = [
      {
        entity: 'invoices',
        isNew: true,
        columns: ['invoice_number', 'vendor', 'total_due'],
        values: { invoice_number: 'INV-2026-114', vendor: 'Globex', total_due: '6400' },
        label: 'INV-2026-114',
      },
    ];
    await fetch(`${server.url}/api/assistant/aggressiveness`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 0.7 }),
    });

    const ing = await fetch(`${server.url}/api/ingest/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'INVOICE INV-2026-114 from Globex, total 6400', title: 'inv' }),
    });
    const { id: fileId } = (await ing.json()) as { id: string };

    // The 'invoices' entity was created with the inferred columns…
    const ents = (await fetch(`${server.url}/api/entities`).then((r) => r.json())) as {
      tables: { name: string; columns: string[] }[];
    };
    const invoices = ents.tables.find((t) => t.name === 'invoices');
    expect(invoices).toBeTruthy();
    // Inferred columns PLUS an always-present `name` column for a human label.
    expect(invoices?.columns).toEqual(
      expect.arrayContaining(['name', 'invoice_number', 'vendor', 'total_due']),
    );

    // …populated with the extracted row, whose `name` is the object's label so
    // the card shows "INV-2026-114" rather than a bare "#<id>"…
    const rows = (await fetch(`${server.url}/api/tables/invoices/rows`).then((r) => r.json())) as {
      rows: Record<string, unknown>[];
    };
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      name: 'INV-2026-114',
      invoice_number: 'INV-2026-114',
      vendor: 'Globex',
    });

    // …and the source file linked to it via an auto-created junction.
    const links = (await fetch(`${server.url}/api/tables/files_invoices/rows`).then((r) =>
      r.json(),
    )) as { rows: Record<string, unknown>[] };
    expect(links.rows).toHaveLength(1);
    expect(links.rows[0]).toMatchObject({ file_id: fileId });

    // Everything is in the audit log → reversible.
    const hist = (await fetch(`${server.url}/api/history?limit=50`).then((r) => r.json())) as {
      entries: { operation: string; table_name: string }[];
    };
    expect(
      hist.entries.some(
        (e) => e.operation === 'schema.create_entity' && e.table_name === 'invoices',
      ),
    ).toBe(true);
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
