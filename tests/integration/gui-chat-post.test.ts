import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { seedClaudeOAuth } from '../helpers/claude-auth.js';
import { Lattice } from '../../src/lattice.js';
import { loadConsent, mintConsent, type ConsentGrant } from '../../src/gui/ai/consent-store.js';

/**
 * POST /api/chat — the assistant chat stream. Claude access is OAuth-only, and a
 * server-side gate refuses every AI-mutating route when no subscription is
 * connected. We can exercise everything except the live model round-trip by
 * seeding a fake connected subscription:
 *   - no subscription connected → the gate returns 403 claude_not_connected
 *   - empty message (subscription connected) → 400
 *   - a real message persists the thread + user message and ACKs 202
 *     {threadId, messageId}; the turn then runs as a background job (its events go
 *     to the chat-progress bus, not the response). The model call is pointed at a
 *     dead endpoint so the background turn fails fast; disposeActive drains the job
 *     on close. Covers the synchronous persist + 202-ack paths.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-chatpost-cfg-'));
  dirs.push(cfgDir);
  for (const k of [
    'LATTICE_CONFIG_DIR',
    'LATTICE_ENCRYPTION_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
  ]) {
    savedEnv[k] = process.env[k];
  }
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'chatpost-test-key';
  delete process.env.ANTHROPIC_API_KEY; // no ambient key should grant auth
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

/** The workspace DB file behind the last {@link boot} — for asserting server state. */
let lastDbPath = '';

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-chatpost-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  lastDbPath = join(root, 'data', 'test.db');
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
      '    outputFile: notes.md',
      '',
    ].join('\n'),
  );
  const server = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    host: '127.0.0.1',
    teamCloud: false,
    openBrowser: false,
  });
  servers.push(server);
  return server;
}

/**
 * A stub Anthropic Messages endpoint that answers every call with one canned text
 * turn, streamed in the SDK's SSE shape, and counts the calls it received.
 *
 * The point of counting: the two routes through a chat turn are told apart by HOW
 * MANY model calls they make. The intent short-circuit answers inline after exactly
 * ONE call (the intent pass itself); the heavy tool loop makes that call and then at
 * least one more. Pointing at a dead endpoint — as the older cases here do — cannot
 * distinguish them, because a failed intent pass falls through to the loop anyway.
 */
async function startModelStub(replyText: string): Promise<{
  url: string;
  calls: () => number;
  close: () => Promise<void>;
}> {
  let calls = 0;
  const frame = (event: string, data: unknown): string =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const server: Server = createServer((req, res) => {
    calls++;
    // Drain the request body before replying (the SDK sends one).
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.write(
        frame('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_stub',
            type: 'message',
            role: 'assistant',
            model: 'stub',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }),
      );
      res.write(
        frame('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      );
      res.write(
        frame('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: replyText },
        }),
      );
      res.write(frame('content_block_stop', { type: 'content_block_stop', index: 0 }));
      res.write(
        frame('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 5 },
        }),
      );
      res.write(frame('message_stop', { type: 'message_stop' }));
      res.end();
    });
  });
  // Await LISTENING before reading the port: address() is null until then, and a
  // stub advertised on port 0 fails as an opaque "Connection error" in the SDK.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    calls: () => calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** The intent pass's reply that routes a turn to the INLINE answer (no tool loop). */
const INLINE_INTENT = [
  '```json',
  JSON.stringify({
    intent_summary: 'acknowledgement',
    ack_message: 'Glad to hear it.',
    needs_work: false,
    needs_more_info: false,
  }),
  '```',
].join('\n');

/** Open a second connection to the booted workspace's DB, for direct assertions. */
async function openWorkspaceDb(): Promise<Lattice> {
  const db = new Lattice(lastDbPath);
  await db.init();
  return db;
}

/** A grant the server would have derived for removing `table`. */
function grantFor(table: string): ConsentGrant {
  return {
    tool: 'delete_entity',
    kind: 'remove_object',
    target: table,
    verbKey: 'resolution:delete_data',
    maxRows: 40,
    rowsUnknown: false,
    detail: `remove "${table}" (40 record(s))`,
  };
}

