import type { LlmClient } from './chat.js';
import { authorWithEscalation } from './author-budget.js';
import { DEFAULT_MODEL, maxOutputTokensFor } from './chat.js';

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
  '- The preview sandbox blocks browser-chrome actions: `window.print()`, `window.open()`, `alert()`/`confirm()`/`prompt()`, `target="_blank"`, and form submission all silently do NOTHING. Do NOT add Print / Export-PDF / Download / "Open in new tab" / submit buttons or any control that calls those — it renders as a dead button, and Lattice strips it and tells the user. Build interactivity IN the page instead (tabs, toggles, filters, sorts that re-render the DOM).',
  '- The preview sandbox also blocks anchor navigation: `<a href>` links do not navigate because the frame has no allow-same-origin. Use window.lattice.act() for page navigation instead (see below). When the page includes source citations or references to external documents, use native browser tooltips via the `title` attribute — `<span title="Full source name">abbreviated label</span>` — so hovering shows the full citation. Do NOT author anchor links for source citations.',
  '',
  "Live data (optional — only when the page should show the user's data):",
  '- A global `window.lattice` object is preloaded. Every method returns a Promise:',
  '    lattice.query(table, { limit, offset })  → resolves to { rows: [ ... ] }',
  '    lattice.get(table, id)                   → resolves to a single row object',
  '    lattice.search(queryString)              → resolves to full-text search results',
  '    lattice.sql(selectStatement)             → resolves to { rows: [ ... ], truncated }',
  '  Use the REAL table and column names from the schema below. Load data on page load (e.g. an async init function using await) and render gracefully — but DISTINGUISH the two failure modes: a query that RESOLVES with zero rows means there is simply no data yet → show a calm "No data yet" empty state; a query that REJECTS (throws) means the data could not be loaded → show a specific, honest message about what failed. NEVER show a generic "Failed to load, please try again" or leave a perpetual spinner for a rejected read — retrying cannot conjure missing data, and a misleading "try again" is worse than saying plainly what is unavailable. Reads are read-only; you cannot create, update, or delete.',
  '',
  '- PREFER lattice.sql for anything beyond listing raw rows: aggregations, counts, group-bys, joins, filters, and top-N should be ONE SELECT rather than fetching whole tables and computing in page JS. A single statement only; it is read-only and results are capped (check `truncated`).',
  '- lattice.sql runs against BOTH SQLite (local / desktop) and Postgres (cloud), so write ONLY PORTABLE SQL that works on both. This matters — a Postgres-only construct throws at render time (e.g. `unrecognized token ":"`), leaving a broken tile:',
  '    • Casts: use `CAST(expr AS INTEGER|REAL|TEXT)`. NEVER the Postgres `expr::type` shorthand — SQLite rejects `::`.',
  '    • Parameters: inline literal values directly into the statement. NEVER use `:name`, `$1`, or `?` placeholders — there is no binding, and `:`/`$` fail to parse.',
  '    • Dates are stored as ISO text (YYYY-MM-DD…): bucket by month with `substr(col,1,7)` and by year with `substr(col,1,4)`. Do NOT use `date_trunc`, `to_char`, or `strftime` — each exists on only one engine.',
  '    • Stay within functions both engines share (count, sum, avg, min, max, round, coalesce, cast, substr, length, lower, upper, replace) plus standard GROUP BY / ORDER BY / JOIN / CASE. Avoid anything specific to one engine.',
  '- The page must stay CURRENT: never hardcode, snapshot, or inline data values into the document — every number, row, and chart must come from a lattice.query/get/sql read at load time, so the page always shows the live data.',
  '',
  'Make every number traceable back to its source — you know which table each read came from, so SAY so in the markup:',
  '- Put `data-lattice-table="<table>"` on the element that renders each chart, key-number tile, or data table, naming the table that section was read FROM (for a chart, put it on the `<canvas>` or its wrapper). For a section built from a join, name the table the section is really ABOUT.',
  '- Additionally put `data-lattice-row-id="<the row id>"` on any element that corresponds to exactly ONE record — a table row, a tile about a single record. Omit it wherever a mark aggregates many rows; a section with no row id is traced at the table level, which is the correct answer there.',
  '- That is ALL that is needed: Lattice turns those attributes into click-through and shows the user where the data came from. Do NOT add your own click handler, link, or tooltip for this, and do NOT invent an id you did not read from the data.',
  '- For marks drawn on a canvas (where there is no per-mark element to annotate), you may call `lattice.showSource(table, rowId)` from the chart onClick with the row id for that mark; pass an empty string when the mark covers many rows.',
  '',
  'Make it clean, readable, and self-explanatory: a simple system-font stack and a responsive layout. Prefer clarity over cleverness.',
  'When the page is a DASHBOARD — an at-a-glance answer to a question about the data — lead with a compact row of key-number tiles, then charts in a responsive grid, then any supporting detail table, each section clearly titled.',
].join('\n');

