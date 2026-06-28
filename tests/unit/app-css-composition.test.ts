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
// Most recently: the live force-graph renderer's hooks — edge stroke + arrowhead
// fill (the renderer no longer inlines them) and a warm `.gnode-hot` search-
// highlight accent — added to the data-model segment.
const ORIGINAL_LENGTH = 93313;
const ORIGINAL_SHA256 = 'a6c8462cd866da181c353e0a81c7579dd19f611377305d8b875cd7bf069bd7e2';

describe('css composition', () => {
  // Normalize line endings before pinning so a CRLF (Windows) checkout doesn't
  // change the byte length/hash — the inlined stylesheet's meaning is unchanged.
  const normalized = css.replace(/\r\n/g, '\n');
  it('matches the original length exactly', () => {
    expect(normalized.length).toBe(ORIGINAL_LENGTH);
  });

  it('matches the original sha256 exactly (byte-identical)', () => {
    const hash = createHash('sha256').update(normalized).digest('hex');
    expect(hash).toBe(ORIGINAL_SHA256);
  });
});
