import type { IncomingMessage, ServerResponse } from 'node:http';

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
  });
  res.end(JSON.stringify(body));
}

/** Default request-body cap (1 MB). Endpoints that accept larger payloads pass
 *  an explicit `maxBytes` (ingest uploads 10 MB, chat history 2 MB). */
export const DEFAULT_BODY_MAX_BYTES = 1_000_000;

/**
 * Read and JSON-parse a request body. Caps the body at `maxBytes` (destroying
 * the socket on overflow), resolves `{}` for an empty body, and rejects on
 * invalid JSON. Defaults to `Record<string, unknown>`; pass a type argument for
 * a different shape (callers that validate the result may use `unknown`).
 */
export function readJson<T = Record<string, unknown>>(
  req: IncomingMessage,
  opts: { maxBytes?: number } = {},
): Promise<T> {
  const maxBytes = opts.maxBytes ?? DEFAULT_BODY_MAX_BYTES;
  return new Promise<T>((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > maxBytes) req.destroy(new Error('Request body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as T) : ({} as T));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Run an async handler, converting any thrown error into a 500 JSON response. */
export async function tryHandler(res: ServerResponse, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    sendJson(res, { error: (e as Error).message }, 500);
  }
}
