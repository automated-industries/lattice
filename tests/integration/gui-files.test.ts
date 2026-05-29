import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

async function ingestFile(url: string, path: string): Promise<string> {
  const res = await fetch(`${url}/api/ingest/file`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  return ((await res.json()) as { id: string }).id;
}

describe('files routes', () => {
  it('streams the referenced blob with the right content type', async () => {
    const { root, server } = await boot();
    const docPath = join(root, 'page.html');
    writeFileSync(docPath, '<h1>Hi</h1>');
    const id = await ingestFile(server.url, docPath);

    const res = await fetch(`${server.url}/api/files/${id}/blob`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe('<h1>Hi</h1>');
  });

  it('404s the blob for a text-only ingest (no underlying path)', async () => {
    const { server } = await boot();
    const res = await fetch(`${server.url}/api/ingest/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'just text', title: 'note' }),
    });
    const { id } = (await res.json()) as { id: string };
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
      const id = await ingestFile(server.url, docPath);
      const res = await fetch(`${server.url}/api/files/${id}/open-in-finder`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect((await res.json()).enabled).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.LATTICE_LOCAL_OPEN;
      else process.env.LATTICE_LOCAL_OPEN = saved;
    }
  });
});
