import type { LlmClient } from './chat.js';
import { DEFAULT_MODEL } from './chat.js';

/**
 * Fast "intent" pass that runs the instant a chat turn is accepted, BEFORE the (possibly
 * slow, multi-round) tool loop. One structured call on the resolved provider using the
 * cheap {@link DEFAULT_MODEL}, so the user gets a contextual acknowledgement within
 * seconds instead of staring at a blank typing bubble while a 16-round agentic loop runs.
 *
 * It returns three signals:
 *  - `needs_work`      — answering requires looking at or changing the user's workspace
 *                        data (search, read, create/update/link, build a dashboard,
 *                        analyze). When true, `ack_message` is a short contextual
 *                        acknowledgement and the real answer comes from the tool loop.
 *  - `needs_more_info` — the request is too ambiguous to act on; `ack_message` is a single
 *                        clarifying question and the turn ends awaiting the user's reply.
 *  - otherwise         — a trivial / general message (greeting, thanks, a capability
 *                        question about Lattice, general knowledge) answerable WITHOUT the
 *                        user's data; `ack_message` IS the full answer and the tool loop
 *                        is skipped.
 *
 * The classifier is deliberately CONSERVATIVE: anything that might touch the user's data
 * is `needs_work: true` so it runs the real loop against real data with the configured
 * model — the cheap inline answer is reserved for clearly-general messages.
 */
export interface IntentResult {
  /** Internal one-line restatement of what the user wants (diagnostics only). */
  intent_summary: string;
  /** User-facing text: a contextual ack (needs_work), the full answer (trivial), or a
   *  clarifying question (needs_more_info). */
  ack_message: string;
  /** The request needs the tool loop (data access / mutation). Bias: true when unsure. */
  needs_work: boolean;
  /** The request is too ambiguous to act on; `ack_message` is a clarifying question. */
  needs_more_info: boolean;
}

const INTENT_SYSTEM =
  'You are the fast intake step for a data assistant called Lattice, which works over the ' +
  "user's own workspace of tables, files, and connected data. Read the user's latest chat " +
  'message and decide how it should be handled, then return ONLY a JSON object in a ' +
  '```json fenced block with these fields:\n' +
  '- "intent_summary": one short sentence restating what the user wants (for logs).\n' +
  '- "needs_work": true if answering requires looking at or changing the workspace data — ' +
  'searching, reading rows/files, counting/analyzing, creating/updating/linking records, ' +
  'building or editing a dashboard, or anything grounded in the actual data. When you are ' +
  'unsure, set this TRUE — it is always safe to do the real work.\n' +
  '- "needs_more_info": true ONLY if the request is too ambiguous to even begin (you would ' +
  'have to guess at something essential). Prefer false — most requests can be attempted.\n' +
  '- "ack_message": \n' +
  '    * if needs_more_info is true → ONE short, friendly clarifying question.\n' +
  '    * else if needs_work is true → a SHORT, contextual acknowledgement in the present ' +
  'continuous tense that names what you are about to do ("Got it — pulling your Q3 ' +
  'invoices…", "On it, checking which projects are unassigned…"). Do NOT answer yet; do ' +
  'NOT invent data or numbers. One sentence, ends with an ellipsis.\n' +
  '    * else (a greeting, thanks, small talk, a question about what Lattice can do, or a ' +
  'general-knowledge question that does NOT depend on the workspace data) → the FULL, ' +
  'complete answer, written warmly and directly.\n' +
  'Never mention this JSON, tables, columns, or tool internals in ack_message. Exactly one ' +
  'of needs_more_info / (needs_work is the fallback path) governs handling; if ' +
  'needs_more_info is true it wins.';

/** Options for {@link runIntent}: light grounding that keeps the call cheap. */
export interface IntentOptions {
  /** The operator's display name, so the ack can address them naturally. */
  operatorName?: string;
  /** Names of the tables in the workspace, so the ack is grounded and needs_work is
   *  judged accurately. Kept to names only (no rows) to stay cheap. */
  tableNames?: string[];
  /** Short label for what the user is currently viewing (e.g. `the dashboard "Sales"`),
   *  so a complaint like "why is this broken" is understood as actionable (investigate
   *  it), NOT flagged as too ambiguous. */
  activeView?: string;
  /** A compact transcript of the last turn or two ("Assistant: …\nUser: …"), so a short
   *  context-dependent reply ("yes", "the first one", "do that") is resolved against what
   *  the assistant just said instead of being judged in a vacuum and mis-flagged as
   *  ambiguous. Without this, "yes" following an offer reads as a standalone message. */
  recentContext?: string;
  /** The pre-formatted, member-scoped "Connected data sources" block (from
   *  describeConnectedSources). The intent pass answers general questions INLINE without
   *  the heavy loop, so without this it can't answer "are you connected to X?" and wrongly
   *  says no. Grounds that inline answer in the real connection list. */
  connectedSources?: string;
  /** True when the connected-sources list could NOT be determined this turn (enumeration
   *  failed). The inline pass must then avoid answering a connection question from missing
   *  data — it treats such a question as `needs_work` so the tool loop can check directly,
   *  rather than asserting a false "not connected". */
  connectionsUnknown?: boolean;
  temperature?: number;
}

