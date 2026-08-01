import type { Lattice } from '../lattice.js';
import type { FeedBus } from '../gui/feed.js';
import type { ChatStreamEvent } from '../gui/ai/sse.js';
import {
  runChat,
  buildSchemaContext,
  type LlmMessage,
  type RunChatOptions,
} from '../gui/ai/chat.js';
import { ASSISTANT_HIDDEN_TABLES, type DispatchCtx } from '../gui/ai/dispatch.js';
import { resolveLlmProvider, type ResolvedProvider } from '../gui/ai/provider.js';
import { generateHtmlFile } from '../gui/ai/html-author.js';
import { generateMarkdown } from '../gui/ai/markdown-author.js';
import { qaDashboard } from '../gui/ai/dashboard-qa.js';
import { columnDescriptionHook } from '../gui/meta-gen.js';
import { getCloudSetting, CLOUD_SETTING_SYSTEM_PROMPT } from '../cloud/settings.js';
import { readIdentity } from '../framework/user-config.js';
import { getAggressiveness, aggressivenessToTemperature } from './ai-config.js';
import { FetchBudget } from '../ai/fetch-policy.js';
import { ingestReferenceMaterial, userAuthoredCorpus } from './reference-ingest.js';

/**
 * One assistant turn, run to completion — a capability, not a route.
 *
 * The assistant is the deepest place the "the browser is one client" promise can
 * be lost, because everything about a turn LOOKS like it belongs to a request:
 * text arrives as a body, answers leave as a stream, and the conversation is
 * stored so a page reload can replay it. None of that is the turn. The turn is:
 * decide which tables the model may touch, wire up the primitives it may call,
 * save whatever reference material the message carried, ask the model, run the
 * tools it asks for, and stop with an answer. That works identically for a
 * terminal, a script, a scheduled job, and a browser — and until this module
 * existed, only the browser could reach it.
 *
 * WHAT STAYED IN THE ROUTE, deliberately. The chat route still owns everything
 * that is about serving a client rather than running a turn: parsing the request,
 * the immediate acknowledgement, publishing each event to the socket the browser
 * is listening on, the per-workspace queue, the stop registry, and persisting the
 * conversation so a reload can replay it. A direct caller needs none of those — it
 * already has the answer as a value, and it owns the abort handle for the turn it
 * started.
 *
 * WHAT THIS OWNS. The dispatch context (which is where the model's permissions
 * actually live), the delegated authors the document tools call, the auto-ingest
 * pre-pass, the provider resolution, and the tool loop itself. The loop is
 * {@link runChat}, unchanged and un-duplicated — this module builds what it needs
 * and drives it.
 *
 * SAFETY IS NOT RELAXED HERE, and none of it is re-implemented per caller. Every
 * write goes through the same audited mutation chokepoint, carrying one
 * operation-group id per tool execution, so a change the assistant makes is
 * reversible as a single action from the version history whoever asked for it.
 * The pre-flight gate that refuses a permanent, wide removal lives inside the
 * dispatcher, so it applies to this path exactly as it applies to a request —
 * there is no flag here that turns it off, and there must never be one.
 */

// ── Failures ────────────────────────────────────────────────────────────────

/**
 * Every failure running a turn distinguishes, as stable codes. A capability
 * cannot answer with a status — the same call serves a request, a command, and a
 * library caller, and only one of those has a response to write — so it throws an
 * ordinary Error carrying a code and lets the adapter decide what that means.
 *
 *   no_model_connected  no model provider is configured on this machine
 *   empty_request       the turn was given nothing to act on
 */
const ASSISTANT_TURN_ERROR_CODES = ['no_model_connected', 'empty_request'] as const;

export type AssistantTurnErrorCode = (typeof ASSISTANT_TURN_ERROR_CODES)[number];

/** An Error carrying one of the codes above. */
export type AssistantTurnError = Error & { code: AssistantTurnErrorCode };

