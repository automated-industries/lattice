import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../lattice.js';
import { FeedBus } from './ai/feed.js';
import { getAnthropicApiKey } from './assistant-routes.js';
import { createAnthropicClient, runChat, type LlmMessage } from './ai/chat.js';
import { formatSseFrame } from './ai/sse.js';
import type { DispatchCtx } from './ai/dispatch.js';

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

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2_000_000) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
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
async function persistTurn(db: Lattice, userMessage: string, assistantText: string): Promise<void> {
  try {
    const threadId = crypto.randomUUID();
    await db.insert('chat_threads', { id: threadId, title: userMessage.slice(0, 60) });
    await db.insert('chat_messages', {
      id: crypto.randomUUID(),
      thread_id: threadId,
      role: 'user',
      content_json: JSON.stringify({ text: userMessage }),
      source: 'gui',
    });
    await db.insert('chat_messages', {
      id: crypto.randomUUID(),
      thread_id: threadId,
      role: 'assistant',
      content_json: JSON.stringify({ text: assistantText }),
      source: 'ai',
    });
  } catch (e) {
    // The stream already reached the user; surface the persistence failure in
    // the log rather than crashing the request after the fact.
    console.warn('[chat] failed to persist turn:', (e as Error).message);
  }
}

export async function dispatchChatRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ChatContext,
): Promise<boolean> {
  if (!(ctx.method === 'POST' && ctx.pathname === '/api/chat')) return false;

  const key = await getAnthropicApiKey(ctx.db);
  if (!key) {
    sendJson(
      res,
      { error: 'No Claude API token configured. Add one in User Settings → Assistant.' },
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

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const dispatch: DispatchCtx = {
    db: ctx.db,
    feed: ctx.feed,
    validTables: ctx.validTables,
    junctionTables: ctx.junctionTables,
    softDeletable: ctx.softDeletable,
  };

  let assistantText = '';
  try {
    const client = createAnthropicClient(key);
    for await (const ev of runChat({ client, dispatch, history, userMessage: message })) {
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
  await persistTurn(ctx.db, message, assistantText);
  return true;
}
