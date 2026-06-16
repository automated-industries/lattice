import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { contentDispositionInline } from '../../src/gui/files-routes.js';

// macOS screenshot names carry a U+202F NARROW NO-BREAK SPACE before the AM/PM
// marker (e.g. "Screenshot 2026-06-14 at 7.09.23<U+202F>PM.png"). That code point
// is outside ISO-8859-1, so putting it raw in a content-disposition header made
// res.writeHead throw ERR_INVALID_CHAR -> the blob serve 500'd and the image
// never loaded. contentDispositionInline must emit an ISO-8859-1-safe header.
const NARROW = String.fromCharCode(0x202f);
const SCREENSHOT = `Screenshot 2026-06-14 at 7.09.23${NARROW}PM.png`;

describe('contentDispositionInline', () => {
  it('keeps a plain ASCII filename intact', () => {
    expect(contentDispositionInline('report.pdf')).toBe(
      'inline; filename="report.pdf"; filename*=UTF-8\'\'report.pdf',
    );
  });

  it('produces an ISO-8859-1-safe header for a non-Latin-1 filename', () => {
    const header = contentDispositionInline(SCREENSHOT);
    // Every char must be ISO-8859-1 (<= 0xFF) — the invariant res.writeHead
    // enforces and that the raw name violated.
    for (const ch of header) expect(ch.codePointAt(0)).toBeLessThanOrEqual(0xff);
    // The non-Latin-1 char is dropped from the ASCII fallback but preserved
    // (percent-encoded) in the RFC 5987 filename*.
    expect(header).toContain("filename*=UTF-8''" + encodeURIComponent(SCREENSHOT));
    expect(header).not.toContain(NARROW);
  });

  it('a real ServerResponse.writeHead accepts the encoded header (regression)', async () => {
    await new Promise<void>((resolve, reject) => {
      const server = createServer((_req, res) => {
        try {
          // Before the fix this threw TypeError [ERR_INVALID_CHAR].
          res.writeHead(200, { 'content-disposition': contentDispositionInline(SCREENSHOT) });
          res.end('ok');
        } catch (e) {
          reject(e as Error);
        }
      });
      server.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        fetch(`http://127.0.0.1:${String(port)}/`)
          .then((r) => {
            expect(r.status).toBe(200);
            server.close(() => {
              resolve();
            });
          })
          .catch((e: unknown) => {
            server.close(() => {
              reject(e as Error);
            });
          });
      });
    });
  });
});
