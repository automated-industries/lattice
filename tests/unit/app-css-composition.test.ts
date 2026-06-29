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
// 5.0 combines: the live force-graph renderer's hooks (edge stroke + arrowhead
// fill + a warm `.gnode-hot` search-highlight accent on the data-model segment;
// the now-unused brain-graph ingest keyframes removed since the live engine
// animates the delta itself) AND the data-provenance styles (per-tier node
// colors, the source table, the collapsed detail panel) plus the collapsible
// sidebar-group rules. Pinned length + hash recomputed for the merged CSS.
// (Bump: collapsible sidebar-group indentation fix — header gutter + body indent.)
// 5.0 GUI reframe (right-side): the docked assistant-rail styles become a floating
// "Ask Lattice" panel (assistant-rail.js segment repurposed); a new Outputs-column
// segment (outputs.js); header chrome for the activity-feed popover + the Ask Lattice
// trigger (topbar.js); the layout grid's third track + token rename to
// --outputs-width; reduced-motion + frosted-fallback selectors retargeted off the
// removed .assistant-rail. Step 3 adds the Model Graph|Tables toggle + the tiered
// Tables-explorer styles (model-tables.js segment). Recaptured.
const ORIGINAL_LENGTH = 107539;
const ORIGINAL_SHA256 = '8ad560ae9baaaac99e048a17aa24caa9ff3056efb304756286522e4f6a442859';

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
