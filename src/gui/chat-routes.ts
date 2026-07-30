import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../lattice.js';
import { isCloudChat, resolveChatOwnerId } from './chat-identity.js';
import type { ChatCancelRegistry } from './chat-cancel.js';
import type { ChatProgressBus } from './chat-progress.js';
import type { ChatStreamEvent } from './ai/sse.js';
import { FeedBus } from './feed.js';
import {
  getAggressiveness,
  aggressivenessToTemperature,
  maybeDisconnectExpiredClaude,
} from './assistant-routes.js';
import { humanizeAssistantError } from './ai/error-humanize.js';
import {
  runChat,
  buildSchemaContext,
  type LlmClient,
  type LlmMessage,
  type ContentBlock,
} from './ai/chat.js';
import { resolveLlmProvider } from './ai/provider.js';
import { normalizeUserUrl } from '../sources/url-safety.js';
import { runIntent, type IntentResult } from './ai/intent.js';
import { type MutationCtx } from './mutations.js';
import type { FileJunction } from './data.js';
import { generateHtmlFile } from './ai/html-author.js';
import { generateMarkdown } from './ai/markdown-author.js';
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
 *  recover: `pending` (accepted, not started) → `streaming` → `done` | `error` |
 *  `stopped`. `stopped` is terminal like the other two, but is NOT a failure: the user
 *  asked the turn to stop, and whatever text had streamed by then is kept. */
type ChatMessageStatus = 'pending' | 'streaming' | 'done' | 'error' | 'stopped';

/** If the intent pass hasn't produced an acknowledgement within this window, publish a
 *  templated one so the user is never left waiting on a blank typing bubble. */
const INTENT_ACK_WATCHDOG_MS = 8000;

/** Longest a message can be and still be nothing but a go-ahead. */
const MAX_GO_AHEAD_CHARS = 40;
/** The whole message, allowing only an affirmation, a go-ahead phrase and politeness. */
const GO_AHEAD_SHAPE =
  /^(?:(?:yes|yeah|yep|yup|ok|okay|sure|correct|confirmed|affirmative)\b[\s,.!-]*)?(?:(?:please\s+)?(?:go\s+ahead|do\s+it|do\s+that|proceed|continue|carry\s+on|go\s+for\s+it)\b[\s,.!-]*)?(?:please|thanks|thank\s+you)?[\s,.!-]*$/i;
/** At least one of those tokens is an actual affirmation, not bare politeness. */
const GO_AHEAD_CORE =
  /\b(?:yes|yeah|yep|yup|ok|okay|sure|correct|confirmed|affirmative|go\s+ahead|do\s+it|do\s+that|proceed|continue|carry\s+on|go\s+for\s+it)\b/i;

/**
 * Is this message NOTHING but a go-ahead — "yes", "yep, do it", "ok go ahead"?
 *
 * Two conditions, and both matter. The SHAPE is anchored at both ends and bounded, so
 * it only matches a message carrying no content of its own — its whole job is to say
 * "the meaning of this message is in the previous turn". The CORE requires an actual
 * affirmation, so a plain "thanks" (which the shape allows, as trailing politeness)
 * stays on the cheap inline path and does not drag the tool loop in for nothing.
 *
 * "no" matches neither, which is the direction that has to be right.
 */
export function isBareGoAhead(message: string): boolean {
  const text = message.trim();
  if (text.length === 0 || text.length > MAX_GO_AHEAD_CHARS) return false;
  return GO_AHEAD_CORE.test(text) && GO_AHEAD_SHAPE.test(text);
}

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
  /** Per-process registry of running turns, so `POST /api/chat/messages/:id/stop` can
   *  abort one. The turn is a DETACHED background job, so cancelling the client's fetch
   *  would stop nothing — the abort has to reach the job here. */
  chatCancel: ChatCancelRegistry;
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
 * What the client's `attachedFiles` payload actually resolved to. The three counts are
 * kept SEPARATE on purpose: "nothing was attached" and "files were attached but none of
 * them could be read" are completely different situations, and collapsing them into one
 * empty string is what let a failed attachment quietly turn into an ordinary text turn
 * (which the model then answered by asking what the user wanted).
 */
export interface AttachedFilesResolution {
  /** Ids the client supplied (bounded to 25), whether or not they resolved. */
  suppliedIds: string[];
  /** Ids that resolved to a readable row in the visible files table. */
  resolvedIds: string[];
  /** Supplied ids that did NOT resolve — stale, invisible, or never ingested. */
  missingIds: string[];
  /** The note prefixed to the model's turn; '' when nothing resolved. */
  note: string;
}

/**
 * Ground the ids the composer attached to a chat message against the VISIBLE files
 * table, and build the note that connects the message to those files so the assistant
 * works on exactly them with its existing file tools. Any file type, any count,
 * bounded to 25 ids.
 *
 * Unresolvable ids are reported, never invented and never silently ignored: the caller
 * refuses the turn when NOTHING resolved, and the note names the shortfall when only
 * some did, so the assistant tells the user rather than answering about files it never
 * read. Exported for regression testing.
 */