// ── "clean the data" is not a page change ────────────────────────────────────
//
// A request to fix the DATA — dedupe it, normalize the values, fill the blanks —
// is a request to change rows. Sent here it becomes a re-authored page instead:
// the dirty values stay exactly as they were, the page is rewritten around them,
// and the reply says the data was cleaned. So the authoring path refuses it and
// names the tools that actually change rows.

/** Verbs that can ONLY mean "change the stored values" — no object needed. */
const DATA_ONLY_VERBS =
  /\b(cleanse|dedupe|de-?dup\w*|deduplicat\w*|normali[sz]\w*|standardi[sz]\w*|canonicali[sz]\w*|backfill)\b/i;

/** Verbs that mean cleaning only when aimed at stored values ("fix the layout" does not). */
const AMBIGUOUS_VERBS =
  /\b(clean(?:s|ed|ing)?(?:\s*up)?|reconcile|merge|consolidat\w*|correct|fix|repair|trim|strip|fill\s+in|populate|delete|remove|drop|purge)\b/i;

/**
 * Objects that unambiguously mean STORED VALUES. Deliberately excludes the
 * structural/ambiguous ones (columns, fields, names, titles) — "fix the column
 * names" is as likely to be about the page's headers, and refusing a real page
 * edit is worse than missing one cleaning request.
 */
const DATA_OBJECTS =
  /\b(data|dataset|rows?|records?|entries|values?|duplicates?|dupes?|blanks?|nulls?|whitespace|typos?|spellings?|imports?)\b/i;

/** Objects that make it about the page — these win, so layout work is never misrouted. */
const PAGE_OBJECTS =
  /\b(page|dashboard|chart|charts|graph|graphs|plot|tile|tiles|card|cards|layout|design|style|styling|css|colou?rs?|font|fonts|header|footer|legend|axis|axes|label|labels|section|sections|widget|widgets|ui|view|tab|tabs|filter\s+control|spacing|margin|padding|theme)\b/i;

/** The row tools that actually change stored values. */
export const ROW_MUTATION_TOOLS = ['update_row', 'bulk_update', 'dedup', 'merge_rows'] as const;

export type AuthoringClassification =
  | { kind: 'authoring' }
  | { kind: 'data_cleaning'; reason: string; tools: readonly string[] };

/**
 * Is this instruction asking to change the DATA rather than the page? Conservative
 * on purpose: a request that names anything visual ("clean up the chart layout")
 * is authoring, and only a cleaning verb aimed at a data object counts as data
 * cleaning — the cost of a false positive (refusing a real page edit) is higher
 * than the cost of a miss.
 */
export function classifyAuthoringRequest(spec: string): AuthoringClassification {
  const text = spec.trim();
  // Anything naming the page wins outright, so layout work is never misrouted.
  if (!text || PAGE_OBJECTS.test(text)) return { kind: 'authoring' };
  const strong = DATA_ONLY_VERBS.exec(text);
  const object = DATA_OBJECTS.exec(text);
  const verb = strong ?? (object ? AMBIGUOUS_VERBS.exec(text) : null);
  if (!verb) return { kind: 'authoring' };
  return {
    kind: 'data_cleaning',
    reason:
      `"${verb[0]}${object ? ` … ${object[0]}` : ''}" asks for the stored values to change, ` +
      `which authoring a page cannot do`,
    tools: ROW_MUTATION_TOOLS,
  };
}

