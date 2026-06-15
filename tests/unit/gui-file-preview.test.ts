import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { guiAppHtml } from '../../src/gui/app.js';

/**
 * #J/#K — file view preview + action buttons. Logic pulled verbatim from the
 * shipped client and executed:
 *  - isImageFile detects by mime AND (fallback) by extension, so an upload that
 *    didn't record a mime still previews inline (the #J "image not displaying").
 *  - Open-in-Finder vs Download are mutually exclusive (#K): local bytes → open;
 *    S3-only (no local copy) → download; never both.
 */
function extractFn(src: string, name: string): string {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let depth = 0;
  let k = src.indexOf('{', i);
  for (; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) {
      k++;
      break;
    }
  }
  return src.slice(i, k);
}

// isImageFile references the module-level IMAGE_EXTS list — pull that line in too.
const imageExts = /var IMAGE_EXTS = \[[^\]]*\];/.exec(guiAppHtml)?.[0] ?? '';
const code =
  imageExts +
  '\n' +
  ['isImageFile', 'hasLocalBytes', 'isS3File'].map((n) => extractFn(guiAppHtml, n)).join('\n');
const api = runInNewContext(
  code + '\n({ isImageFile, hasLocalBytes, isS3File });',
  {},
  { filename: 'gui-file.js' },
) as {
  isImageFile: (r: unknown) => boolean;
  hasLocalBytes: (r: unknown) => boolean;
  isS3File: (r: unknown) => boolean;
};

describe('#J isImageFile — mime OR extension', () => {
  it('detects by image mime', () => {
    expect(api.isImageFile({ mime: 'image/png', original_name: 'x' })).toBe(true);
  });
  it('falls back to the filename extension when mime is missing (the #J bug)', () => {
    expect(api.isImageFile({ mime: '', original_name: 'Screenshot.PNG' })).toBe(true);
    expect(api.isImageFile({ original_name: 'photo.jpeg' })).toBe(true);
  });
  it('is false for non-images', () => {
    expect(api.isImageFile({ mime: 'application/pdf', original_name: 'a.pdf' })).toBe(false);
    expect(api.isImageFile({ original_name: 'notes.txt' })).toBe(false);
  });
});

describe('#K Open-in-Finder vs Download are mutually exclusive', () => {
  const local = { ref_kind: 'blob', blob_path: '/data/blobs/x' };
  const s3only = { ref_kind: 'cloud_ref', ref_provider: 's3', ref_uri: 's3://b/k' };
  const s3WithLocal = { ref_kind: 'cloud_ref', ref_provider: 's3', blob_path: '/data/blobs/x' };
  it('a local blob has local bytes and is not S3-download', () => {
    expect(api.hasLocalBytes(local)).toBe(true);
    expect(api.isS3File(local)).toBe(false);
  });
  it('an S3-only file has no local bytes → download path', () => {
    expect(api.hasLocalBytes(s3only)).toBe(false);
    expect(api.isS3File(s3only)).toBe(true);
  });
  it('an S3 file the uploader also has locally prefers local (open in finder)', () => {
    expect(api.hasLocalBytes(s3WithLocal)).toBe(true); // → Open in Finder, not Download
    expect(api.isS3File(s3WithLocal)).toBe(true);
  });
});
