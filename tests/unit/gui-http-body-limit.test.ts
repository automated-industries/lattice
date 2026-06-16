import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { readJson, tryHandler, sendJson, BodyTooLargeError } from '../../src/gui/http.js';

/**
 * Regression — an oversized request body (e.g. a too-big workspace-logo upload)
 * used to make readJson call `req.destroy()`, RESETTING the socket. The browser's
 * fetch then rejected with an opaque "Failed to fetch" and the user saw no usable
 * reason. readJson must instead reject cleanly (HTTP 413) WITHOUT tearing down the
 * socket, so the route answers with a real, actionable error.
 */
function roundtrip(
  maxBytes: number,
  body: string,
): Promise<{ ok: boolean; status: number; json: { ok?: boolean; error?: string; got?: unknown } }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void tryHandler(res, async () => {
        const parsed = await readJson(req, { maxBytes });
        sendJson(res, { ok: true, got: parsed });
      });
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      fetch(`http://127.0.0.1:${String(port)}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
        .then(async (r) => {
          const json = (await r.json().catch(() => ({}))) as {
            ok?: boolean;
            error?: string;
            got?: unknown;
          };
          server.close(() => {
            resolve({ ok: true, status: r.status, json });
          });
        })
        .catch((e: unknown) => {
          // A reset socket (the OLD behavior) lands here — fetch rejected.
          server.close(() => {
            reject(e as Error);
          });
        });
    });
  });
}

describe('readJson body-size cap (workspace-logo "Failed to fetch" regression)', () => {
  it('BodyTooLargeError carries HTTP 413 + a clear, sized message', () => {
    const e = new BodyTooLargeError(64_000);
    expect(e.statusCode).toBe(413);
    expect(e.message).toMatch(/too large/i);
    expect(e.message).toContain('64000');
  });

  it('an oversized body yields a clean 413 JSON error — the fetch resolves, not resets', async () => {
    const big = JSON.stringify({ logo: 'x'.repeat(5000) });
    const { status, json } = await roundtrip(1000, big);
    expect(status).toBe(413); // a real response, NOT a connection reset
    expect(String(json.error)).toMatch(/too large/i);
  });

  it('a body under the cap parses and the handler runs normally', async () => {
    const { status, json } = await roundtrip(100_000, JSON.stringify({ logo: 'abc' }));
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect((json.got as { logo?: string }).logo).toBe('abc');
  });

  it('tryHandler defaults to 500 for an error with no statusCode', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const server = createServer((_req, res) => {
        void tryHandler(res, () => Promise.reject(new Error('boom')));
      });
      server.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        fetch(`http://127.0.0.1:${String(port)}/`, { method: 'POST', body: '{}' })
          .then((r) => {
            server.close(() => {
              resolve(r.status);
            });
          })
          .catch((e: unknown) => {
            server.close(() => {
              reject(e as Error);
            });
          });
      });
    });
    expect(status).toBe(500);
  });
});
