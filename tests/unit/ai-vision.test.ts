import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeImage, type VisionSenderInput } from '../../src/ai/vision.js';

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
});
