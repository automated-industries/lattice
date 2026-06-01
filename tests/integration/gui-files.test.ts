import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<{ root: string; server: GuiServerHandle }> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-files-'));
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
  const server = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    openBrowser: false,
  });
  servers.push(server);
  return { root, server };
}

/**
 * Seed a native `files` row via the GUI's generic row-CRUD route. A
 * `local_ref` row points at a path on disk (the storage mode the blob route
 * streams); omitting the path produces a metadata-only row with no blob.
 */
async function seedFileRow(
  url: string,
  opts: { path?: string; mime?: string; name?: string },
): Promise<string> {
  const row: Record<string, unknown> = {
    id: randomUUID(),
    original_name: opts.name ?? 'file',
  };
  if (opts.mime) row.mime = opts.mime;
  if (opts.path) {
    row.ref_kind = 'local_ref';
    row.ref_uri = opts.path;
  }
  const res = await fetch(`${url}/api/tables/files/rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(row),
  });
  if (res.status !== 201) throw new Error(`seed failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

describe('files routes', () => {
  it('streams the referenced blob with the right content type', async () => {
    const { root, server } = await boot();
    const docPath = join(root, 'page.html');
    writeFileSync(docPath, '<h1>Hi</h1>');
    const id = await seedFileRow(server.url, {
      path: docPath,
      mime: 'text/html',
      name: 'page.html',
    });

    const res = await fetch(`${server.url}/api/files/${id}/blob`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe('<h1>Hi</h1>');
  });

  it('404s the blob for a metadata-only row (no underlying path)', async () => {
    const { server } = await boot();
    const id = await seedFileRow(server.url, { name: 'note', mime: 'text/plain' });
    const blob = await fetch(`${server.url}/api/files/${id}/blob`);
    expect(blob.status).toBe(404);
  });

  it('reports open-in-finder disabled unless LATTICE_LOCAL_OPEN=1', async () => {
    const saved = process.env.LATTICE_LOCAL_OPEN;
    delete process.env.LATTICE_LOCAL_OPEN;
    try {
      const { root, server } = await boot();
      const docPath = join(root, 'doc.txt');
      writeFileSync(docPath, 'x');
      const id = await seedFileRow(server.url, { path: docPath, name: 'doc.txt' });
      const res = await fetch(`${server.url}/api/files/${id}/open-in-finder`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect((await res.json()).enabled).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.LATTICE_LOCAL_OPEN;
      else process.env.LATTICE_LOCAL_OPEN = saved;
    }
  });
});