/** Send one chat turn and wait for the route to accept it. */
async function post(s: GuiServerHandle, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${s.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Poll until `check` passes or the budget runs out. The turn runs in the background. */
async function until(check: () => Promise<boolean>, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('POST /api/chat', () => {
  it('403s claude_not_connected when no subscription is connected', async () => {
    const s = await boot();
    const r = await fetch(`${s.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('claude_not_connected');
  });

  it('400s on an empty message once a subscription is connected', async () => {
    const s = await boot();
    seedClaudeOAuth();
    const r = await fetch(`${s.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    expect(r.status).toBe(400);
    expect(String((await r.json()).error)).toMatch(/message is required/i);
  });

  it('persists the thread + user message and ACKs 202 {threadId, messageId}; the background turn fails against a dead model endpoint', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'; // nothing listens → the background turn fails fast
    const s = await boot();
    seedClaudeOAuth();
    const r = await fetch(`${s.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'remember this' }),
    });
    // Async transport: the route acks immediately (202) with the ids the client uses to
    // bind the turn to the chat-progress bus, instead of holding a streamed response open.
    expect(r.status).toBe(202);
    expect(r.headers.get('x-thread-id')).toBeTruthy();
    const ack = (await r.json()) as { threadId?: string; messageId?: string };
    expect(ack.threadId).toBeTruthy();
    expect(ack.messageId).toBeTruthy();

    const threads = (await fetch(`${s.url}/api/chat/threads`).then((x) => x.json())) as {
      threads: { id: string }[];
    };
    expect(threads.threads.length).toBeGreaterThanOrEqual(1);
    const tid = threads.threads[0]!.id;
    const msgs = (await fetch(`${s.url}/api/chat/threads/${tid}/messages`).then((x) =>
      x.json(),
    )) as {
      messages: { role: string; text: string; id?: string }[];
    };
    // The user message is persisted synchronously, BEFORE the 202 — so it is present the
    // instant the ack returns, independent of the background turn's outcome.
    expect(msgs.messages.some((m) => m.role === 'user' && m.text === 'remember this')).toBe(true);
    // The pending assistant row was persisted under the acked messageId (its status will
    // settle to 'error' once the background turn fails against the dead endpoint).
    expect(msgs.messages.some((m) => m.role === 'assistant' && m.id === ack.messageId)).toBe(true);
  });

  it('persists attached file names on the user message so they survive a reload', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'; // background turn fails fast; persistence is synchronous
    const s = await boot();
    seedClaudeOAuth();

    // Attach REAL files. The route now refuses a turn whose attachment ids it
    // cannot resolve (see the next case), so a fixture with invented ids would
    // be exercising the refusal rather than the persistence it means to check.
    const mk = async (name: string): Promise<string> => {
      const res = await fetch(`${s.url}/api/ingest/text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `contents of ${name}`, title: name }),
      });
      return ((await res.json()) as { id: string }).id;
    };
    const a = await mk('report.pdf');
    const b = await mk('notes.docx');

    const r = await fetch(`${s.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'look at these',
        attachedFiles: [
          { id: a, name: 'report.pdf' },
          { id: b, name: 'notes.docx' },
        ],
      }),
    });
    expect(r.status).toBe(202);
    const threads = (await fetch(`${s.url}/api/chat/threads`).then((x) => x.json())) as {
      threads: { id: string }[];
    };
    const tid = threads.threads[0]!.id;
    const msgs = (await fetch(`${s.url}/api/chat/threads/${tid}/messages`).then((x) =>
      x.json(),
    )) as {
      messages: { role: string; text: string; files?: string[] }[];
    };
    const user = msgs.messages.find((m) => m.role === 'user');
    expect(user?.text).toBe('look at these');
    // The reload (GET /messages) returns the attachment names so the client re-renders
    // its chips — they used to be lost because only the message text was persisted.
    expect(user?.files).toEqual(['report.pdf', 'notes.docx']);
  });

  it('refuses a turn whose attachments cannot be resolved instead of sending it without them', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
    const s = await boot();
    seedClaudeOAuth();

    // Ids that resolve to nothing (stale, or deleted between upload and send).
    // This used to degrade silently into a no-attachments turn: the model was
    // asked about files it never received, and the user was never told their
    // attachments had been dropped.
    const r = await fetch(`${s.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'look at these',
        attachedFiles: [
          { id: 'f1', name: 'report.pdf' },
          { id: 'f2', name: 'notes.docx' },
        ],
      }),
    });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error?: string };
    expect(body.error).toMatch(/could not be read/i);

    // ...and nothing was persisted, so the composer can restore and retry.
    const threads = (await fetch(`${s.url}/api/chat/threads`).then((x) => x.json())) as {
      threads: { id: string }[];
    };
    expect(threads.threads).toHaveLength(0);
  });
});

/**
 * DURABLE CONSENT AT THE ROUTE.
 *
 * Three properties, each closing a way the previous transcript-derived consent could
 * be bypassed or misread:
 *
 *  - STALENESS IS SERVER-ENFORCED. Every send expires the questions still open in
 *    the thread. Keyed on nothing the client sends, because the bypass it closes is
 *    precisely a send that carries no user text to go stale — a files-only turn used
 *    to leave an open destructive question live behind it.
 *  - A BARE "YES" WITH NO HANDLE GRANTS NOTHING. Agreement has to be an answer to a
 *    question the server wrote down, not a word that appeared in a message.
 *  - A GRANTED RECORD REACHES THE TOOL LOOP. The text of an answer to a confirmation
 *    is "Yes, go ahead", which the fast intent pass reads as small talk with no work
 *    in it — so it would be answered inline and the act the user just approved would
 *    never run.
 */