/**
 * Make a value safe to interpolate into a server-authored context note.
 *
 * A note is a short bracketed sentence the server writes ABOUT the turn ("the user
 * is viewing the dashboard X", "they attached Y"). Several of the values that go
 * into one are model-WRITABLE — a dashboard title the assistant chose, a file name
 * it gave an artifact it created — so anything they can contain, the model can
 * contain. Brackets and newlines are the two characters that used to matter: a `]`
 * closed the note early for whatever parsed it next, and a newline let the rest be
 * read as a fresh line of the user's own words.
 *
 * The structural fix (notes travel as their own content blocks, never concatenated
 * onto the user's message) is what stops a note BECOMING the message. This is the
 * other half: it stops a note CONTAINING a fabricated bracket for whatever reads it
 * next — a log line, a prompt template, a future consumer nobody has written yet.
 * Both, deliberately: either alone leaves the class open.
 */
export function noteValue(value: unknown, fallback = 'untitled'): string {
  const raw = typeof value === 'string' ? value : '';
  const cleaned = raw
    // Control characters, including every newline and tab, become spaces.
    // eslint-disable-next-line no-control-regex -- deliberate: strip C0/C1 controls
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    // The note's own delimiters. Removed rather than escaped: there is no escape
    // convention a downstream reader is guaranteed to honour.
    .replace(/[[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return fallback;
  return cleaned.length > 80 ? `${cleaned.slice(0, 79).trimEnd()}…` : cleaned;
}

export async function resolveAttachedFiles(
  db: Lattice,
  attachedFiles: unknown,
): Promise<AttachedFilesResolution> {
  const suppliedIds = Array.isArray(attachedFiles)
    ? (attachedFiles as unknown[])
        .map((f) =>
          f && typeof (f as { id?: unknown }).id === 'string' ? (f as { id: string }).id : null,
        )
        .filter((x): x is string => !!x)
        .slice(0, 25)
    : [];
  if (!suppliedIds.length) {
    return { suppliedIds, resolvedIds: [], missingIds: [], note: '' };
  }
  const labels: string[] = [];
  const resolvedIds: string[] = [];
  const missingIds: string[] = [];
  // There is no vision path yet, so an attached image resolves to a row the model
  // can name but cannot see into. Track that so the note can say so outright.
  let hasImages = false;
  for (const id of suppliedIds) {
    let row: { id: string; name?: string; original_name?: string; mime?: string } | null = null;
    try {
      row = (await db.get('files', id)) as {
        id: string;
        name?: string;
        original_name?: string;
        mime?: string;
      } | null;
    } catch (e) {
      console.warn('[chat] could not read attached file', id, (e as Error).message);
    }
    if (!row) {
      missingIds.push(id);
      continue;
    }
    // A file's name is MODEL-WRITABLE (an artifact or ingested file it created names
    // itself), and this label goes straight into a bracketed context note — so it is
    // sanitized like any other note value, never interpolated raw.
    const display = noteValue(
      [row.name, row.original_name].find((n) => typeof n === 'string' && n.length > 0),
      'file',
    );
    labels.push(`"${display}" (files id ${noteValue(row.id, 'unknown')})`);
    resolvedIds.push(row.id);
    if (row.mime?.startsWith('image/')) hasImages = true;
  }
  if (!labels.length) return { suppliedIds, resolvedIds, missingIds, note: '' };
  const many = labels.length > 1;
  let note =
    `[The user just attached ${many ? 'these files' : 'this file'} to this message — ` +
    `${many ? 'they have' : 'it has'} been added to their Files: ${labels.join(', ')}. `;
  if (hasImages) {
    // Say it plainly rather than letting the model infer it can see the picture:
    // an attached image reaches it as a name and whatever text was extracted, and
    // a confident description of an image nobody looked at is exactly the kind of
    // invented answer the rest of this release exists to prevent.
    note +=
      'Image files are attached — note that you CANNOT view the visual content of images. ' +
      "You can only work with the file's name, metadata, and any extracted text metadata. ";
  }
  note += `Read ${many ? 'them' : 'it'} with your file tools and use ${many ? 'them' : 'it'} to do what the user asks.]\n\n`;
  if (missingIds.length > 0) {
    // Partial resolution: name the shortfall so the model says so instead of quietly
    // answering as if every attachment had been read.
    note +=
      `[Note: ${String(missingIds.length)} other file${missingIds.length > 1 ? 's' : ''} the user ` +
      `attached could NOT be read from their workspace and ${missingIds.length > 1 ? 'are' : 'is'} ` +
      'not available to you. Tell them plainly which part you could not see; never present a ' +
      'guess as having read it.]\n\n';
  }
  return { suppliedIds, resolvedIds, missingIds, note };
}

/**
 * The attached-files note alone. Thin wrapper over {@link resolveAttachedFiles} kept
 * for callers that only need the prompt text. Empty when nothing resolved — which is
 * exactly why the route uses the full resolution instead of this.
 */
export async function buildAttachedFilesNote(db: Lattice, attachedFiles: unknown): Promise<string> {
  return (await resolveAttachedFiles(db, attachedFiles)).note;
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

/** The note when links in the message were fetched + saved: the page CONTENT is on
 *  hand, so the model must act from it — never ask the user for details the page
 *  already provides. Failures are named so the model says so instead of guessing. */
function linkIngestNote(saved: string[], failed: string[]): string {
  const parts: string[] = [];
  if (saved.length > 0) {
    parts.push(
      `The link${saved.length > 1 ? 's' : ''} in the user's message ` +
        `(${saved.join(', ')}) ${saved.length > 1 ? 'have' : 'has'} already been fetched, ` +
        'saved to their Files, and run through the ingestion engine — the page content is ' +
        'readable with your file tools, and any structured objects it describes were ' +
        'extracted and linked. Do NOT re-fetch, re-save, or re-create it, and do NOT ask ' +
        'the user for details the page already provides — read the saved file and act.',
    );
  }
  if (failed.length > 0) {
    parts.push(
      `${failed.length > 1 ? 'These links' : 'This link'} could not be fetched: ` +
        `${failed.join(', ')} — tell the user plainly and work with what you have; ` +
        'never present guessed page details as fetched.',
    );
  }
  return parts.length > 0 ? `[Note: ${parts.join(' ')}]\n\n` : '';
}

/**
 * Every http(s) URL literally present in the user's message — normalized, deduped,
 * in appearance order. MECHANICAL, never delegated to a model: a shared link is
 * always detected, so it is always fetched (safety-gated). Trailing sentence /
 * bracket punctuation is trimmed; anything `normalizeUserUrl` refuses is skipped.
 */
export function extractUserUrls(message: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s<>"']+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    const raw = m[0].replace(/[),.;!?\]}>'"]+$/, '');
    const normalized = normalizeUserUrl(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(raw);
  }
  return out;
}

/**
 * Everything the USER has typed in this conversation — the current message plus
 * every user turn's top-level TEXT blocks from the (rehydrated) history. Feeds
 * `ingest_url`'s "did the user write this?" gate, so a link shared earlier in
 * the thread stays fetchable. Deliberately excludes `tool_result` blocks (they
 * ride user-role messages in the wire format but carry file/row content — the
 * exact SSRF vector the gate exists to block), assistant turns, and anything
 * nested inside non-text blocks. Exported for regression testing.
 */
export function userAuthoredCorpus(message: string, history: LlmMessage[]): string {
  const texts: string[] = [message];
  for (const h of history) {
    if (h.role !== 'user') continue;
    if (typeof h.content === 'string') {
      texts.push(h.content);
      continue;
    }
    for (const b of h.content) {
      if (b.type === 'text') texts.push(b.text);
    }
  }
  return texts.join('\n');
}

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

  // source:'ingest' (not 'ai') so the saved-and-linked activity surfaces on the
  // persistent feed exactly like a dropped file, not as a chat-turn activity card.
  const mctx: MutationCtx = {
    db: deps.db,
    feed: deps.feed,
    softDeletable: deps.softDeletable,
    source: 'ingest',
    onColumnsAdded: columnDescriptionHook(deps.db),
  };
  const enrichDeps = {
    fileJunctions: [] as FileJunction[],
    entityDescriptions: {} as Record<string, string>,
    ...(deps.aggressiveness !== undefined ? { aggressiveness: deps.aggressiveness } : {}),
    ...(deps.createEntity ? { createEntity: deps.createEntity } : {}),
    ...(deps.createFileJunction ? { createJunction: deps.createFileJunction } : {}),
    ...(deps.createObjectJunction ? { createObjectJunction: deps.createObjectJunction } : {}),
  };

  // ── Links: detected MECHANICALLY from the raw message and ALWAYS fetched ──
  // (assertSafeUrl SSRF guard + fetch budget inside ingestUrlAsFile). Detection
  // is never delegated to the triage model — that is exactly where a shared link
  // used to flake into a "what would you like me to do?" instead of being
  // visited and parsed into an object. Failures are surfaced in the note, never
  // silent, so the model tells the user rather than guessing or asking.
  let urlNote = '';
  const urls = extractUserUrls(message);
  let remainder = message;
  if (urls.length > 0) {
    const { ingestUrlAsFile } = await import('./ingest-url.js');
    const budget = new FetchBudget();
    const saved: string[] = [];
    const failed: string[] = [];
    for (const url of urls) {
      remainder = remainder.split(url).join(' ');
      try {
        await ingestUrlAsFile(
          {
            db: deps.db,
            mctx,
            ...(deps.privateMode ? { privateMode: true } : {}),
            enrich: enrichDeps,
          },
          url,
          { budget },
        );
        saved.push(url);
      } catch (e) {
        console.warn('[chat] link ingest failed:', url, (e as Error).message);
        failed.push(url);
        if (budget.remaining === 0) break; // budget exhausted — stop fetching, keep the note honest
      }
    }
    urlNote = linkIngestNote(saved, failed);
  }

  // ── Text reference material: triaged as before, over the message MINUS the
  // already-ingested links (so a bare link-share triages to nothing). ──
  let textNote = '';
  if (remainder.trim()) {
    let reference = '';
    try {
      reference = (await triageReferenceMaterial(client, remainder, temperature)).reference;
    } catch (e) {
      console.warn('[chat] reference-material triage failed:', (e as Error).message);
      return urlNote;
    }
    const ref = reference.trim();
    if (ref) {
      try {
        const { ingestTextAsFile, looksLikeUrl } = await import('./ingest-routes.js');
        // A triage-returned bare URL (one the extractor's normalizer refused but the
        // ingest normalizer accepts) still crawls; anything else saves as text.
        if (looksLikeUrl(ref)) {
          const { ingestUrlAsFile } = await import('./ingest-url.js');
          await ingestUrlAsFile(
            {
              db: deps.db,
              mctx,
              ...(deps.privateMode ? { privateMode: true } : {}),
              enrich: enrichDeps,
            },
            ref,
          );
        } else {
          await ingestTextAsFile(
            {
              db: deps.db,
              mctx,
              ...enrichDeps,
              ...(deps.privateMode ? { privateMode: true } : {}),
            },
            ref,
            'Pasted note',
          );
        }
        textNote = REFERENCE_INGEST_NOTE;
      } catch (e) {
        console.warn('[chat] reference-material ingest failed:', (e as Error).message);
      }
    }
  }
  return urlNote + textNote;
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
 *
 * Every interpolated value is passed through {@link noteValue} first. The dashboard
 * title in particular is model-writable — the assistant names the pages it creates —
 * so an unsanitized title could close the note's bracket and have the rest read as
 * something else. Exported so that property is directly testable.
 */
export async function describeActiveView(
  db: Lattice,
  active: { table: string; id: string } | undefined,
): Promise<{ note: string; label: string }> {
  if (!active) return { note: '', label: '' };
  if (active.table === 'dashboards') {
    const d = (await db.get('dashboards', active.id).catch(() => null)) as {
      title?: string;
    } | null;
    const title = noteValue(d?.title, '');
    const name = title ? `"${title}"` : 'the one on screen';
    return {
      label: `the dashboard ${name}`,
      note:
        `[The user is currently viewing the dashboard ${name}. If they say "this" / "it" / ` +
        `"this dashboard", or ask why something is broken, empty, blank, or wrong, they mean THIS ` +
        `dashboard — call \`investigate\` to find the concrete fault yourself instead of asking ` +
        `them what is wrong.]\n\n`,
    };
  }
  const label = `the ${noteValue(active.table, 'record')} record "${noteValue(active.id, 'unknown')}"`;
  return {
    label,
    note: `[The user is currently viewing ${label} — "this" / "it" refers to it.]\n\n`,
  };
}

/** Map client-supplied prior turns into the loop's message format. Empty-text turns
 *  are skipped: a files-only send carries its meaning in the structured attachment
 *  payload, not in the message field, so its history entry has no text — and an empty
 *  content block is rejected by the model API. */
function mapHistory(raw: unknown): LlmMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: LlmMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const role = (item as { role?: unknown }).role;
    const text = (item as { text?: unknown }).text;
    if ((role === 'user' || role === 'assistant') && typeof text === 'string' && text.trim()) {
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

/**
 * One assistant turn: its streamed text and the tools it ran.
 *
 * A turn's data changes are NOT recorded here. They are reported while they
 * happen — in the activity feed and the background-task tracker — and the
 * conversation carries only what the user sent and what the assistant answered.
 * Rows persisted before that change may still carry an `events` array; it is
 * simply not read, so those threads replay as text.
 */
interface PersistedTurn {
  text: string;
  tools: { name: string; isError: boolean; errorText?: string }[];
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
  /** Truncated error text (~500 chars) when isError is true, for thread replay. */
  errorText?: string;
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
  files?: string[],
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
    files?: string[];
  } = turns && turns.length > 0 ? { text, turns } : { text };
  if (startedAt) payload.startedAt = startedAt;
  if (status) payload.status = status;
  // Attached-file names ride along so a reloaded message re-renders its attachment
  // chips (the live send shows them; without this they'd vanish on refresh).
  if (files && files.length > 0) payload.files = files.slice(0, 25);
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
        let files: string[] | undefined;
        try {
          const parsed = JSON.parse(asStr(r.content_json, '{}')) as {
            text?: string;
            turns?: PersistedTurn[];
            startedAt?: string;
            status?: ChatMessageStatus;
            files?: string[];
          };
          text = parsed.text ?? '';
          if (typeof parsed.startedAt === 'string') startedAt = parsed.startedAt;
          if (typeof parsed.status === 'string') status = parsed.status;
          if (Array.isArray(parsed.files)) {
            const fs = parsed.files.filter((f): f is string => typeof f === 'string');
            if (fs.length > 0) files = fs;
          }
          if (Array.isArray(parsed.turns)) {
            // Strip toolCalls body — the GUI only needs the text; raw tool result
            // content stays server-side (cross-turn replay only). But harvest error
            // text from toolCalls so the user is told why a tool failed.
            turns = parsed.turns.map((t) => {
              const toolsWithErrors: { name: string; isError: boolean; errorText?: string }[] = [];
              if (Array.isArray(t.tools)) {
                for (let i = 0; i < t.tools.length; i++) {
                  const tool = t.tools[i];
                  if (!tool) continue; // skip undefined entries
                  const tc = Array.isArray(t.toolCalls) ? t.toolCalls[i] : undefined;
                  if (tc?.errorText) {
                    // Add errorText from toolCalls to the tool record for GUI display
                    toolsWithErrors.push({
                      name: tool.name,
                      isError: tool.isError,
                      errorText: tc.errorText,
                    });
                  } else {
                    toolsWithErrors.push(tool);
                  }
                }
              }
              // Any per-turn data-change events an older row carries are dropped
              // here rather than handed back: nothing renders them.
              return {
                text: t.text,
                tools: toolsWithErrors,
              };
            });
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
          ...(files ? { files } : {}),
          created_at: asStr(r.created_at),
        };
      })
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    sendJson(res, { messages });
    return true;
  }

  // POST /api/chat/messages/:id/stop — stop a turn that is running in the background.
  // The turn is a detached job streaming over the realtime socket, NOT a held-open
  // response, so aborting the client's fetch would stop nothing; the abort has to be
  // delivered here, to the controller the job is watching.
  const stopMatch = /^\/api\/chat\/messages\/([^/]+)\/stop$/.exec(ctx.pathname);
  // @gui-only session-state: aborts a turn that this server process is streaming right now.
  // A direct caller owns the abort handle for the turn it started, so there is nothing for
  // it to look up; the route exists only because the client runs in a different process.
  if (ctx.method === 'POST' && stopMatch) {
    const stopId = decodeURIComponent(stopMatch[1] ?? '');
    const entry = ctx.chatCancel.get(stopId);
    if (!entry) {
      // Nothing is running under that id — most often the reply simply finished in the
      // gap between the click and this request. That is a benign no-op, not an error.
      sendJson(res, { stopped: false, reason: 'not_running' });
      return true;
    }
    // One member of a shared workspace must never be able to stop another's turn. The
    // app connects BYPASSRLS, so this check is the boundary (fail closed on a cloud
    // whose identity did not resolve).
    const ownsTurn = cloud ? ownerUserId != null && entry.ownerUserId === ownerUserId : true;
    if (!ownsTurn) {
      sendJson(res, { error: 'That reply belongs to someone else.' }, 403);
      return true;
    }
    ctx.chatCancel.abort(stopId);
    // Release every client bound to this turn right away. The background job settles
    // the persisted row (status `stopped`, partial text kept) when it observes the
    // abort; a second `done` from the job is a no-op for an already-released client.
    ctx.chatProgress.publish({
      threadId: entry.threadId,
      messageId: stopId,
      ownerUserId: entry.ownerUserId,
      event: { type: 'done' },
    });
    sendJson(res, { stopped: true, messageId: stopId }, 202);
    return true;
  }

  // @headless-debt a full assistant turn — tool loop, persistence, streaming — is only
  // reachable through this route. The single largest gap in the headless surface.
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
  // (drop a file into the assistant with no text) still gets a response, carried by the
  // structured attachment payload rather than by the message field.
  if (!rawMessage && !hasAttachments) {
    sendJson(res, { error: 'message is required' }, 400);
    return true;
  }
  const attachedNames =
    hasAttachments && Array.isArray(body.attachedFiles)
      ? (body.attachedFiles as unknown[])
          .map((f) => {
            const name = (f as { name?: unknown } | null)?.name;
            return typeof name === 'string' ? name : '';
          })
          .filter(Boolean)
      : [];
  const attachedLabel = attachedNames.join(', ');
  // The user's OWN words, and nothing else. A files-only send leaves this empty on
  // purpose: putting the file NAME here made it the user's apparent message, so the
  // intent pass judged a bare filename ambiguous and asked what to do with it — while
  // the file itself was sitting right there, readable. The attachment travels as
  // structured data (`attachedFiles`), and the note built from it is what directs the
  // model. `attachedLabel` is now only ever used as a thread-title placeholder.
  const message = rawMessage;
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

  // Connect the request to the files the user just attached (ingested via the
  // composer Send) so the assistant works on them with its existing file tools.
  // The FULL resolution is kept, not just the note: "no attachment" and "an
  // attachment that could not be read" must never collapse into the same state.
  // Resolved BEFORE anything is persisted, so a refused turn leaves no orphan row.
  const attached = await resolveAttachedFiles(ctx.db, body.attachedFiles);
  const attachedNote = attached.note;
  // Every attachment failed to resolve. Refuse the turn loudly instead of running it
  // as if the user had sent bare text — that degradation is what produced an answer
  // about a filename rather than about the file.
  if (attached.suppliedIds.length > 0 && attached.resolvedIds.length === 0) {
    sendJson(
      res,
      {
        error:
          'The files attached to that message could not be read from your workspace, so it was not sent. Attach them again and retry.',
      },
      409,
    );
    return true;
  }
  // A files-only send has no instruction to follow, so say what to do with it here
  // rather than leaving the model to guess from an empty turn.
  const filesOnlyDirective =
    !rawMessage && attached.resolvedIds.length > 0
      ? '[The user attached the file(s) above without typing a message. Read them and reply ' +
        'with a short, concrete summary of what they contain and what you can do with them ' +
        'next. Do not ask what to do with a file you can simply open and read.]\n\n'
      : '';

  // Resolve the thread + persist the user message BEFORE streaming so the
  // thread id can ride back on a header. One thread per conversation; the client
  // reuses it across turns. Every chat row is STAMPED with this user's id so it
  // is private to them (app-layer filter + RLS both key on it).
  // A thread still needs a human-readable placeholder title, so a files-only send
  // titles itself from the attachment names (the AI title replaces it later).
  const threadPlaceholder = rawMessage || attachedLabel || 'Attached files';
  let threadId = '';
  try {
    threadId = await ensureThread(ctx.db, requestedThread, threadPlaceholder, ownerUserId);
    await persistMessage(
      ctx.db,
      threadId,
      'user',
      message,
      ownerUserId,
      undefined,
      undefined,
      undefined,
      undefined,
      attachedNames.length > 0 ? attachedNames : undefined,
    );
  } catch (e) {
    console.warn('[chat] persist user message failed:', (e as Error).message);
  }
  // Chat-awareness of in-progress ingestion (client signal): a file/data import is
  // still running as the user asks, so tell the model — it must not answer about data
  // that may still be loading as if it were already complete.
  const ingestInProgressNote =
    body.ingestInProgress === true
      ? '[Note: the user is CURRENTLY importing files or data into their workspace — some ' +
        'tables or rows may not be fully available yet. If they ask about data that seems ' +
        'missing or incomplete, say it may still be importing and to try again in a moment.]\n\n'
      : '';
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
  // Register the turn as stoppable BEFORE the ack goes out, so a stop that arrives the
  // instant the client learns the message id always finds a live controller.
  const cancelEntry = ctx.chatCancel.register(assistantMsgId, threadId, ownerUserId);
  const abortSignal = cancelEntry.controller.signal;
  /** Has a stop landed? Read through a call so every check sees the CURRENT value —
   *  the flag flips asynchronously, long after any earlier check in the same scope. */
  const stopRequested = (): boolean => cancelEntry.controller.signal.aborted;
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
    // Stopped before the inline answer was published — settle as stopped, keeping
    // whatever the turn had, rather than painting a reply the user cancelled.
    const stopped = stopRequested();
    const settled: ChatMessageStatus = stopped ? 'stopped' : status;
    const body = stopped ? '' : text;
    streamStatus = settled;
    publish({ type: 'assistant_message_start', id: assistantMsgId });
    if (body) publish({ type: 'text_delta', delta: body });
    publish({ type: 'assistant_message_end' });
    try {
      await persistMessage(
        ctx.db,
        threadId,
        'assistant',
        body,
        ownerUserId,
        [],
        turnStartedAt,
        assistantMsgId,
        settled,
      );
    } catch (e) {
      console.warn('[chat] persist intent answer failed:', (e as Error).message);
    }
    publish({ type: 'done' });
    ctx.chatCancel.release(assistantMsgId);
  };

  // The heavy agentic tool loop — runs on the per-workspace FIFO (serialized) only when the
  // intent pass says the request needs data work. Defined here (not enqueued yet) so the
  // intent orchestrator below can decide whether to run it.
  const runHeavyLoop = async (): Promise<void> => {
    // Stopped while this turn was still waiting its place in the workspace FIFO. Settle
    // the row now so it never reads as still running, and end the stream — starting the
    // loop just to abort it on the first round would burn a schema build for nothing.
    if (stopRequested()) {
      streamStatus = 'stopped';
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
          'stopped',
        );
      } catch (e) {
        console.warn('[chat] settling a stopped queued turn failed:', (e as Error).message);
      }
      publish({ type: 'done' });
      ctx.chatCancel.release(assistantMsgId);
      return;
    }
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
      // ingest_url's "did the user write this?" gate covers the WHOLE
      // conversation, not just this turn: a link shared two messages ago is
      // still the user's link — gating on the current message alone made the
      // assistant refuse it and claim it "cannot scrape" a URL the user
      // explicitly shared. Only user-AUTHORED text contributes (top-level text
      // blocks of user turns; never tool_result blocks, model text, or file/row
      // content), so the SSRF property is unchanged: the model still cannot
      // fetch a URL it lifted out of anything but the user's own words.
      userMessage: userAuthoredCorpus(message, history),
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
    // Markdown authoring for large artifacts (spec path in create_artifact).
    // Uses the same author model as HTML dashboards for consistency.
    const authorMarkdown = async (spec: string): Promise<string> => {
      const schema = await buildSchemaContext(dispatch);
      return generateMarkdown({
        client: provider.client,
        schema,
        spec,
        model: authorModel,
      });
    };
    dispatch.markdownAuthor = authorMarkdown;
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
    // with its text and the tools it ran. The data changes a turn makes are
    // reported live in the activity feed as they are published, so the turn record
    // no longer carries a copy of them.
    const turns: {
      text: string;
      tools: { id: string; name: string; isError: boolean }[];
      toolCalls: PersistedToolCall[];
    }[] = [];
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
        .map((t) => {
          // Harvest error text from toolCalls to include in the tools array for GUI display
          const toolsWithErrors = t.tools.map((tool, i) => {
            const toolCall = t.toolCalls[i];
            return {
              name: tool.name,
              isError: tool.isError,
              ...(toolCall?.errorText ? { errorText: toolCall.errorText } : {}),
            };
          });
          return {
            text: t.text,
            tools: toolsWithErrors,
            ...(t.toolCalls.length > 0 ? { toolCalls: t.toolCalls } : {}),
          };
        })
        .filter((t) => t.text.length > 0 || t.tools.length > 0);
    // The turn's deterministic outcome notice, held until the turn settles.
    let outcomeNotice = '';
    /**
     * Keep the outcome notice ON the saved reply. A stopped reply is released the
     * instant the stop is acked — the browser marks it stopped and unbinds it — so
     * a frame published afterwards lands on a bubble nobody is listening to. That
     * is precisely the turn whose truth matters most: the user stopped part-way
     * through destructive work, usually BECAUSE something looked wrong, and the
     * model never gets an answer round to tell them what already changed. The saved
     * message is the one channel that survives, so the notice becomes part of it.
     * Idempotent — appended once, however the turn settles.
     */
    const keepOutcomeNotice = (): void => {
      if (!outcomeNotice) return;
      assistantText += (assistantText.trim() ? '\n\n' : '') + outcomeNotice;
      const cur = turns[turns.length - 1];
      if (cur) cur.text += (cur.text.trim() ? '\n\n' : '') + outcomeNotice;
      else turns.push({ text: outcomeNotice, tools: [], toolCalls: [] });
      outcomeNotice = '';
    };
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
        // The user's OWN words — nothing else. The active-view / attached-files /
        // auto-ingest notes travel as SEPARATE content blocks ahead of it (see
        // RunChatOptions.contextNotes), so no value interpolated into a note can end
        // up inside what is later read as the user's message.
        userMessage: message,
        contextNotes: [
          activeView.note,
          attachedNote,
          ingestNote,
          ingestInProgressNote,
          filesOnlyDirective,
        ],
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
        // What the tools actually did, in the user's terms. Streamed too; held here
        // so a stopped turn can still carry it on the saved reply.
        onOutcomeNotice: (notice) => {
          outcomeNotice = notice;
        },
        // Stop: checked at each round boundary and handed to the model stream, so the
        // turn stops for real instead of running on invisibly after the user gave up.
        signal: abortSignal,
      })) {
        if (ev.type === 'assistant_message_start') {
          turns.push({ text: '', tools: [], toolCalls: [] });
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
          const cur = turns[turns.length - 1];
          if (ev.dropText && cur) {
            // This round's preamble exactly repeated the previous kept one — roll
            // its text off the persisted message (its deltas are the tail of
            // assistantText, same as text_final) and blank the per-round record so
            // it is neither saved nor replayed.
            assistantText = assistantText.slice(0, assistantText.length - cur.text.length);
            cur.text = '';
          } else if (ev.hadTools) {
            // A tool round's streamed narration ("I see — let me try a different approach…")
            // is real content the user should keep — so it stays in BOTH the persisted message
            // and the per-round record. Separate one round's text from the next with a blank
            // line so the persisted message reads as clean paragraphs on reload (matching the
            // live view, where each round is its own bubble). A round with no text adds no
            // separator. assistant_message_end fires after this round's text_delta and before
            // its tool_use, so appending here lands the break between rounds.
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
      // A STOPPED turn proves nothing about the model, so leave the limit state alone.
      if (stopRequested()) {
        streamStatus = 'stopped';
        keepOutcomeNotice();
      } else {
        clearClaudeLimit();
        streamStatus = 'done';
      }
    } catch (e) {
      // The user stopped the turn: aborting the model request rejects the in-flight
      // call, which is not a failure and must not be shown as one. Settle as stopped
      // (the checkpoint below keeps whatever text had already streamed) and end.
      if (stopRequested()) {
        streamStatus = 'stopped';
        keepOutcomeNotice();
        publish({ type: 'done' });
        await checkpoint(true);
        ctx.chatCancel.release(assistantMsgId);
        return;
      }
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
        // Never surface a raw provider error (often a JSON body) to the user. If the
        // Claude subscription's OAuth token is expired/revoked (a real 401/403), also
        // DISCONNECT it — the client's turn-end config re-check then re-onboards the
        // user to reconnect, instead of hitting the same dead-token failure every turn.
        const disconnected = await maybeDisconnectExpiredClaude(ctx.db, provider.kind, e);
        const message = disconnected
          ? 'Your Claude connection expired. Reconnect Claude in Settings → Assistant to keep chatting.'
          : humanizeAssistantError(e, provider.kind);
        publish({ type: 'error', message });
      }
      publish({ type: 'done' });
    }
    // Final checkpoint: persist the complete assistant message (upsert over any
    // mid-stream checkpoints under the same id). The stream is closed now, so a
    // failure here is logged, not surfaced (the mid-stream checkpoints already warn).
    await checkpoint(true);
    ctx.chatCancel.release(assistantMsgId);
    if (threadId) {
      // Give a newly-created thread an AI-generated short title in place of the
      // truncated-first-message placeholder set by ensureThread. Best-effort and
      // idempotent: only when THIS request created the thread, we have a reply,
      // and the title is still the exact placeholder — so a user rename is never
      // clobbered. The stream has already ended; the new title surfaces on the
      // next thread-list refresh. Skipped for a stopped turn: the user asked us to
      // stop spending model calls on it.
      const createdNew = threadId !== requestedThread;
      if (createdNew && assistantText.trim() && streamStatus !== 'stopped') {
        try {
          const placeholder = threadPlaceholder.slice(0, 60) || 'Chat';
          const cur = (await ctx.db.get('chat_threads', threadId)) as { title?: string } | null;
          if (cur && (cur.title ?? '') === placeholder) {
            const title = await generateThreadTitle(
              provider.client,
              threadPlaceholder,
              assistantText,
            );
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
    // Files attached, nothing typed. There is no message for the intent pass to classify
    // — running it on the file NAME is precisely what made the assistant ask "what would
    // you like me to do with report.xlsx?" instead of opening it. Acknowledge from the
    // attachment itself and go straight to the loop, which can actually read the file.
    if (!rawMessage && attached.resolvedIds.length > 0) {
      ackOnce(
        attachedNames.length === 1 && attachedNames[0]
          ? `Reading ${attachedNames[0]}…`
          : attachedNames.length > 1
            ? `Reading your ${String(attachedNames.length)} files…`
            : 'Reading your files…',
      );
      ctx.enqueueChatJob(runHeavyLoop);
      return;
    }
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
    // Keyed on the ids the client SUPPLIED, not on whether a note was rendered: keying it on
    // the note meant an attachment that failed to resolve silently un-gated the clarifying
    // question, and the user got "what do you want me to do with that?" for a file they had
    // just attached. (A turn where nothing resolved is refused outright, above.)
    const turnHasAttachments = attached.suppliedIds.length > 0;
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
    // A bare go-ahead is an ANSWER to something the assistant just proposed or asked,
    // and it must reach the tool loop. The intent pass sees only the text, and "Yes,
    // go ahead" reads as trivial small-talk with no work in it — so it is classified
    // `!needs_work`, answered inline, and the work the user just approved never runs.
    // The user watches themselves say yes and nothing happen.
    //
    // `looksLikeEditOfOpen` above catches this only while a record is open on screen,
    // which is the narrower case. This one is keyed on the message being nothing BUT
    // an affirmation: the loop has the whole rehydrated thread and can see what was
    // being proposed, so it is the only thing that can act on one.
    const looksLikeGoAhead = history.length > 0 && isBareGoAhead(message);
    if (
      !turnHasAttachments &&
      !looksLikeGoAhead &&
      intent?.needs_more_info &&
      !looksLikeEditOfOpen
    ) {
      // Ambiguous — the ack_message is a clarifying question; end the turn awaiting a reply.
      await finishWithAnswer(intent.ack_message, 'done');
      return;
    }
    if (!turnHasAttachments && !looksLikeGoAhead && intent && !intent.needs_work) {
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
    // No job will run and no path will settle the turn, so drop its stop registration
    // rather than leaving a dead controller behind for the rest of the process.
    ctx.chatCancel.release(assistantMsgId);
  });
  return true;
}
