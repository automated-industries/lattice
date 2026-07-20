import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { dispatchSourcesRoute } from '../../src/gui/sources-routes.js';
import type { LocalFileIngestResult } from '../../src/gui/ingest-routes.js';

/**
 * 4.3 — Sources routes (local file/folder roots). Verifies bounded, contained,
 * one-level directory access + ingest-on-add, with a fake ingestFile so no real
 * extraction runs and the credential/config store stays isolated to a temp dir.
 */

let cfgDir: string;
let workDir: string;
let db: Lattice;
const extraDirs: string[] = []; // per-test temp workspace dirs, cleaned in afterEach
const ingested: string[] = [];
const fakeIngest = (p: string): Promise<LocalFileIngestResult> => {
  ingested.push(p);
  return Promise.resolve({ id: 'row-' + ingested.length, extraction_status: 'extracted' });
};

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), 'lattice-src-cfg-'));
  workDir = mkdtempSync(join(tmpdir(), 'lattice-src-work-'));
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  delete process.env.LATTICE_LOCAL_OPEN; // default: enabled
  ingested.length = 0;
  db = new Lattice(':memory:');
});
afterEach(() => {
  db.close();
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  for (const d of extraDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A workspace is identified to the sources routes by its config-file path; its
// roots registry (sources.json) lives next to it. Make a fresh temp workspace.
function newWorkspace(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-ws-' + label + '-'));
  extraDirs.push(dir);
  return join(dir, 'workspace.yml');
}

function fakeReq(method: string, url: string, jsonBody?: unknown): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': 'application/json' };
  req.setEncoding = (() => req) as IncomingMessage['setEncoding'];
  queueMicrotask(() => {
    if (jsonBody !== undefined) req.emit('data', JSON.stringify(jsonBody));
    req.emit('end');
  });
  return req;
}
function fakeRes(): { res: ServerResponse; done: Promise<{ status: number; body: unknown }> } {
  let resolveDone!: (v: { status: number; body: unknown }) => void;
  const done = new Promise<{ status: number; body: unknown }>((r) => (resolveDone = r));
  let status = 200;
  const res = {
    writeHead(s: number) {
      status = s;
      return res;
    },
    end(payload?: string) {
      resolveDone({ status, body: payload ? JSON.parse(payload) : null });
    },
  } as unknown as ServerResponse;
  return { res, done };
}
async function call(
  method: string,
  url: string,
  body?: unknown,
  // Which workspace this request targets. Defaults to a config file inside the
  // global cfgDir, so dirname(configPath) === configDir() and the per-workspace
  // sources.json coincides with the legacy global one (existing tests unchanged).
  configPath: string = join(cfgDir, 'workspace.yml'),
): Promise<{ status: number; body: unknown; handled: boolean }> {
  const path = new URL(url, 'http://localhost').pathname;
  const req = fakeReq(method, url, body);
  const { res, done } = fakeRes();
  const handled = await dispatchSourcesRoute(req, res, {
    db,
    ingestFile: fakeIngest,
    configPath,
    pathname: path,
    method,
  });
  if (!handled) return { status: 0, body: null, handled: false };
  return { ...(await done), handled: true };
}

describe('sources routes', () => {
  it('GET /api/sources/roots is empty initially (enabled)', async () => {
    const r = await call('GET', '/api/sources/roots');
    expect(r.body).toMatchObject({ enabled: true, roots: [] });
  });

  it('registering a folder root ingests its files (bounded, one BFS)', async () => {
    writeFileSync(join(workDir, 'a.txt'), 'a');
    writeFileSync(join(workDir, 'b.txt'), 'b');
    mkdirSync(join(workDir, 'sub'));
    writeFileSync(join(workDir, 'sub', 'c.txt'), 'c');
    const r = await call('POST', '/api/sources/roots', { path: workDir, kind: 'folder' });
    expect(r.status).toBe(200);
    expect((r.body as { result: { ingested: number } }).result.ingested).toBe(3); // a, b, sub/c
    expect(ingested).toHaveLength(3);
    // The root is persisted + listed.
    const list = (await call('GET', '/api/sources/roots')).body as { roots: { path: string }[] };
    expect(list.roots).toHaveLength(1);
    expect(list.roots[0]!.path).toBe(workDir);
  });

  it('GET /api/sources/list returns ONE directory level, dirs first', async () => {
    writeFileSync(join(workDir, 'z.txt'), 'z');
    mkdirSync(join(workDir, 'sub'));
    writeFileSync(join(workDir, 'sub', 'deep.txt'), 'd');
    await call('POST', '/api/sources/roots', { path: workDir, kind: 'folder' });
    const r = await call('GET', '/api/sources/list?path=' + encodeURIComponent(workDir));
    const entries = (r.body as { entries: { name: string; kind: string }[] }).entries;
    // One level only — 'sub' (folder, first) + 'z.txt'; NOT sub/deep.txt.
    expect(entries.map((e) => e.name)).toEqual(['sub', 'z.txt']);
    expect(entries[0]!.kind).toBe('folder');
  });

  it('listing a path OUTSIDE any registered root is refused (403)', async () => {
    await call('POST', '/api/sources/roots', { path: workDir, kind: 'folder' });
    const outside = mkdtempSync(join(tmpdir(), 'lattice-src-outside-'));
    try {
      const r = await call('GET', '/api/sources/list?path=' + encodeURIComponent(outside));
      expect(r.status).toBe(403);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('DELETE removes a root from the sidebar (never the disk files)', async () => {
    writeFileSync(join(workDir, 'a.txt'), 'a');
    await call('POST', '/api/sources/roots', { path: workDir, kind: 'folder' });
    const root = (await call('GET', '/api/sources/roots')).body as { roots: { id: string }[] };
    const id = root.roots[0]!.id;
    const del = await call('DELETE', '/api/sources/roots/' + id);
    expect(del.status).toBe(200);
    expect((await call('GET', '/api/sources/roots')).body).toMatchObject({ roots: [] });
  });

  it('every route degrades to enabled:false when local access is disabled', async () => {
    process.env.LATTICE_LOCAL_OPEN = '0';
    expect((await call('GET', '/api/sources/roots')).body).toMatchObject({ enabled: false });
    expect((await call('POST', '/api/sources/pick', { kind: 'folder' })).body).toMatchObject({
      enabled: false,
    });
  });

  it('returns false for a non-sources path', async () => {
    const r = await call('GET', '/api/something-else');
    expect(r.handled).toBe(false);
  });

  // 4.3.2 regression — the workspace files-leak. Source roots were stored in a
  // single machine-global sources.json, so a brand-new workspace showed another
  // workspace's folders. Roots must be scoped to the workspace that registered
  // them and NEVER appear in another.
  it('roots are isolated per workspace (registering in A never leaks into B)', async () => {
    const wsA = newWorkspace('a');
    const wsB = newWorkspace('b');
    writeFileSync(join(workDir, 'a.txt'), 'a');

    // Register a folder root while workspace A is active.
    const reg = await call('POST', '/api/sources/roots', { path: workDir, kind: 'folder' }, wsA);
    expect(reg.status).toBe(200);

    // Workspace A sees its root.
    const a = (await call('GET', '/api/sources/roots', undefined, wsA)).body as {
      roots: { path: string }[];
    };
    expect(a.roots).toHaveLength(1);
    expect(a.roots[0]!.path).toBe(workDir);

    // Workspace B is empty — no leak across workspaces.
    const b = (await call('GET', '/api/sources/roots', undefined, wsB)).body as {
      roots: unknown[];
    };
    expect(b.roots).toHaveLength(0);

    // And a path registered only in A is NOT browsable while B is active.
    const list = await call(
      'GET',
      '/api/sources/list?path=' + encodeURIComponent(workDir),
      undefined,
      wsB,
    );
    expect(list.status).toBe(403);
  });

  // 4.3.2 migration — installs that registered roots before the fix have them in
  // the legacy global sources.json. On first read they adopt into the active
  // workspace exactly once; the global file is retired so no other (or newly
  // created) workspace can re-adopt them.
  it('adopts legacy global roots into the first workspace opened, not into others', async () => {
    const legacyGlobal = join(cfgDir, 'sources.json'); // configDir() === cfgDir here
    writeFileSync(
      legacyGlobal,
      JSON.stringify({ roots: [{ id: 'r1', path: workDir, kind: 'folder', name: 'work' }] }),
    );

    // First workspace to read adopts the legacy roots…
    const wsA = newWorkspace('a');
    const a = (await call('GET', '/api/sources/roots', undefined, wsA)).body as {
      roots: { path: string }[];
    };
    expect(a.roots).toHaveLength(1);
    expect(a.roots[0]!.path).toBe(workDir);
    // …and the global file is gone (moved, not copied), so it can't be re-adopted.
    expect(existsSync(legacyGlobal)).toBe(false);

    // A second workspace starts empty — the legacy roots do NOT leak into it.
    const wsB = newWorkspace('b');
    const b = (await call('GET', '/api/sources/roots', undefined, wsB)).body as {
      roots: unknown[];
    };
    expect(b.roots).toHaveLength(0);
  });
});

// Folder ingest fans out (INGEST_CONCURRENCY files at once). These pin the two
// properties that fan-out must preserve vs the old sequential loop: (1) one file
// that throws does not abort the whole batch, and (2) the cap counts SUCCESSFUL
// ingests, not files examined, so a run of skipped files doesn't shrink the result.
describe('folder ingest — fan-out resilience + cap semantics', () => {
  // Drive the folder-ingest route with a per-test ingestFile (the shared `call`
  // helper hardcodes the always-succeed fake).
  async function ingestFolderWith(
    dir: string,
    ingestFile: (p: string) => Promise<LocalFileIngestResult>,
  ): Promise<{ ingested: number; skipped: number }> {
    const req = fakeReq('POST', '/api/sources/roots', { path: dir, kind: 'folder' });
    const { res, done } = fakeRes();
    await dispatchSourcesRoute(req, res, {
      db,
      ingestFile,
      configPath: join(cfgDir, 'workspace.yml'),
      pathname: '/api/sources/roots',
      method: 'POST',
    });
    const body = (await done).body as { result: { ingested: number; skipped: number } };
    return body.result;
  }

  it('a file that throws mid-batch is counted as skipped and never aborts the run', async () => {
    for (const n of ['a', 'b', 'boom', 'c', 'd', 'e']) {
      writeFileSync(join(workDir, n + '.txt'), n);
    }
    const seen: string[] = [];
    const result = await ingestFolderWith(workDir, (p) => {
      seen.push(p);
      if (p.endsWith('boom.txt')) return Promise.reject(new Error('simulated DB failure'));
      return Promise.resolve({ id: 'row-' + seen.length, extraction_status: 'extracted' });
    });
    // Every file was still attempted — the throw did not abort the batch.
    expect(seen).toHaveLength(6);
    // The thrower counts as skipped; the other five ingested.
    expect(result.ingested).toBe(5);
    expect(result.skipped).toBe(1);
  });

  it('the cap counts SUCCESSFUL ingests, not files examined (skips do not consume it)', async () => {
    // 510 files; the first 10 ingestFile calls "skip" (no id), the rest succeed. With a
    // MAX_INGEST_FILES=500 cap-on-successes, all 500 success files must ingest (the 10
    // skips don't count). The buggy cap-on-collected variant would stop after examining
    // 500 files (10 skips + 490 successes) and report 490.
    for (let i = 0; i < 510; i++) {
      writeFileSync(join(workDir, 'f' + String(i).padStart(4, '0') + '.txt'), 'x');
    }
    let calls = 0;
    const result = await ingestFolderWith(workDir, () => {
      calls++;
      if (calls <= 10) return Promise.resolve({ extraction_status: 'skipped' }); // no id → skip
      return Promise.resolve({ id: 'row-' + calls, extraction_status: 'extracted' });
    });
    expect(result.ingested).toBe(500);
    expect(result.skipped).toBe(10);
  });
});
