import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';

/**
 * Shared HTTP helpers for the GUI route modules. These were copy-pasted across
 * eight `*-routes.ts` files (and the server) with drifting body-size caps and
 * error messages; this is the single source of truth.
 */

/** Write a JSON response with no-store caching. */
export function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // A JSON API response must never be framed OR read cross-window. Defense in depth against
    // DNS-rebinding data exfiltration: frame-ancestors/XFO stop an iframe embedding it, and COOP
    // severs the opener↔popup relationship so a `window.open(...)` cannot retain a readable handle
    // to the response either. (Belt to the GET same-origin/bound-Host guard's suspenders.)
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'",
    'cross-origin-opener-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

// Large static bodies (the GUI shell; the lazily-loaded chart lib) are compressed
// ONCE and cached by content, so Accept-Encoding negotiation is a Map lookup, never
// a per-request compress on a hot path. Keyed by the body string; a handful of
// distinct bodies, so the Map stays tiny.
const _compressCache = new Map<string, { identity: Buffer; gzip: Buffer; br: Buffer }>();

function compressedVariants(body: string): { identity: Buffer; gzip: Buffer; br: Buffer } {
  let v = _compressCache.get(body);
  if (!v) {
    const identity = Buffer.from(body, 'utf8');
    v = {
      identity,
      gzip: gzipSync(identity),
      br: brotliCompressSync(identity, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }),
    };
    _compressCache.set(body, v);
  }
  return v;
}

/** Which content-encoding a client accepts, in our preference order (br > gzip). */
export function pickEncoding(acceptEncoding: string | string[] | undefined): 'br' | 'gzip' | null {
  const ae = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : (acceptEncoding ?? '');
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return null;
}

/**
 * Serve a static body with Accept-Encoding negotiation (brotli/gzip/identity), a
 * `Vary` header, and the given content-type + cache-control. Compression is cached
 * per body.
 */
export function sendCompressed(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  contentType: string,
  cacheControl = 'no-store',
): void {
  const v = compressedVariants(body);
  const encoding = pickEncoding(req.headers['accept-encoding']);
  const out = encoding === 'br' ? v.br : encoding === 'gzip' ? v.gzip : v.identity;
  const headers: Record<string, string> = {
    'content-type': contentType,
    'cache-control': cacheControl,
    vary: 'accept-encoding',
  };
  if (encoding) headers['content-encoding'] = encoding;
  res.writeHead(200, headers);
  res.end(out);
}

/**
 * Serve the GUI shell HTML: `no-store` (version-gated, never cached) + compression.
 * Compressing the inlined bundle cuts the shell transfer ~5× for any real browser.
 */
export function sendHtmlCompressed(req: IncomingMessage, res: ServerResponse, html: string): void {
  sendCompressed(req, res, html, 'text/html; charset=utf-8', 'no-store');
}

/** Default request-body cap (1 MB). Endpoints that accept larger payloads pass
 *  an explicit `maxBytes` (ingest uploads 10 MB, chat history 2 MB). */
export const DEFAULT_BODY_MAX_BYTES = 1_000_000;

/** Max bytes Lattice will read for a structured-source ingest/import (50 MB). The
 *  cap is enforced both on the streaming upload and again when the import-apply
 *  route re-reads the retained bytes, so an oversized source can't exhaust memory
 *  regardless of how the file got onto disk. */
export const MAX_INGEST_BYTES = 50_000_000;

/** Max rows a single bounded list read returns — `limit` is clamped to this so no
 *  one request can read an unbounded slice of a table (bounded reads). */
export const MAX_ROWS_PAGE = 1000;
/** Page size used when a request omits `limit`. */
export const DEFAULT_ROWS_PAGE = 500;

/**
 * Parse + validate a `limit`/`offset` query param. Returns the numeric value, or
 * `'invalid'` for a non-numeric / negative / non-integer string — the caller
 * returns 400 instead of letting `Number('abc')` become `LIMIT NaN`. `limit` is
 * clamped to `[1, MAX_ROWS_PAGE]` (so a client can never request an unbounded
 * read); `offset` is floored at 0. Single source of truth for every paged read.
 */
export function parsePageParam(raw: string | null, kind: 'limit' | 'offset'): number | 'invalid' {
  if (raw === null) return kind === 'limit' ? DEFAULT_ROWS_PAGE : 0;
  if (!/^\d+$/.test(raw.trim())) return 'invalid';
  const n = Number(raw);
  if (!Number.isFinite(n)) return 'invalid';
  if (kind === 'limit') return Math.min(Math.max(1, n), MAX_ROWS_PAGE);
  return Math.max(0, n);
}

/**
 * Thrown by {@link readJson} when the body exceeds the cap. Carries HTTP 413 so
 * {@link tryHandler} returns a real "Payload Too Large" response. Previously the
 * reader called `req.destroy()` on overflow, RESETTING the socket — which the
 * browser's `fetch` surfaces as an opaque "Failed to fetch" with no actionable
 * message (e.g. a too-big workspace-logo upload). Rejecting cleanly while leaving
 * the socket alive lets the route answer with the real reason — fail loudly and
 * visibly, never with a silent connection reset.
 */
export class BodyTooLargeError extends Error {
  readonly statusCode = 413;
  constructor(maxBytes: number) {
    super(`Request body too large (max ${String(maxBytes)} bytes)`);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Read and JSON-parse a request body. Caps the body at `maxBytes` — on overflow
 * it REJECTS with a {@link BodyTooLargeError} (HTTP 413) and stops buffering, but
 * keeps draining the request so the socket stays alive and the route can send the
 * error response (a destroyed socket becomes a browser "Failed to fetch"). Resolves
 * `{}` for an empty body and rejects on invalid JSON. Defaults to
 * `Record<string, unknown>`; pass a type argument for a different shape.
 */
export function readJson<T = Record<string, unknown>>(
  req: IncomingMessage,
  opts: { maxBytes?: number } = {},
): Promise<T> {
  const maxBytes = opts.maxBytes ?? DEFAULT_BODY_MAX_BYTES;
  return new Promise<T>((resolve, reject) => {
    let raw = '';
    let overflowed = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (overflowed) return; // keep draining so 'end' fires; do NOT reset the socket
      raw += chunk;
      if (raw.length > maxBytes) {
        overflowed = true;
        raw = ''; // free the buffered prefix
        reject(new BodyTooLargeError(maxBytes));
      }
    });
    req.on('end', () => {
      if (overflowed) return; // already rejected; never resolve too
      try {
        resolve(raw ? (JSON.parse(raw) as T) : ({} as T));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Run an async handler, converting any thrown error into a 500 JSON response.
 *  #4.11 — the error is also LOGGED server-side (message + stack) before the 500
 *  goes out. Previously a thrown cloud-op failure became a bare generic 500 with
 *  no server-side trace, so the real cause was invisible to whoever ran the GUI
 *  (Rule: no silent failures). The label defaults but a caller can pass a more
 *  specific one (e.g. the route) for sharper logs. */
export async function tryHandler(
  res: ServerResponse,
  fn: () => Promise<void>,
  label = 'request',
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const err = e as Error & { statusCode?: number };
    // Honor a status the error carries (e.g. BodyTooLargeError → 413); default to
    // 500. A 4xx is a client/request problem, not a server fault — log it quietly
    // without a stack; keep the full stack for genuine 5xx faults (#4.11).
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 500) console.error(`[gui] ${label} failed: ${err.message}\n${err.stack ?? ''}`);
    else console.warn(`[gui] ${label}: ${err.message}`);
    sendJson(res, { error: err.message }, status);
  }
}
