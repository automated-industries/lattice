import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the AI library's vision + crawl so the ingest wiring is deterministic
// (no sharp, no network, no key). Stub the GUI LLM client too so the follow-on
// enrichment fails fast instead of making a real Anthropic call.
vi.mock('../../src/gui/ai/chat.js', async (orig) => {
  const actual = await orig();
  return { ...actual, createAnthropicClient: () => ({}) };
});
vi.mock('../../src/ai/vision.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    describeImage: () => Promise.resolve('A red bicycle leaning on a brick wall.'),
  };
});
vi.mock('../../src/ai/crawl.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    crawlUrl: () =>
      Promise.resolve({
        url: 'https://example.com/post',
        title: 'Example Post',
        text: 'The full readable article text extracted from the page.',
        excerpt: '',
        mime: 'text/html',
        byteLength: 100,
      }),
  };
});

import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake';
});
afterEach(async () => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-vc-'));
  dirs.push(root);
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  notes:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      body: { type: text }',
      '    outputFile: notes.md',
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

async function getFile(url: string, id: string): Promise<Record<string, unknown>> {
  return (await fetch(`${url}/api/tables/files/rows/${id}`).then((r) => r.json())) as Record<
    string,
    unknown
  >;
}

describe('ingest: image vision + URL crawl', () => {
  it('describes a dropped image with vision instead of marking it skipped', async () => {
    const server = await boot();
    const res = await fetch(`${server.url}/api/ingest/upload`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-filename': 'bike.png' },
      body: Buffer.from('not-a-real-png'),
    });
    expect(res.status).toBe(201);
    const { id, extraction_status } = (await res.json()) as {
      id: string;
      extraction_status: string;
    };
    expect(extraction_status).toBe('extracted'); // NOT 'skipped'
    const row = await getFile(server.url, id);
    expect(String(row.extracted_text)).toContain('red bicycle');
  });

  it('crawls a pasted URL into readable text and preserves the source URL', async () => {
    const server = await boot();
    const res = await fetch(`${server.url}/api/ingest/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'https://example.com/post' }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await getFile(server.url, id);
    expect(row.original_name).toBe('Example Post');
    expect(String(row.extracted_text)).toContain('readable article text');
    expect(row.ref_uri).toBe('https://example.com/post');
    expect(row.ref_provider).toBe('web');
  });
});
