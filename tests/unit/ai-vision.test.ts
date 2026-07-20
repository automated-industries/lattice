import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeImage,
  describePdf,
  buildVisionAnthropicConfig,
  type VisionSenderInput,
  type PdfSenderInput,
} from '../../src/ai/vision.js';

// A 1×1 transparent PNG.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('describeImage', () => {
  it('normalizes the image with sharp and returns the sender result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-vis-'));
    dirs.push(dir);
    const img = join(dir, 'pic.png');
    writeFileSync(img, PNG_1x1);

    let received: VisionSenderInput | null = null;
    const text = await describeImage({ apiKey: 'x' }, img, {
      sender: (input) => {
        received = input;
        return Promise.resolve('A tiny test image.');
      },
    });

    expect(text).toBe('A tiny test image.');
    expect(received).not.toBeNull();
    expect(received?.media_type).toBe('image/jpeg'); // sharp normalized PNG → JPEG
    expect((received?.data.length ?? 0) > 0).toBe(true); // base64 payload present
  });

  it('falls back to raw bytes with the original media type when normalization is unavailable/fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-vis-'));
    dirs.push(dir);
    // Bytes sharp cannot decode → normalizeImage throws → the raw-bytes fallback fires (the same
    // path that saves a hosted runtime where the native `sharp` addon isn't installed).
    const img = join(dir, 'weird.png');
    writeFileSync(img, Buffer.from('this is not a decodable image but is tagged image/png'));

    let received: VisionSenderInput | null = null;
    const text = await describeImage({ apiKey: 'x' }, img, {
      mediaType: 'image/png',
      sender: (input) => {
        received = input;
        return Promise.resolve('Fallback read.');
      },
    });
    expect(text).toBe('Fallback read.');
    expect(received?.media_type).toBe('image/png'); // raw fallback preserves the ORIGINAL type
  });

  it('surfaces a clear error (never silent) when neither normalization nor a raw fallback works', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-vis-'));
    dirs.push(dir);
    const img = join(dir, 'weird.svg');
    writeFileSync(img, Buffer.from('<svg/> not decodable'));
    // image/svg+xml is NOT a directly-supported vision type → no raw fallback → a thrown error the
    // caller logs (rather than a silent empty result that reads as "no source text").
    await expect(
      describeImage({ apiKey: 'x' }, img, { mediaType: 'image/svg+xml', sender: () => Promise.resolve('x') }),
    ).rejects.toThrow(/could not prepare image for vision/i);
  });
});

describe('buildVisionAnthropicConfig', () => {
  it('honors a custom baseURL so vision reaches the same host as chat (proxy / BYO custom host)', () => {
    expect(buildVisionAnthropicConfig({ apiKey: 'k', baseURL: 'https://proxy.example/v1' }).baseURL).toBe(
      'https://proxy.example/v1',
    );
    expect(buildVisionAnthropicConfig({ apiKey: 'k' }).baseURL).toBeUndefined();
  });
});

describe('describePdf', () => {
  it('base64-encodes the PDF and returns the sender result (no SDK/sharp needed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-pdf-'));
    dirs.push(dir);
    const pdf = join(dir, 'doc.pdf');
    const bytes = Buffer.from('%PDF-1.4 fake');
    writeFileSync(pdf, bytes);

    let received: PdfSenderInput | null = null;
    const text = await describePdf({ apiKey: 'x' }, pdf, {
      sender: (input) => {
        received = input;
        return Promise.resolve('Invoice INV-SA-003, amount due $1,200.');
      },
    });

    expect(text).toBe('Invoice INV-SA-003, amount due $1,200.');
    expect(received?.data).toBe(bytes.toString('base64'));
  });

  it('rejects a PDF larger than the byte cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-pdf-'));
    dirs.push(dir);
    const pdf = join(dir, 'big.pdf');
    writeFileSync(pdf, Buffer.alloc(1024));
    await expect(
      describePdf({ apiKey: 'x' }, pdf, { maxBytes: 100, sender: () => Promise.resolve('x') }),
    ).rejects.toThrow(/too large/);
  });
});
