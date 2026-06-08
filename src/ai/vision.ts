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
  'Read this document for a knowledge base. First transcribe its readable text, ' +
  'then add a 2-4 sentence factual summary of what it is and its key details. ' +
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
 * scanned/image-only PDFs (no text layer), which `markitdown` cannot extract.
 * AI-gated; the model call is injectable for tests.
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

async function normalizeImage(path: string, maxBytes: number): Promise<Buffer> {
  const sharpMod = (await import('sharp')) as unknown as { default: SharpFactory };
  const sharp = sharpMod.default;
  let quality = 80;
  let buf = await renderJpeg(sharp, path, quality);
  while (buf.length > maxBytes && quality > 35) {
    quality -= 15;
    buf = await renderJpeg(sharp, path, quality);
  }
  return buf;
}

type SharpFactory = (input: string) => SharpPipeline;
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

interface AnthropicMessagesApi {
  messages: {
    create(
      params: Record<string, unknown>,
    ): Promise<{ content: { type: string; text?: string }[] }>;
  };
}
type AnthropicCtor = new (config: Record<string, unknown>) => AnthropicMessagesApi;

function defaultSender(auth: ClaudeAuth): (input: VisionSenderInput) => Promise<string> {
  return async (input) => {
    const importMetaUrl = (import.meta as { url?: string }).url;
    const req = importMetaUrl ? createRequire(importMetaUrl) : require;
    const sdk = req('@anthropic-ai/sdk') as { Anthropic?: AnthropicCtor; default?: AnthropicCtor };
    const Anthropic = sdk.Anthropic ?? sdk.default;
    if (!Anthropic) throw new Error("Could not resolve Anthropic from '@anthropic-ai/sdk'");
    const config: Record<string, unknown> = {};
    if (auth.authToken) config.authToken = auth.authToken;
    else if (auth.apiKey) config.apiKey = auth.apiKey;
    if (auth.betaHeader) config.defaultHeaders = { 'anthropic-beta': auth.betaHeader };
    const client = new Anthropic(config);
    const res = await client.messages.create({
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
    });
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
    const config: Record<string, unknown> = {};
    if (auth.authToken) config.authToken = auth.authToken;
    else if (auth.apiKey) config.apiKey = auth.apiKey;
    if (auth.betaHeader) config.defaultHeaders = { 'anthropic-beta': auth.betaHeader };
    const client = new Anthropic(config);
    const res = await client.messages.create({
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
    });
    return res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  };
}
