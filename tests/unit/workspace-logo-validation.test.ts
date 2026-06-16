import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { parseAndValidateLogo } from '../../src/gui/dbconfig-routes.js';

/** Synthetic PNG: 8-byte signature + a fake IHDR carrying width@16 / height@20. */
function pngBytes(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.writeUInt32BE(0x0000000d, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function pngUri(w: number, h: number): string {
  return 'data:image/png;base64,' + pngBytes(w, h).toString('base64');
}
/** Synthetic JPEG: SOI + a single SOF0 segment carrying the dimensions. */
function jpegBytes(w: number, h: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8, // SOI
    0xff,
    0xc0, // SOF0
    0x00,
    0x11, // segment length (17)
    0x08, // precision
    (h >> 8) & 0xff,
    h & 0xff, // height
    (w >> 8) & 0xff,
    w & 0xff, // width
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01, // 3 components
    0xff,
    0xd9, // EOI
  ]);
}
function jpegUri(w: number, h: number): string {
  return 'data:image/jpeg;base64,' + jpegBytes(w, h).toString('base64');
}

describe('parseAndValidateLogo', () => {
  it('accepts a square PNG and returns the content sha256 as the etag', () => {
    const r = parseAndValidateLogo(pngUri(64, 64));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mime).toBe('image/png');
      expect(r.etag).toBe(createHash('sha256').update(pngBytes(64, 64)).digest('hex'));
    }
  });

  it('accepts a square JPEG', () => {
    const r = parseAndValidateLogo(jpegUri(48, 48));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mime).toBe('image/jpeg');
  });

  it('rejects a non-square PNG with a clear error (no silent crop)', () => {
    const r = parseAndValidateLogo(pngUri(64, 32));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/square/i);
  });

  it('rejects a non-data: string', () => {
    expect(parseAndValidateLogo('hello').ok).toBe(false);
    expect(parseAndValidateLogo('https://example.com/logo.png').ok).toBe(false);
  });

  it('rejects SVG and text/html data URIs (stored-XSS guard)', () => {
    expect(parseAndValidateLogo('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=').ok).toBe(false);
    expect(parseAndValidateLogo('data:text/html;base64,PGgxPmhpPC9oMT4=').ok).toBe(false);
  });

  it('rejects a MIME/magic mismatch (declared PNG, actually JPEG bytes)', () => {
    const lie = 'data:image/png;base64,' + jpegBytes(32, 32).toString('base64');
    const r = parseAndValidateLogo(lie);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/match|image type/i);
  });

  it('rejects an oversized image (> 64 KB decoded)', () => {
    // A valid PNG header followed by enough padding to exceed the cap.
    const big = Buffer.concat([pngBytes(64, 64), Buffer.alloc(70_000)]);
    const r = parseAndValidateLogo('data:image/png;base64,' + big.toString('base64'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too large/i);
  });

  it('rejects an empty / non-string input', () => {
    expect(parseAndValidateLogo('').ok).toBe(false);
    expect(parseAndValidateLogo(undefined).ok).toBe(false);
    expect(parseAndValidateLogo(123).ok).toBe(false);
  });
});