const KNOWN: ReadonlySet<string> = new Set<string>(ASSISTANT_TURN_ERROR_CODES);

/** Build a tagged turn failure. Throw it; never return it. */
export function assistantTurnError(
  code: AssistantTurnErrorCode,
  message: string,
): AssistantTurnError {
  return Object.assign(new Error(message), { code });
}

/**
 * The turn code on a thrown value, or undefined when it carries none of ours.
 * A provider error carries a `code` too, and reading any string as one of ours
 * would classify a real fault as an expected answer.
 */
export function assistantTurnErrorCode(e: unknown): AssistantTurnErrorCode | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !KNOWN.has(code)) return undefined;
  return code as AssistantTurnErrorCode;
}

/**
 * What to tell somebody who has no model connected — as the command that fixes
 * it, one per backend.
 *
 * This is the first thing a fresh machine says, and for a while it said "open the
 * app" — which, on the headless box where somebody is most likely to read it, is
 * not an instruction at all. Every backend now has a command-line door, so the
 * message names the door rather than the settings screen. A person on a machine
 * with a browser can still use it; the app and these commands write the same
 * machine-local choice, and every surface reads it.
 */
export const NO_MODEL_CONNECTED_MESSAGE =
  'No model provider is connected. Connect one of:\n' +
  '  lattice model subscription                              a Claude subscription\n' +
  '  lattice model connect --base-url <url> --model <id>     an OpenAI-compatible endpoint\n' +
  '  lattice model account                                   a Lattice Cloud account\n' +
  'The choice is stored on this machine, and every surface reads the same one. ' +
  '`lattice model status` says what is connected now.';

// ── What a turn runs against ────────────────────────────────────────────────

/**
 * The workspace a turn runs against, and the primitives the assistant may call
 * within it.
 *
 * Every optional member is a CAPABILITY THE MODEL LOSES when it is absent: omit
 * `createEntity` and the assistant reports that it cannot create a table, rather
 * than failing halfway through one. That is deliberate — a caller wiring up a
 * narrower turn does so explicitly, and the model is told, never left to discover
 * it mid-answer.
 */
export interface AssistantTurnWorkspace {
  db: Lattice;
  feed: FeedBus;
  /** Tables the assistant may query or write. Internal + hidden tables are removed here. */
  validTables: Set<string>;
  /** Junction tables eligible for link / unlink. */
  junctionTables: Set<string>;
  /** Tables carrying a `deleted_at` column. */
  softDeletable: Set<string>;
  /** Registered computed tables — tagged read-only so the model never writes to one. */
  computedTables?: Set<string>;
  computedOps?: DispatchCtx['computedOps'];
  createEntity?: DispatchCtx['createEntity'];
  addColumn?: DispatchCtx['addColumn'];
  createJunction?: DispatchCtx['createJunction'];
  createFileJunction?: DispatchCtx['createFileJunction'];
  deleteEntity?: DispatchCtx['deleteEntity'];
  importAttachment?: DispatchCtx['importAttachment'];
  /** Pre-formatted "Connected data sources" section for the schema context. */
  connectedSources?: string;
  /** Active config path + rendered-context dir, for the dedup tool's link re-pointing. */
  configPath?: string;
  outputDir?: string;
  /**
   * The session writes are attributed to. Audit entries carry it, and an
   * operation group may only be reversed by the session that authored it — so a
   * caller that wants to undo what this turn did must pass one and keep it.
   */
  sessionId?: string;
  /** Force rows the assistant creates this turn private, whatever the table default. */
  privateMode?: boolean;
  /**
   * The already-resolved model provider. Absent ⇒ resolved from the machine's
   * stored configuration, and a turn with nothing connected throws
   * `no_model_connected` rather than answering emptily.
   */
  provider?: ResolvedProvider;
}

