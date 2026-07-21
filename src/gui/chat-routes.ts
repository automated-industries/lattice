import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../lattice.js';
import { isCloudChat, resolveChatOwnerId } from './chat-identity.js';
import type { ChatProgressBus } from './chat-progress.js';
import type { ChatStreamEvent } from './ai/sse.js';
import { FeedBus } from './feed.js';
import { getAggressiveness, aggressivenessToTemperature } from './assistant-routes.js';
import {
  runChat,
  buildSchemaContext,
  type LlmClient,
  type LlmMessage,
  type ContentBlock,
} from './ai/chat.js';
import { resolveLlmProvider } from './ai/provider.js';
import { runIntent, type IntentResult } from './ai/intent.js';
import { type MutationCtx } from './mutations.js';
import type { FileJunction } from './data.js';
import { generateHtmlFile } from './ai/html-author.js';
import { qaDashboard } from './ai/dashboard-qa.js';
import { readIdentity } from '../framework/user-config.js';
import { getCloudSetting, CLOUD_SETTING_SYSTEM_PROMPT } from '../cloud/settings.js';
import { generateThreadTitle, triageReferenceMaterial } from './ai/summarize.js';
import { getClaudeLimitState, clearClaudeLimit, CLAUDE_LIMIT_MESSAGE } from './ai/limit-state.js';
import { columnDescriptionHook } from './meta-gen.js';
import { sendJson, readJson } from './http.js';
import {
  ASSISTANT_HIDDEN_TABLES,
  type AssistantJunction,
  type DispatchCtx,
} from './ai/dispatch.js';
import { FetchBudget } from '../ai/fetch-policy.js';
import {
  collectFromMarkdown,
  applyTraceLinks,
  appendSources,
  enrichExistingLinks,
  snapshotMissingFields,
  type TraceRef,
  type FocusedRef,
} from './ai/trace-links.js';

/**
 * Trace-link an intent-inline answer (the fast path that skips the tool loop):
 * harvest the thread's established lattice:// links from recent persisted
 * assistant messages, then linkify matches and cite paraphrased records. A
 * bounded, thread-scoped read; best-effort — a failure returns the text as-is.
 */
async function traceLinkInlineAnswer(
  db: Lattice,
  threadId: string | null,
  ownerUserId: string | null,
  text: string,
): Promise<string> {
  if (!threadId || !text) return text;
  try {
    const filters = [
      { col: 'thread_id', op: 'eq' as const, val: threadId },
      { col: 'role', op: 'eq' as const, val: 'assistant' },
      { col: 'deleted_at', op: 'isNull' as const },
    ];
    if (ownerUserId != null) {
      filters.push({ col: 'owner_user_id', op: 'eq' as const, val: ownerUserId });
    }
    const rows = (await db.query('chat_messages', { filters, limit: 60 })) as Record<
      string,
      unknown
    >[];
    const linkables = new Map<string, TraceRef | null>();
    const focused = new Map<string, FocusedRef>();
    for (const r of rows) {
      try {
        const p = JSON.parse(asStr(r.content_json, '{}')) as { text?: string };
        if (p.text) collectFromMarkdown(p.text, linkables, focused);
      } catch {
        // malformed persisted message — nothing to harvest from it
      }
    }
    await snapshotMissingFields(
      (t, i) => db.get(t, i) as Promise<Record<string, unknown> | null>,
      text,
      focused,
    );
    return appendSources(enrichExistingLinks(applyTraceLinks(text, linkables), focused), focused);
  } catch {
    return text; // best-effort: an unreadable thread must not block the answer
  }
}

/** Lifecycle of the assistant row, persisted in content_json so a reload mid-turn can
 *  recover: `pending` (accepted, not started) → `streaming` → `done` | `error`. */
type ChatMessageStatus = 'pending' | 'streaming' | 'done' | 'error';

/** If the intent pass hasn't produced an acknowledgement within this window, publish a
 *  templated one so the user is never left waiting on a blank typing bubble. */
const INTENT_ACK_WATCHDOG_MS = 8000;

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
  addColumn?: (
    table: string,
    column: string,
  ) => Promise<{ ok: true; column: string } | { ok: false; error: string }>;
  createJunction?: (tableA: string, tableB: string) => Promise<AssistantJunction | null>;
  createFileJunction?: DispatchCtx['createFileJunction'];
  deleteEntity?: DispatchCtx['deleteEntity'];
  /** Faithfully import an attached spreadsheet by files id (deterministic importer). */
  importAttachment?: DispatchCtx['importAttachment'];
  /** Registered computed tables — tagged read-only in the assistant's schema context. */
  computedTables?: Set<string>;
  /** Computed-table primitives for the assistant's computed-table tools. */
  computedOps?: DispatchCtx['computedOps'];
  /** Member-scoped "Connected data sources" section for the assistant's context,
   *  so it knows which MCP servers / databases are connected. Omitted when none. */
  connectedSources?: string;
  /** True when the connected-sources list could NOT be determined this turn (enumeration
   *  threw). Distinct from "none connected": the intent pass must then NOT answer a
   *  connection question with a false negative — it defers to the tool loop instead. */
  connectionsUnknown?: boolean;
  /** Active config path + rendered-context dir, for the `dedup` tool's link re-pointing. */
  configPath?: string;
  outputDir?: string;
  /** GUI session id — stamped on the assistant's mutations so they're undoable. */
  sessionId?: string;
  /** Per-workspace bus the chat turn publishes its streamed events to (delivered to the
   *  GUI over /api/stream, gated per user). Chat text lives here, not on a held-open
   *  POST response. */
  chatProgress: ChatProgressBus;
  /** Enqueue the heavy chat loop onto the workspace's serialized FIFO (active.chatJobs),
   *  so a second message runs only after the first finishes. Fire-and-forget. */
  enqueueChatJob: (job: () => Promise<void>) => void;
  pathname: string;
  method: string;
}

