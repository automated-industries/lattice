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
 * A REFUSAL HAS TO BE HEARD, AND IT HAS TO LAST.
 *
 * The gate's documented invariant is that a plan the user REFUSED is gated at any
 * size — chipping away at it one small call at a time is the same plan. Two
 * measurements showed the invariant holding for almost nothing:
 *
 *  1. A TYPED refusal never became a refusal at all. The client attaches the open
 *     consent id to every send with optionIndex = -1 for any free-text or
 *     files-only message, and its own comment says that "explicitly DECLINES".
 *     Server-side it became `expired` instead: the staleness sweep ran first and
 *     spared the record only for a non-negative index, and the resolver rejected a
 *     negative index as "not one of the options shown". The gate then saw "never
 *     asked" rather than "asked and said no", and the refused plan RAN. Measured
 *     A/B on one fixture with only the option index differing: a clicked no left
 *     the rows intact; a typed no left them [null, null, null].
 *  2. A refusal lasted exactly ONE turn. The record the gate reads came only from
 *     the questionId on the answering request, and nothing ever looked for a PRIOR
 *     refusal in the conversation. Turn 2's clicked "no" gated correctly; turn 3's
 *     "ok then" re-ran the identical plan and destroyed the rows — while the stored
 *     record still read `declined`.
 *
 * Both run through the real POST /api/chat, because both defects lived in the route,
 * not in the ledger the unit tests hand a hand-built record to. Three records is far
 * under the size threshold, which is exactly the shape the invariant exists to stop.
 */

/** Every model round's context, in order — where a tool_result shows up. */
let rounds: LlmMessage[][] = [];
/** How many times the destructive call has been attempted. */
let attempts = 0;
/** True while the model should attempt the clear on its next real round. */
let armed = false;

/** Flatten one model round's context to the text the model actually reads. */
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
    // Snapshot: the loop keeps mutating the same array after this call returns.
    const snapshot = JSON.parse(JSON.stringify(params.messages)) as LlmMessage[];
    rounds.push(snapshot);
    const seen = contextText(snapshot);
    const plain = (text: string): Promise<TurnResult> => {
      params.onText(text);
      return Promise.resolve({ stopReason: 'end_turn', text, toolUses: [] });
    };
    // The thread-title pass is its own one-shot model call on the same client.
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

// The fast intent pass would otherwise short-circuit the turn inline; force the loop.
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
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-refusal-cfg-'));
  dirs.push(cfgDir);
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY', 'LATTICE_CHAT_AUTOINGEST']) {
    savedEnv[k] = process.env[k];
  }
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'refusal-test-key';
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-refusal-srv-'));
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

/** Poll until `check` passes or the budget runs out. The turn runs in the background. */
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

/**
 * A real consent question about clearing `notes`, exactly as the server mints one —
 * every field read off the pre-flight classifier, the way `planConsent` does. A
 * hand-written `verbKey` here would be a key neither end derives in production, and
 * the refusal history is now keyed on exactly that value.
 */
async function grantForClear(db: Lattice, args: Record<string, unknown>): Promise<ConsentGrant> {
  const ctx: DispatchCtx = {
    db,
    feed: new FeedBus(),
    validTables: new Set(['notes']),
    junctionTables: new Set(),
    softDeletable: new Set(),
  };
  const intent = await destructiveIntent(ctx, 'bulk_update', args);
  if (!intent) throw new Error('the clear was not classified as destructive');
  return {
    tool: 'bulk_update',
    kind: intent.kind,
    target: intent.target,
    verbKey: intent.verbKey,
    maxRows: intent.rows,
    rowsUnknown: intent.rowsUnknown === true,
    rowsSaturated: intent.rowsSaturated === true,
    detail: intent.detail,
  };
}

async function openQuestion(db: Lattice, threadId: string): Promise<string> {
  const grant = await grantForClear(db, { table: 'notes', set: { body: null } });
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

/** Open a thread by sending one ordinary turn. */
async function openThread(url: string): Promise<string> {
  const opened = (await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hello' }),
  }).then((r) => r.json())) as { threadId: string };
  expect(await until(async () => Promise.resolve(rounds.length >= 1))).toBe(true);
  return opened.threadId;
}

