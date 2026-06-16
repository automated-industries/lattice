/**
 * Workspace-logo routes on a LOCAL (SQLite) workspace — the cloud-only feature
 * degrades cleanly: a local single-user workspace has no team to brand for.
 *   - GET  /api/cloud/workspace-logo → 404 (not a cloud)
 *   - POST /api/cloud/workspace-logo → 400 (not a cloud)
 *   - GET  /api/dbconfig             → logoEtag: null
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function bootLocal(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-logo-local-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
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
      '      title: { type: text }',
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

describe('workspace logo on local SQLite', () => {
  it('GET workspace-logo is 404 on a local workspace', async () => {
    const s = await bootLocal();
    const r = await fetch(`${s.url}/api/cloud/workspace-logo`);
    expect(r.status).toBe(404);
  });

  it('POST workspace-logo is 400 on a local workspace', async () => {
    const s = await bootLocal();
    const r = await fetch(`${s.url}/api/cloud/workspace-logo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logo: 'data:image/png;base64,iVBORw0KGgo=' }),
    });
    expect(r.status).toBe(400);
  });

  it('GET /api/dbconfig reports logoEtag: null on local', async () => {
    const s = await bootLocal();
    const cfg = (await fetch(`${s.url}/api/dbconfig`).then((r) => r.json())) as {
      logoEtag: string | null;
    };
    expect(cfg.logoEtag).toBeNull();
  });
});
