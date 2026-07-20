import { describe, it, expect } from 'vitest';
import { createServer, request } from 'node:http';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { sendHtmlCompressed, pickEncoding } from '../../src/gui/http.js';

/**
 * The GUI shell inlines the whole ~1 MB client bundle. sendHtmlCompressed
 * negotiates brotli/gzip so a real browser transfers a fraction of that, while
 * staying `no-store` (the shell is version-gated). These pin the negotiation,
 * decompression integrity, and that it actually shrinks the payload.
 */
function roundtrip(
  html: string,
  acceptEncoding: string,
): Promise<{ status: number; encoding: string | null; body: string; wireBytes: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      sendHtmlCompressed(req, res, html);
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      const clientReq = request(
        { host: '127.0.0.1', port, path: '/', headers: { 'accept-encoding': acceptEncoding } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => {
            chunks.push(c);
          });
          res.on('end', () => {
            const raw = Buffer.concat(chunks);
            const enc = res.headers['content-encoding'] ?? null;
            const body =
              enc === 'br'
                ? brotliDecompressSync(raw).toString('utf8')
                : enc === 'gzip'
                  ? gunzipSync(raw).toString('utf8')
                  : raw.toString('utf8');
            server.close(() => {
              resolve({ status: res.statusCode ?? 0, encoding: enc, body, wireBytes: raw.length });
            });
          });
        },
      );
      clientReq.on('error', (e) => {
        server.close(() => {
          reject(e);
        });
      });
      clientReq.end();
    });
  });
}

describe('sendHtmlCompressed', () => {
  const HTML = '<!doctype html><html>' + 'lattice '.repeat(3000) + '</html>';

  it('brotli-compresses when br is accepted, decompressing byte-identical', async () => {
    const { status, encoding, body, wireBytes } = await roundtrip(HTML, 'gzip, deflate, br');
    expect(status).toBe(200);
    expect(encoding).toBe('br');
    expect(body).toBe(HTML);
    expect(wireBytes).toBeLessThan(Buffer.byteLength(HTML) / 2); // real shrink
  });

  it('gzip-compresses when only gzip is accepted', async () => {
    const { encoding, body } = await roundtrip(HTML, 'gzip');
    expect(encoding).toBe('gzip');
    expect(body).toBe(HTML);
  });

  it('serves identity when no supported encoding is accepted', async () => {
    const { encoding, body } = await roundtrip(HTML, 'identity');
    expect(encoding).toBeNull();
    expect(body).toBe(HTML);
  });
});

describe('pickEncoding', () => {
  it('prefers brotli', () => {
    expect(pickEncoding('gzip, deflate, br')).toBe('br');
  });
  it('falls back to gzip', () => {
    expect(pickEncoding('gzip, deflate')).toBe('gzip');
  });
  it('is null for identity-only', () => {
    expect(pickEncoding('identity')).toBeNull();
  });
  it('is null when absent', () => {
    expect(pickEncoding(undefined)).toBeNull();
  });
  it('normalizes an array-valued header', () => {
    expect(pickEncoding(['gzip', 'br'])).toBe('br');
  });
});