/** One turn's request: the user's words, and what the caller knows about the turn. */
export interface AssistantTurnInput {
  /** The user's OWN words, and nothing else. Server-authored context goes in the notes. */
  message: string;
  /** Prior conversation turns, excluding this message. */
  history?: LlmMessage[];
  /**
   * Server-authored notes placed AHEAD of the auto-ingest note — what the caller
   * knows about the request itself (what is on screen, what was attached).
   */
  contextNotes?: string[];
  /**
   * Server-authored notes placed AFTER it — what the caller knows about the
   * session the request arrived in. Split from {@link contextNotes} only so the
   * note describing what the pre-pass just saved keeps its position among them.
   */
  trailingContextNotes?: string[];
  /** The record the caller is looking at, so "this" resolves to it. */
  activeContext?: { table: string; id: string };
  /** The id of the dashboard on screen, so an edit targets it by default. */
  activeDashboardId?: string;
  /** Stops the turn at the next round boundary, and cuts the model stream. */
  signal?: AbortSignal;
  /** Sink for each executed tool call, for cross-turn replay memory. */
  onToolRecord?: RunChatOptions['onToolRecord'];
  /** The turn's deterministic outcome notice, handed over as well as streamed. */
  onOutcomeNotice?: (notice: string) => void;
  /** The instant this turn began (ISO-8601). Absent ⇒ now. */
  nowIso?: string;
  /** The caller's IANA timezone. Absent ⇒ this machine's. */
  timezone?: string;
  /** The operator's display name. Absent ⇒ the machine-local identity. */
  operatorName?: string;
}

/** One tool the turn executed. */
export interface AssistantTurnToolCall {
  name: string;
  /** False when the tool reported an error back to the model. */
  ok: boolean;
}

/** Everything one completed turn produced, as a value. */
export interface AssistantTurnResult {
  /** False when the turn failed — the caller must not read `text` as an answer. */
  ok: boolean;
  /** The assistant's final answer. Empty when the turn failed or was stopped early. */
  text: string;
  /** Every tool the turn ran, in order. */
  tools: AssistantTurnToolCall[];
  /** True when the turn ended because the caller aborted it. */
  stopped: boolean;
  /**
   * Warnings the turn raised about ITSELF — today, that it ran out of tool
   * rounds with work still outstanding, so the answer describes an unfinished
   * job.
   *
   * These are not decoration. A turn that hits the step cap is cut off mid-task
   * and says nothing else about it: no error is raised, the answer reads as
   * complete, and a caller with nowhere to put this would report success for a
   * half-done job. A browser shows each one; so must everybody else.
   *
   * The deterministic outcome notice is NOT repeated here — it has its own field
   * and its own callback, and a caller that printed both would say the same
   * sentence twice.
   */
  warnings: string[];
  /** What the tools actually did, in the user's terms, when the turn produced one. */
  outcomeNotice?: string;
  /** The question the model asked instead of answering, when it asked one. */
  question?: { question: string; options: string[]; allowOther: boolean };
  /** Rows the turn asked a viewer to open. */
  opened: { table: string; id: string }[];
  /** Why the turn failed. Present exactly when `ok` is false. */
  error?: string;
}

// ── Building the turn ───────────────────────────────────────────────────────

/**
 * The model provider this turn runs on.
 *
 * @throws `no_model_connected` when nothing is configured. Never returns a
 * stand-in: a turn with no model must fail loudly, not answer emptily.
 */
async function requireProvider(ws: AssistantTurnWorkspace): Promise<ResolvedProvider> {
  if (ws.provider) return ws.provider;
  const provider = await resolveLlmProvider(ws.db);
  if (!provider) throw assistantTurnError('no_model_connected', NO_MODEL_CONNECTED_MESSAGE);
  return provider;
}

/**
 * Build the dispatch context one turn runs with: which tables the model may
 * reach, which primitives it may call, and the delegated authors the document
 * tools use.
 *
 * This is where the assistant's permissions actually live, so it is one function
 * rather than something each caller assembles: credential-bearing and internal
 * tables are stripped HERE, and a caller cannot forget to.
 */
