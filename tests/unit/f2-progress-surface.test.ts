import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appJs } from '../../src/gui/app/script.js';
import { inlineImportJs } from '../../src/gui/app/modules/inline-import.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { seedClaudeOAuth } from '../helpers/claude-auth.js';

/**
 * One progress surface.
 *
 * The conversation rail holds what the user sent and what the assistant answered.
 * Every mechanical progress signal — ingestion, imports, renders, the assistant's
 * own in-flight turn — reports through the single background-task tracker in the
 * activity menu. What this pins:
 *
 *  - the composed client no longer carries the per-turn activity-card renderer or
 *    its grouping helpers (they had no caller left, and re-adding one would put a
 *    second progress surface back in the conversation);
 *  - a running structured import paints NO card into the rail — it registers a
 *    background task and re-labels it from the import stream;
 *  - a structured drop has no confirm card at all: every case (new dataset, or a
 *    known-document re-import with no date) imports silently through the same
 *    background task — there is no question to ask, so nothing lands in the rail;
 *  - a thread row persisted BEFORE the change — one that still carries a per-turn
 *    `events` array — replays as text without throwing and without re-emitting the
 *    events, so old conversations degrade cleanly instead of breaking.
 */

// ── (1) composition: the retired grouping cluster is gone, the live feed stays ──

describe('one progress surface — retired client code', () => {
  it('no longer defines the per-turn card renderer or its grouping helpers', () => {
    expect(appJs).not.toContain('function renderTurnEventCards');
    expect(appJs).not.toContain('function feedGroupKey');
    expect(appJs).not.toContain('function groupedSummary');
    expect(appJs).not.toContain('function groupedRowSummary');
    expect(appJs).not.toContain('function schemaGroupSummary');
    expect(appJs).not.toContain('function schemaAction');
    expect(appJs).not.toContain('function setGroupTime');
    expect(appJs).not.toContain('function applyGroupHit');
    expect(appJs).not.toContain('function newGroup');
    expect(appJs).not.toContain('function onlyKey');
    expect(appJs).not.toContain('GROUPABLE_OPS');
    expect(appJs).not.toContain('SCHEMA_GROUP');
    // feedGroups was write-only: declared in one segment, assigned in another,
    // read nowhere. Both sides go, or the assignment leaks a stray binding.
    expect(appJs).not.toContain('feedGroups');
  });

  it('keeps the live activity feed that the tracker sits beside', () => {
    // The activity menu is the surviving surface: its cards and the icon
    // normalizer that both live and replayed schema ops share.
    expect(appJs).toContain('function makeFeedCard');
    expect(appJs).toContain('function renderFeedItem');
    expect(appJs).toContain('function isSchemaOp');
    expect(appJs).toContain('function bgTask');
  });

  it('composes the import segment INSIDE the main client closure', () => {
    // The import segment uses wrapper-scoped helpers (bgTask, escapeHtml,
    // refreshEntities, renderSidebar, renderRoute, state). It previously sat
    // after the closure, i.e. at true global scope, where every one of those
    // resolved to undefined — rendering the card threw on escapeHtml and the
    // post-import refresh threw inside a promise chain, so the entity list
    // silently never updated until a reload. It must stay ahead of the closing
    // init() call that ends the IIFE.
    const importMarker = appJs.indexOf('function iiTracker');
    const iifeTail = appJs.indexOf('startRelTimeTicker();');
    expect(importMarker).toBeGreaterThan(-1);
    expect(iifeTail).toBeGreaterThan(-1);
    expect(importMarker).toBeLessThan(iifeTail);
    // ...and the global-scope workaround it needed is gone.
    expect(appJs).not.toContain('window.latticeBgTask');
  });

  it('formats in-progress work as a DURATION, not a relative "ago"', () => {
    // The shared elapsed formatter. Its coverage moved here from the retired
    // per-turn card tests, which were its only callers; the retirement left it
    // without one, so this keeps its contract pinned for the next use.
    const decl = appJs.slice(appJs.indexOf('function formatElapsed('));
    const body = decl.slice(0, decl.indexOf('\n    }') + 6);
    const formatElapsed = runInNewContext(body + '\nformatElapsed;', {}) as (ms: number) => string;
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(4000)).toBe('4s');
    expect(formatElapsed((4 * 60 + 2) * 1000)).toBe('4m 2s');
  });
});

