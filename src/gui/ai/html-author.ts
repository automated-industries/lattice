import type { LlmClient } from './chat.js';
import { DEFAULT_MODEL } from './chat.js';

/**
 * Author a complete, standalone HTML file via a focused model sub-call.
 *
 * This is the "tool-delegated" half of the dashboard feature: the chat
 * assistant runs on a fast, cheap model and only gathers intent — when it decides
 * to build or change a dashboard it calls `create_dashboard` / `edit_dashboard`,
 * whose handlers call HERE to do the heavy authoring on a stronger model.
 *
 * The model is given the live table/column schema so any data it wires up uses
 * real names, and is instructed to read data through the injected `window.lattice`
 * bridge (the frame is fully isolated and has NO network access — it cannot fetch)
 * and to use the `Chart` global the GUI injects into the rendered frame — the
 * authored HTML must NOT add its own `<script src>` or attempt any network call.
 * Returns the HTML string; throws loudly (never a silent empty/partial fallback)
 * if the model returns something that isn't HTML.
 */

/**
 * The model used for HTML authoring. It MUST be a model the resolved Claude auth
 * can actually call, so it tracks the chat model (`DEFAULT_MODEL`) rather than
 * hardcoding a separate, "stronger" one. A connected Claude *subscription*
 * ("Connect with Claude") is entitled only to the models on the user's plan; a
 * hardcoded model the plan lacks returns a `429 rate_limit_error` on EVERY call
 * — even a one-token one — so authoring would fail 100% of the time for those
 * users (verified live: `claude-haiku-4-5` OK, `claude-sonnet-4-6` 429 on a
 * subscription that only entitled haiku). Using the chat's own model guarantees
 * the authoring sub-call works wherever the chat itself works.
 */
export const HTML_AUTHOR_MODEL = DEFAULT_MODEL;

/**
 * The preferred authoring model when the resolved auth can actually run it. An
 * Anthropic API key is entitled to all GA models, so API-key users get the
 * stronger model — better, more reliable pages (and edits), which is the model
 * the feature was designed around. It is deliberately NOT used for an OAuth
 * subscription: subscription entitlements vary and may be limited to a single
 * model, and a non-entitled model returns `429 rate_limit_error` on every call
 * (see {@link HTML_AUTHOR_MODEL}).
 */
export const HTML_AUTHOR_STRONG_MODEL = 'claude-sonnet-4-6';

/**
 * Pick the authoring model for a resolved Claude auth: the stronger model for an
 * API key (entitled to all models), the chat model for an OAuth subscription
 * (proven entitled in-session — never 429s for lack of entitlement).
 */
export function htmlAuthorModelForAuth(auth: { apiKey?: string | null | undefined }): string {
  return auth.apiKey ? HTML_AUTHOR_STRONG_MODEL : HTML_AUTHOR_MODEL;
}

/** Output budget for a full standalone HTML document (well under the model ceiling). */
const HTML_MAX_TOKENS = 16000;

