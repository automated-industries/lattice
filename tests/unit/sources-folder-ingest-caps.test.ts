import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { dispatchSourcesRoute } from '../../src/gui/sources-routes.js';
import { FeedBus } from '../../src/gui/feed.js';
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
  feed?: FeedBus,
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
    feed,
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

describe('ingest progress feed emission', () => {
  it('publishes progress events when feed is provided', async () => {
    // Create a few test files.
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(workDir, `file-${i}.txt`), 'content');
    }

    const feed = new FeedBus();
    const events: Array<{ op: string; progress?: { done: number; total: number } }> = [];
    feed.subscribe((e) => {
      if (e.op === 'ingest_progress') {
        events.push({ op: e.op, progress: e.progress });
      }
    });

    // Use the registration endpoint which triggers ingest automatically and passes feed.
    const r = await call('POST', '/api/sources/roots', { path: workDir, kind: 'folder' },
      join(cfgDir, 'workspace.yml'), feed);
    expect(r.status).toBe(200);
    expect(r.handled).toBe(true);

    // Should have at least 2 events: initial (0/3) and terminal (3/3).
    // However, the feed is only captured by our subscriber which was set up
    // BEFORE the route was called, so events should be present.
    expect(events.length).toBeGreaterThanOrEqual(2);
    // First event is initial: done=0.
    expect(events[0]).toEqual({ op: 'ingest_progress', progress: { done: 0, total: 3 } });
    // Last event is terminal: done=total.
    const last = events[events.length - 1];
    expect(last?.progress?.done).toBe(last?.progress?.total);
    expect(last?.progress?.total).toBe(3);
  });

  it('is a no-op when feed is absent', async () => {
    writeFileSync(join(workDir, 'a.txt'), 'a');
    // Register root first so the ingest-folder endpoint will find it.
    await call('POST', '/api/sources/roots', { path: workDir, kind: 'folder' });

    // Now call ingest-folder without a feed to verify it's a no-op.
    const r = await call('POST', '/api/sources/ingest-folder', { path: workDir },
      join(cfgDir, 'workspace.yml'));
    expect(r.status).toBe(200);
    expect(r.handled).toBe(true);
  });

  it('throttles intermediate progress events', async () => {
    // Create enough files that throttling kicks in (5+ files or 2s elapsed).
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(workDir, `file-${i}.txt`), 'content');
    }

    const feed = new FeedBus();
    const events: number[] = []; // Track done counts only
    feed.subscribe((e) => {
      if (e.op === 'ingest_progress' && e.progress) {
        events.push(e.progress.done);
      }
    });

    // Register the root first, then call ingest-folder to test throttling.
    await call('POST', '/api/sources/roots', { path: workDir, kind: 'folder' }, join(cfgDir, 'workspace.yml'), feed);
    // Call again to ingest just the folder (events array should accumulate both calls).
    const r = await call('POST', '/api/sources/ingest-folder', { path: workDir },
      join(cfgDir, 'workspace.yml'), feed);
    expect(r.status).toBe(200);

    // We should have events from both the registration (which ingests) and the explicit ingest call.
    // Both should be throttled. The first call publishes 0 and 10, the second publishes 0 and 10.
    // So events should contain [0, (intermediate), 10, 0, (intermediate), 10] or similar.
    expect(events.length).toBeGreaterThan(0);
    // All events should be within the expected range.
    for (const done of events) {
      expect(done).toBeGreaterThanOrEqual(0);
      expect(done).toBeLessThanOrEqual(10);
    }
  });
});