describe('a refusal is heard however it is given, and it lasts', () => {
  it('treats a TYPED reply to an open confirmation as a refusal, not as a stale question', async () => {
    const server = await boot();
    await seedThreeNotes(server.url);
    const threadId = await openThread(server.url);

    const db = await openWorkspaceDb();
    try {
      const questionId = await openQuestion(db, threadId);

      // The user types their answer instead of clicking. The client attaches the
      // open consent id with NO option index — which is what a free-text or
      // files-only send always does.
      armed = true;
      const mark = rounds.length;
      const r = await fetch(`${server.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: 'no, please leave those alone',
          threadId,
          questionId,
        }),
      });
      expect(r.status).toBe(202);

      // It was recorded as an ANSWER — a no — not swept away as a question nobody
      // got round to. `expired` here is the whole defect: it reads as "never asked".
      expect(
        await until(async () => (await loadConsent(db, questionId))?.status !== 'pending'),
      ).toBe(true);
      expect((await loadConsent(db, questionId))?.status).toBe('declined');

      // The loop really ran and really attempted the clear.
      expect(await until(async () => Promise.resolve(attempts >= 1))).toBe(true);
      expect(await until(async () => Promise.resolve(rounds.length >= mark + 2))).toBe(true);

      // THE assertion: the records are still there.
      const rows = await db.query('notes', {});
      expect(rows.map((x) => x.body).sort()).toEqual(['first', 'second', 'third']);

      const refusal = rounds.map(contextText).find((t) => t.includes('REFUSED')) ?? '';
      expect(refusal).toContain('said no');
    } finally {
      db.close();
    }
  }, 60_000);

  it('keeps a refused plan refused on the NEXT turn, when nothing is being answered', async () => {
    const server = await boot();
    await seedThreeNotes(server.url);
    const threadId = await openThread(server.url);

    const db = await openWorkspaceDb();
    try {
      const questionId = await openQuestion(db, threadId);

      // Turn 2 — the user clicks "No, cancel". Nothing destructive is attempted.
      const afterAsk = rounds.length;
      const decline = await fetch(`${server.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: 'No, cancel',
          threadId,
          questionId,
          optionIndex: 1,
        }),
      });
      expect(decline.status).toBe(202);
      expect(
        await until(async () => (await loadConsent(db, questionId))?.status === 'declined'),
      ).toBe(true);
      expect(await until(async () => Promise.resolve(rounds.length >= afterAsk + 1))).toBe(true);

      // Turn 3 — an ordinary follow-up carrying NO answer to anything. The model
      // retries the plan the user refused one turn ago.
      armed = true;
      const mark = rounds.length;
      const next = await fetch(`${server.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'ok then', threadId }),
      });
      expect(next.status).toBe(202);
      expect(await until(async () => Promise.resolve(attempts >= 1))).toBe(true);
      expect(await until(async () => Promise.resolve(rounds.length >= mark + 2))).toBe(true);

      // THE assertion: a refusal given last turn still stands this turn.
      const rows = await db.query('notes', {});
      expect(rows.map((x) => x.body).sort()).toEqual(['first', 'second', 'third']);

      const refusal = rounds.map(contextText).find((t) => t.includes('REFUSED')) ?? '';
      expect(refusal).toContain('said no');
      // ...and the record still says so, so this is a durable refusal being honoured
      // rather than the plan happening to fail for some other reason.
      expect((await loadConsent(db, questionId))?.status).toBe('declined');
    } finally {
      db.close();
    }
  }, 60_000);

  it('still lets a later YES override an earlier refusal on the same object', async () => {
    // The refusal must bind until the user is asked again — not for ever. A durable
    // "no" that no later "yes" can lift would make the object permanently unusable
    // for the rest of the conversation, which is its own kind of broken.
    const server = await boot();
    await seedThreeNotes(server.url);
    const threadId = await openThread(server.url);

    const db = await openWorkspaceDb();
    try {
      const firstId = await openQuestion(db, threadId);
      const declined = await fetch(`${server.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: 'No, cancel',
          threadId,
          questionId: firstId,
          optionIndex: 1,
        }),
      });
      expect(declined.status).toBe(202);
      expect(await until(async () => (await loadConsent(db, firstId))?.status === 'declined')).toBe(
        true,
      );

      // Asked again, and this time they say yes.
      const secondId = await openQuestion(db, threadId);
      armed = true;
      const mark = rounds.length;
      const granted = await fetch(`${server.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: 'Yes, go ahead',
          threadId,
          questionId: secondId,
          optionIndex: 0,
        }),
      });
      expect(granted.status).toBe(202);
      expect(await until(async () => (await loadConsent(db, secondId))?.status === 'granted')).toBe(
        true,
      );
      expect(await until(async () => Promise.resolve(attempts >= 1))).toBe(true);
      expect(await until(async () => Promise.resolve(rounds.length >= mark + 2))).toBe(true);

      // The clear the user approved actually happened.
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
