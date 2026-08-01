import type { Lattice } from '../lattice.js';
import type { FeedBus } from '../gui/feed.js';
import type { MutationCtx } from '../gui/mutations.js';
import type { FileJunction } from '../gui/data.js';
import type { AssistantJunction } from '../gui/ai/dispatch.js';
import type { LlmClient, LlmMessage } from '../gui/ai/chat.js';
import { normalizeUserUrl } from '../sources/url-safety.js';
import { columnDescriptionHook } from '../gui/meta-gen.js';
import { triageReferenceMaterial } from '../gui/ai/summarize.js';
import { FetchBudget } from '../ai/fetch-policy.js';

/**
 * The auto-ingest pre-pass a chat turn runs over the user's own words — a
 * capability, not a route.
 *
 * A message can carry reference material as well as an instruction: a pasted
 * document, a note of facts, a link. That material is saved and enriched the
 * same way a dropped file is, BEFORE the turn runs, so the assistant answers
 * from a saved, linked record instead of re-deriving it (or asking for details
 * the page it was handed already provides).
 *
 * This lived inside the chat route, which meant the only way to run it was to
 * start a server and send yourself a request — so a command line or a background
 * job could run the turn but not the pre-pass that belongs to it. The body below
 * is unchanged; `gui/chat-routes.ts` re-exports it so callers that predate the
 * move keep working.
 */

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
    const { ingestUrlAsFile } = await import('../gui/ingest-url.js');
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
        const { ingestTextAsFile, looksLikeUrl } = await import('./ingest-text.js');
        // A triage-returned bare URL (one the extractor's normalizer refused but the
        // ingest normalizer accepts) still crawls; anything else saves as text.
        if (looksLikeUrl(ref)) {
          const { ingestUrlAsFile } = await import('../gui/ingest-url.js');
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
