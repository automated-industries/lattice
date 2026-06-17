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

  it('drag-drop ingests into a files table with NOT NULL name/title (auto-fills from the filename)', async () => {
    // Reproduces "ingest failed: not null constraint failed: files.name" on a
    // drag-drop upload: a cloud whose `files` table declares name + title NOT
    // NULL (same class as the slug case above). Ingest must populate both from
    // the upload's filename so drag-drop never breaks on a NOT NULL identity
    // column, instead of 500-ing.
    const root = mkdtempSync(join(tmpdir(), 'lattice-ingest-name-'));
    dirs.push(root);
    mkdirSync(join(root, 'data'), { recursive: true });
    const seed = new Lattice(join(root, 'data', 'test.db'));
    await seed.init();
    await seed.adapter.runAsync(
      'CREATE TABLE files (id TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL, slug TEXT, original_name TEXT, mime TEXT, size_bytes INTEGER, extracted_text TEXT, description TEXT, extraction_status TEXT, deleted_at TEXT)',
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

    const res = await fetch(`${server.url}/api/ingest/upload`, {
      method: 'POST',
      headers: { 'content-type': 'text/markdown', 'x-filename': 'Quarterly-Review.md' },
      body: '# Quarterly\nrevenue and headcount',
    });
    expect(res.status).toBe(201); // pre-fix: 500 from the files.name NOT NULL violation
    const { id } = (await res.json()) as { id: string };
    const row = await getFile(server.url, id);
    expect(String(row.name).length).toBeGreaterThan(0);
    expect(String(row.title).length).toBeGreaterThan(0);
    expect(row.name).toBe('Quarterly-Review.md');
    expect(row.title).toBe('Quarterly-Review.md');
  });

  it('drag-drop ingests into a files table with a NOT NULL path (auto-fills from the filename)', async () => {
    // Reproduces "Ingest failed: NOT NULL constraint failed: files.path": a
    // cloud/customized `files` table declares `path` NOT NULL, but a browser drop
    // has no OS path to send. Ingest must fill `path` from the filename so
    // drag-drop never breaks, instead of 500-ing.
    const root = mkdtempSync(join(tmpdir(), 'lattice-ingest-path-'));
    dirs.push(root);
    mkdirSync(join(root, 'data'), { recursive: true });
    const seed = new Lattice(join(root, 'data', 'test.db'));
    await seed.init();
    await seed.adapter.runAsync(
      'CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT, title TEXT, slug TEXT, original_name TEXT, mime TEXT, size_bytes INTEGER, extracted_text TEXT, description TEXT, extraction_status TEXT, deleted_at TEXT)',
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

    const res = await fetch(`${server.url}/api/ingest/upload`, {
      method: 'POST',
      headers: { 'content-type': 'text/markdown', 'x-filename': 'Quarterly-Review.md' },
      body: '# Quarterly\nrevenue and headcount',
    });
    expect(res.status).toBe(201); // pre-fix: 500 from the files.path NOT NULL violation
    const { id } = (await res.json()) as { id: string };
    const row = await getFile(server.url, id);
    expect(row.path).toBe('Quarterly-Review.md'); // filled from the filename
  });

  it('records the real OS path on upload when a client supplies x-filepath', async () => {
    // A non-browser/desktop client that knows the dropped file's path sends it;
    // the upload route then records the real path instead of the filename fallback.
    const root = mkdtempSync(join(tmpdir(), 'lattice-ingest-xpath-'));
    dirs.push(root);
    mkdirSync(join(root, 'data'), { recursive: true });
    const seed = new Lattice(join(root, 'data', 'test.db'));
    await seed.init();
    await seed.adapter.runAsync(
      'CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT NOT NULL, original_name TEXT, mime TEXT, size_bytes INTEGER, extracted_text TEXT, description TEXT, extraction_status TEXT, deleted_at TEXT)',
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

    const realPath = '/tmp/dropped/report.md';
    const res = await fetch(`${server.url}/api/ingest/upload`, {
      method: 'POST',
      headers: {
        'content-type': 'text/markdown',
        'x-filename': 'report.md',
        'x-filepath': encodeURIComponent(realPath),
      },
      body: '# Report\nbody',
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await getFile(server.url, id);
    expect(row.path).toBe(realPath);
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

  it('ingests raw uploaded bytes, extracting text and leaving path null on the native schema', async () => {
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
    // The native `files.path` is nullable, so a browser drop (no OS path) leaves
    // it null and is served via the retained blob/ref — NOT a filename shoved into
    // `path`, which would shadow the blob. requiredFileDefaults only fills `path`
    // when the physical schema declares it NOT NULL (see the path-required test).
    expect(row.path == null).toBe(true);
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

  it('retains a non-image document upload (csv) as a downloadable blob', async () => {
    // Regression: a browser drag-drop of a document (here a .csv; the original
    // bug was a .pptx) extracted text but DISCARDED the bytes, so blob_path
    // stayed null and /blob 404'd — the file view could neither preview nor
    // download the underlying file. Documents + media now keep their bytes.
    const { server: sp } = boot();
    const server = await sp;
    servers.push(server);
    const csv = 'region,arr\nNorth America,800\nEMEA,420\n';
    const res = await fetch(`${server.url}/api/ingest/upload`, {
      method: 'POST',
      headers: { 'content-type': 'text/csv', 'x-filename': 'segments.csv' },
      body: csv,
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await getFile(server.url, id);
    expect(row.ref_kind).toBe('blob'); // pre-fix: null (bytes discarded)
    expect(typeof row.blob_path).toBe('string');

    // The retained blob is served back so the file view can download/open it.
    const blob = await fetch(`${server.url}/api/files/${id}/blob`);
    expect(blob.status).toBe(200); // pre-fix: 404 "no underlying blob here"
    expect(await blob.text()).toBe(csv);
  });

  it('does NOT retain a blob for an arbitrary binary upload (keeps text-only)', async () => {
    // The other side of the docs+media gate: an unknown/arbitrary binary keeps
    // the extracted description but no blob — there is nothing useful to preview.
    const { server: sp } = boot();
    const server = await sp;
    servers.push(server);
    const res = await fetch(`${server.url}/api/ingest/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'firmware.bin' },
      body: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await getFile(server.url, id);
    expect(row.blob_path == null).toBe(true);
    expect(row.ref_kind == null).toBe(true);
    const blob = await fetch(`${server.url}/api/files/${id}/blob`);
    expect(blob.status).toBe(404);
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
