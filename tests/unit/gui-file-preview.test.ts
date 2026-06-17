import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { guiAppHtml } from '../../src/gui/app.js';

/**
 * #J/#K — file view preview + action buttons. Logic pulled verbatim from the
 * shipped client and executed:
 *  - isImageFile detects by mime AND (fallback) by extension, so an upload that
 *    didn't record a mime still previews inline (the #J "image not displaying").
 *  - fileActions decides the action affordances (#K): a file rendered inline
 *    (image / PDF) needs neither; any other file WITH bytes is downloadable so
 *    the underlying file is always reachable (office docs, audio, video, an
 *    S3-only file); local bytes additionally open in Finder when local-open is on.
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
  ['isImageFile', 'hasLocalFile', 'hasViewableFile', 'hasLocalBytes', 'isS3File', 'fileActions']
    .map((n) => extractFn(guiAppHtml, n))
    .join('\n');
const api = runInNewContext(
  code + '\n({ isImageFile, hasLocalBytes, isS3File, fileActions });',
  {},
  { filename: 'gui-file.js' },
) as {
  isImageFile: (r: unknown) => boolean;
  hasLocalBytes: (r: unknown) => boolean;
  isS3File: (r: unknown) => boolean;
  fileActions: (
    r: unknown,
    localOpenOn: boolean,
  ) => { inline: boolean; open: boolean; download: boolean };
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

describe('#K local vs S3 byte-source primitives', () => {
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
  it('an S3 file the uploader also has locally is both local and S3', () => {
    expect(api.hasLocalBytes(s3WithLocal)).toBe(true);
    expect(api.isS3File(s3WithLocal)).toBe(true);
  });
});

describe('#K2 fileActions — the underlying file is always reachable', () => {
  const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const localDoc = {
    ref_kind: 'blob',
    blob_path: '/data/blobs/x',
    mime: PPTX,
    original_name: 'deck.pptx',
  };
  const localImg = { ref_kind: 'blob', blob_path: '/data/blobs/y', mime: 'image/png' };
  const s3Doc = { ref_kind: 'cloud_ref', ref_provider: 's3', ref_uri: 's3://b/k', mime: PPTX };
  const s3Img = {
    ref_kind: 'cloud_ref',
    ref_provider: 's3',
    ref_uri: 's3://b/i',
    mime: 'image/png',
  };
  const textOnly = { mime: PPTX, extracted_text: 'slide text', original_name: 'gone.pptx' };

  it('a local document is downloadable, and opens in Finder when local-open is on (the bug fix)', () => {
    const on = api.fileActions(localDoc, true);
    expect(on).toEqual({ inline: false, open: true, download: true });
    // Even with Open-in-Finder unavailable, the file is still reachable via Download.
    const off = api.fileActions(localDoc, false);
    expect(off).toEqual({ inline: false, open: false, download: true });
  });

  it('a local image renders inline → no separate download (open in Finder only)', () => {
    expect(api.fileActions(localImg, true)).toEqual({ inline: true, open: true, download: false });
  });

  it('an S3-only document is downloadable (no local bytes to open)', () => {
    expect(api.fileActions(s3Doc, true)).toEqual({ inline: false, open: false, download: true });
  });

  it('an S3-only image keeps its download (unchanged from before)', () => {
    expect(api.fileActions(s3Img, true)).toEqual({ inline: true, open: false, download: true });
  });

  it('a text-only file with no retained bytes offers nothing to fetch', () => {
    expect(api.fileActions(textOnly, true)).toEqual({
      inline: false,
      open: false,
      download: false,
    });
  });
});