/** The refusal text for a data-cleaning request that reached the authoring path. */
export function dataCleaningRefusal(spec: string, reason: string): string {
  return (
    `That is a request to change the DATA, not the page — ${reason}. Nothing was authored and ` +
    `nothing was changed. Re-authoring a dashboard leaves every dirty value exactly as it is, ` +
    `so it must never be reported as cleaning the data. Do it on the rows instead: ` +
    `${ROW_MUTATION_TOOLS.join(' / ')} (read the real values first with list_rows / search, and ` +
    `if which rows should change is a judgement call — the same thing recorded several ways — ` +
    `ask the user which definition to use before changing anything). Request: "${spec
      .replace(/\s+/g, ' ')
      .slice(0, 200)}"`
  );
}

/**
 * Strip a leading/trailing ``` fence if the model wrapped the document in one.
 * The lead and tail are stripped INDEPENDENTLY: an all-or-nothing match would
 * no-op whenever the closing fence is missing (e.g. truncated output), leaving
 * the opening fence to render as literal text at the top of the stored page.
 * Exported for tests.
 */
export function stripFences(s: string): string {
  let t = s.trim();
  const lead = /^```[a-zA-Z]*[ \t]*\r?\n/.exec(t);
  if (lead) t = t.slice(lead[0].length);
  const tail = /\r?\n```$/.exec(t);
  if (tail) t = t.slice(0, tail.index);
  return t.trim();
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
  // Refuse BEFORE the model call: a data-cleaning request answered with a page is
  // the failure, and it costs a page rewrite to produce.
  const routed = classifyAuthoringRequest(spec);
  if (routed.kind === 'data_cleaning') {
    throw new Error(dataCleaningRefusal(spec, routed.reason));
  }
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
  // Try the normal budget first, then climb if the page did not fit. A large page
  // is not a malformed request, so exhausting the ceiling should escalate rather
  // than immediately telling the user to simplify something reasonable.
  const attempt = await authorWithEscalation(
    HTML_MAX_TOKENS,
    async (maxTokens) => {
      captured = '';
      const t = await client.runTurn({
        model: model ?? HTML_AUTHOR_MODEL,
        system: HTML_SYSTEM,
        messages: [{ role: 'user', content: parts.join('\n\n') }],
        tools: [],
        maxTokens,
        onText: (d) => {
          captured += d;
        },
      });
      return { result: t, truncated: t.stopReason === 'max_tokens' };
    },
    (from, to) => {
      console.warn(
        `[html-author] page did not fit in ${String(from)} output tokens; retrying at ${String(to)}`,
      );
    },
    // The model's hard ceiling: a rung above it is rejected as a bad REQUEST, which
    // would replace the explanatory refusal below with a raw provider error.
    maxOutputTokensFor(model ?? HTML_AUTHOR_MODEL),
  );
  const turn = attempt.result;

  // Every budget tier ran out mid-token. Fail loudly rather than returning the
  // fragment: a truncated page is worse than no page at all. The
  // model MUST complete the document before returning — a truncated page is
  // worse than no page at all (a partial <script> or unterminated attribute
  // breaks the whole thing and silent failures downstream catch nothing).
  if (attempt.truncated) {
    throw new Error(
      'HTML authoring exceeded the output budget and returned an incomplete page. Simplify the request (fewer data sources, smaller dashboards, less detailed charts) or split it into multiple pages.',
    );
  }

  const html = stripFences(turn.text || captured);
  if (!html || !looksLikeHtml(html)) {
    throw new Error(
      'HTML authoring failed: the model did not return an HTML document. Try restating what you want the page to show.',
    );
  }
  return html;
}
