import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../lattice.js';
import { FeedBus } from './feed.js';
import {
  resolveClaudeAuth,
  getAggressiveness,
  aggressivenessToTemperature,
} from './assistant-routes.js';
import { createAnthropicClient, runChat, type LlmMessage } from './ai/chat.js';
import { formatSseFrame } from './ai/sse.js';
import {
  ASSISTANT_HIDDEN_TABLES,
  type AssistantJunction,
  type DispatchCtx,
} from './ai/dispatch.js';

/**
 * POST /api/chat — the assistant chat stream. Resolves the Claude token,
 * runs the tool loop against the active database, and streams the SSE event
 * protocol to the browser. Each completed turn is persisted to the native
 * chat_threads / chat_messages entities.
 *
 * Localhost trust, same as the other GUI routes; team-cloud mode does not
 * mount it.
 */

interface ChatContext {
  db: Lattice;
  feed: FeedBus;
  validTables: Set<string>;
  junctionTables: Set<string>;
  softDeletable: Set<string>;
  createEntity?: (name: string, columns: string[]) => Promise<string | null>;
  createJunction?: (tableA: string, tableB: string) => Promise<AssistantJunction | null>;
  pathname: string;
  method: string;
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/** Coerce an unknown DB column to a string, with a fallback for null/non-string. */
function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      raw += c;
      if (raw.length > 2_000_000) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Map client-supplied prior turns into the loop's message format. */
function mapHistory(raw: unknown): LlmMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: LlmMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const role = (item as { role?: unknown }).role;
    const text = (item as { text?: unknown }).text;
    if ((role === 'user' || role === 'assistant') && typeof text === 'string') {
      out.push({ role, content: text });
    }
  }
  return out;
}

/** Persist one completed exchange to the native chat entities (best-effort). */
async function ensureThread(db: Lattice, threadId: string | null, title: string): Promise<string> {
  if (threadId) {
    const existing = (await db.get('chat_threads', threadId)) as {
      deleted_at?: string | null;
    } | null;
    if (existing && !existing.deleted_at) return threadId;
  }
  const id = crypto.randomUUID();
  await db.insert('chat_threads', { id, title: title.slice(0, 60) || 'Chat' });
  return id;
}

async function persistMessage(
  db: Lattice,
  threadId: string,
  role: 'user' | 'assistant',
  text: string,
): Promise<void> {
  await db.insert('chat_messages', {
    id: crypto.randomUUID(),
    thread_id: threadId,
    role,
    content_json: JSON.stringify({ text }),
    source: role === 'user' ? 'gui' : 'ai',
  });
}

export async function dispatchChatRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ChatContext,
): Promise<boolean> {
  // GET /api/chat/threads — conversation list, most recent first.
  if (ctx.method === 'GET' && ctx.pathname === '/api/chat/threads') {
    const rows = (await ctx.db.query('chat_threads', { limit: 100 })) as Record<string, unknown>[];
    const threads = rows
      .filter((r) => !r.deleted_at)
      .map((r) => ({
        id: asStr(r.id),
        title: asStr(r.title, 'Chat'),
        created_at: asStr(r.created_at),
      }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    sendJson(res, { threads });
    return true;
  }

  // GET /api/chat/threads/:id/messages — replay a conversation.
  const msgMatch = /^\/api\/chat\/threads\/([^/]+)\/messages$/.exec(ctx.pathname);
  if (ctx.method === 'GET' && msgMatch) {
    const threadId = decodeURIComponent(msgMatch[1] ?? '');
    const rows = (await ctx.db.query('chat_messages', { limit: 1000 })) as Record<
      string,
      unknown
    >[];
    const messages = rows
      .filter((r) => r.thread_id === threadId && !r.deleted_at)
      .map((r) => {
        let text = '';
        try {
          text = (JSON.parse(asStr(r.content_json, '{}')) as { text?: string }).text ?? '';
        } catch {
          /* ignore malformed */
        }
        return { role: asStr(r.role), text, created_at: asStr(r.created_at) };
      })
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    sendJson(res, { messages });
    return true;
  }

  if (!(ctx.method === 'POST' && ctx.pathname === '/api/chat')) return false;

  const auth = await resolveClaudeAuth(ctx.db);
  if (!auth) {
    sendJson(
      res,
      {
        error:
          'No Claude auth configured. Connect a subscription or add an API token in User Settings → Assistant.',
      },
      400,
    );
    return true;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch (e) {
    sendJson(res, { error: (e as Error).message }, 400);
    return true;
  }
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    sendJson(res, { error: 'message is required' }, 400);
    return true;
  }
  const history = mapHistory(body.history);
  const requestedThread = typeof body.threadId === 'string' ? body.threadId : null;

  // Resolve the thread + persist the user message BEFORE streaming so the
  // thread id can ride back on a header. One thread per conversation; the
  // client reuses it across turns.
  let threadId = '';
  try {
    threadId = await ensureThread(ctx.db, requestedThread, message);
    await persistMessage(ctx.db, threadId, 'user', message);
  } catch (e) {
    console.warn('[chat] persist user message failed:', (e as Error).message);
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-thread-id': threadId,
  });

  // Strip credential-bearing native tables (secrets) so the assistant can
  // neither query them nor be told they exist — it reads rows already decrypted.
  const dispatch: DispatchCtx = {
    db: ctx.db,
    feed: ctx.feed,
    validTables: new Set([...ctx.validTables].filter((t) => !ASSISTANT_HIDDEN_TABLES.has(t))),
    junctionTables: new Set([...ctx.junctionTables].filter((t) => !ASSISTANT_HIDDEN_TABLES.has(t))),
    softDeletable: ctx.softDeletable,
    ...(ctx.createEntity ? { createEntity: ctx.createEntity } : {}),
    ...(ctx.createJunction ? { createJunction: ctx.createJunction } : {}),
  };

  let assistantText = '';
  try {
    const client = createAnthropicClient(auth);
    const temperature = aggressivenessToTemperature(await getAggressiveness(ctx.db));
    for await (const ev of runChat({
      client,
      dispatch,
      history,
      userMessage: message,
      temperature,
    })) {
      if (ev.type === 'text_delta') assistantText += ev.delta;
      try {
        res.write(formatSseFrame(ev));
      } catch {
        break; // client disconnected
      }
    }
  } catch (e) {
    try {
      res.write(formatSseFrame({ type: 'error', message: (e as Error).message }));
      res.write(formatSseFrame({ type: 'done' }));
    } catch {
      // socket gone
    }
  }
  res.end();
  if (threadId) {
    try {
      await persistMessage(ctx.db, threadId, 'assistant', assistantText);
    } catch (e) {
      console.warn('[chat] persist assistant message failed:', (e as Error).message);
    }
  }
  return true;
}
