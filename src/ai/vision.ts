import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import type { ClaudeAuth } from './llm-client.js';
import { DEFAULT_MODEL } from './llm-client.js';

/**
 * Media extraction with Claude: describe an image ({@link describeImage}, via
 * `sharp`) or read a PDF natively ({@link describePdf}, incl. scanned/image-only
 * PDFs that have no text layer). AI-gated — requires a {@link ClaudeAuth}. The
 * model calls are injectable (test seams), and `sharp` / `@anthropic-ai/sdk`
 * load lazily so importing this module costs nothing until a call runs.
 */

const DEFAULT_PROMPT =
  'Describe this image for a knowledge base in 2-4 factual sentences: what it ' +
  'shows, any visible text, and notable details. No preamble.';

/** Max pixel dimension Claude vision accepts efficiently. */
const MAX_DIM = 1568;

export interface VisionSenderInput {
  media_type: string;
  data: string; // base64
  prompt: string;
  model: string;
}

export interface VisionOptions {
  model?: string;
  prompt?: string;
  /** Cap on the normalized JPEG size (bytes). Default ~1.4 MB. */
  maxBytes?: number;
  /** Injectable model call (test seam). Defaults to a real Anthropic vision call. */
  sender?: (input: VisionSenderInput) => Promise<string>;
}

export async function describeImage(
  auth: ClaudeAuth,
  path: string,
  opts: VisionOptions = {},
): Promise<string> {
  const data = (await normalizeImage(path, opts.maxBytes ?? 1_400_000)).toString('base64');
  const sender = opts.sender ?? defaultSender(auth);
  const text = await sender({
    media_type: 'image/jpeg',
    data,
    prompt: opts.prompt ?? DEFAULT_PROMPT,
    model: opts.model ?? DEFAULT_MODEL,
  });
  return text.trim();
}

const DEFAULT_PDF_PROMPT =
  'Summarize this document for a knowledge base: a 2-4 sentence factual summary of ' +
  'what it is and its key details. Do NOT transcribe the full text — summary only. ' +
  'It may be a scanned/image-only PDF — read the text from the page images. No preamble.';

export interface PdfSenderInput {
  data: string; // base64 PDF
  prompt: string;
  model: string;
}

export interface PdfOptions {
  model?: string;
  prompt?: string;
  /** Max PDF size sent to the model (bytes). Default 30 MB (API limit ~32 MB). */
  maxBytes?: number;
  /** Injectable model call (test seam). Defaults to a real Anthropic document call. */
  sender?: (input: PdfSenderInput) => Promise<string>;
}

/**
 * Read a PDF with Claude's native document support — works on text PDFs AND
 * scanned/image-only PDFs (no text layer), where in-process text extraction
 * finds nothing. AI-gated; the model call is injectable for tests.
 */
export async function describePdf(
  auth: ClaudeAuth,
  path: string,
  opts: PdfOptions = {},
): Promise<string> {
  const buf = await readFile(path);
  const maxBytes = opts.maxBytes ?? 30_000_000;
  if (buf.length > maxBytes) {
    throw new Error(
      `PDF too large for a direct model read (${String(buf.length)} > ${String(maxBytes)} bytes)`,
    );
  }
  const sender = opts.sender ?? defaultPdfSender(auth);
  const text = await sender({
    data: buf.toString('base64'),
    prompt: opts.prompt ?? DEFAULT_PDF_PROMPT,
    model: opts.model ?? DEFAULT_MODEL,
  });
  return text.trim();
}

/**
 * Native image work is serialized process-wide. `sharp` is a native (libvips)
 * addon; running several JPEG pipelines at once inside the packaged desktop
 * runtime crashed the whole process during a bulk folder ingest (many images
 * normalized concurrently). Serializing just the native step removes the
 * concurrent native access — the model calls that follow each normalization
 * stay concurrent, so end-to-end throughput is essentially unchanged
 * (normalization is fast; the vision call dominates). A rejection never poisons
 * the next waiter.
 */
let nativeImageLock: Promise<unknown> = Promise.resolve();