const HTML_SYSTEM = [
  'You author a SINGLE, complete, standalone HTML document (an HTML "file") that will be rendered inline inside a Lattice database GUI.',
  '',
  'Output contract:',
  '- Output ONLY the HTML document — begin at `<!doctype html>` (or `<html>`). No markdown, no code fences, no prose before or after.',
  '- Self-contained: put CSS in an inline `<style>` and JS in an inline `<script>`. Do NOT add any `<script src="...">` and do NOT reference any external/CDN URL.',
  '- The page runs fully isolated with NO network access: `fetch`, `XMLHttpRequest`, WebSocket, and remote images are all blocked. Read data ONLY through the injected `window.lattice` bridge (described below). Never attempt a direct network call — it will fail.',
  '- A charting library is ALREADY loaded in the page: a global `Chart` (Chart.js) is available. Call `new Chart(canvasEl, {...})` directly when a chart helps. Never load your own chart library.',
  '',
  "Live data (optional — only when the page should show the user's data):",
  '- A global `window.lattice` object is preloaded. Every method returns a Promise:',
  '    lattice.query(table, { limit, offset })  → resolves to { rows: [ ... ] }',
  '    lattice.get(table, id)                   → resolves to a single row object',
  '    lattice.search(queryString)              → resolves to full-text search results',
  '    lattice.sql(selectStatement)             → resolves to { rows: [ ... ], truncated }',
  '  Use the REAL table and column names from the schema below. Load data on page load (e.g. an async init function using await) and render gracefully — but DISTINGUISH the two failure modes: a query that RESOLVES with zero rows means there is simply no data yet → show a calm "No data yet" empty state; a query that REJECTS (throws) means the data could not be loaded → show a specific, honest message about what failed. NEVER show a generic "Failed to load, please try again" or leave a perpetual spinner for a rejected read — retrying cannot conjure missing data, and a misleading "try again" is worse than saying plainly what is unavailable. Reads are read-only; you cannot create, update, or delete.',
  '',
  '- PREFER lattice.sql for anything beyond listing raw rows: aggregations, counts, group-bys, joins, filters, and top-N should be ONE portable SELECT (works unchanged on SQLite and Postgres — stick to standard SQL: no dialect-specific functions) rather than fetching whole tables and computing in page JS. A single statement only; it is read-only and results are capped (check `truncated`).',
  '- The page must stay CURRENT: never hardcode, snapshot, or inline data values into the document — every number, row, and chart must come from a lattice.query/get/sql read at load time, so the page always shows the live data.',
  '',
  'Make it clean, readable, and self-explanatory: a simple system-font stack and a responsive layout. Prefer clarity over cleverness.',
  'When the page is a DASHBOARD — an at-a-glance answer to a question about the data — lead with a compact row of key-number tiles, then charts in a responsive grid, then any supporting detail table, each section clearly titled.',
].join('\n');

/** Strip a leading/trailing ``` fence if the model wrapped the document in one. */
function stripFences(s: string): string {
  const t = s.trim();
  const inner = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/.exec(t)?.[1];
  return inner !== undefined ? inner.trim() : t;
}

/** True when the text looks like an HTML document, not prose / JSON / markdown. */
function looksLikeHtml(s: string): boolean {
  const head = s.slice(0, 300).toLowerCase();
  if (head.includes('<!doctype html') || head.includes('<html')) return true;
  // No doctype/html wrapper, but a real HTML element near the top also counts.
  return /<(body|head|main|section|div|canvas|table|h1|h2|script|style)\b/i.test(s.slice(0, 800));
}

export interface HtmlAuthorRequest {
  client: LlmClient;
  /** Pre-built schema context (table + column listing) the page may read from. */
  schema: string;
  /** Natural-language description (create) or change instruction (edit). */
  spec: string;
  /** For an edit: the current HTML to modify. Absent → author from scratch. */
  currentHtml?: string;
  /** Authoring model. Defaults to the chat model ({@link HTML_AUTHOR_MODEL}). */
  model?: string;
}

/**
 * Run the authoring sub-call and return the HTML document text. The caller passes
 * a client built from the already-resolved Claude auth, so api-key and OAuth paths
 * both work. Throws if authoring fails or the result is not HTML.
 */
export async function generateHtmlFile(req: HtmlAuthorRequest): Promise<string> {
  const { client, schema, spec, currentHtml, model } = req;
  const parts: string[] = [`# Available data (tables and columns)\n${schema}`];
  if (currentHtml?.trim()) {
    parts.push(
      '# Current HTML file\nApply the change described below to THIS document and return the FULL updated document:\n\n' +
        currentHtml,
    );
    parts.push(`# Change to make\n${spec}`);
  } else {
    parts.push(`# What to build\n${spec}`);
  }

  let captured = '';
  const turn = await client.runTurn({
    model: model ?? HTML_AUTHOR_MODEL,
    system: HTML_SYSTEM,
    messages: [{ role: 'user', content: parts.join('\n\n') }],
    tools: [],
    maxTokens: HTML_MAX_TOKENS,
    onText: (d) => {
      captured += d;
    },
  });

  const html = stripFences(turn.text || captured);
  if (!html || !looksLikeHtml(html)) {
    throw new Error(
      'HTML authoring failed: the model did not return an HTML document. Try restating what you want the page to show.',
    );
  }
  return html;
}
