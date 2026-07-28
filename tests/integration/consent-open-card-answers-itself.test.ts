import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import type { LlmClient, LlmMessage, TurnParams, TurnResult } from '../../src/gui/ai/chat.js';
import { mintConsent, loadConsent, type ConsentGrant } from '../../src/gui/ai/consent-store.js';
import { destructiveIntent, type DispatchCtx } from '../../src/gui/ai/dispatch.js';
import { FeedBus } from '../../src/gui/feed.js';
import { seedClaudeOAuth } from '../helpers/claude-auth.js';

/**
 * AN OPEN CONFIRMATION MUST BE ANSWERABLE WITHOUT THE CLIENT'S HELP.
 *
 * The typed-decline rule — "a reply that is not the affirming click is a refusal" —
 * only ever ran when the BROWSER attached the open card's id to the send. That id is
 * ephemeral in-memory state: a page reload, a stream reconnect, or any client that
 * loses it between rendering the card and the next message drops it. The record then
 * stayed `pending`, the staleness sweep stamped it `expired`, and the gate read "never
 * asked" instead of "asked and said no" — so the plan the user had just walked away
 * from was runnable again on the very next turn, at any size.
 *
 * Three records is far under the unasked size threshold, which is exactly the shape
 * the refusal rule exists to stop: nothing but the refusal can gate this call, so the
 * rows are a direct read-out of whether the refusal was heard.
 *
 * Runs through the real POST /api/chat, because the defect lives in the route: the
 * ledger only sees whatever the route managed to resolve.
 */

let rounds: LlmMessage[][] = [];
let attempts = 0;
let armed = false;

function contextText(msgs: LlmMessage[] | undefined): string {
  const parts: string[] = [];
  for (const m of msgs ?? []) {
    if (typeof m.content === 'string') {
      parts.push(m.content);
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'text') parts.push(b.text);
      else if (b.type === 'tool_result') parts.push(b.content);
      else parts.push(`${b.name} ${JSON.stringify(b.input)}`);
    }
  }
  return parts.join('\n');
}

const scriptedClient: LlmClient = {
  runTurn(params: TurnParams): Promise<TurnResult> {
    const snapshot = JSON.parse(JSON.stringify(params.messages)) as LlmMessage[];
    rounds.push(snapshot);
    const seen = contextText(snapshot);
    const plain = (text: string): Promise<TurnResult> => {
      params.onText(text);
      return Promise.resolve({ stopReason: 'end_turn', text, toolUses: [] });
    };
    if (seen.includes('Title (3-5 words)')) return plain('Notes');
    if (armed) {
      armed = false;
      attempts += 1;
      return Promise.resolve({
        stopReason: 'tool_use',
        text: '',
        toolUses: [
          {
            id: `tu${String(attempts)}`,
            name: 'bulk_update',
            input: { table: 'notes', set: { body: null } },
          },
        ],
      });
    }
    return plain('Understood.');
  },
};

vi.mock('../../src/gui/ai/provider.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/gui/ai/provider.js')>();
  return {
    ...mod,
    resolveLlmProvider: () =>
      Promise.resolve({
        client: scriptedClient,
        kind: 'anthropic' as const,
        authorModel: 'test-model',
        noteError: () => 'other' as const,
      }),
  };
});

vi.mock('../../src/gui/ai/intent.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/gui/ai/intent.js')>();
  return {
    ...mod,
    runIntent: () =>
      Promise.resolve({ needs_work: true, needs_more_info: false, ack_message: 'Working on it…' }),
  };
});

const dirs: string[] = [];
const servers: { close: () => Promise<void> }[] = [];
const savedEnv: Record<string, string | undefined> = {};
let dbPath = '';

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-opencard-cfg-'));
  dirs.push(cfgDir);
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY', 'LATTICE_CHAT_AUTOINGEST']) {
    savedEnv[k] = process.env[k];
  }
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'opencard-test-key';
  process.env.LATTICE_CHAT_AUTOINGEST = 'false';
  seedClaudeOAuth();
  rounds = [];
  attempts = 0;
  armed = false;
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

async function boot(): Promise<{ url: string }> {
  const { startGuiServer } = await import('../../src/gui/server.js');
  const root = mkdtempSync(join(tmpdir(), 'lattice-opencard-srv-'));
  dirs.push(root);
  dbPath = join(root, 'data', 'test.db');
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
    host: '127.0.0.1',
    openBrowser: false,
  });
  servers.push(server);
  return server;
}

