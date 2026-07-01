import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { appJs } from '../../src/gui/app/script.js';

// `src/gui/app/script.ts` (a single 7319-line template literal) was split into
// per-subsystem segments under `src/gui/app/modules/`, composed back into `appJs`
// in the original order via `modules/index.ts`. The split is a pure source-
// organization refactor: the composed string MUST equal the original byte-for-byte,
// which is what proves the inlined `<script>${appJs}</script>` is unchanged.
//
// These constants pin the composed `appJs`. They are re-captured whenever `appJs`
// changes intentionally (the modules are edited together as the source of truth):
// the offline-retry self-heal, the 3.4.1 merge's workspace-switch logo refresh
// (the switch path now re-fetches /api/dbconfig + re-points the header logo,
// matching the boot path), the manual-upgrade link (the version chip's
// "Update available — Upgrade" affordance: checkUpdateAvailable + wireUpdateLink,
// wired at boot and refreshed on each reconnect version check), and the FOUC fix
// that softens the two background in-place re-renders (advanced-mode toggle +
// workspace-switch reload now pass {soft:true} so they never paint the loading
// frame), and the 4.2 structured-source-importer GUI, reachable only by dropping a
// JSON/xlsx file into the assistant chat: the upload returns a proposal and an
// inline confirm card renders into the assistant rail (no top-bar button, no
// modal). The 4.3 release adds the Connectors settings panel + inline HTML files
// (the file preview renders an `artifact_type='html'` file live in a sandboxed,
// null-origin `srcdoc` frame — no network, a read-only postMessage broker + an
// injected `window.lattice` bridge — with the bundled minified Chart.js assigned
// to `window.__LATTICE_CHART_LIB__`, the bulk of the size), the 4.3 GUI layout
// redesign (tab strip + center brain graph, Sources sidebar, single top-right
// status, live ingest animation, file two-view/history/remove), plus 4.2.4's
// desktop build + the shared `claudeAuth()` single-source-of-truth pass merged
// from main, and the on-device voice-dictation host glue (the voice-local segment:
// a module Web Worker runs an in-browser speech model so dictation works with NO
// API key and audio never leaves the machine). The GUI uses on-device dictation
// ONLY — there is no voice-provider choice in settings and the mic always shows;
// rec.onstop always transcribes on-device. The keyed/cloud transcribe route stays
// reachable to API callers for backward compatibility, but the GUI never calls it.
// Recapture the length + hash on any intended change. 5.0 combines: the
// surface-aware auto-update pill (checkUpdateAvailable branches on status.action,
// dev/linked badge, slow-interval re-poll); the force-directed brain-graph
// migration (all three graphs moved to the live renderer loaded out of band from
// /gui-assets/force-graph.mjs; the static builders + hand-rolled forceLayout sim
// removed; the ingest animation feeds the live handle); and the data-provenance
// module (renderProvenance / renderProvenancePanel + the source graph/table
// views). Pinned length + hash recomputed for the merged inline host.
// (Bump: GA decoupled from the prod website property — reads window.__LATTICE_GA_ID,
// default opt-in — so the local app no longer inflates the website's unique users.)
// 5.0 GUI reframe — Inputs/Model/Outputs. Step 1: a new "Databases" section in
// the left Inputs sidebar (inputs.js segment). Step 2 (right-side reframe): the
// docked assistant rail is replaced by a right-hand Outputs column (outputs.js —
// Artifacts moved here from the left, plus Markdown/Tables/Server-Docs/API-Docs/MCP
// section shells); the chat moves to a floating "Ask Lattice" panel (ask-lattice.js
// — open/close + file drag-drop; the composer/feed/thread controls reuse the same
// element IDs so the chat client is unchanged); a live activity feed moves to a
// header popover next to the version-history clock (activity-header.js; renderFeedItem
// now also appends there); the rail-resize becomes an Outputs-column resize
// (initOutputsResize). Step 3 (Model view): a Graph | Tables toggle in the center
// pane (system-tables segment) over the existing brain graph and a new tiered Tables
// explorer (model-tables.js — Source/Model/Surface columns, Entity/Field
// toggle, tier chips, detail panel + generic computed caveats; the tier classifier
// mirrors src/gui/tier-classify.ts). Step 4 (Outputs content): the Markdown panel
// renders the workspace's rendered context tree (outputs.js: renderOutputsMarkdown
// over GET /api/context/tree + a click-to-open detail slide-over via
// /api/context/file, reusing mdToHtml/stripFrontmatter) and the Tables mirror
// reuses mtBuildModel for a compact tiered list. Recaptured.
// Step 6 removes the redundant per-object "list view" tile-grid escape hatch:
// the fsObjectView toggle, the three "List view" buttons (provenance + object-graph
// + files-root) and the moot graph-toggle, so the top-level object page is the
// provenance view; nested relation collections still render the tile grid. Step 5c
// fills the Inputs > Databases section (inputs.js): list connected external DBs +
// a connect modal (connection string OR host/user/password) posting to
// /api/db-sources, with disconnect + post-import refresh.
// Graph high-volume cap: the brain graph drew a node per row/file uncapped (a
// large cloud → tens of thousands of nodes → the force layout froze). The graph
// builder now bounds row/file detail nodes (the table topology always renders in
// full) and reports truncated/totalEntities; renderSchemaGraph surfaces a
// "large workspace" note so the cap isn't silent.
// Ask Lattice polish: the floating panel opens/closes via an `.open` class (so it
// can animate in AND out from the top-right corner), a click outside collapses it,
// and "powered by Claude" is dropped (ask-lattice.js segment).
// Markdown rework: the Outputs Markdown view is now a LAZY collapsible tree
// mirroring the on-disk Context/ layout (folders fetch children via
// /api/context/list on expand), and the detail panel is a shared slide-in
// (openOutputsDetail) opened via an .open class (outputs.js segment).
// Nav redesign: Graph vs Tables is now a top-level tab/route (#/graph, #/tables),
// not an in-pane toggle — the redundant Brain Graph tab + the model-toggle div-in-
// div are gone. tabs.js now has just two permanent tabs (records no longer spawn
// tabs); renderBrainGraph/renderModelTablesView render a single view into #content
// (the setModelView/renderModelBody + dynamic-tab helpers were removed → net
// shrink). Breadcrumb "Brain Graph" → "Graph".
// Live-review polish batch: Tables explorer gains table + field lineage (upstream
// sources / downstream consumers + a "+ Wire" link) and drops the dead Show-tier
// chips; the Markdown tree gets dedicated styles; the brain graph is fetched
// schema-only (?schema=1 → table topology, no row nodes — instant + scalable) with
// a settle-then-reveal spinner (no off-centre jump) and the "N objects" note
// removed; the inline record-create ("New <entity>") feature is removed entirely.
// Lineage is built from the server-computed /api/graph?schema=1 edges (cached),
// not the client's entity.relations — so it works for cloud members too (who
// never receive the owner's relation config).
// Tables detail panel drops the CAVEATS section (+ mtCaveats); the object page is
// now a single table-only provenance view (graph mode + buildProvenanceModel /
// renderProvenanceGraph / legend removed), its breadcrumb returns to Tables, and
// object/record routes keep the Tables tab highlighted (tabKeyForHash).
// The Files object page + folder drill-ins render as a TABLE (paintFolderGraph
// now emits a .fs-files-table, not a force graph; buildFolderGraphModel removed),
// the Files breadcrumb returns to Tables, and #/folder/* keeps the Tables tab lit.
// The object page now shows the table's ROWS as a table (objRowCols/fsCellText in
// renderFsCollection), mirroring the Files file list — the full-page provenance
// view (renderProvenance) is removed (per-row provenance panel kept). Breadcrumbs
// are rooted at "Tables" (fsBreadcrumb + folderBreadcrumb) for one consistent path.
// Per-row "Data provenance" now has a universal traceback: the client PROV_TIERS
// renders the new 'related' (belongsTo parents) + 'created' (authoring floor)
// tiers the server emits — so a seeded/authored row no longer reads "No sources".
// Object/Files rows tables: the WHOLE row is clickable (opens the record), not
// just the name cell (inner links still work).
// Connect-a-database is now the same left side-drawer as Add a Connector
// (openDbConnectDrawer reuses the connector drawer chrome + .conn-form/.conn-field
// classes), replacing the centered modal (inputs.js segment).
// Tables explorer wiring (schema-explorer pattern): relationships are drawn as SVG
// connectors between the tier cards (mtDrawEdges), and "+ Wire" toggles a mode
// where clicking a source then a target creates an m2m link via POST
// /api/schema/junctions (mtWireClick) — replacing the broken settings navigation.
// Review fixes: file soft-delete navigates to the Files collection (the old
// closable-tab dismissal no-ops under the two-tab model + stranded the user), and
// the Tables-explorer edge ResizeObserver is disconnected before re-creating (no
// per-render observer accumulation).
// Dead-code removal: the unreachable focused-object-graph subsystem
// (renderFsObjectGraph/mountObjectGraph/objectGraphData/buildObjectGraphModel +
// FS_GRAPH_* state + openGraphFile) is gone now that object pages are tables.
// Record Formatted | Markdown toggle: the record view (renderFsItem) gains a
// segmented control (fsItemView/setFsItemView/applyFsItemView) that shows either
// the structured fields (Formatted) or the row's rendered context (Markdown).
// Markdown-in-center: a context .md opens at #/md/<path> (renderMarkdownDoc) in the
// center pane instead of the removed Outputs slide-in drawer (openOutputsDetail gone).
// Artifacts object: files carrying an artifact_type render as their own table at
// #/fs/artifacts (renderArtifactsView), and an artifact record's breadcrumb roots at
// "Artifacts" (fsBreadcrumb) instead of Files; displayFor gains an 'artifacts' label.
// Review low: the renderFsCollection + renderFsItem error catches now guard on
// renderGen so a stale async error can't clobber a newer view.
// Rows-table pagination: a shared paintRowsTable helper (thead/body + whole-row
// click + a Prev/Next pager with an "A–B of T" / "T+" total), PAGE_SIZE +
// per-collection page state (fsPageByPath), and fetchRowsPage (returns
// { rows, approxTotal, totalIsCapped }, asking the server for the total via
// ?withTotal=1). Review hardening: fetchRowsPage over-fetches one sentinel row so
// hasNext is exact (no phantom trailing page) via fsServerPage; a stale page index
// clamps to the last real page; onPage bumps renderGen so a slow prior-page fetch
// can't paint over a newer one; Artifacts page server-side (?artifactType=present)
// so every artifact is reachable; paintRowsTable takes an emptyText override.
// Single-step Create Workspace dialog: the 3-step "+ New workspace" wizard
// (name+kind → starter entities → review) collapses to one step (name+kind →
// Create); the entity pre-creation step + createStarterEntities are removed.
// Tables-explorer edges: solid strokes (m2m dash removed), drawn ABOVE the cards
// (svg z-index 2) so links aren't hidden behind tables, and same-column links
// loop out into the right gutter (mtDrawEdges overlap-aware routing).
// Workspace-switch Outputs refresh: reloadEverything() now re-renders the Outputs
// column (Markdown context tree + Tables mirror) so a switch can't leak the prior
// workspace's rendered markdown.
// Realtime graph on ingest: runGraphIngestAnim() now does a full renderSchemaGraph()
// re-render when there is no live handle yet (graph mounted while empty), so the
// first objects ingested appear live instead of staying on the empty-state.
// Hide link tables everywhere: the client isJunction predicate is broadened to a
// DISPLAY rule (mirror of server isHiddenLinkTable) that also hides PHYSICAL link
// tables created without declared relations (an AI-built files_<entity> shaped
// (id, name, x_id, y_id)) from object lists / sidebars / graph nodes / panels.
// Tables-explorer Wire/Merge interactions: a second "Merge" mode plus drag-to-act
// for both modes (drag a card onto another to link or merge — merge via POST
// /api/schema/entities/:source/merge), and grey-out of invalid targets while a
// source is held (model-tables.js segment).
// Record view redesign: Formatted = the rendered (compiled) markdown; Markdown =
// an editable raw-markdown textarea that writes round-trippable columns back via
// PUT /api/tables/:t/rows/:id/context. The old column-by-column field dump
// (fsFieldHtml/.fs-doc) and its click-to-edit (wireFsEdit) are removed, and
// loadFsContext renders ONE primary doc (no more duplicate "Files" sections).
// Workspace-switch fast path: the boot / switch / post-mutation / route reloads
// fetch /api/entities-summary (Objects list — tables + counts — with NO O(files)
// rendered-file scan) instead of /api/entities (the GUI never read the scanned
// `entities` field).
// Review batch A2 — Tables-explorer + write-back client safety: mtResetState()
// clears cached edges + wire/merge state on workspace switch (reloadEverything);
// the drag adds a pointercancel/unified teardown; and the record Markdown
// write-back captures renderGen so a debounced save can't fire into a navigated-
// away record.
const ORIGINAL_LENGTH = 843018;
const ORIGINAL_SHA256 = '73a1b72deef8a2383c04df45f98bc73ae361af451059191711aec0f1387a94e2';

describe('appJs composition', () => {
  // Normalize line endings before pinning: a Windows checkout may materialize the
  // source modules with CRLF, which would change the byte length/hash without
  // changing the inlined script's meaning. Pin the LF-canonical form.
  const normalized = appJs.replace(/\r\n/g, '\n');
  it('matches the original length exactly', () => {
    expect(normalized.length).toBe(ORIGINAL_LENGTH);
  });

  it('matches the original sha256 exactly (byte-identical)', () => {
    const hash = createHash('sha256').update(normalized).digest('hex');
    expect(hash).toBe(ORIGINAL_SHA256);
  });

  it('composes to syntactically valid JavaScript', () => {
    // The bundle is inlined as `<script>${appJs}</script>`, so a template-string
    // slip in any module (an unbalanced brace, a stray backtick) would only surface
    // in the browser. Parse it here to catch that at build time.
    expect(() => new Function(normalized)).not.toThrow();
  });
});
