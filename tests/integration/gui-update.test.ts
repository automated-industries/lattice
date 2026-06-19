import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import type { UpdateService, UpdateStatus } from '../../src/gui/update-service.js';

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

// A fully fake update service — no real registry check, no real npm install.
// `checkNow` is a deterministic spy so the apply route never touches the network.
function fakeUpdateService(status: UpdateStatus): {
  service: UpdateService;
  checkNow: ReturnType<typeof vi.fn>;
} {
  const checkNow = vi.fn(() => Promise.resolve(status));
  const service: UpdateService = {
    start: () => undefined,
    stop: () => undefined,
    status: () => status,
    checkNow,
  };
  return { service, checkNow };
}

async function bootWithUpdateService(
  version: string,
  status: UpdateStatus,
): Promise<{ handle: GuiServerHandle; checkNow: ReturnType<typeof vi.fn> }> {
  const { service, checkNow } = fakeUpdateService(status);
  const handle = await startGuiServer({
    port: 0,
    openBrowser: false,
    version,
    updateServiceFactory: () => service,
  });
  servers.push(handle);
  return { handle, checkNow };
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

describe('POST /api/update/apply', () => {
  it('kicks off the update and returns { ok: true, status } when an update service is present', async () => {
    const status: UpdateStatus = {
      current: '1.0.0',
      latest: '2.0.0',
      kind: 'global',
      installable: true,
      checking: false,
      installing: false,
      lastError: null,
    };
    const { handle, checkNow } = await bootWithUpdateService('1.0.0', status);
    const res = await fetch(`${handle.url}/api/update/apply`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.status).toEqual(status);
    // Forced check kicked off (fire-and-forget) — never a real npm install.
    expect(checkNow).toHaveBeenCalledWith(true);
  });

  it('returns { ok: false, error } when no update service is available', async () => {
    const { url } = await bootVirgin('1.2.3');
    const res = await fetch(`${url}/api/update/apply`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(String(body.error)).toMatch(/not available|latticesql\.com/i);
  });
});