async function until(check: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function openWorkspaceDb(): Promise<Lattice> {
  const db = new Lattice(dbPath);
  db.define('notes', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
    render: () => '',
    outputFile: 'notes.md',
  });
  await db.init();
  return db;
}

/** A card the SERVER would really mint: every field off the pre-flight classifier. */
async function openQuestion(db: Lattice, threadId: string): Promise<string> {
  const ctx: DispatchCtx = {
    db,
    feed: new FeedBus(),
    validTables: new Set(['notes']),
    junctionTables: new Set(),
    softDeletable: new Set(),
  };
  const intent = await destructiveIntent(ctx, 'bulk_update', {
    table: 'notes',
    set: { body: null },
  });
  if (!intent) throw new Error('the clear was not classified as destructive');
  const grant: ConsentGrant = {
    tool: 'bulk_update',
    kind: intent.kind,
    target: intent.target,
    verbKey: intent.verbKey,
    maxRows: intent.rows,
    rowsUnknown: intent.rowsUnknown === true,
    rowsSaturated: intent.rowsSaturated === true,
    detail: intent.detail,
  };
  return mintConsent(db, {
    threadId,
    ownerUserId: null,
    grants: [grant],
    affirmIndex: 0,
    optionCount: 2,
    ttlMs: 60_000,
  });
}

async function seedThreeNotes(url: string): Promise<void> {
  for (const body of ['first', 'second', 'third']) {
    const r = await fetch(`${url}/api/tables/notes/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    expect(r.status).toBeLessThan(300);
  }
}

async function openThread(url: string): Promise<string> {
  const opened = (await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hello' }),
  }).then((r) => r.json())) as { threadId: string };
  expect(await until(async () => Promise.resolve(rounds.length >= 1))).toBe(true);
  return opened.threadId;
}

describe('an open confirmation is answered from the store, not from the client', () => {
  it('treats a message that carries NO question id as a refusal of the card still open', async () => {
    const server = await boot();
    await seedThreeNotes(server.url);
    const threadId = await openThread(server.url);

    const db = await openWorkspaceDb();
    try {
      const questionId = await openQuestion(db, threadId);

      // The card is on screen; the browser then reloads, so the next send carries no
      // `questionId` at all. The model retries the plan the card asked about in the
      // SAME turn.
      armed = true;
      const mark = rounds.length;
      const r = await fetch(`${server.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'actually, what were we doing?', threadId }),
      });
      expect(r.status).toBe(202);

      // The card is no longer open, and the loop really ran and really attempted the
      // clear — so what follows is a read-out of the gate, not of a turn that never
      // happened.
      expect(
        await until(async () => (await loadConsent(db, questionId))?.status !== 'pending'),
      ).toBe(true);
      expect(await until(async () => Promise.resolve(attempts >= 1))).toBe(true);
      expect(await until(async () => Promise.resolve(rounds.length >= mark + 2))).toBe(true);

      // THE assertion: three records, far under the unasked threshold, are still
      // there — so the refusal is the only thing that could have stopped it.
      const rows = await db.query('notes', {});
      expect(rows.map((x) => x.body).sort()).toEqual(['first', 'second', 'third']);

      const refusal = rounds.map(contextText).find((t) => t.includes('REFUSED')) ?? '';
      expect(refusal).toContain('said no');

      // ...and the record says the server answered it as a NO. `expired` here is the
      // whole defect: it reads as "never asked".
      expect((await loadConsent(db, questionId))?.status).toBe('declined');
    } finally {
      db.close();
    }
  }, 60_000);

  it('does not touch a card the same message really did answer with a yes', async () => {
    // The sweep must not steal an answer: a send that DOES carry the affirming click
    // settles its own card, and the approved act still runs.
    const server = await boot();
    await seedThreeNotes(server.url);
    const threadId = await openThread(server.url);

    const db = await openWorkspaceDb();
    try {
      const questionId = await openQuestion(db, threadId);
      armed = true;
      const mark = rounds.length;
      const r = await fetch(`${server.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: 'Yes, go ahead',
          threadId,
          questionId,
          optionIndex: 0,
        }),
      });
      expect(r.status).toBe(202);
      expect(
        await until(async () => (await loadConsent(db, questionId))?.status === 'granted'),
      ).toBe(true);
      expect(await until(async () => Promise.resolve(attempts >= 1))).toBe(true);
      expect(await until(async () => Promise.resolve(rounds.length >= mark + 2))).toBe(true);

      expect(
        await until(async () => {
          const rows = await db.query('notes', {});
          return rows.every((x) => x.body === null);
        }),
      ).toBe(true);
    } finally {
      db.close();
    }
  }, 60_000);
});
