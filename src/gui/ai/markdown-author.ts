import type { LlmClient } from './chat.js';
import { authorWithEscalation } from './author-budget.js';
import { DEFAULT_MODEL } from './chat.js';

/**
 * Author a complete markdown document via a focused model sub-call.
 *
 * This is the delegated authoring path for large artifacts: when the chat
 * assistant decides to create a large document, it calls `create_artifact`
 * with a `spec` (brief description of what to write), which delegates the
 * heavy authoring to this function on a stronger model. This avoids token-limit
 * truncation: the spec fits easily in the tool call, and the markdown is authored
 * server-side with its own token budget.
 *
 * The model is given the live table/column schema so any references use real names.
 * Returns the markdown string; throws loudly (never a silent empty/partial fallback)
 * if the model returns something that isn't markdown.
 */

/**
 * The model used for markdown authoring. Same logic as HTML authoring: use the
 * chat model to ensure subscription entitlements work, not a hardcoded stronger one.
 */
export const MARKDOWN_AUTHOR_MODEL = DEFAULT_MODEL;

/**
 * The preferred authoring model when the resolved auth can actually run it. An
 * Anthropic API key is entitled to all GA models, so API-key users get the
 * stronger model. For OAuth subscriptions, fall back to the chat model.
 */
export const MARKDOWN_AUTHOR_STRONG_MODEL = 'claude-sonnet-4-6';

/**
 * Pick the authoring model for a resolved Claude auth: the stronger model for an
 * API key (entitled to all models), the chat model for an OAuth subscription.
 */
export function markdownAuthorModelForAuth(auth: { apiKey?: string | null | undefined }): string {
  return auth.apiKey ? MARKDOWN_AUTHOR_STRONG_MODEL : MARKDOWN_AUTHOR_MODEL;
}

/** Output budget for a complete markdown document (well under the model ceiling). */
const MARKDOWN_MAX_TOKENS = 16000;

const MARKDOWN_SYSTEM = [
  'You author a SINGLE, complete markdown document. Output ONLY the markdown — no code fences, no prose before or after. Begin directly with the content.',
  '',
  'Guidelines:',
  '- Use GitHub-flavored markdown (headings, bold, italic, lists, code blocks, tables, links).',
  '- Organize with clear headings and sections.',
  '- Be thorough and complete — this is a finished document, not a draft or outline.',
  '- Write for clarity: use plain language, avoid jargon where possible, explain technical terms.',
  "- When the document references the user's data (tables, records, fields), use the real names from the schema below.",
  "- Do NOT invent data or make up row values — if the document should show data from the workspace, instruct in text how to retrieve it, don't fake example rows.",
  '- When applicable, structure information with tables, lists, or other markdown formatting for readability.',
].join('\n');

/** True when the text looks like markdown, not prose wrapping / JSON / HTML. */
function looksLikeMarkdown(s: string): boolean {
  const t = s.trim();
  // Check for markdown-specific markers in the first ~500 chars
  return (
    /#\s+\S/.test(t) || // Heading
    /[-*]\s+\S/.test(t) || // List
    /\[.+\]\(.+\)/.test(t) || // Link
    t.includes('```') || // Code block
    /\|.+\|/.test(t) // Table
  );
}

export interface MarkdownAuthorRequest {
  client: LlmClient;
  /** Pre-built schema context (table + column listing). */
  schema: string;
  /** Natural-language description of what markdown to write. */
  spec: string;
  /** Authoring model. Defaults to the chat model ({@link MARKDOWN_AUTHOR_MODEL}). */
  model?: string;
}

/**
 * Run the authoring sub-call and return the markdown document text. The caller passes
 * a client built from the already-resolved Claude auth, so api-key and OAuth paths
 * both work. Throws if authoring fails or the result is not markdown.
 */
export async function generateMarkdown(req: MarkdownAuthorRequest): Promise<string> {
  const { client, schema, spec, model } = req;
  const parts: string[] = [
    `# Available data (tables and columns)\n${schema}`,
    `# What to write\n${spec}`,
  ];

  let captured = '';
  // Same ladder the HTML author uses: a long document is not a malformed request,
  // so climb the budget before refusing.
  const attempt = await authorWithEscalation(
    MARKDOWN_MAX_TOKENS,
    async (maxTokens) => {
      captured = '';
      const t = await client.runTurn({
        model: model ?? MARKDOWN_AUTHOR_MODEL,
        system: MARKDOWN_SYSTEM,
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
        `[markdown-author] document did not fit in ${String(from)} output tokens; retrying at ${String(to)}`,
      );
    },
  );
  const turn = attempt.result;

  // Every tier ran out mid-token. A document cut mid-sentence stored as though it
  // were whole is the same failure the HTML path had: it looks like text, passes
  // every check that inspects text, and silently loses the tail the user asked for.
  if (attempt.truncated) {
    throw new Error(
      'Document authoring exceeded the output budget and returned an incomplete document. ' +
        'Ask for a shorter document, or split it into sections.',
    );
  }

  const markdown = (turn.text || captured).trim();
  if (!markdown || !looksLikeMarkdown(markdown)) {
    throw new Error(
      'Markdown authoring failed: the model did not return markdown content. Try restating what document you want created.',
    );
  }
  return markdown;
}
