import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { css } from '../../src/gui/app/css.js';

// `src/gui/app/css.ts` (a single ~1410-line template literal) was split into
// per-section segments under `src/gui/app/styles/`, composed back into `css`
// in the original order via `styles/index.ts`. The split is a pure source-
// organization refactor: the composed string MUST equal the original byte-for-byte,
// which is what proves the inlined `<style>${css}</style>` is unchanged.
//
// These constants were captured from the pre-split `css` value. If `css` is
// ever changed intentionally, recapture the length + hash and update them here.
// Most recently: the 4.3 inline-HTML-file styles (a taller `.html-frame` for a
// live HTML file plus its `.html-badge`) in the file-preview segment.
const ORIGINAL_LENGTH = 82702;
const ORIGINAL_SHA256 = '6e15421a4b4707fc61523d7c1a201c8eb8ea6cb3e7bcbf2c0499302951271e29';

describe('css composition', () => {
  it('matches the original length exactly', () => {
    expect(css.length).toBe(ORIGINAL_LENGTH);
  });

  it('matches the original sha256 exactly (byte-identical)', () => {
    const hash = createHash('sha256').update(css).digest('hex');
    expect(hash).toBe(ORIGINAL_SHA256);
  });
});
