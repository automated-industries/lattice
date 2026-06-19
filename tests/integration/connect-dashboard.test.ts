import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { Lattice, ensureLatticeRoot, addWorkspace, resolveWorkspacePaths } from '../../src/index.js';
import { getConnectedDashboard } from '../../src/connect/dashboard.js';

/**
 * Covers the `lattice connect` server surface: serving a user-provided dashboard
 * same-origin (file + folder modes), keeping the built-in shell at /lattice and
 * /api/* reachable, and the upload/note → list loop the dashboard depends on.
 * No Claude key is configured, so ingest degrades to extraction-only — exactly
 * the deterministic path we want to assert here.
 */

const DASH_MARKER = 'CONNECT_DASHBOARD_MARKER_42';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  saved.LATTICE_CONFIG_DIR = process.env.LATTICE_CONFIG_DIR;
  // Deterministic, key-free ingest + isolated credential store.
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (saved.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY;
  if (saved.LATTICE_CONFIG_DIR === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = saved.LATTICE_CONFIG_DIR;
  delete process.env.LATTICE_ROOT;
});

/** Stand up a fresh local SQLite workspace and return its config/context paths. */
async function freshWorkspace(prefix: string): Promise<{ configPath: string; contextDir: string }> {
  const base = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(base);
  process.env.LATTICE_ROOT = join(base, '.lattice');
  process.env.LATTICE_CONFIG_DIR = join(base, '.lattice');
  const root = ensureLatticeRoot(base);
  const ws = addWorkspace(root, { displayName: 'Test' });
  const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
  db.close();
  const paths = resolveWorkspacePaths(root, ws);
  return { configPath: paths.configPath, contextDir: paths.contextDir };
}

describe('connect: dashboard serving', () => {
  it('serves a single-file dashboard at / and the built-in shell at /lattice', async () => {
    const { configPath, contextDir } = await freshWorkspace('lattice-cd-file-');
    const dash = join(dirs[0]!, 'dash.html');
    writeFileSync(dash, `<!doctype html><title>x</title><body>${DASH_MARKER}</body>`, 'utf8');

    const server = await startGuiServer({
      configPath,
      outputDir: contextDir,
      port: 0,
      openBrowser: false,
      dashboardPath: dash,
    });
    servers.push(server);

    const rootRes = await fetch(`${server.url}/`);
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get('content-type')).toContain('text/html');
    expect(await rootRes.text()).toContain(DASH_MARKER);

    // Built-in shell relocated to /lattice (its loading div is a stable marker).
    const spa = await fetch(`${server.url}/lattice`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('app-loading');

    // /api/* is never shadowed by dashboard serving.
    const ver = (await (await fetch(`${server.url}/api/version`)).json()) as { version: string };
    expect(typeof ver.version).toBe('string');
  });

  it('serves a folder dashboard with its static assets, traversal-guarded', async () => {
    const { configPath, contextDir } = await freshWorkspace('lattice-cd-dir-');
    const dashDir = join(dirs[0]!, 'site');
    mkdirSync(dashDir, { recursive: true });
    writeFileSync(join(dashDir, 'index.html'), `<!doctype html><body>${DASH_MARKER}</body>`, 'utf8');
    writeFileSync(join(dashDir, 'style.css'), 'body{color:red}', 'utf8');

    const server = await startGuiServer({
      configPath,
      outputDir: contextDir,
      port: 0,
      openBrowser: false,
      dashboardPath: dashDir,
    });
    servers.push(server);

    expect(await (await fetch(`${server.url}/`)).text()).toContain(DASH_MARKER);
    const css = await fetch(`${server.url}/style.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(await css.text()).toContain('color:red');
  });

  it('leaves the built-in shell at / when no dashboard is configured', async () => {
    const { configPath, contextDir } = await freshWorkspace('lattice-cd-default-');
    const server = await startGuiServer({
      configPath,
      outputDir: contextDir,
      port: 0,
      openBrowser: false,
    });
    servers.push(server);
    expect(await (await fetch(`${server.url}/`)).text()).toContain('app-loading');
  });

  it('supports the dashboard upload→list loop: a note ingests and reads back', async () => {
    const { configPath, contextDir } = await freshWorkspace('lattice-cd-loop-');
    const dash = join(dirs[0]!, 'dash.html');
    writeFileSync(dash, `<!doctype html><body>${DASH_MARKER}</body>`, 'utf8');
    const server = await startGuiServer({
      configPath,
      outputDir: contextDir,
      port: 0,
      openBrowser: false,
      dashboardPath: dash,
    });
    servers.push(server);

    const ingest = (await (
      await fetch(`${server.url}/api/ingest/text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'a quick captured note', title: 'My Note' }),
      })
    ).json()) as { id: string; extraction_status: string };
    expect(ingest.id).toBeTruthy();
    expect(ingest.extraction_status).toBe('extracted');

    const list = (await (await fetch(`${server.url}/api/tables/files/rows?limit=10`)).json()) as {
      rows: { id: string; original_name?: string }[];
    };
    expect(list.rows.some((r) => r.id === ingest.id)).toBe(true);
  });
});

describe('connect: runtime /api/connect/dashboard', () => {
  async function postPath(url: string, path: string): Promise<Response> {
    return fetch(`${url}/api/connect/dashboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  }

  it('connects, reflects, persists, and disconnects a dashboard at runtime', async () => {
    const { configPath, contextDir } = await freshWorkspace('lattice-cd-rt-');
    const dash = join(dirs[0]!, 'rt-dash.html');
    writeFileSync(dash, `<!doctype html><body>${DASH_MARKER}</body>`, 'utf8');

    // Start with NO dashboard → / serves the built-in shell.
    const server = await startGuiServer({
      configPath,
      outputDir: contextDir,
      port: 0,
      openBrowser: false,
    });
    servers.push(server);

    const before = (await (await fetch(`${server.url}/api/connect/dashboard`)).json()) as {
      path: string | null;
    };
    expect(before.path).toBeNull();
    expect(await (await fetch(`${server.url}/`)).text()).toContain('app-loading');

    // Connect at runtime.
    const set = (await (await postPath(server.url, dash)).json()) as {
      ok: boolean;
      mode: string;
      path: string;
    };
    expect(set.ok).toBe(true);
    expect(set.mode).toBe('file');
    // Now / serves the dashboard and the shell has moved to /lattice.
    expect(await (await fetch(`${server.url}/`)).text()).toContain(DASH_MARKER);
    expect(await (await fetch(`${server.url}/lattice`)).text()).toContain('app-loading');
    // GET reflects it, and it is persisted to the machine-local store.
    const cur = (await (await fetch(`${server.url}/api/connect/dashboard`)).json()) as {
      path: string;
    };
    expect(cur.path).toContain('rt-dash.html');
    expect(getConnectedDashboard()).toContain('rt-dash.html');

    // A nonexistent path is a 400, not a 500.
    const bad = await postPath(server.url, join(dirs[0]!, 'nope.html'));
    expect(bad.status).toBe(400);

    // Disconnect with an empty path → / serves the shell again, store cleared.
    const off = (await (await postPath(server.url, '')).json()) as {
      ok: boolean;
      path: string | null;
    };
    expect(off.ok).toBe(true);
    expect(off.path).toBeNull();
    expect(await (await fetch(`${server.url}/`)).text()).toContain('app-loading');
    expect(getConnectedDashboard()).toBeNull();
  });
});
