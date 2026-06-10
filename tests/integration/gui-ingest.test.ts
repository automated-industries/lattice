import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { Lattice } from '../../src/lattice.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
let savedKey: string | undefined;

beforeEach(() => {
  // Keep ingest deterministic: no LLM enrichment unless a test opts in.
  savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(async () => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function boot(): { root: string; server: Promise<GuiServerHandle> } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-ingest-'));
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
      '    render: default-list',
      '    outputFile: notes.md',
      '',
    ].join('\n'),
  );
  const server = startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    openBrowser: false,
  });
  return { root, server };
}

async function getFile(url: string, id: string): Promise<Record<string, unknown>> {
  return (await fetch(`${url}/api/tables/files/rows/${id}`).then((r) => r.json())) as Record<
    string,
    unknown
  >;
}

describe('ingest routes', () => {
  it('ingests pasted text into a files row', async () => {
    const { server: sp } = boot();
    const server = await sp;
    servers.push(server);

    const res = await fetch(`${server.url}/api/ingest/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello from a paste', title: 'My Note' }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await getFile(server.url, id);
    expect(row.original_name).toBe('My Note');
    expect(row.extracted_text).toBe('hello from a paste');
    expect(row.extraction_status).toBe('extracted');
    expect(typeof row.description).toBe('string');
  });

  it('ingests into a files table that has a NOT NULL slug column (auto-generates the slug)', async () => {
    // Reproduces "ingest failed: not null constraint failed: files.slug":
    // a cloud whose `files` table declares `slug NOT NULL` (created outside the
    // native def). Pre-create that shape, then let the native reconcile add the
    // rest. Ingest must auto-derive a slug from the filename so the insert
    // satisfies the constraint instead of 500-ing.
    const root = mkdtempSync(join(tmpdir(), 'lattice-ingest-slug-'));
    dirs.push(root);
    mkdirSync(join(root, 'data'), { recursive: true });
    const seed = new Lattice(join(root, 'data', 'test.db'));
    await seed.init();
    await seed.adapter.runAsync(
      'CREATE TABLE files (id TEXT PRIMARY KEY, slug TEXT NOT NULL, original_name TEXT, mime TEXT, size_bytes INTEGER, extracted_text TEXT, description TEXT, extraction_status TEXT, deleted_at TEXT)',
    );
    seed.close();

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
      ].join('\n'),
    );
    const server = await startGuiServer({
      configPath,
      outputDir: join(root, 'context'),
      port: 0,
      openBrowser: false,
    });
    servers.push(server);

    const res = await fetch(`${server.url}/api/ingest/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'body', title: 'Invoice 2026' }),
    });
    expect(res.status).toBe(201); // pre-fix: 500 from the NOT NULL violation
    const { id } = (await res.json()) as { id: string };
    const row = await getFile(server.url, id);
    expect(typeof row.slug).toBe('string');
    expect(String(row.slug).length).toBeGreaterThan(0);
    expect(String(row.slug)).toContain('invoice-2026'); // derived from the filename
  });

  it('ingests a local text file by path and extracts its content', async () => {
    const { root, server: sp } = boot();
    const server = await sp;
    servers.push(server);
    const docPath = join(root, 'readme.md');
    writeFileSync(docPath, '# Readme\nThe quick brown fox.');

    const res = await fetch(`${server.url}/api/ingest/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: docPath }),
    });
    expect(res.status).toBe(201);
    const { id, extraction_status } = (await res.json()) as {
      id: string;
      extraction_status: string;
    };
    expect(extraction_status).toBe('extracted');
    const row = await getFile(server.url, id);
    expect(row.path).toBe(docPath);
    expect(row.mime).toBe('text/markdown');
    expect(String(row.extracted_text)).toContain('quick brown fox');
  });

  it('marks an unsupported binary type as skipped (still referenced)', async () => {
    const { root, server: sp } = boot();
    const server = await sp;
    servers.push(server);
    const binPath = join(root, 'data.bin');
    writeFileSync(binPath, 'rawbytes');

    const res = await fetch(`${server.url}/api/ingest/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: binPath }),
    });
    const { id, extraction_status } = (await res.json()) as {
      id: string;
      extraction_status: string;
    };
    expect(extraction_status).toBe('skipped');
    const row = await getFile(server.url, id);
    expect(row.path).toBe(binPath);
    expect(String(row.description)).toMatch(/binary file/i);
  });

  it('ingests raw uploaded bytes, extracting text and leaving path null', async () => {
    const { server: sp } = boot();
    const server = await sp;
    servers.push(server);

    const res = await fetch(`${server.url}/api/ingest/upload`, {
      method: 'POST',
      headers: { 'content-type': 'text/markdown', 'x-filename': 'dropped.md' },
      body: '# Dropped\nlazy dog jumps',
    });
    expect(res.status).toBe(201);
    const { id, extraction_status } = (await res.json()) as {
      id: string;
      extraction_status: string;
    };
    expect(extraction_status).toBe('extracted');
    const row = await getFile(server.url, id);
    expect(row.original_name).toBe('dropped.md');
    expect(row.path == null).toBe(true); // bytes discarded — referenced by content, not path
    expect(String(row.extracted_text)).toContain('lazy dog');
  });

  it('retains an uploaded image as a blob and serves it for inline preview', async () => {
    const { server: sp } = boot();
    const server = await sp;
    servers.push(server);
    // A 1×1 transparent PNG (bytes are retained as a content-addressed blob).
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const res = await fetch(`${server.url}/api/ingest/upload`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-filename': 'pic.png' },
      body: png,
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await getFile(server.url, id);
    expect(row.ref_kind).toBe('blob');
    expect(typeof row.blob_path).toBe('string');

    // The retained blob is served back (so the GUI can render <img src=…/blob>).
    const blob = await fetch(`${server.url}/api/files/${id}/blob`);
    expect(blob.status).toBe(200);
    expect(blob.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await blob.arrayBuffer()).equals(png)).toBe(true);
  });

  it('400s on a missing path', async () => {
    const { server: sp } = boot();
    const server = await sp;
    servers.push(server);
    const res = await fetch(`${server.url}/api/ingest/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/no/such/file/here.txt' }),
    });
    expect(res.status).toBe(400);
  });
});