/** Coerce an unknown DB column to a string, with a fallback for null/non-string. */
function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * Build the "the user just attached these files" note that connects a chat message
 * to the files the user attached to it (ingested via the composer Send just before
 * the message is sent). Each id is grounded against the VISIBLE files table — so a
 * stale/invisible/invented id is dropped rather than referenced — and the resulting
 * note (empty when nothing valid is attached) is prefixed to the model's turn so it
 * works on exactly those files with its existing file tools. Any file type, any
 * count. Exported for regression testing. Bounded to 25 ids.
 */
export async function buildAttachedFilesNote(db: Lattice, attachedFiles: unknown): Promise<string> {
  const ids = Array.isArray(attachedFiles)
    ? (attachedFiles as unknown[])
        .map((f) =>
          f && typeof (f as { id?: unknown }).id === 'string' ? (f as { id: string }).id : null,
        )
        .filter((x): x is string => !!x)
        .slice(0, 25)
    : [];
  if (!ids.length) return '';
  const labels: string[] = [];
  for (const id of ids) {
    try {
      const row = (await db.get('files', id)) as {
        id: string;
        name?: string;
        original_name?: string;
      } | null;
      if (row) {
        const display =
          [row.name, row.original_name].find((n) => typeof n === 'string' && n.length > 0) ??
          'file';
        labels.push(`"${display}" (files id ${row.id})`);
      }
    } catch {
      // stale/invisible id — skip rather than invent a reference
    }
  }
  if (!labels.length) return '';
  const many = labels.length > 1;
  return (
    `[The user just attached ${many ? 'these files' : 'this file'} to this message — ` +
    `${many ? 'they have' : 'it has'} been added to their Files: ${labels.join(', ')}. ` +
    `Read ${many ? 'them' : 'it'} with your file tools and use ${many ? 'them' : 'it'} to do what the user asks.]\n\n`
  );
}

/** Env off-switch for auto-ingesting reference material from chat messages
 *  (default ON). Mirrors LATTICE_CHAT_REHYDRATE. */
function autoIngestEnabled(): boolean {
  return process.env.LATTICE_CHAT_AUTOINGEST !== 'false';
}

/** Wiring for {@link ingestReferenceMaterial} — the same creators the chat dispatch
 *  holds, so auto-ingested content enriches with the workspace's real schema. */
export interface ReferenceIngestDeps {
  db: Lattice;
  feed: FeedBus;
  softDeletable: Set<string>;
  aggressiveness?: number;
  createEntity?: (name: string, columns: string[]) => Promise<string | null>;
  createFileJunction?: (otherTable: string) => Promise<FileJunction | null>;
  createObjectJunction?: (tableA: string, tableB: string) => Promise<AssistantJunction | null>;
  privateMode?: boolean;
}

/** Prepended to the model's turn when reference material was auto-ingested, so it works
 *  with the saved item instead of re-creating it. Order-agnostic wording (the note may
 *  sit before or after the attached-files note). */
const REFERENCE_INGEST_NOTE =
  "[Note: reference material in the user's message has already been saved to their " +
  'Files and automatically enriched by the ingestion engine — linked to the records it ' +
  'refers to, with any structured objects it describes extracted and linked. Do NOT ' +
  're-create, re-save, or re-link that content; just address the request and refer to ' +
  'what was saved if useful.]\n\n';

/**
 * Route any REFERENCE MATERIAL in the user's message through the SAME engine a dropped
 * file uses — decided by content TYPE (facts / notes / a pasted document / a link), not
 * size. A message may be mixed (reference material + a directive); only the reference
 * portion is ingested here, and the assistant still handles the directive. Deterministic
 * where it counts: the classifier ALWAYS runs (ingestion isn't left to the chat model
 * choosing a tool), and the finding-and-linking is the engine's, not prompt rules'.
 *
 * Runs BEFORE the chat turn and is fully awaited: row writes aren't serialized against
 * the chat's own tool writes (better-sqlite3 is one connection), so overlapping them
 * would race BEGIN — sequencing avoids that AND lets the model reference what was saved.
 *
 * Returns a note to prepend to the model's turn, or '' when there was nothing to save,
 * auto-ingest is disabled, or it failed. Best-effort: a triage/ingest failure is logged
 * and never blocks the chat. Exported for regression testing.
 */
export async function ingestReferenceMaterial(
  client: LlmClient,
  message: string,
  deps: ReferenceIngestDeps,
  temperature: number,
): Promise<string> {
  if (!autoIngestEnabled()) return '';
  let reference = '';
  try {
    reference = (await triageReferenceMaterial(client, message, temperature)).reference;
  } catch (e) {
    console.warn('[chat] reference-material triage failed:', (e as Error).message);
    return '';
  }
  const ref = reference.trim();
  if (!ref) return '';

  // source:'ingest' (not 'ai') so the saved-and-linked activity surfaces on the
  // persistent feed exactly like a dropped file, not as a chat-turn activity card.
  const mctx: MutationCtx = {
    db: deps.db,
    feed: deps.feed,
    softDeletable: deps.softDeletable,
    source: 'ingest',
    onColumnsAdded: columnDescriptionHook(deps.db),
  };
  try {
    const { ingestTextAsFile, looksLikeUrl } = await import('./ingest-routes.js');
    // A bare URL is CRAWLED for its readable text (SSRF + policy guarded), mirroring the
    // /api/ingest/text route; anything else is saved as text. Both go through enrichment.
    if (looksLikeUrl(ref)) {
      const { ingestUrlAsFile } = await import('./ingest-url.js');
      await ingestUrlAsFile(
        {
          db: deps.db,
          mctx,
          ...(deps.privateMode ? { privateMode: true } : {}),
          enrich: {
            fileJunctions: [],
            entityDescriptions: {},
            ...(deps.aggressiveness !== undefined ? { aggressiveness: deps.aggressiveness } : {}),
            ...(deps.createEntity ? { createEntity: deps.createEntity } : {}),
            ...(deps.createFileJunction ? { createJunction: deps.createFileJunction } : {}),
            ...(deps.createObjectJunction
              ? { createObjectJunction: deps.createObjectJunction }
              : {}),
          },
        },
        ref,
      );
      return REFERENCE_INGEST_NOTE;
    }
    await ingestTextAsFile(
      {
        db: deps.db,
        mctx,
        fileJunctions: [],
        entityDescriptions: {},
        ...(deps.aggressiveness !== undefined ? { aggressiveness: deps.aggressiveness } : {}),
        ...(deps.createEntity ? { createEntity: deps.createEntity } : {}),
        ...(deps.createFileJunction ? { createJunction: deps.createFileJunction } : {}),
        ...(deps.createObjectJunction ? { createObjectJunction: deps.createObjectJunction } : {}),
        ...(deps.privateMode ? { privateMode: true } : {}),
      },
      ref,
      'Pasted note',
    );
    return REFERENCE_INGEST_NOTE;
  } catch (e) {
    console.warn('[chat] reference-material ingest failed:', (e as Error).message);
    return '';
  }
}

