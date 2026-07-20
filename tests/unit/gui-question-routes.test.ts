import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import { dispatchQuestionRoute } from '../../src/gui/question-routes.js';
import { dispatchAssistantRoute } from '../../src/gui/assistant-routes.js';
import { enqueueQuestion, getQuestion } from '../../src/gui/questions.js';
import { readPreferences } from '../../src/framework/user-config.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * `/api/questions/*` route shapes + gating, plus the clarify-threshold PUT
 * (which mirrors the aggressiveness preference route). The dispatcher-level
 * tests use fake req/res (the sources-routes pattern); the gating tests boot a
 * real server so the virgin-409 and same-origin guards are exercised for real.
 */

let cfgDir: string;
let db: Lattice;
let feed: FeedBus;

beforeEach(async () => {
  cfgDir = mkdtempSync(join(tmpdir(), 'lattice-qroutes-cfg-'));
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  db = new Lattice(':memory:');
  db.define('widgets', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'widgets.md',
  });
  db.define('_lattice_gui_meta', {
    columns: {
      entity_name: 'TEXT PRIMARY KEY',
      icon: 'TEXT',
      description: 'TEXT',
      updated_at: "TEXT DEFAULT (datetime('now'))",
    },
    primaryKey: 'entity_name',
    render: () => '',
    outputFile: '.lattice-gui/meta.md',
  });
  await db.init();
  feed = new FeedBus();
});
afterEach(() => {
  db.close();
  rmSync(cfgDir, { recursive: true, force: true });
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
  const pathname = new URL(url, 'http://localhost').pathname;
  const req = fakeReq(method, url, body);
  const { res, done } = fakeRes();
  const handled = await dispatchQuestionRoute(req, res, {
    db,
    feed,
    softDeletable: new Set(['widgets']),
    pathname,
    method,
  });
  if (!handled) return { status: 0, body: null, handled };
  const result = await done;
  return { ...result, handled };
}

describe('question routes', () => {
  it('GET /api/questions/pending returns the card shape (allowOther always true)', async () => {
    const id = await enqueueQuestion(db, feed, {
      source: 'enrich',
      question: 'Is this meant to track suppliers?',
      options: ['Yes', 'No'],
    });
    const r = await call('GET', '/api/questions/pending');
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    const body = r.body as { questions: Record<string, unknown>[] };
    expect(body.questions.length).toBe(1);
    expect(body.questions[0]).toMatchObject({
      id,
      question: 'Is this meant to track suppliers?',
      options: ['Yes', 'No'],
      allowOther: true,
      source: 'enrich',
    });
    expect(typeof body.questions[0]?.created_at).toBe('string');
  });

  it('POST answer executes + stamps; validates the body; maps store errors to statuses', async () => {
    const id = await enqueueQuestion(db, feed, {
      source: 'enrich',
      question: 'What is widgets for?',
      options: ['Inventory', 'Suppliers'],
      context: { action: { kind: 'set_definition', table: 'widgets' } },
    });
    // Missing answer → 400 and the question stays pending.
    const bad = await call('POST', `/api/questions/${id}/answer`, {});
    expect(bad.status).toBe(400);
    expect((await getQuestion(db, id))?.status).toBe('pending');
    // Happy path returns what it did.
    const ok = await call('POST', `/api/questions/${id}/answer`, {
      answer: 'Tracks parts we resell',
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id, status: 'answered', action: 'set_definition' });
    // Re-answering a resolved question → 409; an unknown id → 404.
    const again = await call('POST', `/api/questions/${id}/answer`, { answer: 'Inventory' });
    expect(again.status).toBe(409);
    const missing = await call('POST', '/api/questions/nope/answer', { answer: 'Inventory' });
    expect(missing.status).toBe(404);
  });

  it('an executor failure returns the error loudly and leaves the question pending', async () => {
    const id = await enqueueQuestion(db, feed, {
      source: 'assistant',
      question: 'What is this row about?',
      options: ['A', 'B'],
      context: {
        enrich: [{ target: 'row_field', table: 'widgets', column: 'name', rowId: 'ghost' }],
      },
    });
    const r = await call('POST', `/api/questions/${id}/answer`, { answer: 'free-form info' });
    expect(r.status).toBe(500);
    expect(String((r.body as { error?: string }).error)).toMatch(/no row/i);
    expect((await getQuestion(db, id))?.status).toBe('pending');
  });

  it('POST dismiss resolves the card; unknown id → 404; unmatched paths fall through', async () => {
    const id = await enqueueQuestion(db, feed, {
      source: 'import',
      question: 'Keep both sheets?',
      options: ['Yes', 'No'],
    });
    const r = await call('POST', `/api/questions/${id}/dismiss`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, id, status: 'dismissed' });
    expect((await call('POST', '/api/questions/nope/dismiss')).status).toBe(404);
    // Not a questions route → unhandled (the server falls through to 404).
    expect((await call('GET', '/api/questions')).handled).toBe(false);
    expect((await call('DELETE', `/api/questions/${id}/dismiss`)).handled).toBe(false);
  });
});

describe('PUT /api/assistant/clarify-threshold', () => {
  async function put(value: unknown): Promise<{ status: number; body: unknown }> {
    const req = fakeReq('PUT', '/api/assistant/clarify-threshold', { value });
    const { res, done } = fakeRes();
    const handled = await dispatchAssistantRoute(req, res, {
      db: null,
      pathname: '/api/assistant/clarify-threshold',
      method: 'PUT',
    });
    expect(handled).toBe(true);
    return done;
  }

  it('persists a valid value to the machine-local preference', async () => {
    const r = await put(0.75);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, value: 0.75 });
    expect(readPreferences().clarify_threshold).toBe(0.75);
  });

  it('rejects out-of-range / non-numeric values', async () => {
    expect((await put(1.5)).status).toBe(400);
    expect((await put(-0.1)).status).toBe(400);
    expect((await put('often')).status).toBe(400);
    expect(readPreferences().clarify_threshold).toBe(0.6); // untouched default
  });
});

describe('question routes — server gating', () => {
  const dirs: string[] = [];
  const servers: GuiServerHandle[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('409s in the virgin (zero-workspace) state and blocks cross-site POSTs when active', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lattice-qroutes-srv-'));
    dirs.push(root);
    // Virgin boot: no active workspace → every questions route 409s.
    const virginRoot = join(root, 'virgin', '.lattice');
    mkdirSync(virginRoot, { recursive: true });
    const virgin = await startGuiServer({
      latticeRoot: virginRoot,
      port: 0,
      openBrowser: false,
    });
    servers.push(virgin);
    const v = await fetch(`${virgin.url}/api/questions/pending`);
    expect(v.status).toBe(409);

    // Active workspace: the route mounts, and a mutating request from a
    // cross-site origin is rejected by the same-origin gate (403) before the
    // dispatcher ever runs.
    const wsDir = join(root, 'ws');
    mkdirSync(join(wsDir, 'data'), { recursive: true });
    const configPath = join(wsDir, 'lattice.config.yml');
    writeFileSync(
      configPath,
      [
        'db: ./data/test.db',
        '',
        'entities:',
        '  widgets:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '    render: default-list',
        '    outputFile: widgets.md',
        '',
      ].join('\n'),
    );
    const server = await startGuiServer({
      configPath,
      outputDir: join(wsDir, 'context'),
      port: 0,
      openBrowser: false,
    });
    servers.push(server);
    const ok = await fetch(`${server.url}/api/questions/pending`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ questions: [] });
    const crossSite = await fetch(`${server.url}/api/questions/some-id/dismiss`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    expect(crossSite.status).toBe(403);
  });
});
