import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LlmClient, TurnParams, TurnResult } from '../../src/gui/ai/chat.js';
import { seedClaudeOAuth } from '../helpers/claude-auth.js';

/**
 * Stopping a reply has to happen on the SERVER. `POST /api/chat` acks 202 and the turn
 * then runs as a detached background job streaming over the realtime socket — so
 * abandoning the browser's request would stop nothing: the job would keep calling the
 * model, keep writing to the workspace, and keep spending tokens.
 *
 * These cover the stop route end to end: it aborts the running turn, the row settles to
 * `stopped` with the partial text intact, it refuses a stop from a different member of a
 * shared workspace, and stopping something that already finished is a benign no-op.
 */

// The model client the turn runs against. Streams a little text, then waits — so the
// test can stop it mid-turn and assert what survived.
let releaseTurn: (() => void) | null = null;
let sawSignalAbort = false;
let turnStarted: Promise<void>;
let markTurnStarted: () => void;

const fakeClient: LlmClient = {
  runTurn(params: TurnParams): Promise<TurnResult> {
    params.onText('partial answer so far');
    markTurnStarted();
    return new Promise<TurnResult>((resolve, reject) => {
      releaseTurn = () => {
        resolve({ stopReason: 'end_turn', text: 'partial answer so far', toolUses: [] });
      };
      const signal = params.signal;
      if (!signal) return;
      signal.addEventListener('abort', () => {
        sawSignalAbort = true;
        reject(new Error('Request was aborted.'));
      });
    });
  },
};

vi.mock('../../src/gui/ai/provider.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/gui/ai/provider.js')>();
  return {
    ...mod,
    resolveLlmProvider: () =>
      Promise.resolve({
        client: fakeClient,
        kind: 'anthropic' as const,
        authorModel: 'test-model',
        noteError: () => 'other' as const,
      }),
  };
});

// The fast intent pass would otherwise call the model too; force it to the tool loop.
vi.mock('../../src/gui/ai/intent.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/gui/ai/intent.js')>();
  return {
    ...mod,
    runIntent: () =>
      Promise.resolve({ needs_work: true, needs_more_info: false, ack_message: 'Working on it…' }),
  };
});

const { startGuiServer } = await import('../../src/gui/server.js');
const { ChatCancelRegistry } = await import('../../src/gui/chat-cancel.js');
const { dispatchChatRoute } = await import('../../src/gui/chat-routes.js');
type GuiServerHandle = Awaited<ReturnType<typeof startGuiServer>>;

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-stop-cfg-'));
  dirs.push(cfgDir);
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY', 'LATTICE_CHAT_AUTOINGEST']) {
    savedEnv[k] = process.env[k];
  }
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'stop-test-key';
  // Reference-material auto-ingest would make its own model call before the turn.
  process.env.LATTICE_CHAT_AUTOINGEST = 'false';
  seedClaudeOAuth();
  releaseTurn = null;
  sawSignalAbort = false;
  turnStarted = new Promise<void>((resolve) => {
    markTurnStarted = resolve;
  });
});