// ── (2) behavior: a running import is a background task, not a card in the rail ──

interface ImportWindow {
  fetch: (url: string, init?: unknown) => Promise<unknown>;
  bgTask?: (id: string, opts?: { label?: string }) => unknown;
  escapeHtml: (v: unknown) => string;
  refreshEntities: () => Promise<void>;
  renderSidebar: () => void;
  renderRoute: () => void;
  state: Record<string, unknown>;
  runInlineImportSilent: (proposal: Record<string, unknown>) => void;
  handleAutoImport: (proposal: Record<string, unknown>) => void;
  document: Document;
}

interface TaskRecord {
  id: string;
  labels: string[];
  done: string[];
  failed: string[];
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Load the import segment into a throwaway document, exactly the way it is
 * composed: at script scope, with the surrounding client's helpers stubbed. The
 * NDJSON response deliberately has no streaming body, so the segment takes its
 * whole-text branch and the test needs no stream plumbing.
 */
function loadImportSegment(ndjsonLines: string[]): { win: ImportWindow; tasks: TaskRecord[] } {
  const dom = new JSDOM(
    '<!doctype html><body><div id="rail-feed">' +
      '<div class="chat-msg" id="m1">show me the file</div>' +
      '<div class="chat-msg" id="m2">Here is what I found.</div>' +
      '</div></body>',
    { runScripts: 'outside-only' },
  );
  const win = dom.window as unknown as ImportWindow;

  const tasks: TaskRecord[] = [];
  win.bgTask = (id, opts) => {
    let rec = tasks.find((t) => t.id === id);
    if (!rec) {
      rec = { id, labels: [], done: [], failed: [] };
      tasks.push(rec);
    }
    if (opts?.label != null) rec.labels.push(opts.label);
    const target = rec;
    return {
      update: () => {},
      done: (label?: string) => target.done.push(label ?? ''),
      fail: (msg?: string) => target.failed.push(msg ?? ''),
    };
  };
  win.fetch = () =>
    Promise.resolve({
      body: null,
      text: () => Promise.resolve(ndjsonLines.join('\n')),
    });
  win.escapeHtml = (v: unknown) => String(v ?? '');
  win.refreshEntities = () => Promise.resolve();
  win.renderSidebar = () => {};
  win.renderRoute = () => {};
  win.state = { entities: { tables: [{ name: 'books' }] } };

  dom.window.eval(inlineImportJs as string);
  return { win, tasks };
}

describe('one progress surface — a running import (jsdom)', () => {
  it('reports through the tracker and leaves the rail holding only chat messages', async () => {
    const { win, tasks } = loadImportSegment([
      JSON.stringify({ message: 'Created table books' }),
      JSON.stringify({ message: 'Loaded 9 rows into books' }),
      JSON.stringify({ phase: 'done', result: { rowsByTable: { books: 9 } } }),
    ]);

    win.runInlineImportSilent({ fileId: 'f1', reason: 'new-dataset', computedProposals: [] });
    await flush();
    await flush();
    await flush();

    const rail = win.document.getElementById('rail-feed')!;
    // Nothing mechanical was painted into the conversation.
    expect(rail.querySelectorAll('.feed-item').length).toBe(0);
    expect(rail.querySelectorAll('.import-live').length).toBe(0);
    expect(rail.querySelectorAll('.imp-card-log').length).toBe(0);
    // Only the two chat messages that were already there.
    expect(rail.children.length).toBe(2);
    for (const el of Array.from(rail.children)) {
      expect(el.className).toBe('chat-msg');
    }

    // …and the progress landed on one background task instead.
    expect(tasks.length).toBe(1);
    const task = tasks[0]!;
    expect(task.labels[0]).toBe('Importing your data…');
    expect(task.labels).toContain('Created table books');
    expect(task.labels).toContain('Loaded 9 rows into books');
    expect(task.done.join(' ')).toContain('Imported 1 table, 9 rows');
  });

  it('fails the task loudly when the source cannot be modelled as tables', async () => {
    const { win, tasks } = loadImportSegment([
      JSON.stringify({ phase: 'error', message: 'No tabular structure found' }),
    ]);

    win.runInlineImportSilent({ fileId: 'f2', reason: 'new-dataset', computedProposals: [] });
    await flush();
    await flush();

    const rail = win.document.getElementById('rail-feed')!;
    expect(rail.querySelectorAll('.feed-item').length).toBe(0);
    expect(tasks[0]!.failed.length).toBe(1);
    expect(tasks[0]!.failed[0]).toContain('No tabular structure found');
    // The drop is not data loss — the file is still saved and openable, and the
    // user is told so rather than left with a bare "failed".
    expect(tasks[0]!.failed[0]).toContain('kept as a file');
  });

  it('routes a needs-confirm re-import to the silent executor — no card, no question', async () => {
    // A known-document re-import with no detectable date used to render a confirm card asking
    // for a snapshot date. Zero-decision: handleAutoImport now sends it straight to the silent
    // executor (the apply route dates it as a new snapshot), so nothing is painted into the rail.
    const { win, tasks } = loadImportSegment([
      JSON.stringify({ phase: 'done', result: { rowsByTable: { books: 2 } } }),
    ]);

    win.handleAutoImport({ reason: 'needs-confirm', fileId: 'f3', computedProposals: [] });
    await flush();
    await flush();
    await flush();

    const rail = win.document.getElementById('rail-feed')!;
    // No confirm card and no question control — the two chat messages are all that remain.
    expect(rail.querySelectorAll('.feed-item').length).toBe(0);
    expect(win.document.getElementById('ii-apply')).toBeNull();
    expect(rail.children.length).toBe(2);
    // The import ran as a background task instead.
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.labels[0]).toBe('Importing your data…');
  });
});

