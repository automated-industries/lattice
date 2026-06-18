import type { Lattice } from '../lattice.js';
import type { FileJunction } from './data.js';
import { createRow, type MutationCtx } from './mutations.js';
import { fileIdentity, requiredFileDefaults } from './file-row.js';
import { describe } from './ai/extract.js';
import { enrichWithLlm } from './ai/enrich.js';
import { crawlUrl } from '../ai/crawl.js';
import { assertSafeUrl } from '../sources/url-safety.js';
import {
  urlIngestConfig,
  assertUrlPolicy,
  fetchGate,
  takeHostSlot,
  type FetchBudget,
} from '../ai/fetch-policy.js';
import type { ClassifyMatch } from './ai/summarize.js';

/**
 * The single, shared "fetch a web URL and save it as a `files` row" path —
 * used by BOTH the assistant's `ingest_url` tool and the `/api/ingest/text`
 * URL branch, so policy, rate-limiting, the untrusted-content framing, and the
 * row shape are identical everywhere a URL is ingested.
 *
 * Guard order (every fetch passes through all of them):
 *   1. `assertSafeUrl`   — SSRF (no private / loopback / metadata addresses)
 *   2. `assertUrlPolicy` — deployment on/off switch + allow/block-list
 *   3. `FetchBudget.take` — per-chat-turn ceiling (anti "fetch a hundred URLs")
 *   4. `fetchGate`       — process-wide concurrency cap (headless render is heavy)
 *   5. `takeHostSlot`    — per-host min-interval throttle
 *
 * The fetched bytes are UNTRUSTED external content: the row is flagged
 * `source_json.untrusted = true` (so readers wrap it in injection framing) and
 * the LLM enrichment runs with `untrusted: true`.
 */

/** Optional auto-organize context — when present, the saved file is summarized
 *  + auto-linked exactly like a pasted-text ingest. Omit to skip enrichment. */
export interface UrlIngestEnrich {
  fileJunctions: FileJunction[];
  entityDescriptions: Record<string, string>;
  createJunction?: (otherTable: string) => Promise<FileJunction | null>;
  aggressiveness?: number;
  createEntity?: (entity: string, columns: string[]) => Promise<string | null>;
}

export interface UrlIngestCtx {
  db: Lattice;
  mctx: MutationCtx;
  /** Force the saved row PRIVATE regardless of the table default (cloud only). */
  privateMode?: boolean;
  /** Enrichment context — omit for a bare "save it" with no auto-link. */
  enrich?: UrlIngestEnrich;
}

export interface UrlIngestOptions {
  /** Render headless-first (SPA shells). Degrades to static if Playwright absent. */
  forceJs?: boolean;
  /** Per-chat-turn fetch budget — `take()` is called before fetching. */
  budget?: FetchBudget;
  /**
   * Test/advanced seam: an injected `fetch` + permission to reach private
   * addresses. Production callers (the assistant tool + the ingest route) leave
   * both unset, so the full SSRF guard applies and the runtime `fetch` is used.
   */
  fetcher?: typeof fetch;
  allowPrivate?: boolean;
}

export interface UrlIngestResult {
  id: string;
  title: string;
  url: string;
  finalUrl: string;
  mime: string;
  byteLength: number;
  charsExtracted: number;
  description: string;
  suggestedLinks: ClassifyMatch[];
}

export async function ingestUrlAsFile(
  ctx: UrlIngestCtx,
  rawUrl: string,
  opts: UrlIngestOptions = {},
): Promise<UrlIngestResult> {
  const cfg = urlIngestConfig();
  const allowPrivate = opts.allowPrivate ?? false;
  // 1 + 2: SSRF guard, then the deployment's on/off + allow/block policy.
  const u = await assertSafeUrl(rawUrl, allowPrivate);
  assertUrlPolicy(u, cfg);
  // 3: per-turn budget (throws when exhausted — surfaced to the caller).
  opts.budget?.take();

  // 4 + 5: global concurrency gate, then the per-host throttle.
  const release = await fetchGate().acquire();
  let crawled;
  try {
    await takeHostSlot(u.hostname, cfg.hostMinIntervalMs);
    crawled = await crawlUrl(u.toString(), {
      maxBytes: cfg.maxBytes,
      timeoutMs: cfg.timeoutMs,
      forceJs: opts.forceJs ?? false,
      allowPrivate,
      ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
    });
  } finally {
    release();
  }

  const text = crawled.text.trim();
  // No readable text → THROW (do not silently save the URL string as a file).
  if (text.length === 0) {
    throw new Error(`Lattice: no readable text found at ${u.toString()}`);
  }

  const title = crawled.title.trim() || 'Web page';
  const mime = crawled.mime || 'text/html';
  const fileId = crypto.randomUUID();
  const description = describe(text, mime, title);
  const row: Record<string, unknown> = {
    id: fileId,
    ...fileIdentity(title, fileId),
    original_name: title,
    mime,
    size_bytes: crawled.byteLength,
    extracted_text: text.slice(0, 200_000),
    description,
    extraction_status: 'extracted',
    // Reference model: the durable pointer is the URL; bytes are not copied.
    ref_kind: 'cloud_ref',
    ref_uri: u.toString(),
    ref_provider: 'web',
    // Mark the content untrusted so any reader (the assistant's get_row/list_rows)
    // wraps it in prompt-injection framing.
    source_json: JSON.stringify({
      origin: 'web_fetch',
      untrusted: true,
      final_url: crawled.url,
      fetched_at: new Date().toISOString(),
    }),
  };
  const { id } = await createRow(
    ctx.mctx,
    'files',
    { ...(await requiredFileDefaults(ctx.db, title, fileId, row)), ...row },
    ctx.privateMode ? 'private' : undefined,
  );

  let suggestedLinks: ClassifyMatch[] = [];
  if (ctx.enrich) {
    // untrusted: true — the fetched page may contain prompt-injection, so the
    // enrichment prompts treat its text strictly as data (see summarize.ts).
    suggestedLinks = await enrichWithLlm(
      ctx.mctx,
      ctx.db,
      id,
      text,
      title,
      ctx.enrich.fileJunctions,
      ctx.enrich.entityDescriptions,
      ctx.enrich.createJunction,
      ctx.enrich.aggressiveness,
      ctx.enrich.createEntity,
      true,
      ctx.privateMode === true,
    );
  }

  return {
    id,
    title,
    url: u.toString(),
    finalUrl: crawled.url,
    mime,
    byteLength: crawled.byteLength,
    charsExtracted: text.length,
    description,
    suggestedLinks,
  };
}