export function buildTurnDispatch(
  ws: AssistantTurnWorkspace,
  input: AssistantTurnInput,
  provider: ResolvedProvider,
): DispatchCtx {
  const history = input.history ?? [];
  // Strip credential-bearing native tables (secrets) and the assistant's own
  // conversation storage so it can neither read them nor be told they exist.
  const dispatch: DispatchCtx = {
    db: ws.db,
    feed: ws.feed,
    ...(ws.privateMode === true ? { privateMode: true } : {}),
    // Live-aware table set: the caller's snapshot PLUS anything registered since
    // (a connector connected this session), minus internal + hidden.
    validTables: new Set(
      [...ws.validTables, ...ws.db.getRegisteredTableNames()].filter(
        (t) =>
          !ASSISTANT_HIDDEN_TABLES.has(t) &&
          !t.startsWith('__lattice') &&
          !t.startsWith('_lattice'),
      ),
    ),
    junctionTables: new Set([...ws.junctionTables].filter((t) => !ASSISTANT_HIDDEN_TABLES.has(t))),
    ...(ws.connectedSources ? { connectedSources: ws.connectedSources } : {}),
    softDeletable: ws.softDeletable,
    onColumnsAdded: columnDescriptionHook(ws.db),
    aggressiveness: getAggressiveness(),
    // The "did the user write this?" gate on URL fetching covers the WHOLE
    // conversation, not just this message: a link shared two turns ago is still
    // the user's link. Only user-AUTHORED text contributes, so the model still
    // cannot fetch a URL it lifted out of a file or a row.
    userMessage: userAuthoredCorpus(input.message, history),
    // One shared fetch budget for the whole turn.
    urlFetchBudget: new FetchBudget(),
    ...(ws.configPath !== undefined ? { configPath: ws.configPath } : {}),
    ...(ws.outputDir !== undefined ? { outputDir: ws.outputDir } : {}),
    ...(ws.sessionId !== undefined ? { sessionId: ws.sessionId } : {}),
    ...(ws.createEntity ? { createEntity: ws.createEntity } : {}),
    ...(ws.addColumn ? { addColumn: ws.addColumn } : {}),
    ...(ws.createJunction ? { createJunction: ws.createJunction } : {}),
    ...(ws.createFileJunction ? { createFileJunction: ws.createFileJunction } : {}),
    ...(ws.deleteEntity ? { deleteEntity: ws.deleteEntity } : {}),
    ...(ws.importAttachment ? { importAttachment: ws.importAttachment } : {}),
    // Copied like validTables so in-turn additions stay visible to later tool
    // calls without mutating the caller's set.
    ...(ws.computedTables ? { computedTables: new Set(ws.computedTables) } : {}),
    ...(ws.computedOps ? { computedOps: ws.computedOps } : {}),
  };

  // Delegated authoring: the document tools call these to write a full standalone
  // page. Each builds its own client from the SAME resolved auth and the live
  // schema, so a provider failure surfaces as a recoverable tool error rather
  // than a crash. The model is the strongest the auth can actually run.
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
  const authorMarkdown = async (spec: string): Promise<string> => {
    const schema = await buildSchemaContext(dispatch);
    return generateMarkdown({ client: provider.client, schema, spec, model: authorModel });
  };
  dispatch.markdownAuthor = authorMarkdown;
  // Automatic QA for an authored dashboard: run its data queries, check them
  // against the request, repair, and report what is left. On by default.
  if (process.env.LATTICE_DASHBOARD_QA !== 'false') {
    dispatch.qaDashboard = (html: string, intent: string) =>
      qaDashboard(
        { db: ws.db, client: provider.client, model: authorModel, reAuthor: authorHtml },
        html,
        intent,
      );
  }
  if (input.activeDashboardId !== undefined) {
    // No existence probe needed: the edit handler verifies the row itself.
    dispatch.activeDashboardId = input.activeDashboardId;
  }
  return dispatch;
}

