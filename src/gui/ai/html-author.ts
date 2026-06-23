import type { LlmClient } from './chat.js';

/**
 * Author a complete, standalone HTML file via a focused model sub-call.
 *
 * This is the "tool-delegated" half of the inline-HTML-file feature: the chat
 * assistant runs on a fast, cheap model and only gathers intent — when it decides
 * to build or change an HTML file it calls `create_html_file` / `edit_html_file`,
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

/** The model used for HTML authoring — stronger than the chat default. */
export const HTML_AUTHOR_MODEL = 'claude-sonnet-4-6';

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
  '  Use the REAL table and column names from the schema below. Load data on page load (e.g. an async init function using await) and render gracefully when a query returns no rows or rejects. Reads are read-only; you cannot create, update, or delete.',
  '',
  'Make it clean, readable, and self-explanatory: a simple system-font stack and a responsive layout. Prefer clarity over cleverness.',
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
}

/**
 * Run the authoring sub-call and return the HTML document text. The caller passes
 * a client built from the already-resolved Claude auth, so api-key and OAuth paths
 * both work. Throws if authoring fails or the result is not HTML.
 */
export async function generateHtmlFile(req: HtmlAuthorRequest): Promise<string> {
  const { client, schema, spec, currentHtml } = req;
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
    model: HTML_AUTHOR_MODEL,
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
