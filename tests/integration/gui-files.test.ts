import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { seedFileRowDirect } from './helpers/seed-file.js';

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
// Seed a files row DIRECTLY into the workspace DB — the byte-location columns (ref_kind/ref_uri)
// are refused on the generic HTTP write route (S1), so trusted-path rows are seeded out of band.
function seedFileRow(root: string, opts: { path?: string; mime?: string; name?: string }): string {
  return seedFileRowDirect(root, {
    original_name: opts.name ?? 'file',
    mime: opts.mime,
    ...(opts.path ? { ref_kind: 'local_ref', ref_uri: opts.path } : {}),
  });
}

describe('files routes', () => {
  it('streams the referenced blob with the right content type', async () => {
    const { root, server } = await boot();
    const docPath = join(root, 'page.html');
    writeFileSync(docPath, '<h1>Hi</h1>');
    const id = seedFileRow(root, {
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
    const { root, server } = await boot();
    const id = seedFileRow(root, { name: 'note', mime: 'text/plain' });
    const blob = await fetch(`${server.url}/api/files/${id}/blob`);
    expect(blob.status).toBe(404);
  });

  it('reports open-in-finder disabled when LATTICE_LOCAL_OPEN=0 (default is now on)', async () => {
    const saved = process.env.LATTICE_LOCAL_OPEN;
    process.env.LATTICE_LOCAL_OPEN = '0'; // explicit opt-out — default is now enabled
    try {
      const { root, server } = await boot();
      const docPath = join(root, 'doc.txt');
      writeFileSync(docPath, 'x');
      const id = seedFileRow(root, { path: docPath, name: 'doc.txt' });
      const res = await fetch(`${server.url}/api/files/${id}/open-in-finder`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect((await res.json()).enabled).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.LATTICE_LOCAL_OPEN;
      else process.env.LATTICE_LOCAL_OPEN = saved;
    }
  });
});
