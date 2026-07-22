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
// Rows-table pager: .rows-pager / .rows-pager-info + pager button sizing.
// Tables-explorer edges restyled: solid strokes (m2m dash removed), svg.mt-edges
// raised above the cards (z-index 2), stroke-width + opacity bumped for visibility.
// Tables-explorer Wire/Merge: a warm-accent "Merge" toggle button, plus
// .mt-card-disabled (greyed/undroppable invalid targets) and .mt-drag-active (the
// card being dragged) states.
// Record Markdown view: .fs-context-edit (the editable raw-markdown textarea) +
// .fs-context-status (its inline save status).
// Review batch A2: .mt-card gets touch-action:none so a touch drag-to-wire/merge
// doesn't scroll the page mid-gesture.
// 5.0 webview drag-hardening: .mt-card ALSO gets user-select:none (matching
// .fs-tile) so a drag can't start a native text-selection that steals the pointer
// stream and freezes the ghost. Plus the assistant persona: .chat-msg.assistant
// gets a ::before avatar (the older-woman emoji) so replies read as coming from
// Gladys. Length + hash recaptured.
// 5.0 drag fix — .wm-ghost is position:fixed !important so it beats .fs-tile's
// position:relative (equal specificity), and the ghost is appended to <body>; both
// ensure the drag clone anchors to the cursor instead of being offset ~100px.
// 5.0 GUI batch — the file-drag overlay is now a whole-window .file-drop-overlay
// (replacing the Gladys-panel outline). Length + hash recaptured.
// 5.0 GUI batch 2 — workspace-switch fade overlay (.ws-switch-overlay in layout),
// and the Tables-explorer consumer-chip remove-✕ styles (.mt-lin-chip-wrap /
// .mt-lin-x / .mt-lin-x-busy in model-tables). Length + hash recaptured.
// 5.0 GUI batch 2a — the consumer chip's via truncates (ellipsis) and the chip
// shrinks (min-width:0) so the remove-✕ can't be pushed off the fixed-width detail
// panel. Length + hash recaptured.
// 5.0 GUI batch 4 — the status pill moves to the header slot where the version was
// (.header-status-slot) and the version moves to the Settings drawer footer
// (.drawer-version). Length + hash recaptured.
// 5.0 GUI batch 6 — the drilled-in entity graph (.brain-graph.entity-graph) lays a
// breadcrumb bar (.graph-crumbs) above the graph canvas. Length + hash recaptured.
// 5.0 GUI batch 8 — the top search box CSS is removed (.topsearch/.search-* gone;
// .last-edited kept); a .history-sep divides Back/Forward from Undo/Redo. Length +
// hash recaptured.
// 5.0 GUI batch 11 — .md-doc (the deleted #/md viewer) removed; .mt-nest indent
// for belongsTo-nested tables; .mt-edge-fk dead (lines are m2m-only). Recaptured.
// 5.0 GUI batch 16 — the settings drawer restyles as the full-workspace
// takeover (below-header, fade/slide, [hidden] display:none guard, trigger
// highlight).
// 5.0 GUI batch 17 — .mdt-render-pending fade + .mdt-render-fill bar in the
// Markdown tree; the .card-render overlay CSS is deleted.
// 5.0 GUI batch 19 — the takeover panel + backdrop sit BELOW the topbar so the
// header triggers stay clickable (collapse works); was intercepting on CI.
// 5.0 Tables taxonomy — .mt-card-flag (the computed-table ƒ badge on a Tables-
// explorer card) and .pvchip-derived (the provenance chip for the new 'derived'
// tier). Length + hash recaptured.
// Computed-table builder — a new computed-builder segment: the builder page
// (.computed-builder cards, field rows, chips, preview table, SQL details,
// refresh log, error strip), the "Computed" badge + read-only note + field
// list on record/collection pages, the Tables explorer's computed-tier "+ New"
// button + detail-panel actions, and the dashed base→view projection connector
// (.mt-edge-computes). Length + hash recaptured.
// Clarification questions — a new questions segment: the .q-card question
// cards (accent-tinted head/options/other-input/error/resolved states), the
// #question-cards strip between the chat feed and the composer, the in-turn
// .q-inline sizing, and the .has-question notification dot on the Ask trigger.
// Length + hash recaptured.
// Import computed proposals — .imp-computed checkbox rows for the confirm
// card's opt-in "Computed tables" section (inline-import segment). Length +
// hash recaptured.
// 5.0 Analytics view — analytics layout grid + Dashboards sidebar + dashboard
// page/canvas + dock status line; the floating assistant panel's styles became
// the .ask-dock column (feed/composer/staging rules unchanged). Length + hash
// recaptured.
// 5.0 merge — the questions segment's #question-cards strip now lives in the
// .ask-dock (between the status line and the composer); its rules are
// container-agnostic, so only the dot comment changed. Length + hash
// recaptured for the merged stylesheet.
// Dead-CSS removal (markup retired in the 5.0 refactors): the whole
// rendered-context segment (.context-block/.context-file*/.context-empty — its
// import + array entry dropped from styles/index.ts and the file deleted);
// provenance's .prov-mount (object page is a table view); table-view's
// td .cell-clip + .empty-row; chat's retired floating-assistant-rail block
// (.assistant-rail.dragging-file overlay, .rail-handle, and the mobile-drawer
// @media — the real drop overlay is .file-drop-overlay in assistant-rail, and
// layout.ts owns the current mobile #content rule); buttons' legacy
// renderTable row-action controls (.row-actions/.row-delete/.row-restore/
// tr.row-deleted); outputs' abandoned multi-group classes (.out-group/.out-link/
// .out-placeholder); settings-drawer's Advanced-View toggle-switch
// (.toggle/.toggle-track/.toggle-thumb/.toggle-label); and fs-workspace's
// retired .fs-doc detail card. (.fs-tile-vis was KEPT — the shared vis() helper
// still emits it and gui-visibility-indicators.test.ts exercises it.) Length +
// hash recaptured.
// Fix: the Connect-a-database / connectors MODAL dialog z-index restored 95→130
// so it sits ABOVE its z-120 backdrop (a takeover-panel z-fix had dropped it
// below the backdrop, dimming the dialog itself). Length + hash recaptured.
// Analytics batch: "Workspace" col-header on the tab strip (aligned with the
// Configure headers), + New Dashboard button, adjustable Ask-dock resize handle,
// empty-state prompt box. Length + hash recaptured.
// Analytics polish batch: the three analytics column headers get Configure-style
// accents (Dashboards=blue, Workspace=purple, Ask Gladys=teal); the tab strip
// moves to its own row BELOW the Workspace header (no longer a col-header); the
// Ask Gladys header drops its gradient and adopts the uppercase col-header-text
// treatment; the Settings tab row hides via [hidden] when Version history shows.
// Length + hash recaptured.
// Analytics tab strip = folder tabs: the strip is a tinted bar with raised,
// rounded, bordered .tab buttons; the active tab fills to the canvas surface and
// merges into the content below, so a single "New Dashboard" tab reads as a TAB
// rather than an underlined heading. Length + hash recaptured.
// Version-history takeover drops its redundant "Version history" page heading
// (the takeover header already titles it); the entity filter moves into a compact
// .history-subhead row. Length + hash recaptured.
// The connect wall becomes a wizard (choice cards, faded Connect, spinner, error status),
// and the shared "bubble" field base is strengthened (rounder corners, defined border, real
// padding on every input/select/textarea) so form fields are consistent app-wide. Recaptured.
// The connection-form fields (.conn-field, used by Connect-a-Database / Migrate-to-cloud) drop
// their own box styling and inherit the global bubble base so they match every other form.
// Recaptured.
// Graph is its own full-width Configure tab (.graph-tab, a flex column with a definite
// height) into which .brain-graph flex-grows, so the force-graph canvas is never 0px.
// Data Model + Graph run edge-to-edge (.drawer-body.dm-wide lifts the 980px cap). Recaptured.
// A data-lineage map (.lineage-grid: upstream · this · downstream) sits above a table's
// rows, reusing the explorer chips. Recaptured.
// Single-layout polish: .dash-page fills the pane (height:100%, not inert flex:1); sidebar
// full-height + scroll (.dash-sidebar height:100%/overflow); nav heads styled like
// DASHBOARDS (blue #2563eb, 11px/0.08em, sticky); drawer scroll-lock (body.drawer-open
// overflow:hidden + .drawer-body overscroll-behavior:contain). Recaptured.
// Markdown redesign: deleted outputs.ts styles (Outputs column + .mdt-* markdown tree) +
// the .fs-view-toggle rules; TABLES/FILES nav heads now match DASHBOARDS exactly via
// .nav-section-head .section-label-text (11px/700/0.08em/#2563eb). Recaptured.
// Review fix: keep the TABLES/FILES label blue on hover too (.section-toggle.nav-section-head
// :hover .section-label-text) — a generic .section-toggle:hover rule would flip it to
// var(--text), diverging from DASHBOARDS which never recolors on hover. Recaptured.
// Configure/sidebar polish batch: Configure drawer slides in from the top (translateY(-100%)
// → 0) instead of fading; radio cards keep their flex layout (.modal .field label.wiz-kind-card
// out-specifies the .modal .field label{display:block} that jammed the radio against the text);
// the left sidebar is a fixed-header accordion (rail overflow:hidden; the open section grows +
// scrolls via :has(); Dashboards header row + body); DASHBOARDS/TABLES/FILES carets removed;
// workspace tab strip forces uniform tab widths (flex:1 1 0; min 38px icon / max 180px) that
// shrink then spill into the ⋯ menu; the now-unused .inputs-group-head rule (its subheadings
// were dropped when Inputs split into three tabs) was deleted. Recaptured.
// Schema-grouped TABLES + SQL-runner table page: added the collapsible .nav-schema-head
// styles + the .sql-runner/.sql-editor/.sql-error/.sql-note/.sql-results-head block; removed
// the dead #nav-files-tree rule (the FILES sidebar section is gone). Recaptured.
// Design pass M1 — token scales added to tokens.ts (hue mini-palette, brand isolate,
// accent/danger/warn alpha steps, opaque status pairs, radius scale, z tiers, motion,
// font stacks, overlay/selection) in a second :root block + the fallback-policy and
// value-scale doc comments. Purely additive: histogram diff = 63 additions, 0 removals;
// nothing references the new tokens yet, so rendered output is unchanged. Recaptured.
// Design pass M2a — value normalization across the styles files: color literals swapped to the
// token layer (hue palette, accent/danger/warn color-mix steps, status pairs, --btn-text/
// --surface whites), dead root-token fallbacks stripped (incl. the undefined --panel/
// --text-dim/--mono/--danger-soft fallbacks), odd paddings/margins + half-pixel font sizes
// snapped to the documented scales, letter-spacing unified at .05em, border-radius moved to
// the --r-* tokens, exact-match durations to --dur-*, and font stacks to --font-ui/--font-mono.
// Four sanctioned contrast fixes (op-schema chip, import errors, shared-yellow, role-expired
// bg) + three hue absorptions. z-index untouched (next commit). Recaptured.
// Design pass M2b — z-index tiers: every stacking-tier literal moved to its --z-* token
// (values unchanged), and the five in-content dropdowns (file menu, sources add-menu, tab
// overflow, emoji grid — each the sole floater in its own stacking context) merged at
// --z-menu. Literals <= 10 (intra-component micro-order) stay by documented rule. Recaptured.
// Design pass M3 — component consolidation: NEW components.ts (canonical modal moved from
// teams.ts; backdrop-geometry, icon-button-chrome, card-DNA, pill-radius, empty-state,
// kicker, toolbar alias groups; grouped focus ring; .panel/.pill/.empty-state/.kicker/
// .toolbar primitives) + NEW utilities.ts (the .muted/.hint/.mono/.u-* vocabulary — the
// global .muted rule is the sanctioned fix for ~43 bare class=muted usages). Dead CSS
// deleted (.danger-btn, .wm-actions/.wm-btn, .modal-foot .btn overrides, .cd-btn dupes).
// Recaptured.
// MCP Connectors overhaul: the connectors-dialog section comment now describes
// the shared side-drawer chrome (kept for the DB dialog; .conn-* styles are
// reused by the MCP Connectors tab panel). Recaptured (on top of #146).
// Databases tab redesign: removed the unused .connectors-dialog/.connectors-backdrop
// side-drawer rules (both connectors + databases are inline now) and added the
// .db-table / .db-form-grid full-width table + form styles. Recaptured.
// MCP Connectors tab redesign reuses the .db-table/.db-* styles for its
// full-width connected-servers table (no new connector-table CSS). Recaptured.
// Rebase recapture: assistant-rail CSS tweak (workspace-registry-hygiene PR) on
// top of the connectors/databases full-width table styles. Recaptured.
// Question cards: .q-subject secondary line (the record a clarification is
// about) — muted, hover underline. Recaptured.
// .q-banner collapsed pending-questions banner + #q-stack hidden rule. Recaptured.
// 5.0.1 Bug 8: .staging-busy state (dim chips, hide remove buttons, pulse the
// "Adding…" header) while a staged file batch ingests. Recaptured.
// v5.1 merge — traceable rendered context (PR #176) folded in: .chip-trace inline trace
// chips, .source-chips-row / .source-chip per-file source summaries, .provenance-card*
// floating card (z tier via var(--z-popover)), .lattice-ref inline word-link (accent tint
// + dotted underline replacing the boxed pill), and .trace-hl source-data flash — tokens
// only. Length + hash recaptured for the combined v5.1 bundle.
// Managed token balance + out-of-credit notice: the .chat-bubble.assistant.notice-error
// red style (the friendly $0-balance chat notice). Length + hash recaptured.
const ORIGINAL_LENGTH = 171900;
const ORIGINAL_SHA256 = '62062335ce445d926881c4cad41174215d8db183760c786ea14dc02292b576c5';

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