/**
 * Validate the client's "what am I looking at" hint into `{ table, id }`, or null.
 * The table must be a known table (so a bogus hint can't inject a fake name into
 * the prompt) and the id a short non-empty string. Access is still enforced by the
 * tools the assistant calls; this only resolves deictic references ("this file").
 */
export function parseActiveContext(
  raw: unknown,
  validTables: Set<string>,
): { table: string; id: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const table = (raw as { table?: unknown }).table;
  const id = (raw as { id?: unknown }).id;
  if (typeof table !== 'string' || typeof id !== 'string') return undefined;
  if (!validTables.has(table)) return undefined;
  const trimmedId = id.trim();
  if (trimmedId.length === 0 || trimmedId.length > 256) return undefined;
  return { table, id: trimmedId };
}

/**
 * A short context note telling the model what the user is currently LOOKING AT, so
 * "this" / "it" / "why is this broken" resolve without asking. Prepended to the
 * turn's message (the dispatch + tools still see the real message). Empty when no
 * view context was sent. For a dashboard it names the page and points at the
 * `investigate` tool, so the model diagnoses a complaint itself instead of
 * interrogating the user for details it can find.
 */
async function describeActiveView(
  db: Lattice,
  active: { table: string; id: string } | undefined,
): Promise<{ note: string; label: string }> {
  if (!active) return { note: '', label: '' };
  if (active.table === 'dashboards') {
    const d = (await db.get('dashboards', active.id).catch(() => null)) as {
      title?: string;
    } | null;
    const name = d?.title ? `"${d.title}"` : 'the one on screen';
    return {
      label: `the dashboard ${name}`,
      note:
        `[The user is currently viewing the dashboard ${name}. If they say "this" / "it" / ` +
        `"this dashboard", or ask why something is broken, empty, blank, or wrong, they mean THIS ` +
        `dashboard — call \`investigate\` to find the concrete fault yourself instead of asking ` +
        `them what is wrong.]\n\n`,
    };
  }
  const label = `the ${active.table} record "${active.id}"`;
  return {
    label,
    note: `[The user is currently viewing ${label} — "this" / "it" refers to it.]\n\n`,
  };
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
 * Render the tail of the conversation as a compact "Role: text" transcript, so the fast
 * intent pass can resolve a context-dependent reply ("yes", "the first one") against what
 * the assistant just said instead of judging it in a vacuum. Text blocks only — tool
 * calls/results carry no user-facing meaning for the classifier and would just add noise.
 */
function renderRecentContext(history: LlmMessage[], maxMessages: number): string {
  const textOf = (c: string | ContentBlock[]): string =>
    typeof c === 'string'
      ? c
      : c
          .map((b) => (b.type === 'text' ? b.text : ''))
          .join(' ')
          .trim();
  const lines: string[] = [];
  for (const m of history.slice(-maxMessages)) {
    const t = textOf(m.content).trim();
    if (!t) continue;
    lines.push(`${m.role === 'assistant' ? 'Assistant' : 'User'}: ${t.slice(0, 800)}`);
  }
  return lines.join('\n');
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
  ownerUserId: string | null,
): Promise<LlmMessage[]> {
  if (!threadId || !rehydrateEnabled()) return clientHistory;
  let rows: Record<string, unknown>[];
  try {
    // On a team cloud, only ever rebuild context from the operator's OWN
    // messages — never reconstruct another member's conversation from a
    // guessed thread id.
    const filters = [
      { col: 'thread_id', op: 'eq' as const, val: threadId },
      { col: 'deleted_at', op: 'isNull' as const },
    ];
    if (ownerUserId != null) {
      filters.push({ col: 'owner_user_id', op: 'eq' as const, val: ownerUserId });
    }
    rows = (await db.query('chat_messages', {
      filters,
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

/**
 * Resolve (or create) the thread for this exchange, stamping the owning member.
 * A chat is private to its author: on a team cloud (`ownerUserId` non-null) an
 * existing thread is reused ONLY when the operator owns it — a thread owned by
 * someone else (or a guessed/foreign id) is never appended to; a fresh,
 * operator-owned thread is created instead. On a local DB (`ownerUserId` null)
 * there is one user, so ownership is not enforced.
 */
async function ensureThread(
  db: Lattice,
  threadId: string | null,
  title: string,
  ownerUserId: string | null,
): Promise<string> {
  if (threadId) {
    const existing = (await db.get('chat_threads', threadId)) as {
      deleted_at?: string | null;
      owner_user_id?: string | null;
    } | null;
    const ownsIt = ownerUserId == null || (existing?.owner_user_id ?? null) === ownerUserId;
    if (existing && !existing.deleted_at && ownsIt) return threadId;
  }
  const id = crypto.randomUUID();
  await db.insert('chat_threads', {
    id,
    title: title.slice(0, 60) || 'Chat',
    owner_user_id: ownerUserId,
  });
  return id;
}

/** A data-change the assistant made during a turn, captured from the feed bus so
 *  a reloaded conversation replays the same collapsed activity cards the live rail
 *  showed. Reads (list/get) publish no feed event, so only mutations are stored. */
interface PersistedTurnEvent {
  op: string;
  table: string | null;
  rowId: string | null;
  summary: string;
  /** Feed timestamp of the event, so a reloaded turn can show how long the
   *  run took (first event → last) instead of a relative "ago". */
  ts?: string;
}
/** One assistant turn: its streamed text + the activity it produced, in order. */
interface PersistedTurn {
  text: string;
  tools: { name: string; isError: boolean }[];
  /** Data-change events this turn produced (mutations only). Replayed as the
   *  per-thread activity cards in the rail. */
  events?: PersistedTurnEvent[];
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
  ownerUserId: string | null,
  turns?: PersistedTurn[],
  startedAt?: string,
  id?: string,
  status?: ChatMessageStatus,
): Promise<void> {
  // `text` stays for backward-compat (old clients + the model-history replay);
  // `turns` carries the rich structure so a reloaded conversation shows the same
  // bubbles + activity cards as the live stream. `startedAt` lets the replay show
  // each card's task DURATION (start → last event) instead of a relative "ago".
  // `status` drives recovery: a reload mid-turn sees 'pending'/'streaming' and rebinds
  // to the live chat-progress stream; 'done'/'error' render as final.
  const payload: {
    text: string;
    turns?: PersistedTurn[];
    startedAt?: string;
    status?: ChatMessageStatus;
  } = turns && turns.length > 0 ? { text, turns } : { text };
  if (startedAt) payload.startedAt = startedAt;
  if (status) payload.status = status;
  // Upsert-by-id powers incremental assistant checkpointing: the same row is
  // inserted early in the turn and UPDATEd as it streams, so a mid-turn refresh
  // recovers the work so far. Without an id (e.g. the user message) a fresh row
  // is always inserted.
  if (id) {
    const existing = await db.get('chat_messages', id);
    if (existing) {
      await db.update('chat_messages', id, { content_json: JSON.stringify(payload) });
      return;
    }
    await db.insert('chat_messages', {
      id,
      thread_id: threadId,
      owner_user_id: ownerUserId,
      role,
      content_json: JSON.stringify(payload),
      source: role === 'user' ? 'gui' : 'ai',
    });
    return;
  }
  await db.insert('chat_messages', {
    id: crypto.randomUUID(),
    thread_id: threadId,
    // Mirror the owning member onto each message so a message read can be
    // filtered independently of the thread join. NULL on local DBs.
    owner_user_id: ownerUserId,
    role,
    content_json: JSON.stringify(payload),
    source: role === 'user' ? 'gui' : 'ai',
  });
}

export async function dispatchChatRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ChatContext,
): Promise<boolean> {
  // A chat belongs ONLY to the user who created it. The app connects as a
  // BYPASSRLS role, so Postgres RLS does NOT filter the owner's connection — we
  // MUST scope every chat read by owner in the app layer too (and fail CLOSED:
  // on a cloud with no resolvable identity, show nothing rather than everything).
  const ownerUserId = await resolveChatOwnerId(ctx.db);
  const cloud = isCloudChat(ctx.db);
  // Belt-and-suspenders predicate: on a cloud a row is visible to this user ONLY
  // if its owner matches; a NULL owner (orphaned/legacy) is visible to NO ONE.
  const ownedByMe = (r: Record<string, unknown>): boolean =>
    !cloud || (r.owner_user_id != null && r.owner_user_id === ownerUserId);

  // GET /api/chat/threads — conversation list, most recent first.
  if (ctx.method === 'GET' && ctx.pathname === '/api/chat/threads') {
    if (cloud && ownerUserId == null) {
      sendJson(res, { threads: [] }); // fail closed — identity unresolved
      return true;
    }
    const filters: { col: string; op: 'isNull' | 'eq'; val?: unknown }[] = [
      { col: 'deleted_at', op: 'isNull' },
    ];
    if (ownerUserId != null) filters.push({ col: 'owner_user_id', op: 'eq', val: ownerUserId });
    const rows = (await ctx.db.query('chat_threads', { filters, limit: 100 })) as Record<
      string,
      unknown
    >[];
    const threads = rows
      .filter((r) => !r.deleted_at && ownedByMe(r))
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
    if (cloud && ownerUserId == null) {
      sendJson(res, { messages: [] }); // fail closed — identity unresolved
      return true;
    }
    // Scope by owner too (not just thread_id) so a member can't read another
    // member's messages even by guessing a thread id.
    const msgFilters: { col: string; op: 'eq' | 'isNull'; val?: unknown }[] = [
      { col: 'thread_id', op: 'eq', val: threadId },
    ];
    if (ownerUserId != null) msgFilters.push({ col: 'owner_user_id', op: 'eq', val: ownerUserId });
    const rows = (await ctx.db.query('chat_messages', {
      filters: msgFilters,
      limit: 1000,
    })) as Record<string, unknown>[];
    const messages = rows
      .filter((r) => r.thread_id === threadId && !r.deleted_at && ownedByMe(r))
      .map((r) => {
        let text = '';
        let turns: PersistedTurn[] | undefined;
        let startedAt: string | undefined;
        let status: ChatMessageStatus | undefined;
        try {
          const parsed = JSON.parse(asStr(r.content_json, '{}')) as {
            text?: string;
            turns?: PersistedTurn[];
            startedAt?: string;
            status?: ChatMessageStatus;
          };
          text = parsed.text ?? '';
          if (typeof parsed.startedAt === 'string') startedAt = parsed.startedAt;
          if (typeof parsed.status === 'string') status = parsed.status;
          if (Array.isArray(parsed.turns)) {
            // Strip toolCalls — the GUI only needs text + the data-change events
            // (replayed as activity cards); raw tool result content stays
            // server-side (cross-turn replay only).
            turns = parsed.turns.map((t) => ({
              text: t.text,
              tools: t.tools,
              ...(t.events ? { events: t.events } : {}),
            }));
          }
        } catch {
          /* ignore malformed */
        }
        return {
          // `id` + `status` let the GUI rebind a turn that was still streaming when the
          // page reloaded: a 'pending'/'streaming' last assistant row is re-bound to the
          // live chat-progress bus by messageId instead of replayed as a finished bubble.
          id: asStr(r.id),
          role: asStr(r.role),
          text,
          ...(turns ? { turns } : {}),
          ...(startedAt ? { startedAt } : {}),
          ...(status ? { status } : {}),
          created_at: asStr(r.created_at),
        };
      })
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    sendJson(res, { messages });
    return true;
  }

  if (!(ctx.method === 'POST' && ctx.pathname === '/api/chat')) return false;

  const provider = await resolveLlmProvider(ctx.db);
  if (!provider) {
    sendJson(
      res,
      {
        error:
          'No model provider configured. Connect a Claude subscription or an OpenAI-compatible model in User Settings → Assistant.',
      },
      400,
    );
    return true;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJson(req, { maxBytes: 2_000_000 });
  } catch (e) {
    sendJson(res, { error: (e as Error).message }, 400);
    return true;
  }
  const rawMessage = typeof body.message === 'string' ? body.message.trim() : '';
  const hasAttachments = Array.isArray(body.attachedFiles) && body.attachedFiles.length > 0;
  // A turn needs SOMETHING to act on — a message OR an attachment. A files-only send
  // (drop a file into the assistant with no text) still gets a response: synthesize a
  // directive so the model reads the attached files (the attached-files note names them).
  if (!rawMessage && !hasAttachments) {
    sendJson(res, { error: 'message is required' }, 400);
    return true;
  }
  const message = rawMessage || 'Take a look at the attached file(s).';
  const requestedThread = typeof body.threadId === 'string' ? body.threadId : null;

  // Fail CLOSED: on a cloud we must know who this is before creating or reading
  // any chat row — otherwise a thread would land with a NULL owner (world-
  // readable). If the identity can't be resolved, refuse rather than write an
  // un-owned chat.
  if (cloud && ownerUserId == null) {
    sendJson(res, { error: 'Could not resolve your cloud identity; chat is disabled.' }, 500);
    return true;
  }

  // The record the user is currently viewing (table + id), so "delete this file"
  // resolves to it. Client-supplied hint, validated to a known table; every action
  // still flows through the permission-gated tools, so this can't widen access.
  const activeContext = parseActiveContext(body.activeContext, ctx.validTables);
  // Server-authoritative prior-turn context: real tool_use/tool_result blocks
  // rebuilt from the persisted thread so the model retains row ids across turns
  // (the text-only client history drops them). Scoped to THIS user's messages.
  const history = await rehydrateHistory(
    ctx.db,
    requestedThread,
    mapHistory(body.history),
    ownerUserId,
  );

  // Resolve the thread + persist the user message BEFORE streaming so the
  // thread id can ride back on a header. One thread per conversation; the client
  // reuses it across turns. Every chat row is STAMPED with this user's id so it
  // is private to them (app-layer filter + RLS both key on it).
  let threadId = '';
  try {
    threadId = await ensureThread(ctx.db, requestedThread, message, ownerUserId);
    await persistMessage(ctx.db, threadId, 'user', message, ownerUserId);
  } catch (e) {
    console.warn('[chat] persist user message failed:', (e as Error).message);
  }

  // Connect the request to the files the user just attached (ingested via the
  // composer Send) so the assistant works on them with its existing file tools.
  const attachedNote = await buildAttachedFilesNote(ctx.db, body.attachedFiles);
  // What the user is currently looking at, so "this"/"it"/"why is this broken"
  // resolve to the open dashboard/record (and a complaint routes to `investigate`).
  const activeView = await describeActiveView(ctx.db, activeContext);

  // Persist a PENDING assistant row and respond IMMEDIATELY (202) — the turn then runs
  // in a background job and streams over the /api/stream WebSocket, so the request path
  // ends here instead of being held open for the whole agentic loop. The client shows a
  // typing bubble on the 202 and renders live chat-progress frames keyed by (threadId,
  // messageId); a reload mid-turn recovers from this row's `status` (see persistMessage).
  const turnStartedAt = new Date().toISOString();
  const assistantMsgId = crypto.randomUUID();
  try {
    await persistMessage(
      ctx.db,
      threadId,
      'assistant',
      '',
      ownerUserId,
      [],
      turnStartedAt,
      assistantMsgId,
      'pending',
    );
  } catch (e) {
    console.warn('[chat] persist pending assistant row failed:', (e as Error).message);
  }
  res.writeHead(202, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-thread-id': threadId,
  });
  res.end(JSON.stringify({ threadId, messageId: assistantMsgId }));

  // Everything below runs in the BACKGROUND job, publishing each event to the
  // chat-progress bus instead of a held-open response. Serialized per workspace via the
  // FIFO (enqueueChatJob) so a queued second message runs after the first; the job never
  // touches `res` and runs to completion even if the client disconnects/reloads (recovery
  // reads the checkpointed row). enqueueChatJob catches + logs a job failure loudly rather
  // than letting the rejection escape unhandled.
  let streamStatus: ChatMessageStatus = 'streaming';
  const publish = (event: ChatStreamEvent): void => {
    ctx.chatProgress.publish({ threadId, messageId: assistantMsgId, ownerUserId, event });
  };
  // Stream a complete answer (the intent-inline paths: a trivial reply or a clarifying
  // question) into the SAME bubble the client is showing, then settle + end the turn — no
  // tool loop. Mirrors the loop's frame sequence so the client renders it identically and
  // a reload replays it from the persisted row.
  const finishWithAnswer = async (text: string, status: ChatMessageStatus): Promise<void> => {
    streamStatus = status;
    publish({ type: 'assistant_message_start', id: assistantMsgId });
    if (text) publish({ type: 'text_delta', delta: text });
    publish({ type: 'assistant_message_end' });
    try {
      await persistMessage(
        ctx.db,
        threadId,
        'assistant',
        text,
        ownerUserId,
        [],
        turnStartedAt,
        assistantMsgId,
        status,
      );
    } catch (e) {
      console.warn('[chat] persist intent answer failed:', (e as Error).message);
    }
    publish({ type: 'done' });
  };

  // The heavy agentic tool loop — runs on the per-workspace FIFO (serialized) only when the
  // intent pass says the request needs data work. Defined here (not enqueued yet) so the
  // intent orchestrator below can decide whether to run it.
  const runHeavyLoop = async (): Promise<void> => {
    // Strip credential-bearing native tables (secrets) so the assistant can
    // neither query them nor be told they exist — it reads rows already decrypted.
    const dispatch: DispatchCtx = {
      db: ctx.db,
      feed: ctx.feed,
      // "Private mode" chat toggle: force rows the assistant creates this turn private
      // regardless of the table default (a transient per-request choice).
      privateMode: body.privateMode === true,
      // Live-aware table set: the open-time snapshot PLUS anything registered
      // since (a connector connected this session), minus internal + hidden. A
      // defineLate connector table (mcp_items) is otherwise absent from the
      // snapshot, so the assistant would reject it as "Unknown table".
      validTables: new Set(
        [...ctx.validTables, ...ctx.db.getRegisteredTableNames()].filter(
          (t) =>
            !ASSISTANT_HIDDEN_TABLES.has(t) &&
            !t.startsWith('__lattice') &&
            !t.startsWith('_lattice'),
        ),
      ),
      junctionTables: new Set(
        [...ctx.junctionTables].filter((t) => !ASSISTANT_HIDDEN_TABLES.has(t)),
      ),
      ...(ctx.connectedSources ? { connectedSources: ctx.connectedSources } : {}),
      softDeletable: ctx.softDeletable,
      onColumnsAdded: columnDescriptionHook(ctx.db),
      aggressiveness: getAggressiveness(),
      // The user's message this turn — ingest_url only fetches a URL found here.
      userMessage: message,
      // One shared fetch budget for the whole turn (caps assistant-driven fetches).
      urlFetchBudget: new FetchBudget(),
      ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
      ...(ctx.outputDir !== undefined ? { outputDir: ctx.outputDir } : {}),
      ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.createEntity ? { createEntity: ctx.createEntity } : {}),
      ...(ctx.addColumn ? { addColumn: ctx.addColumn } : {}),
      ...(ctx.createJunction ? { createJunction: ctx.createJunction } : {}),
      ...(ctx.createFileJunction ? { createFileJunction: ctx.createFileJunction } : {}),
      ...(ctx.deleteEntity ? { deleteEntity: ctx.deleteEntity } : {}),
      ...(ctx.importAttachment ? { importAttachment: ctx.importAttachment } : {}),
      // Copied like validTables so in-turn additions (create_computed_table)
      // stay visible to later tool calls without mutating the server's set —
      // the audited op updates the workspace-level set itself.
      ...(ctx.computedTables ? { computedTables: new Set(ctx.computedTables) } : {}),
      ...(ctx.computedOps ? { computedOps: ctx.computedOps } : {}),
    };

    // Delegated HTML-file authoring: create_html_file / edit_html_file call this to
    // author a full standalone HTML page. The closure builds its own client from the
    // SAME resolved auth (api-key or OAuth) and the live schema, so SDK-missing /
    // provider errors surface as a tool error (recoverable), never a crash. The model
    // is the strongest the auth can actually run — sonnet for an API key (entitled to
    // all models), the chat model for an OAuth subscription (whose entitlements vary;
    // a non-entitled model 429s every call). If the user is viewing an html artifact,
    // expose its id so edit_html_file targets the file on screen by default.
    const authorModel = provider.authorModel;
    const authorHtml = async (spec: string, currentHtml?: string): Promise<string> => {
      const schema = await buildSchemaContext(dispatch);
      return generateHtmlFile({
        client: provider.client,
        schema,
        spec,
        model: authorModel,
        ...(currentHtml !== undefined ? { currentHtml } : {}),
      });
    };
    dispatch.htmlAuthor = authorHtml;
    // Automatic QA for an authored dashboard: run its data queries + check them against the
    // request, repair via the same author, and report residual issues (see dashboard-qa).
    // On by default; LATTICE_DASHBOARD_QA=false disables it (skips the extra queries + judge
    // call + any repair round per dashboard create/edit).
    if (process.env.LATTICE_DASHBOARD_QA !== 'false') {
      dispatch.qaDashboard = (html: string, intent: string) =>
        qaDashboard(
          { db: ctx.db, client: provider.client, model: authorModel, reAuthor: authorHtml },
          html,
          intent,
        );
    }
    if (activeContext?.table === 'dashboards') {
      // The user is looking at a dashboard — make it edit_dashboard's default
      // target. No existence probe needed: the handler verifies the row itself.
      dispatch.activeDashboardId = activeContext.id;
    }

    // turnStartedAt + assistantMsgId are declared above (before the 202) — they identify
    // the pending row this job now fills in.
    let assistantText = '';
    // Rebuild the rich structure as it streams: one entry per assistant turn, each
    // with its text + the data-change events it produced. Persisted so a reloaded
    // conversation renders the same collapsed activity cards the live stream did.
    const turns: {
      text: string;
      tools: { id: string; name: string; isError: boolean }[];
      events: PersistedTurnEvent[];
      toolCalls: PersistedToolCall[];
    }[] = [];
    // Capture the assistant's data-change events from the feed bus, bucketed into
    // the turn that produced them. feed.publish is synchronous inside the tool's
    // executeFunction, so each event lands in the current (last-pushed) turn. Only
    // source='ai' — this assistant's own writes — is captured, never other clients.
    const unsubscribeFeed = ctx.feed.subscribe((fe) => {
      if (fe.source !== 'ai') return;
      const cur = turns[turns.length - 1];
      if (cur)
        cur.events.push({
          op: fe.op,
          table: fe.table,
          rowId: fe.rowId,
          summary: fe.summary ?? '',
          ts: fe.ts,
        });
    });
    // The cloud owner's workspace system prompt, bundled into every member's chat.
    // Best-effort + read through the member's own RLS-scoped connection: a member
    // never sees this text in the UI/API (owner-only there), it's only injected into
    // the turn here. null on local / unset / un-upgraded cloud → no injection.
    const cloudSystemPrompt =
      (await getCloudSetting(ctx.db, CLOUD_SETTING_SYSTEM_PROMPT)) ?? undefined;

    // Incremental checkpointing: the assistant message is persisted under the stable
    // assistantMsgId declared above and UPDATEd as the turn streams, so a refresh mid-turn
    // (notably a long batch run) recovers the work so far instead of losing the whole turn.
    let lastCheckpoint = 0;
    let checkpointWarned = false;
    const buildCleanTurns = (): PersistedTurn[] =>
      turns
        .map((t) => ({
          text: t.text,
          tools: t.tools.map((x) => ({ name: x.name, isError: x.isError })),
          ...(t.events.length > 0 ? { events: t.events } : {}),
          ...(t.toolCalls.length > 0 ? { toolCalls: t.toolCalls } : {}),
        }))
        .filter((t) => t.text.length > 0 || t.tools.length > 0 || (t.events?.length ?? 0) > 0);
    const checkpoint = async (force: boolean): Promise<void> => {
      if (!threadId) return;
      const now = Date.now();
      if (!force && now - lastCheckpoint < 1500) return; // throttle mid-stream writes
      const cleanTurns = buildCleanTurns();
      // A mid-stream checkpoint with nothing yet is a no-op — but a FORCED (terminal) write
      // must always land so the pending row's status settles to 'done'/'error'. Otherwise a
      // turn that errors before producing any text stays 'pending' forever (a stuck typing
      // bubble on reload, and no way for a waiter to know the turn finished).
      if (!force && cleanTurns.length === 0 && assistantText.length === 0) return;
      lastCheckpoint = now;
      try {
        await persistMessage(
          ctx.db,
          threadId,
          'assistant',
          assistantText,
          ownerUserId,
          cleanTurns,
          turnStartedAt,
          assistantMsgId,
          streamStatus,
        );
      } catch (e) {
        // Surface a persist failure to the client (the turn is still streaming over the
        // bus here) rather than silently losing the conversation — but only once per turn.
        console.warn('[chat] checkpoint persist failed:', (e as Error).message);
        if (!checkpointWarned) {
          checkpointWarned = true;
          publish({
            type: 'warn',
            message:
              'Saving this conversation is failing — recent messages may not survive a refresh.',
          });
        }
      }
    };

    try {
      const client = provider.client;
      const temperature = aggressivenessToTemperature(getAggressiveness());
      // Deterministic, type-based ingestion: pull any reference material out of the
      // user's message and route it through the SAME engine a dropped file uses, BEFORE
      // the chat turn (sequential — the chat's own writes must not overlap these). The
      // returned note tells the model what was saved so it neither re-creates nor guesses.
      const ingestNote = await ingestReferenceMaterial(
        client,
        message,
        {
          db: ctx.db,
          feed: ctx.feed,
          softDeletable: ctx.softDeletable,
          aggressiveness: getAggressiveness(),
          ...(ctx.createEntity ? { createEntity: ctx.createEntity } : {}),
          ...(ctx.createFileJunction ? { createFileJunction: ctx.createFileJunction } : {}),
          ...(ctx.createJunction ? { createObjectJunction: ctx.createJunction } : {}),
          ...(body.privateMode === true ? { privateMode: true } : {}),
        },
        temperature,
      );
      for await (const ev of runChat({
        client,
        dispatch,
        history,
        // Prefix the active-view + attached-files + auto-ingest notes (if any) so the model
        // knows what's on screen and connects the request to what was just added; the
        // dispatch + tools still see the real message.
        userMessage: activeView.note + attachedNote + ingestNote + message,
        temperature,
        // Give the assistant the operator's name so it addresses them and
        // resolves "me"/"my" without asking for a name it already has.
        operatorName: readIdentity().display_name,
        // Ground the assistant in the real wall-clock (server-owned) + the viewer's
        // timezone, so "today"/"recent"/"most recent" resolve to NOW, not its stale
        // training cutoff. turnStartedAt is the instant this turn began.
        nowIso: turnStartedAt,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(cloudSystemPrompt ? { cloudSystemPrompt } : {}),
        ...(activeContext ? { activeContext } : {}),
        // Capture each executed tool call (capped) for cross-turn replay memory.
        onToolRecord: (rec) => {
          turns[turns.length - 1]?.toolCalls.push(rec);
        },
      })) {
        if (ev.type === 'assistant_message_start') {
          turns.push({ text: '', tools: [], events: [], toolCalls: [] });
        } else if (ev.type === 'text_delta') {
          assistantText += ev.delta;
          const cur = turns[turns.length - 1];
          if (cur) cur.text += ev.delta;
        } else if (ev.type === 'text_final') {
          // The answer round's text re-emitted with deterministic trace links —
          // replace the round's accumulated deltas in both records so the
          // persisted message replays with the links.
          const cur = turns[turns.length - 1];
          if (cur) {
            assistantText =
              assistantText.slice(0, assistantText.length - cur.text.length) + ev.text;
            cur.text = ev.text;
          }
        } else if (ev.type === 'assistant_message_end') {
          // A tool round's streamed narration ("I see — let me try a different approach…")
          // is real content the user should keep — so it stays in BOTH the persisted message
          // and the per-round record. Separate one round's text from the next with a blank
          // line so the persisted message reads as clean paragraphs on reload (matching the
          // live view, where each round is its own bubble). A round with no text adds no
          // separator. assistant_message_end fires after this round's text_delta and before
          // its tool_use, so appending here lands the break between rounds.
          if (ev.hadTools) {
            const cur = turns[turns.length - 1];
            if (cur?.text) assistantText += '\n\n';
          }
        } else if (ev.type === 'tool_use') {
          turns[turns.length - 1]?.tools.push({ id: ev.id, name: ev.name, isError: false });
        } else if (ev.type === 'tool_result') {
          const tool = turns[turns.length - 1]?.tools.find((t) => t.id === ev.toolUseId);
          if (tool) tool.isError = ev.isError;
        }
        // Publish to the per-workspace bus instead of a held-open response. The
        // /api/stream forwarder gates delivery per user and writes the SSE frame to
        // each eligible socket; a disconnected client just has no subscriber, so the
        // turn keeps running and the checkpointed row carries recovery.
        publish(ev);
        await checkpoint(false); // throttled mid-stream persist for refresh recovery
      }
      // A completed turn means Claude is answering — clear any stale usage limit.
      clearClaudeLimit();
      streamStatus = 'done';
    } catch (e) {
      // A genuine usage-limit 429 flips the shared limit state and shows the
      // standard notice (so the Configure side blocks too, via /api/assistant/config).
      // A transient or entitlement 429, or any other failure, stays a plain error.
      streamStatus = 'error';
      const kind = provider.noteError(e);
      if (kind === 'usage') {
        const limit = getClaudeLimitState();
        publish({
          type: 'limit',
          message: limit ? limit.message : CLAUDE_LIMIT_MESSAGE,
          ...(limit ? { resetAt: new Date(limit.resetAt).toISOString() } : {}),
        });
      } else {
        publish({ type: 'error', message: (e as Error).message });
      }
      publish({ type: 'done' });
    } finally {
      unsubscribeFeed();
    }
    // Final checkpoint: persist the complete assistant message (upsert over any
    // mid-stream checkpoints under the same id). The stream is closed now, so a
    // failure here is logged, not surfaced (the mid-stream checkpoints already warn).
    await checkpoint(true);
    if (threadId) {
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
            const title = await generateThreadTitle(provider.client, message, assistantText);
            if (title) {
              await ctx.db.update('chat_threads', threadId, { title });
              // The title is written AFTER the stream closed (kept off the response
              // path for responsiveness), so the client's stream-close thread-list
              // refresh already ran with the placeholder. Signal it on the persistent
              // feed so the conversation list re-fetches and shows the friendly title.
              ctx.feed.publish({
                table: null,
                op: 'thread_title',
                rowId: threadId,
                source: 'gui',
                summary: title,
              });
            }
          }
        } catch (e) {
          console.warn('[chat] thread title generation failed:', (e as Error).message);
        }
      }
    }
  };

  // ── Intent orchestrator (ack-first) — runs OFF the FIFO so the ack is instant ──
  // A fast structured intent pass runs concurrently (NOT serialized behind a prior turn's
  // heavy loop), so even a queued second message is acknowledged within seconds. It then
  // routes: a clarifying question or a trivial/general answer finishes inline (no tool
  // loop); anything that needs the workspace data joins the FIFO to run the real loop.
  void (async () => {
    let acked = false;
    const ackOnce = (text: string): void => {
      if (acked || !text) return;
      acked = true;
      publish({ type: 'ack', message: text });
    };
    // Belt-and-suspenders: if the intent model is slow, publish a templated ack so the user
    // is never left on a blank typing bubble past the guarantee window.
    const watchdog = setTimeout(() => {
      ackOnce('Working on it…');
    }, INTENT_ACK_WATCHDOG_MS);
    let intent: IntentResult | null = null;
    try {
      // A wider window (was 4) so the fast intent pass can SEE a change the user stated a few
      // turns ago ("update the tagline to the second one") when they later say "can you edit it"
      // — otherwise it can't tell what to change and wrongly asks again. Each message is capped
      // at 800 chars and the whole block sliced to 4000, so this stays cheap.
      const recentContext = renderRecentContext(history, 10);
      intent = await runIntent(provider.client, message, {
        operatorName: readIdentity().display_name,
        tableNames: [...ctx.validTables],
        ...(activeView.label ? { activeView: activeView.label } : {}),
        ...(recentContext ? { recentContext } : {}),
        // The intent pass answers "are you connected to X?" inline (no heavy loop), so it
        // needs the connected-sources list or it wrongly says not connected.
        ...(ctx.connectedSources ? { connectedSources: ctx.connectedSources } : {}),
        ...(ctx.connectionsUnknown ? { connectionsUnknown: true } : {}),
      });
    } catch (e) {
      // Best-effort — never drop the user's message; fall through to the real loop.
      console.warn('[chat] intent pass failed:', (e as Error).message);
    } finally {
      clearTimeout(watchdog);
    }

    // A dragged-in file must ALWAYS be processed by the tool loop: the intent pass sees only
    // the message text, so a file attached to a short/vague message ("here", "thanks") would
    // otherwise be silently dropped by an inline short-circuit. When files are attached, skip
    // the inline branches and run the real loop (which works on the attachment).
    const hasAttachments = attachedNote.length > 0;
    // An edit/go-ahead request on the object the user is VIEWING must not be short-circuited into
    // an inline clarify. The heavy loop has the full rehydrated thread history + the open-object
    // grounding, so it resolves "what to change" better than the 4-message intent pass — and can
    // still ask a grounded question if genuinely unsure. So route it to the loop instead of
    // re-asking "what would you like to change?". Kept narrow (viewing an object + short
    // edit/go-ahead phrasing) so general ambiguous questions still get the fast inline clarify.
    const looksLikeEditOfOpen =
      !!activeContext &&
      /\b(edit|change|update|modify|revise|adjust|fix|tweak|rename|redo|make (it|that|this)|do (it|that|this)|go ahead|yes,? (do|go|please))\b/i.test(
        message,
      );
    if (!hasAttachments && intent?.needs_more_info && !looksLikeEditOfOpen) {
      // Ambiguous — the ack_message is a clarifying question; end the turn awaiting a reply.
      await finishWithAnswer(intent.ack_message, 'done');
      return;
    }
    if (!hasAttachments && intent && !intent.needs_work) {
      // Trivial / general — the ack_message IS the complete answer; skip the tool loop.
      // An inline answer bypasses the tool loop's trace-link pass, so run it here
      // against the thread's established links — an answer-from-memory must stay
      // as traceable as one that re-read the records. (Clarifying questions above
      // are left alone: citing sources on a question would be noise.)
      await finishWithAnswer(
        await traceLinkInlineAnswer(ctx.db, threadId, ownerUserId, intent.ack_message),
        'done',
      );
      return;
    }
    // needs_work (or the intent pass failed) → publish the contextual ack (or the generic
    // one if the watchdog already fired) and run the real loop on the FIFO.
    ackOnce(intent?.ack_message ?? 'Working on it…');
    ctx.enqueueChatJob(runHeavyLoop);
  })().catch((e: unknown) => {
    console.error('[chat] intent orchestration failed:', (e as Error).message);
  });
  return true;
}
