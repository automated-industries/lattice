import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../lattice.js';
import { FeedBus } from './feed.js';
import {
  resolveClaudeAuth,
  getAggressiveness,
  aggressivenessToTemperature,
} from './assistant-routes.js';
import { createAnthropicClient, runChat, type LlmMessage, type ContentBlock } from './ai/chat.js';
import { generateThreadTitle } from './ai/summarize.js';
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
  deleteEntity?: DispatchCtx['deleteEntity'];
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

/** Merge adjacent same-role messages into one (Anthropic requires alternation). */
function collapseSameRole(msgs: LlmMessage[]): LlmMessage[] {
  const toBlocks = (c: string | ContentBlock[]): ContentBlock[] =>
    typeof c === 'string' ? (c ? [{ type: 'text', text: c }] : []) : c;
  const out: LlmMessage[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last?.role === m.role) {
      last.content = [...toBlocks(last.content), ...toBlocks(m.content)];
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/**
 * Rebuild the model's prior-turn context from the persisted thread so it retains
 * row ids it read earlier. The text-only client history drops those ids, which
 * is what made the assistant guess an id (→ "Could not update row") or fabricate
 * a success. Server-authoritative: when a thread exists we rebuild entirely from
 * its persisted messages and ignore the client text history; a new thread (or a
 * disabled flag / read failure) falls back to the text-only client history.
 *
 * Per prior assistant turn that called tools (most-recent N within a byte
 * budget) it emits: assistant[tool_use…] → user[tool_result…] → assistant[text].
 * That keeps roles strictly alternating and every tool_use paired with its
 * tool_result in order — Anthropic 400s otherwise.
 */
async function rehydrateHistory(
  db: Lattice,
  threadId: string | null,
  clientHistory: LlmMessage[],
): Promise<LlmMessage[]> {
  if (!threadId || !rehydrateEnabled()) return clientHistory;
  let rows: Record<string, unknown>[];
  try {
    rows = (await db.query('chat_messages', {
      filters: [
        { col: 'thread_id', op: 'eq', val: threadId },
        { col: 'deleted_at', op: 'isNull' },
      ],
      limit: 1000,
    })) as Record<string, unknown>[];
  } catch {
    return clientHistory; // best-effort — fall back to text-only
  }
  // created_at is second-resolution (datetime('now')), so tie-break on id —
  // otherwise a tool_result could sort before its tool_use and the API 400s.
  const ordered = rows
    .map((r) => ({
      role: asStr(r.role),
      created_at: asStr(r.created_at),
      id: asStr(r.id),
      content_json: asStr(r.content_json, '{}'),
    }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  if (ordered.length === 0) return clientHistory;

  const parsed = ordered.map((m) => {
    let text = '';
    let turns: PersistedTurn[] = [];
    try {
      const p = JSON.parse(m.content_json) as { text?: string; turns?: PersistedTurn[] };
      text = p.text ?? '';
      if (Array.isArray(p.turns)) turns = p.turns;
    } catch {
      /* ignore malformed */
    }
    // Flatten this message's tool calls; never replay a hidden-table result
    // (defensive — those can't be produced, but chat_messages is itself writable).
    const calls = turns
      .flatMap((t) => t.toolCalls ?? [])
      .filter((c) => !ASSISTANT_HIDDEN_TABLES.has(asStr((c.input as { table?: unknown }).table)));
    return { role: m.role, text, calls };
  });

  // Eligibility: most-recent assistant turns with tool calls, newest→oldest,
  // under the turn count + byte budget. Others replay as text only.
  const eligible = new Set<number>();
  let budget = REHYDRATE_MAX_BYTES;
  let used = 0;
  for (let i = parsed.length - 1; i >= 0 && used < REHYDRATE_MAX_TURNS; i--) {
    const p = parsed[i];
    if (!p) continue;
    if (p.role !== 'assistant' || p.calls.length === 0) continue;
    const bytes = p.calls.reduce((n, c) => n + c.content.length + c.id.length, 0);
    if (bytes > budget) continue;
    budget -= bytes;
    used++;
    eligible.add(i);
  }

  const out: LlmMessage[] = [];
  parsed.forEach((p, i) => {
    if (p.role === 'user') {
      if (p.text) out.push({ role: 'user', content: p.text });
      return;
    }
    if (eligible.has(i)) {
      out.push({
        role: 'assistant',
        content: p.calls.map(
          (c): ContentBlock => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input }),
        ),
      });
      out.push({
        role: 'user',
        content: p.calls.map(
          (c): ContentBlock => ({
            type: 'tool_result',
            tool_use_id: c.id,
            content: c.content,
            is_error: c.isError,
          }),
        ),
      });
    }
    if (p.text) out.push({ role: 'assistant', content: p.text });
  });

  // Collapse any accidental consecutive same-role messages (e.g. a truncated
  // turn that ended on a tool call with no final text), and never end on a user
  // message — runChat appends the new user message next, which must alternate.
  const merged = collapseSameRole(out);
  const last = merged[merged.length - 1];
  if (last?.role === 'user') {
    merged.push({ role: 'assistant', content: 'Understood.' });
  }
  return merged;
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

/** One assistant turn: its streamed text + the tool pills it fired, in order. */
interface PersistedTurn {
  text: string;
  tools: { name: string; isError: boolean }[];
  /**
   * Replayable tool detail for cross-turn memory — SERVER-SIDE ONLY (stripped
   * before the GUI reload response). Lets rehydrateHistory rebuild real
   * tool_use/tool_result blocks so a later turn can reference a row id read
   * earlier, instead of guessing it or fabricating an edit.
   */
  toolCalls?: PersistedToolCall[];
}
interface PersistedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  content: string;
  isError: boolean;
}

// Cross-turn rehydration bounds (see rehydrateHistory). Re-sending prior tool
// results to the model costs tokens + Supabase egress, so only the most recent
// REHYDRATE_MAX_TURNS turns within REHYDRATE_MAX_BYTES get full tool blocks;
// older turns replay as plain text.
const REHYDRATE_MAX_TURNS = 6;
const REHYDRATE_MAX_BYTES = 24000;
/** Cross-turn tool replay is on by default; LATTICE_CHAT_REHYDRATE=false disables it. */
function rehydrateEnabled(): boolean {
  return process.env.LATTICE_CHAT_REHYDRATE !== 'false';
}

async function persistMessage(
  db: Lattice,
  threadId: string,
  role: 'user' | 'assistant',
  text: string,
  turns?: PersistedTurn[],
): Promise<void> {
  await db.insert('chat_messages', {
    id: crypto.randomUUID(),
    thread_id: threadId,
    role,
    // `text` stays for backward-compat (old clients + the model-history replay);
    // `turns` carries the rich structure so a reloaded conversation shows the
    // same text bubbles + tool pills as the live stream, not one text wall.
    content_json: JSON.stringify(turns && turns.length > 0 ? { text, turns } : { text }),
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
        let turns: PersistedTurn[] | undefined;
        try {
          const parsed = JSON.parse(asStr(r.content_json, '{}')) as {
            text?: string;
            turns?: PersistedTurn[];
          };
          text = parsed.text ?? '';
          if (Array.isArray(parsed.turns)) {
            // Strip toolCalls — the GUI only needs text + pill names; raw tool
            // result content stays server-side (cross-turn replay only).
            turns = parsed.turns.map((t) => ({ text: t.text, tools: t.tools }));
          }
        } catch {
          /* ignore malformed */
        }
        return {
          role: asStr(r.role),
          text,
          ...(turns ? { turns } : {}),
          created_at: asStr(r.created_at),
        };
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
  const requestedThread = typeof body.threadId === 'string' ? body.threadId : null;
  // Server-authoritative prior-turn context: real tool_use/tool_result blocks
  // rebuilt from the persisted thread so the model retains row ids across turns
  // (the text-only client history drops them). New thread → text-only fallback.
  const history = await rehydrateHistory(ctx.db, requestedThread, mapHistory(body.history));

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
    ...(ctx.deleteEntity ? { deleteEntity: ctx.deleteEntity } : {}),
  };

  let assistantText = '';
  // Rebuild the rich structure as it streams: one entry per assistant turn,
  // each with its text + the tool pills it fired (resolved ok/error). Persisted
  // so a reloaded conversation renders the same way the live stream did.
  const turns: {
    text: string;
    tools: { id: string; name: string; isError: boolean }[];
    toolCalls: PersistedToolCall[];
  }[] = [];
  try {
    const client = createAnthropicClient(auth);
    const temperature = aggressivenessToTemperature(getAggressiveness());
    for await (const ev of runChat({
      client,
      dispatch,
      history,
      userMessage: message,
      temperature,
      // Capture each executed tool call (capped) for cross-turn replay memory.
      onToolRecord: (rec) => {
        turns[turns.length - 1]?.toolCalls.push(rec);
      },
    })) {
      if (ev.type === 'assistant_message_start') {
        turns.push({ text: '', tools: [], toolCalls: [] });
      } else if (ev.type === 'text_delta') {
        assistantText += ev.delta;
        const cur = turns[turns.length - 1];
        if (cur) cur.text += ev.delta;
      } else if (ev.type === 'tool_use') {
        turns[turns.length - 1]?.tools.push({ id: ev.id, name: ev.name, isError: false });
      } else if (ev.type === 'tool_result') {
        const tool = turns[turns.length - 1]?.tools.find((t) => t.id === ev.toolUseId);
        if (tool) tool.isError = ev.isError;
      }
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
    const cleanTurns: PersistedTurn[] = turns
      .map((t) => ({
        text: t.text,
        tools: t.tools.map((x) => ({ name: x.name, isError: x.isError })),
        ...(t.toolCalls.length > 0 ? { toolCalls: t.toolCalls } : {}),
      }))
      .filter((t) => t.text.length > 0 || t.tools.length > 0);
    try {
      await persistMessage(ctx.db, threadId, 'assistant', assistantText, cleanTurns);
    } catch (e) {
      console.warn('[chat] persist assistant message failed:', (e as Error).message);
    }
    // Give a newly-created thread an AI-generated short title in place of the
    // truncated-first-message placeholder set by ensureThread. Best-effort and
    // idempotent: only when THIS request created the thread, we have a reply,
    // and the title is still the exact placeholder — so a user rename is never
    // clobbered. The stream has already ended; the new title surfaces on the
    // next thread-list refresh.
    const createdNew = threadId !== requestedThread;
    if (createdNew && assistantText.trim()) {
      try {
        const placeholder = message.slice(0, 60) || 'Chat';
        const cur = (await ctx.db.get('chat_threads', threadId)) as { title?: string } | null;
        if (cur && (cur.title ?? '') === placeholder) {
          const title = await generateThreadTitle(
            createAnthropicClient(auth),
            message,
            assistantText,
          );
          if (title) await ctx.db.update('chat_threads', threadId, { title });
        }
      } catch (e) {
        console.warn('[chat] thread title generation failed:', (e as Error).message);
      }
    }
  }
  return true;
}
