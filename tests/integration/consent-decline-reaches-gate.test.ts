import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import type { LlmClient, LlmMessage, TurnParams, TurnResult } from '../../src/gui/ai/chat.js';
import { mintConsent, loadConsent, type ConsentGrant } from '../../src/gui/ai/consent-store.js';
import { seedClaudeOAuth } from '../helpers/claude-auth.js';

/**
 * A DECLINE has to reach the gate, through the real route.
 *
 * The gate has always had the rule: a plan the user REFUSED is gated at any size,
 * because chipping away at it one small call at a time is the same plan and the size
 * screen waves every one of those through. The rule was written, documented, and
 * unit-tested by handing the ledger a declined record directly.
 *
 * The route never built one. It kept the resolved record only when the answer was a
 * YES, so `status === 'declined'` was unreachable in production and everything behind
 * it was dead code — the refusal branch, its explanation, and the any-size rule. The
 * unit tests passed because they constructed the state the route could not.
 *
 * So this test constructs nothing. It answers a real consent question with the
 * NON-affirming option through POST /api/chat, lets the real orchestration run, and
 * asks the only question that matters: after an explicit no, does a SMALL destructive
 * call on that exact object still go through? Three records is far under the size
 * threshold, which is precisely the shape the missing branch existed to stop.
 */

/** The user's refusal, used to recognise the turn that follows it. */
const DECLINE_TEXT = 'No, cancel';

/** Every model round's context, in order — where a tool_result shows up. */
let rounds: LlmMessage[][] = [];
/** True once the destructive call has been attempted (once per test). */
let attemptedDestructive = false;
/** Set when the turn after the decline should attempt the clear. */
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
    // Recognised so the round numbering of the real turns cannot drift under it.
    if (seen.includes('Title (3-5 words)')) return plain('Notes');
    if (armed && !attemptedDestructive && seen.includes(DECLINE_TEXT)) {
      attemptedDestructive = true;
      return Promise.resolve({
        stopReason: 'tool_use',
        text: '',
        toolUses: [
          { id: 'tu1', name: 'bulk_update', input: { table: 'notes', set: { body: null } } },
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
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-decline-cfg-'));
  dirs.push(cfgDir);
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY', 'LATTICE_CHAT_AUTOINGEST']) {
    savedEnv[k] = process.env[k];
  }
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'decline-test-key';
  // Reference-material auto-ingest would make its own model call before the turn.
  process.env.LATTICE_CHAT_AUTOINGEST = 'false';
  seedClaudeOAuth();
  rounds = [];
  attemptedDestructive = false;
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-decline-srv-'));
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

describe('a declined consent record reaches the destructive gate', () => {
  it('a small clear on the refused object is still refused after the user says no', async () => {
    const server = await boot();

    // Three records — comfortably under the size threshold, so nothing but the
    // refusal itself can gate this call.
    for (const body of ['first', 'second', 'third']) {
      const r = await fetch(`${server.url}/api/tables/notes/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      expect(r.status).toBeLessThan(300);
    }

    // Turn 1 exists only to open a thread the consent record can be scoped to.
    const opened = (await fetch(`${server.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    }).then((r) => r.json())) as { threadId: string };
    expect(await until(async () => Promise.resolve(rounds.length >= 1))).toBe(true);

    const db = await openWorkspaceDb();
    try {
      // A real consent question about clearing that object, exactly as the server
      // mints one. Option 0 affirms; the user is about to pick option 1.
      const grant: ConsentGrant = {
        tool: 'bulk_update',
        kind: 'clear',
        target: 'notes',
        verbKey: 'clear:body',
        maxRows: 3,
        rowsUnknown: false,
        rowsSaturated: false,
        detail: 'clear "body" on 3 record(s) in "notes"',
      };
      const questionId = await mintConsent(db, {
        threadId: opened.threadId,
        ownerUserId: null,
        grants: [grant],
        affirmIndex: 0,
        optionCount: 2,
        ttlMs: 60_000,
      });

      // Turn 2: the user clicks "No, cancel", and the model tries the small clear
      // anyway — the exact plan they just refused, one call at a time.
      armed = true;
      const mark = rounds.length;
      const r = await fetch(`${server.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: DECLINE_TEXT,
          threadId: opened.threadId,
          questionId,
          optionIndex: 1,
        }),
      });
      expect(r.status).toBe(202);

      // The no was recorded as a real answer, not swept as stale.
      expect(
        await until(async () => (await loadConsent(db, questionId))?.status === 'declined'),
      ).toBe(true);

      // The tool loop really ran and really attempted the clear — without this the
      // assertion below would be vacuously true.
      expect(await until(async () => Promise.resolve(attemptedDestructive))).toBe(true);
      // ...and the call has been dispatched and its result handed back (the round
      // after the tool round), so what follows reads a settled workspace.
      expect(await until(async () => Promise.resolve(rounds.length >= mark + 2))).toBe(true);

      // THE assertion — the one no privilege bit or log line can satisfy: the
      // records the user refused to have cleared are still there.
      const rows = await db.query('notes', {});
      expect(rows.map((x) => x.body).sort()).toEqual(['first', 'second', 'third']);

      // And the model was told WHY, so it does not simply retry the same call.
      const refusal = rounds.map(contextText).find((t) => t.includes('REFUSED')) ?? '';
      expect(refusal).toContain('said no');
      expect(refusal).toContain('size does not make it allowed');
    } finally {
      db.close();
    }
  }, 60_000);
});
