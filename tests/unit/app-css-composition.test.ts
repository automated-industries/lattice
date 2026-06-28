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
// Most recently: the data-provenance styles (per-tier node colors, the source
// table, the collapsed detail panel) plus the collapsible sidebar-group rules.
const ORIGINAL_LENGTH = 96623;
const ORIGINAL_SHA256 = '98bbad05ac38f00c43a220151680e86a3f687fff53702ba2b460c45caac79088';

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
