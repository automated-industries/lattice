import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the LLM layer so ingest enrichment is deterministic: a fixed summary and
// a single classifier match to the seeded `projects` row — no network, no API key.
vi.mock('../../src/gui/ai/chat.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, createAnthropicClient: () => ({}) };
});
vi.mock('../../src/gui/ai/summarize.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    summarizeText: async () => 'a deterministic summary',
    classifyLinks: async () => [{ table: 'projects', id: 'proj-1' }],
  };
});

import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake'; // makes resolveClaudeAuth truthy
});
afterEach(async () => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-autojx-'));
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

describe('ingest auto-junction creation', () => {
  it('creates the files↔projects junction when none exists, then links the file (audited)', async () => {
    const server = await boot();

    // Seed the note the classifier will match (fixed id the mock returns).
    await fetch(`${server.url}/api/tables/projects/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'proj-1', title: 'Quarterly plan' }),
    });

    // No junction table exists yet — querying it is rejected.
    const before = await fetch(`${server.url}/api/tables/files_projects/rows`);
    expect(before.ok).toBe(false);

    // Ingest text → enrichment classifies a link to projects → junction auto-created + linked.
    const ing = await fetch(`${server.url}/api/ingest/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Notes about the quarterly plan', title: 'memo' }),
    });
    expect(ing.status).toBe(201);
    const { id: fileId } = (await ing.json()) as { id: string };

    // The junction table now exists and holds exactly the file↔project link.
    const links = (await fetch(`${server.url}/api/tables/files_projects/rows`).then((r) =>
      r.json(),
    )) as { rows: Record<string, unknown>[] };
    expect(links.rows).toHaveLength(1);
    expect(links.rows[0]).toMatchObject({ file_id: fileId, projects_id: 'proj-1' });

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
});
