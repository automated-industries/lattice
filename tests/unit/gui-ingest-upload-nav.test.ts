/**
 * B3 — after a single-file ingest the new record opens automatically (the dedup
 * survivor if it was a duplicate); a multi-file drop does not navigate. Logic
 * pulled verbatim from the shipped client `uploadFiles` and executed with stubbed
 * `uploadFile` / `openSearchHit` / `gaTrack`.
 */
import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { guiAppHtml } from '../../src/gui/app.js';

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

function makeApi(uploadResult: Record<string, unknown>): {
  uploadFiles: (files: { name: string }[]) => void;
  calls: { openSearchHit: [string, string][]; uploadFile: number };
} {
  const calls: { openSearchHit: [string, string][]; uploadFile: number } = {
    openSearchHit: [],
    uploadFile: 0,
  };
  const ctx = {
    gaTrack: () => undefined,
    openSearchHit: (table: string, id: string) => calls.openSearchHit.push([table, id]),
    uploadFile: () => {
      calls.uploadFile++;
      return Promise.resolve(uploadResult);
    },
    // Multi-file path deps. The progress bar is DOM-bound, so stub it; the
    // batch runner is exercised for real (extracted below) so the test still
    // verifies every file is uploaded.
    INGEST_MAX_CONCURRENCY: 3,
    ingestProgress: () => ({ update: () => undefined, done: () => undefined }),
  };
  const code =
    extractFn(guiAppHtml, 'runIngestBatch') +
    '\n' +
    extractFn(guiAppHtml, 'uploadFiles') +
    '\n({ uploadFiles });';
  const api = runInNewContext(code, ctx, { filename: 'uploadFiles.js' }) as {
    uploadFiles: (files: { name: string }[]) => void;
  };
  return { uploadFiles: api.uploadFiles, calls };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('uploadFiles single-file navigation (B3)', () => {
  it('opens the new record after a single-file ingest', async () => {
    const { uploadFiles, calls } = makeApi({ id: 'f1' });
    uploadFiles([{ name: 'a.pdf' }]);
    await flush();
    expect(calls.openSearchHit).toEqual([['files', 'f1']]);
  });

  it('opens the dedup survivor when the single upload was a duplicate', async () => {
    const { uploadFiles, calls } = makeApi({ id: 'f2', duplicateOf: 'orig' });
    uploadFiles([{ name: 'a.pdf' }]);
    await flush();
    expect(calls.openSearchHit).toEqual([['files', 'orig']]);
  });

  it('does NOT navigate on a multi-file drop', async () => {
    const { uploadFiles, calls } = makeApi({ id: 'f3' });
    uploadFiles([{ name: 'a.pdf' }, { name: 'b.pdf' }]);
    await flush();
    expect(calls.openSearchHit).toEqual([]);
    expect(calls.uploadFile).toBe(2);
  });
});