function runExclusiveNative<T>(fn: () => Promise<T>): Promise<T> {
  const run = nativeImageLock.then(fn, fn);
  nativeImageLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function normalizeImage(path: string, maxBytes: number): Promise<Buffer> {
  return runExclusiveNative(async () => {
    const sharpMod = (await import('sharp')) as unknown as { default: SharpFactory };
    const sharp = sharpMod.default;
    // Also pin libvips' internal thread pool to one thread — belt-and-suspenders
    // against concurrent native work from a single pipeline.
    sharp.concurrency(1);
    let quality = 80;
    let buf = await renderJpeg(sharp, path, quality);
    while (buf.length > maxBytes && quality > 35) {
      quality -= 15;
      buf = await renderJpeg(sharp, path, quality);
    }
    return buf;
  });
}

type SharpFactory = ((input: string) => SharpPipeline) & { concurrency(threads: number): number };
interface SharpPipeline {
  rotate(): SharpPipeline;
  resize(opts: {
    width: number;
    height: number;
    fit: 'inside';
    withoutEnlargement: boolean;
  }): SharpPipeline;
  jpeg(opts: { quality: number }): SharpPipeline;
  toBuffer(): Promise<Buffer>;
}

function renderJpeg(sharp: SharpFactory, path: string, quality: number): Promise<Buffer> {
  return sharp(path)
    .rotate()
    .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
}

// ── Real vision call (lazy SDK) ──────────────────────────────────────────────

type VisionMessage = { content: { type: string; text?: string }[] };
interface AnthropicMessagesApi {
  messages: {
    create(params: Record<string, unknown>): Promise<VisionMessage>;
    // Streaming variant — MessageStream exposes finalMessage() for the resolved
    // message. Narrowed to what this module uses.
    stream(params: Record<string, unknown>): { finalMessage(): Promise<VisionMessage> };
  };
}
type AnthropicCtor = new (config: Record<string, unknown>) => AnthropicMessagesApi;

/**
 * Build the SDK constructor config from a {@link ClaudeAuth}. Exported as a pure
 * test seam. `apiKey` is ALWAYS set explicitly (to a key or to null) so the SDK
 * never falls back to its own `process.env.ANTHROPIC_API_KEY` default — which, on
 * the OAuth path, would add an `x-api-key` header alongside the Bearer token and
 * get the request rejected.
 */
export function buildVisionAnthropicConfig(auth: ClaudeAuth): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (auth.authToken) {
    config.authToken = auth.authToken;
    config.apiKey = null;
  } else if (auth.apiKey) {
    config.apiKey = auth.apiKey;
  } else {
    config.apiKey = null;
  }
  if (auth.betaHeader) config.defaultHeaders = { 'anthropic-beta': auth.betaHeader };
  return config;
}

function defaultSender(auth: ClaudeAuth): (input: VisionSenderInput) => Promise<string> {
  return async (input) => {
    const importMetaUrl = (import.meta as { url?: string }).url;
    const req = importMetaUrl ? createRequire(importMetaUrl) : require;
    const sdk = req('@anthropic-ai/sdk') as { Anthropic?: AnthropicCtor; default?: AnthropicCtor };
    const Anthropic = sdk.Anthropic ?? sdk.default;
    if (!Anthropic) throw new Error("Could not resolve Anthropic from '@anthropic-ai/sdk'");
    const client = new Anthropic(buildVisionAnthropicConfig(auth));
    // Stream: the only non-streaming vision leg. Streaming avoids the SDK's
    // long-request timeout on a slow model response and returns the same final
    // message via .finalMessage().
    const res = await client.messages
      .stream({
        model: input.model,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: input.media_type, data: input.data },
              },
              { type: 'text', text: input.prompt },
            ],
          },
        ],
      })
      .finalMessage();
    return res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  };
}

function defaultPdfSender(auth: ClaudeAuth): (input: PdfSenderInput) => Promise<string> {
  return async (input) => {
    const importMetaUrl = (import.meta as { url?: string }).url;
    const req = importMetaUrl ? createRequire(importMetaUrl) : require;
    const sdk = req('@anthropic-ai/sdk') as { Anthropic?: AnthropicCtor; default?: AnthropicCtor };
    const Anthropic = sdk.Anthropic ?? sdk.default;
    if (!Anthropic) throw new Error("Could not resolve Anthropic from '@anthropic-ai/sdk'");
    const client = new Anthropic(buildVisionAnthropicConfig(auth));
    // Stream (see the image sender): avoids the long-request timeout; same final
    // message via .finalMessage().
    const res = await client.messages
      .stream({
        model: input.model,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: input.data },
              },
              { type: 'text', text: input.prompt },
            ],
          },
        ],
      })
      .finalMessage();
    return res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  };
}
