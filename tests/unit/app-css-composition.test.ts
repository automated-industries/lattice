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
// Tables-explorer styles (model-tables.js segment). Step 4 adds the Outputs
// Tables-mirror tier styles + the Markdown detail slide-over (outputs.js segment).
// Recaptured.
// Ask Lattice polish: the floating panel becomes a depth-shadowed card offset
// further off the top-right corner, with class-based open/close transitions
// (animate in + out), replacing the [hidden]/keyframe approach (assistant-rail.js).
// Markdown rework: the Outputs detail panel slides in from the right positioned
// LEFT of the Outputs column (right: var(--outputs-width)) so the column stays
// visible, via class-based .open transitions (outputs.js style segment).
// Nav redesign: shared .col-header chrome for the three column headers (Inputs ·
// Model · Outputs — same font/style, per-column accent), the center tab strip
// restyled as seamless underline tabs sitting on the header's bottom border, and
// the now-dead .model-toggle/.model-view/.model-body styles removed (replaced by
// the .model-tables-view route container).
// Live-review polish batch: Tables-explorer lineage styles (selection highlight on
// tier cards + lineage chips + field-lineage rows + "+ Wire") replacing the dead
// Show-tier chips; dedicated nested Markdown-tree styles (.mdt-*); the Inputs
// column header pinned flush + full-width (aligned with Model/Outputs); a graph
// loading spinner (.graph-loading/.graph-spinner) shown until settled.
// Removed the dead CAVEATS styles (.mt-caveat*) and the dead provenance graph-mode
// styles (.pv-legend/.pv-sw/.pvnode-*/.btn.pv-active/.prov-fallback) now that the
// object page is a single table view.
// Added .fs-files-table path-column style for the Files object page / folder
// drill-in table view.
// Added .fs-rows-table styles (object page = rows table); kept .pv-table which it
// reuses.
// Added .pvchip-related / .pvchip-created chip colors for the new provenance tiers.
// Clickable-row cursor/hover for the object + Files rows tables (.fs-row-click).
// Connector/db drawer form fields + buttons restyled to the Ask Lattice composer
// aesthetic (.conn-field input/select fill + radius + accent focus; .conn-or
// divider; .conn-form-actions button polish).
// Tables-explorer relationship edges (svg.mt-edges + .mt-edge-fk/m2m), the tiers
// positioning context, and the wiring affordances (.mt-wire.on / .mt-wire-hint /
// .mt-wiring crosshair / .mt-wire-from highlight).
// Removed the dead object-graph CSS (#fsg-mount / .fsg-more / .ognode-*) that the
// removed focused-object-graph subsystem used.
// Record Formatted | Markdown toggle: .fs-view-toggle segmented control on the
// record view-header. Markdown-in-center: the Outputs slide-in drawer styles
// (.outputs-detail*) are removed in favor of a center .md-doc render (#/md/<path>).
const ORIGINAL_LENGTH = 113497;
const ORIGINAL_SHA256 = 'ede847aff92dddff99e4dd845174de3fbbcf2959e101c4dea7a91cdd4b328173';

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