afterEach(async () => {
  if (releaseTurn) releaseTurn();
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-stop-'));
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

interface ReplayMessage {
  id: string;
  role: string;
  text: string;
  status?: string;
}

async function replay(url: string, threadId: string): Promise<ReplayMessage[]> {
  const r = (await fetch(`${url}/api/chat/threads/${threadId}/messages`).then((x) => x.json())) as {
    messages: ReplayMessage[];
  };
  return r.messages;
}

async function waitFor<T>(read: () => Promise<T | null>, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await read();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('stopping a chat turn', () => {
  it('aborts the running turn and settles the row to stopped with the partial text', async () => {
    const server = await boot();
    const ack = (await fetch(`${server.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'do something long' }),
    }).then((r) => r.json())) as { threadId: string; messageId: string };
    expect(ack.messageId).toBeTruthy();

    await turnStarted; // the model call is in flight

    const stop = await fetch(
      `${server.url}/api/chat/messages/${encodeURIComponent(ack.messageId)}/stop`,
      { method: 'POST' },
    );
    expect(stop.status).toBe(202);
    expect(await stop.json()).toMatchObject({ stopped: true });
    // The abort reached the model request itself, not just the loop boundary — an
    // in-flight generation keeps costing until the stream is actually cut.
    expect(sawSignalAbort).toBe(true);

    const row = await waitFor(async () => {
      const msgs = await replay(server.url, ack.threadId);
      const m = msgs.find((x) => x.id === ack.messageId);
      return m?.status === 'stopped' ? m : null;
    }, 'the assistant row to settle as stopped');
    // Whatever streamed before the stop is kept — stopping is not discarding.
    expect(row.text).toContain('partial answer so far');
  });

  it('is a benign no-op for a turn that already settled', async () => {
    const server = await boot();
    const res = await fetch(`${server.url}/api/chat/messages/never-existed/stop`, {
      method: 'POST',
    });
    // Not an error: the reply may simply have finished between the click and the request.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stopped: false, reason: 'not_running' });
  });

  it('refuses a stop for a turn owned by a different member', async () => {
    // On a shared cloud the app connects with a bypass role, so the ownership check in
    // the route is the boundary. Drive the route directly against a stub whose dialect
    // is postgres and whose session identity is someone else.
    const registry = new ChatCancelRegistry();
    registry.register('msg-theirs', 'thread-theirs', 'member-a');

    const db = {
      getDialect: () => 'postgres',
      adapter: {
        get: () => ({ u: 'member-b' }),
        getAsync: () => Promise.resolve({ u: 'member-b' }),
      },
    };

    const published: unknown[] = [];
    let status = 0;
    let payload = '';
    const res = {
      writeHead: (s: number) => {
        status = s;
      },
      end: (b: string) => {
        payload = b;
      },
    };

    const handled = await dispatchChatRoute(
      {} as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      {
        db: db as never,
        feed: { publish: () => undefined } as never,
        validTables: new Set<string>(),
        junctionTables: new Set<string>(),
        softDeletable: new Set<string>(),
        chatProgress: { publish: (e: unknown) => published.push(e) } as never,
        chatCancel: registry,
        enqueueChatJob: () => undefined,
        pathname: '/api/chat/messages/msg-theirs/stop',
        method: 'POST',
      },
    );

    expect(handled).toBe(true);
    expect(status).toBe(403);
    expect(payload).toContain('someone else');
    // Refused means refused: the turn is untouched and nothing was broadcast.
    expect(registry.get('msg-theirs')?.controller.signal.aborted).toBe(false);
    expect(published).toEqual([]);
  });

  it('lets the owner stop their own turn on a shared workspace', async () => {
    const registry = new ChatCancelRegistry();
    registry.register('msg-mine', 'thread-mine', 'member-a');
    const db = {
      getDialect: () => 'postgres',
      adapter: {
        get: () => ({ u: 'member-a' }),
        getAsync: () => Promise.resolve({ u: 'member-a' }),
      },
    };
    const published: { event?: { type?: string } }[] = [];
    let status = 0;
    const res = {
      writeHead: (s: number) => {
        status = s;
      },
      end: () => undefined,
    };

    await dispatchChatRoute({} as unknown as IncomingMessage, res as unknown as ServerResponse, {
      db: db as never,
      feed: { publish: () => undefined } as never,
      validTables: new Set<string>(),
      junctionTables: new Set<string>(),
      softDeletable: new Set<string>(),
      chatProgress: { publish: (e: { event?: { type?: string } }) => published.push(e) } as never,
      chatCancel: registry,
      enqueueChatJob: () => undefined,
      pathname: '/api/chat/messages/msg-mine/stop',
      method: 'POST',
    });

    expect(status).toBe(202);
    expect(registry.get('msg-mine')?.controller.signal.aborted).toBe(true);
    // A terminal frame goes out immediately so every bound client releases, even if
    // the job is still winding down (or has not reached the front of the queue yet).
    expect(published.map((p) => p.event?.type)).toEqual(['done']);
  });
});

/**
 * Attachments must never degrade into "the user sent bare text". An id that does not
 * resolve is a failure to report, not an empty string to fall through on — collapsing
 * the two is what turned "here are five files" into a turn about one of them, and made
 * an attached file get answered with "what would you like me to do with that?".
 */
describe('attached files are resolved, not assumed', () => {
  it('reports supplied / resolved / missing separately', async () => {
    const { Lattice } = await import('../../src/lattice.js');
    const { resolveAttachedFiles } = await import('../../src/gui/chat-routes.js');
    const root = mkdtempSync(join(tmpdir(), 'lattice-attach-'));
    dirs.push(root);
    const db = new Lattice(join(root, 'attach.db'));
    db.define('files', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'files.md',
    });
    await db.init();
    await db.insert('files', { id: 'real-1', name: 'quarterly.csv' });
    const fileId = { id: 'real-1' };

    const none = await resolveAttachedFiles(db, []);
    expect(none).toMatchObject({ suppliedIds: [], resolvedIds: [], missingIds: [], note: '' });

    const partial = await resolveAttachedFiles(db, [{ id: fileId.id }, { id: 'ghost' }]);
    expect(partial.suppliedIds).toHaveLength(2);
    expect(partial.resolvedIds).toEqual([fileId.id]);
    expect(partial.missingIds).toEqual(['ghost']);
    expect(partial.note).toContain('quarterly.csv');
    // The shortfall is named in the prompt, so the reply cannot claim to have read
    // something it never saw.
    expect(partial.note).toContain('could NOT be read');

    const allGone = await resolveAttachedFiles(db, [{ id: 'ghost-a' }, { id: 'ghost-b' }]);
    expect(allGone.suppliedIds).toHaveLength(2);
    expect(allGone.resolvedIds).toEqual([]);
    expect(allGone.missingIds).toEqual(['ghost-a', 'ghost-b']);
    db.close();
  });

  it('refuses a turn whose attachments all failed to resolve, instead of sending it as text', async () => {
    const server = await boot();
    const res = await fetch(`${server.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'analyze these',
        attachedFiles: [{ id: 'ghost', name: 'ghost.csv' }],
      }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('could not be read');
    // Nothing was persisted — a refused turn leaves no orphan message behind.
    const list = (await fetch(`${server.url}/api/chat/threads`).then((r) => r.json())) as {
      threads: unknown[];
    };
    expect(list.threads).toEqual([]);
  });

  it('a files-only send persists the empty message plus its attachment names', async () => {
    const server = await boot();
    const file = (await fetch(`${server.url}/api/tables/files/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'notes.md' }),
    }).then((r) => r.json())) as { id: string };

    const ack = (await fetch(`${server.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '',
        attachedFiles: [{ id: file.id, name: 'notes.md' }],
      }),
    }).then((r) => r.json())) as { threadId: string; messageId: string };

    await turnStarted; // let the background turn reach the model, then let it finish
    releaseTurn?.();

    const msgs = (await fetch(`${server.url}/api/chat/threads/${ack.threadId}/messages`).then((r) =>
      r.json(),
    )) as { messages: { role: string; text: string; files?: string[] }[] };
    const user = msgs.messages.find((m) => m.role === 'user');
    // The filename is the ATTACHMENT, not the message. Persisting it as the message
    // text is what made the model treat a filename as the user's request.
    expect(user?.text).toBe('');
    expect(user?.files).toEqual(['notes.md']);
  });
});