/**
 * Run the intent pass. Best-effort — the caller treats a thrown error or an unparseable
 * result as "run the tool loop" (never drops the user's message). Uses the cheap default
 * model with a small output budget so it returns in ~1-2s.
 */
export async function runIntent(
  client: LlmClient,
  message: string,
  opts: IntentOptions = {},
): Promise<IntentResult> {
  const who = opts.operatorName ? `The user's name is ${opts.operatorName}.\n` : '';
  const tables =
    opts.tableNames && opts.tableNames.length > 0
      ? `The workspace currently has these tables: ${opts.tableNames.slice(0, 80).join(', ')}.\n`
      : 'The workspace has no tables yet.\n';
  // Grounding for a message about what's on screen: a complaint that "this" is
  // broken/empty/wrong is actionable (the assistant can investigate it), so it must
  // be needs_work — never needs_more_info.
  const viewing = opts.activeView
    ? `The user is currently viewing ${opts.activeView}. If their message is a complaint or ` +
      `question that "this"/"it" is broken, empty, blank, wrong, or not working, it refers to ` +
      `what they are viewing and is NOT ambiguous — set needs_work true (the assistant will ` +
      `investigate it); do NOT ask them what is wrong.\n`
    : '';
  // The last turn or two, so a context-dependent reply is resolved in context rather than
  // judged in a vacuum. A bare "yes"/"do it"/"the first one" answering the assistant's
  // previous question or offer is a CONTINUATION — never treat it as ambiguous or as a
  // fresh greeting; if that prior turn offered to do data work, set needs_work true so the
  // real work runs.
  const recent = opts.recentContext
    ? `Recent conversation so far (oldest first; the user's latest message is below, NOT ` +
      `repeated here):\n${opts.recentContext.slice(0, 4000)}\n\nThe user's latest message may be ` +
      `a direct reply to the assistant's previous message. If it is a short confirmation, ` +
      `answer, or selection that only makes sense as a continuation (e.g. "yes", "do it", ` +
      `"the first one", "that one"), treat it as continuing that thread — it is NOT ambiguous, ` +
      `and if the assistant just offered to create/update/link a record or build something, ` +
      `set needs_work true. Do NOT restart with a greeting or ask what they want.\n`
    : '';
  // The connected external sources — the intent pass answers "are you connected to X?"
  // INLINE (no heavy loop), so it must see this list or it will wrongly say "not connected".
  // The list is authoritative; match a service name against a source's name OR its server
  // host ("justworks" matches "mcp.justworks.com").
  const connected = opts.connectedSources
    ? `${opts.connectedSources}\nIf the user asks whether a service/integration/source is connected ` +
      `(e.g. "are you connected to X?"), answer INLINE from the "Connected data sources" list above — ` +
      `it is AUTHORITATIVE. If X matches an entry by name OR by its server host (e.g. "justworks" ` +
      `matches "mcp.justworks.com"), confirm it IS connected (this is a general question, not needs_work); ` +
      `never say it is not connected when it appears in that list. Only say it isn't connected if it is ` +
      `genuinely absent from the list.\n`
    : opts.connectionsUnknown
      ? // The list couldn't be loaded this turn. Do NOT guess "not connected" — defer any
        // connection question to the tool loop, which can check the connector tables directly.
        `The list of connected external sources could not be loaded this turn. If the user asks ` +
        `whether a service/integration/source is connected, do NOT answer that it is not connected — ` +
        `set needs_work true so the assistant can check the connector state directly.\n`
      : '';
  const turn = await client.runTurn({
    model: DEFAULT_MODEL,
    // Small budget: the ack/inline-answer is short by construction. Keeps latency + cost low.
    maxTokens: 700,
    system: INTENT_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `${who}${tables}${connected}${viewing}${recent}\nUser message:\n${message.slice(0, 8000)}\n\nReturn the JSON object.`,
      },
    ],
    tools: [],
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    onText: () => undefined,
  });
  return parseIntent(turn.text, message);
}

/**
 * Parse the intent JSON defensively. On ANY problem (no JSON, bad shape, empty ack) fall
 * back to the safe path: `needs_work: true` with a generic ack, so the caller runs the
 * real tool loop rather than answering with nothing.
 */
export function parseIntent(raw: string, message: string): IntentResult {
  const fallback: IntentResult = {
    intent_summary: message.slice(0, 200),
    ack_message: 'Working on it…',
    needs_work: true,
    needs_more_info: false,
  };
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = (fence?.[1] ?? raw).trim();
  if (!body) return fallback;
  try {
    const o = JSON.parse(body) as Partial<Record<keyof IntentResult, unknown>>;
    const ack = typeof o.ack_message === 'string' ? o.ack_message.trim() : '';
    const needsMoreInfo = o.needs_more_info === true;
    // Default needs_work to TRUE unless the model explicitly said false — the safe path is
    // to run the real loop. An empty ack also collapses to the fallback loop path.
    const needsWork = o.needs_work !== false;
    if (!ack) return fallback;
    return {
      intent_summary:
        typeof o.intent_summary === 'string' ? o.intent_summary : message.slice(0, 200),
      ack_message: ack,
      needs_work: needsMoreInfo ? true : needsWork,
      needs_more_info: needsMoreInfo,
    };
  } catch {
    return fallback;
  }
}