describe('POST /api/chat — durable consent', () => {
  let stub: { url: string; calls: () => number; close: () => Promise<void> } | null = null;

  afterEach(async () => {
    await stub?.close();
    stub = null;
  });

  /** Start a thread and return its id (the turn itself is allowed to fail). */
  async function startThread(s: GuiServerHandle): Promise<string> {
    const r = await post(s, { message: 'hello' });
    expect(r.status).toBe(202);
    return ((await r.json()) as { threadId: string }).threadId;
  }

  it('a files-only turn EXPIRES a pending consent record (the staleness bypass)', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
    const s = await boot();
    seedClaudeOAuth();
    const threadId = await startThread(s);

    // A real file to attach, so the turn carries an attachment and NO text — the
    // shape that used to slip past the staleness rule entirely.
    const fileId = (
      (await fetch(`${s.url}/api/ingest/text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'contents', title: 'notes.txt' }),
      }).then((x) => x.json())) as { id: string }
    ).id;

    const db = await openWorkspaceDb();
    try {
      const id = await mintConsent(db, {
        threadId,
        ownerUserId: null,
        grants: [grantFor('notes')],
        affirmIndex: 0,
        optionCount: 2,
        ttlMs: 60_000,
      });
      expect((await loadConsent(db, id))?.status).toBe('pending');

      const r = await post(s, {
        message: '',
        threadId,
        attachedFiles: [{ id: fileId, name: 'notes.txt' }],
      });
      expect(r.status).toBe(202);

      expect(await until(async () => (await loadConsent(db, id))?.status === 'expired')).toBe(true);
      // Expired ⇒ nothing it described can ever be authorized.
      expect((await loadConsent(db, id))?.status).toBe('expired');
    } finally {
      db.close();
    }
  });

  it('a later bare "yes" with no questionId grants nothing', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
    const s = await boot();
    seedClaudeOAuth();
    const threadId = await startThread(s);

    const db = await openWorkspaceDb();
    try {
      const id = await mintConsent(db, {
        threadId,
        ownerUserId: null,
        grants: [grantFor('notes')],
        affirmIndex: 0,
        optionCount: 2,
        ttlMs: 60_000,
      });

      // The word, with none of the machinery: no handle, no index.
      const r = await post(s, { message: 'yes, go ahead', threadId });
      expect(r.status).toBe(202);

      expect(await until(async () => (await loadConsent(db, id))?.status !== 'pending')).toBe(true);
      const after = await loadConsent(db, id);
      expect(after?.status).toBe('expired'); // swept, never granted
      expect(after?.answerIndex).toBeNull();
      expect(after?.grants.every((g) => g.spentAt === undefined)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('a granted record bypasses the intent short-circuit and reaches the tool loop', async () => {
    stub = await startModelStub(INLINE_INTENT);
    process.env.ANTHROPIC_BASE_URL = stub.url;
    const s = await boot();
    seedClaudeOAuth();
    const threadId = await startThread(s);
    await until(async () => Promise.resolve(stub!.calls() >= 1));

    const db = await openWorkspaceDb();
    try {
      // BASELINE FIRST: the same message with no consent handle. The stub always
      // answers "needs_work: false", so this is answered inline — exactly ONE model
      // call. Run before the record is minted, because this send would (correctly)
      // sweep it: a message that answers nothing ends every open question.
      const before = stub.calls();
      expect((await post(s, { message: 'Yes, go ahead', threadId })).status).toBe(202);
      await until(async () => Promise.resolve(stub!.calls() > before));
      await new Promise((r) => setTimeout(r, 300)); // let any further calls land
      expect(stub.calls() - before).toBe(1);

      const id = await mintConsent(db, {
        threadId,
        ownerUserId: null,
        grants: [grantFor('notes')],
        affirmIndex: 0,
        optionCount: 2,
        ttlMs: 60_000,
      });

      // NOW with the handle + the affirming index. Same text, same classification —
      // but the recorded yes routes it to the tool loop, which calls the model again.
      const mark = stub.calls();
      const r = await post(s, {
        message: 'Yes, go ahead',
        threadId,
        questionId: id,
        optionIndex: 0,
      });
      expect(r.status).toBe(202);
      expect(await until(async () => Promise.resolve(stub!.calls() - mark >= 2))).toBe(true);

      // ...and the answer really was recorded as a grant, not merely observed.
      expect((await loadConsent(db, id))?.status).toBe('granted');
      expect((await loadConsent(db, id))?.answerIndex).toBe(0);
    } finally {
      db.close();
    }
  });
});
