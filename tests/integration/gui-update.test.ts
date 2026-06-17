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

async function bootVirgin(version: string): Promise<GuiServerHandle> {
  const h = await startGuiServer({ port: 0, openBrowser: false, version });
  servers.push(h);
  return h;
}

async function bootConfigured(version: string): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-update-'));
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
  const h = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    openBrowser: false,
    version,
  });
  servers.push(h);
  return h;
}

describe('GET /api/version', () => {
  it('returns the version in the virgin (no-workspace) state', async () => {
    const { url } = await bootVirgin('9.9.9');
    const res = await fetch(`${url}/api/version`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: '9.9.9' });
  });

  it('returns the version in the active (workspace) state', async () => {
    const { url } = await bootConfigured('7.7.7');
    const res = await fetch(`${url}/api/version`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: '7.7.7' });
  });
});

describe('GET /api/update/status', () => {
  it('reports a disabled (not-installable) status when self-update is off', async () => {
    const { url } = await bootVirgin('1.2.3');
    const res = await fetch(`${url}/api/update/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.current).toBe('1.2.3');
    expect(body.installable).toBe(false);
    expect(body.installing).toBe(false);
    expect(body.lastError).toBeNull();
  });
});