// ── (3) server: old thread rows still replay ──

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-f2-cfg-'));
  dirs.push(cfgDir);
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY']) {
    savedEnv[k] = process.env[k];
  }
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'f2-test-key';
  // The thread-replay routes sit behind the assistant-auth gate.
  seedClaudeOAuth();
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-f2-'));
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
  const server = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    openBrowser: false,
  });
  servers.push(server);
  return server;
}

async function insert(url: string, table: string, row: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${url}/api/tables/${table}/rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(row),
  });
  return ((await res.json()) as { id: string }).id;
}

describe('one progress surface — replaying a thread written before the change', () => {
  it('replays the text and ignores the per-turn events array', async () => {
    const server = await boot();
    await insert(server.url, 'chat_threads', { id: 'old', title: 'Cleanup' });
    await insert(server.url, 'chat_messages', {
      thread_id: 'old',
      role: 'assistant',
      // Exactly how a turn was persisted before data changes moved to the
      // activity menu: text plus the events the turn produced.
      content_json: JSON.stringify({
        text: 'Done — removed them.',
        turns: [
          {
            text: 'Done — removed them.',
            tools: [{ name: 'delete_entity', isError: false }],
            events: [
              { op: 'schema.delete_entity', table: 'a', rowId: null, summary: 'Deleted table a' },
              { op: 'schema.delete_entity', table: 'b', rowId: null, summary: 'Deleted table b' },
            ],
          },
        ],
      }),
      source: 'ai',
      created_at: '2026-01-02T00:00:01.000Z',
    });

    const res = await fetch(`${server.url}/api/chat/threads/old/messages`);
    expect(res.status).toBe(200);
    const replay = (await res.json()) as {
      messages: {
        role: string;
        text: string;
        turns?: { text: string; tools: unknown[]; events?: unknown[] }[];
      }[];
    };
    const asst = replay.messages.find((m) => m.role === 'assistant');
    // The conversation still reads back in full…
    expect(asst?.text).toBe('Done — removed them.');
    expect(asst?.turns?.[0]?.text).toBe('Done — removed them.');
    expect(asst?.turns?.[0]?.tools).toHaveLength(1);
    // …and the events the old row carries are not handed back to the client,
    // because nothing renders them any more.
    expect(asst?.turns?.[0]?.events).toBeUndefined();
  });

  it('no longer records per-turn data-change events on new turns', () => {
    // The capture is gone at the source: a turn no longer subscribes to the
    // change bus, so nothing writes an events array into a persisted turn.
    // Asserted against the module text because the capture had no observable
    // output of its own once the client stopped rendering it — reproducing it
    // behaviourally would mean driving a whole model turn.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../src/gui/chat-routes.ts'),
      'utf8',
    );
    expect(src).not.toContain('PersistedTurnEvent');
    expect(src).not.toContain('unsubscribeFeed');
    expect(src).not.toContain('ctx.feed.subscribe');
  });
});
