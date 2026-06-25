import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
});

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
): Promise<{ status: number; body: unknown; handled: boolean }> {
  const path = new URL(url, 'http://localhost').pathname;
  const req = fakeReq(method, url, body);
  const { res, done } = fakeRes();
  const handled = await dispatchSourcesRoute(req, res, {
    db,
    ingestFile: fakeIngest,
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
});
