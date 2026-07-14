import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { dispatchSourcesRoute } from '../../src/gui/sources-routes.js';
import type { LocalFileIngestResult } from '../../src/gui/ingest-routes.js';

let cfgDir: string;
let workDir: string;
let db: Lattice;
const extraDirs: string[] = [];

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), 'lattice-src-cap-cfg-'));
  workDir = mkdtempSync(join(tmpdir(), 'lattice-src-cap-work-'));
  db = new Lattice(':memory:');
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  delete process.env.LATTICE_LOCAL_OPEN; // default: enabled
});
afterEach(() => {
  db.close();
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  for (const d of extraDirs.splice(0)) rmSync(d, { recursive: true, force: true });
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
  configPath: string = join(cfgDir, 'workspace.yml'),
): Promise<{ status: number; body: unknown; handled: boolean }> {
  const path = new URL(url, 'http://localhost').pathname;
  const req = fakeReq(method, url, body);
  const { res, done } = fakeRes();
  const ingested: string[] = [];
  const fakeIngest = (): Promise<LocalFileIngestResult> => {
    ingested.push('file');
    return Promise.resolve({ id: 'row-' + ingested.length, extraction_status: 'extracted' });
  };
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

describe('folder ingest with truncation/cap reporting', () => {
  it('includes scanned/capped fields in folder registration response', async () => {
    writeFileSync(join(workDir, 'a.txt'), 'a');
    writeFileSync(join(workDir, 'b.txt'), 'b');

    const r = await call('POST', '/api/sources/roots', { path: workDir, kind: 'folder' });
    expect(r.status).toBe(200);
    const result = (r.body as { result: { ingested: number; scanned: number; scanTruncated: boolean; capped: boolean } }).result;

    // Verify the new fields are present in the response
    expect(result).toHaveProperty('scanned');
    expect(result).toHaveProperty('scanTruncated');
    expect(result).toHaveProperty('capped');
    expect(result.scanned).toBe(2);
    expect(result.scanTruncated).toBe(false);
    expect(result.capped).toBe(false);
    expect(result.ingested).toBe(2);
  });

  it('reports correct counts for normal small ingest', async () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(workDir, `file-${i}.txt`), 'content');
    }

    const r = await call('POST', '/api/sources/roots', { path: workDir, kind: 'folder' });
    const result = (r.body as { result: any }).result;
    expect(result.scanned).toBe(5);
    expect(result.scanTruncated).toBe(false);
    expect(result.capped).toBe(false);
  });
});