/**
 * Run one assistant turn, streaming its events as they happen.
 *
 * The generator IS the turn: it yields the same event sequence a browser
 * receives, so a caller that wants to show progress can, and a caller that just
 * wants the answer drains it ({@link runAssistantTurn}). Nothing about the
 * transport is decided here.
 *
 * @throws `no_model_connected` before doing any work when no provider is set up,
 * and `empty_request` when the turn was given nothing to act on. Anything the
 * model or a tool throws propagates: a turn that failed must never look like one
 * that answered.
 */
export async function* streamAssistantTurn(
  ws: AssistantTurnWorkspace,
  input: AssistantTurnInput,
): AsyncGenerator<ChatStreamEvent> {
  const message = input.message.trim();
  const contextNotes = input.contextNotes ?? [];
  const trailing = input.trailingContextNotes ?? [];
  // A turn needs SOMETHING to act on. A caller with no message but a note
  // describing an attachment is a real turn; a caller with neither is a mistake,
  // and answering it would mean answering nothing.
  if (!message && contextNotes.every((n) => !n.trim()) && trailing.every((n) => !n.trim())) {
    throw assistantTurnError('empty_request', 'A turn needs a message to act on.');
  }
  const provider = await requireProvider(ws);
  const history = input.history ?? [];
  const temperature = aggressivenessToTemperature(getAggressiveness());
  // The TRIMMED message throughout, so the words the model is asked to answer and
  // the words the URL-fetch gate checks against are the same string. Two versions
  // of "what the user said" is how a gate ends up guarding a slightly different
  // sentence from the one that ran.
  const dispatch = buildTurnDispatch(ws, { ...input, message }, provider);

  // Deterministic, type-based ingestion: pull any reference material out of the
  // user's message and route it through the SAME engine a dropped file uses,
  // BEFORE the turn. Fully awaited — the turn's own writes must not overlap
  // these — and the returned note tells the model what was saved so it neither
  // re-creates nor guesses at it.
  const ingestNote = await ingestReferenceMaterial(
    provider.client,
    message,
    {
      db: ws.db,
      feed: ws.feed,
      softDeletable: ws.softDeletable,
      aggressiveness: getAggressiveness(),
      ...(ws.createEntity ? { createEntity: ws.createEntity } : {}),
      ...(ws.createFileJunction ? { createFileJunction: ws.createFileJunction } : {}),
      ...(ws.createJunction ? { createObjectJunction: ws.createJunction } : {}),
      ...(ws.privateMode === true ? { privateMode: true } : {}),
    },
    temperature,
  );

  // The cloud workspace's owner-set system prompt, bundled into every member's
  // turn. Best-effort and read through the caller's own connection; null on a
  // local or unset workspace ⇒ no injection.
  const cloudSystemPrompt =
    (await getCloudSetting(ws.db, CLOUD_SETTING_SYSTEM_PROMPT)) ?? undefined;

  yield* runChat({
    client: provider.client,
    dispatch,
    history,
    userMessage: message,
    contextNotes: [...contextNotes, ingestNote, ...trailing],
    temperature,
    // Address the operator by name, and resolve "me"/"my" without asking for a
    // name we already have.
    operatorName: input.operatorName ?? readIdentity().display_name,
    // Ground the assistant in the real wall clock and the caller's timezone, so
    // "today" and "most recent" resolve to now rather than a training cutoff.
    nowIso: input.nowIso ?? new Date().toISOString(),
    timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(cloudSystemPrompt ? { cloudSystemPrompt } : {}),
    ...(input.activeContext ? { activeContext: input.activeContext } : {}),
    ...(input.onToolRecord ? { onToolRecord: input.onToolRecord } : {}),
    ...(input.onOutcomeNotice ? { onOutcomeNotice: input.onOutcomeNotice } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

/**
 * Run one assistant turn to completion and hand back what it produced.
 *
 * This is the headless assistant: give it a workspace and a sentence, get an
 * answer and a record of what it did. It is what `lattice ask` runs, and what a
 * script or a scheduled job calls.
 *
 * A failure is REPORTED, never swallowed into an empty answer: a turn that errors
 * comes back `ok: false` with the reason, so a caller can exit non-zero on it. The
 * two situations a caller must distinguish before it starts — nothing connected,
 * nothing to act on — are thrown as tagged errors instead, because they are not
 * outcomes of a turn that ran.
 */
export async function runAssistantTurn(
  ws: AssistantTurnWorkspace,
  input: AssistantTurnInput,
): Promise<AssistantTurnResult> {
  const tools: AssistantTurnToolCall[] = [];
  const byId = new Map<string, AssistantTurnToolCall>();
  const opened: { table: string; id: string }[] = [];
  const warnings: string[] = [];
  let text = '';
  /** This round's own text, so a replacement or a retraction removes exactly it. */
  let roundText = '';
  let error: string | undefined;
  let question: AssistantTurnResult['question'];
  let outcomeNotice: string | undefined;
  const onOutcomeNotice = (notice: string): void => {
    outcomeNotice = notice;
    input.onOutcomeNotice?.(notice);
  };

  for await (const ev of streamAssistantTurn(ws, { ...input, onOutcomeNotice })) {
    if (ev.type === 'assistant_message_start') {
      roundText = '';
    } else if (ev.type === 'text_delta') {
      text += ev.delta;
      roundText += ev.delta;
    } else if (ev.type === 'text_final') {
      // The answer round re-emitted with its record references linkified —
      // replaces this round's accumulated deltas, exactly as a live client does.
      text = text.slice(0, text.length - roundText.length) + ev.text;
      roundText = ev.text;
    } else if (ev.type === 'assistant_message_end') {
      if (ev.dropText) {
        // This round's preamble exactly repeated the previous kept one — roll it
        // back off rather than saying the same thing twice.
        text = text.slice(0, text.length - roundText.length);
        roundText = '';
      } else if (ev.hadTools && roundText) {
        // A tool round's narration is real content the reader keeps; separate it
        // from the next round with a blank line so the answer reads as paragraphs.
        text += '\n\n';
      }
    } else if (ev.type === 'tool_use') {
      const call: AssistantTurnToolCall = { name: ev.name, ok: true };
      tools.push(call);
      byId.set(ev.id, call);
    } else if (ev.type === 'tool_result') {
      const call = byId.get(ev.toolUseId);
      if (call) call.ok = !ev.isError;
    } else if (ev.type === 'open') {
      opened.push({ table: ev.table, id: ev.id });
    } else if (ev.type === 'question') {
      question = { question: ev.question, options: ev.options, allowOther: ev.allowOther };
    } else if (ev.type === 'warn') {
      // The turn warning about itself — the step cap being the one that matters,
      // because it is the only sign that the answer describes an unfinished job.
      // The outcome notice travels this channel too, and it already has a field
      // of its own; carrying it twice would have every caller print it twice.
      if (ev.message !== outcomeNotice) warnings.push(ev.message);
    } else if (ev.type === 'error' || ev.type === 'limit') {
      // First failure wins: a later one is usually a consequence of it, and the
      // first is the one that explains the turn.
      error ??= ev.message;
    }
  }

  const stopped = input.signal?.aborted === true;
  return {
    ok: error === undefined,
    text: text.trim(),
    tools,
    stopped,
    warnings,
    ...(outcomeNotice ? { outcomeNotice } : {}),
    ...(question ? { question } : {}),
    opened,
    ...(error !== undefined ? { error } : {}),
  };
}
