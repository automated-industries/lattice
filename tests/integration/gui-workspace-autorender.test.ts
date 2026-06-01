import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * Workspace mode (autoRender:true) derives a canonical entity context for a
 * table that declares none, and keeps it rendered — so the row-context view
 * has content instead of "No rendered context for this row". A plain
 * `--config` GUI (autoRender:false) keeps the externally-rendered-only contract
 * (covered in gui-context-discovery.test.ts), so this asserts the workspace
 * path specifically.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(autoRender: boolean): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-ar-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  // `tasks` has NO entityContexts: block — exactly the user's case.
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  tasks:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '    outputFile: tasks.md',
      '',
    ].join('\n'),
  );
  const server = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    openBrowser: false,
    autoRender,
  });
  servers.push(server);
  return server;
}

async function createTask(url: string): Promise<string> {
  const res = await fetch(`${url}/api/tables/tasks/rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: randomUUID(), title: 'Write the docs' }),
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function rowContext(url: string, id: string): Promise<{ name: string }[]> {
  const ctx = (await (await fetch(`${url}/api/tables/tasks/rows/${id}/context`)).json()) as {
    files: { name: string }[];
  };
  return ctx.files;
}

describe('GUI workspace auto-render', () => {
  it('renders canonical per-row context for a table with no entityContext', async () => {
    const s = await boot(true);
    const id = await createTask(s.url);
    // Auto-render is debounced; give it a beat to flush after the insert.
    await new Promise((r) => setTimeout(r, 400));
    const files = await rowContext(s.url, id);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => /TASK\.md|CONTEXT\.md/i.test(f.name))).toBe(true);
  });

  it('a plain (non-workspace) GUI still returns no context for an unconfigured table', async () => {
    const s = await boot(false);
    const id = await createTask(s.url);
    await new Promise((r) => setTimeout(r, 200));
    expect(await rowContext(s.url, id)).toEqual([]);
  });
});
