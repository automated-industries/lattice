import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { appJs } from '../../src/gui/app/script.js';
import { analyticsTabsJs } from '../../src/gui/app/modules/analytics-tabs.js';

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
// 5.0 MCP connectors — the connectors settings panel gains a server-URL form for
// bring-your-own-URL MCP connectors and an OAuth-redirect open + auto-refresh
// handler. Plus wire/merge drag fixes for webviews: the drop hit-test hides the
// floating ghost so elementFromPoint finds the tile underneath, the tile takes
// setPointerCapture so the gesture keeps streaming pointermove, and the tile CSS
// blocks native text-selection/scroll gestures.
// 5.0 perf review — realtime refresh now scopes cache invalidation to the changed
// table(s) instead of wiping the whole row cache, and relation-chip fetches exclude
// files.extracted_text.
// 5.0 startup speed — the ~275 KB vendored Chart.js (chartLibJs, ~31% of the bundle)
// is no longer composed in; it's served on demand at /gui-assets/chart-lib.js and
// fetched only when an HTML-file artifact preview needs it. The bundle parsed on
// EVERY startup dropped ~32% (849022 → 575322).
// 5.0 reliability — a read-degraded active workspace no longer bricks the GUI: the
// /api/entities-summary fetch has its own catch so the header workspace switcher
// still mounts (the user can always switch away).
// 5.0 drag fix — the wire/merge ghost is appended to <body> (not the folders grid)
// so position:fixed is viewport-relative and the clone anchors to the cursor.
// 5.0 GUI batch — "already linked" fails silently, the Wire button is now "Link",
// the record view's Inside folders use the emoji folder icon, and file drag-drop is
// a whole-window overlay (openAskLattice on drop) instead of the Gladys panel. The
// folder view drops the "Linked" section header (linked + child folders list first).
// Length + hash recaptured.
// 5.0 GUI batch 2 — a workspace switch shows a full-app fade overlay while the
// columns rebuild (reloadEverything show/hideSwitchOverlay in search); the
// Tables-explorer consumer chips gain a remove-✕ (linChip + mtRemoveLink) and the
// same-column edge bow is clamped inside the content box so a link in a narrow
// (wrapped) Model pane is never clipped by overflow (mtDrawEdges in model-tables).
// Length + hash recaptured.
// 5.0 GUI batch 3 — folder one-to-many nesting: a folder drag nests (belongsTo)
// instead of m2m-linking (wmAttachDrag/wmWire take onDrop/onDropOut; folders pass
// foldersNestDrop/foldersUnnestDrop); the top-level grid hides nested children;
// breadcrumbs show the parent chain; child folders move into the single "Items"
// section (folders first, then rows). Length + hash recaptured.
// 5.0 GUI batch 4 — the status pill homes into the header slot where the version
// was (status-indicator prefers #header-status-slot); the "Advanced View" toggle
// + feature are removed (advancedMode() is a false constant; setAdvancedMode /
// mapHashForMode / fsTerminal deleted), leaving the file workspace as the only
// view. Length + hash recaptured.
// 5.0 GUI batch 5 — the schema graph mounts empty (instant canvas, renderer module
// loaded in parallel with the data fetch) and reveals nodes in waves (biggest hubs
// first) via successive setData calls, so entities fly in progressively like the
// live-ingest delta instead of all at once (revealGraphInWaves in system-tables).
// Length + hash recaptured.
// 5.0 GUI batch 7 — sticky-section navigation (section-scoped record routes
// #/fs|#/graph|#/tables via a shared renderer + section arg; breadcrumb root + tab
// per section); "Folders" tab renamed to "Objects" + object tiles use their own
// emoji (no folder icon); record view "Inside" → "Connected objects" (count>0
// only); link/merge on the brain graph updates via a live setData delta instead of
// a full rebuild; the Tables explorer drops the "Surface" tier (Source + Tables
// only, "Model · entities" renamed "Tables"). Length + hash recaptured.
// 5.0 GUI batch 6 — Graph section drill-down: clicking an entity node opens
// #/graph/<obj> → renderEntityGraph (that entity's rows as nodes, linked to the
// rows they belongsTo, labelled by name/id); clicking a node opens the record
// (entity) page; a breadcrumb rooted at "Graph" keeps the Graph tab lit
// (tabKeyForHash + the #/graph/<obj> route). Length + hash recaptured.
// 5.0 GUI batch 8 — header: the top search box is removed (Ask Gladys is the sole
// search surface; openSearchHit kept for the feed/wizard/onboarding), replaced by
// Back/Forward page-nav buttons next to Undo/Redo. Graph object bubbles size on a
// log scale by row count. The Outputs "Tables" mirror opens objects under #/tables
// (Tables tab stays lit). Length + hash recaptured.
// 5.0 GUI batch 9 — SOURCE-tier tables (files, connector-synced, imported
// databases) are raw inputs, excluded from the Objects grid (foldersModel) and the
// schema graph (buildSchemaModel); they appear only in the Inputs column + the
// Tables explorer's Source column. Length + hash recaptured.
// 5.0 GUI batch 10 — the Connect-a-database dialog takes host/port/user/password/
// database fields ONLY (the raw connection-string input is removed; the connection
// is read-only by contract) and its lead copy states the read-only guarantee.
// Length + hash recaptured.
// 5.0 GUI batch 11 — the Outputs Markdown tree lists ONE node per table in the
// same tier categories as the Tables mirror (junctions excluded by construction;
// strays under Other files); .md clicks resolve to the record page (the single
// markdown surface — the read-only #/md viewer is deleted); belongsTo-nested
// tables indent under their parent in the Tables explorer (link lines are m2m
// only); exclusivity client guards. Length + hash recaptured.
// 5.0 GUI batch 12 — Back/Forward operate on an app-managed, PER-WORKSPACE
// hash-history stack (window.history spans workspace switches); a switch lands
// on the new workspace's own last location, never the old one's hash.
// 5.0 GUI batch 13 — the right column is ONE Markdown view: header renamed, the
// separate Artifacts + Tables sections deleted, artifacts render as a category
// inside the markdown tree. Length + hash recaptured.
// 5.0 GUI batch 14 — ONE record page for every row: files/artifacts flow through
// the same chrome as regular records (toggle, sharing, provenance, connected
// objects, actions menu); the separate doc renderer is deleted; view mode is a
// single per-record map (formatted/markdown/history). Length + hash recaptured.
// 5.0 GUI batch 15 — the legacy #/objects table/detail views are RETIRED: the
// structured fields editor + junction manager were absorbed into the unified
// record page (actions menu > Edit fields); #/objects/* redirects; strays group
// hidden in the Markdown tree. Length + hash recaptured.
// 5.0 GUI batch 16 — Settings + Version history are ONE full-workspace takeover
// panel below the header: triggers highlight while open and toggle closed;
// history is a drawer tab; #/settings/history opens the takeover.
// 5.0 GUI batch 17 — per-table render progress lives in the Markdown tree
// (fade until rendered, in-node bar, un-fade on done; card overlays removed,
// header pill kept); boot kicks the stale connector/db-source syncs.
// 5.0 GUI batch 18 — collection pages gain the Formatted | Markdown toggle:
// markdown shows the table's whole-table rollup (read-only); a rollup .md click
// in the Markdown tree lands in markdown mode, not the rows view.
// 5.0 Tables taxonomy — the Tables explorer becomes three columns: Inputs /
// Derived Tables / Computed Tables (MT_LAYERS + the mtClassifyTier mirror gain
// the 'computed' tier and read the server-stamped t.computedTable + t.origin);
// mtBuildModel excludes the native `secrets` table (a credentials store) and
// carries computedTable onto the built entities; mtCardHtml flags a computed
// card with a small ƒ; wire/merge validity (wmValidTarget + mtInvalidTarget)
// rejects computed tables as source and target (read-only projections); the
// per-row provenance PROV_TIERS gains 'derived' (model-tables / wiremerge /
// provenance segments). Length + hash recaptured.
// Computed-table history: schemaEntryLabel gains the four schema.*_computed
// ops, and a schema.refresh_computed entry shows "not revertible" instead of a
// Revert button — a refresh only fills AI cells, so (like a purge) it has no
// inverse (markdown segment). Length + hash recaptured.
// Computed-table builder + read-only surfaces: a new computed-builder segment
// renders the full-page builder at #/computed/new | #/computed/<name> (base
// picker over /api/computed-tables/fields, per-kind field rows with labeled
// kinds, dry-run preview with per-field ✓/✕ marks + the compiled SQL, save
// through POST/PUT /api/computed-tables, NDJSON refresh via iiStreamNdjson,
// delete); renderRoute dispatches the route and tabKeyForHash keeps the Tables
// tab lit. The Tables explorer gains a computed-tier "+ New" header button, a
// computed detail panel (sub-line, Edit definition →, streamed Refresh status,
// lazy Definition (SQL) block), lineage over the new 'computes' graph edge
// (base upstream → view downstream; chips not removable), and a dashed
// projection connector. Record + collection pages for computedTable entities
// go read-only: a "Computed" badge, a where-values-come-from note, no
// Formatted|Markdown toggle or actions menu, and a read-only field list
// (loadComputedContext); paintRowsTable takes an optional noteHtml. Length +
// hash recaptured.
// Clarification questions: a new questions segment (pending-question cards
// above the composer — option buttons, free-form "Other", dismiss; the shared
// card renderer also serves the in-turn ask_user event; refreshQuestions
// reconciles cards + the trigger notification dot, auto-opening the panel on a
// new question); ask-lattice's open/close refresh the dot; onboarding's SSE
// handler renders the 'question' chat event; dispatchStreamMessage routes
// op:'question' feed events to the reconciler; boot calls initQuestions().
// Length + hash recaptured.
// Import computed proposals: the inline import confirm card gains an opt-in
// "Computed tables" section (unchecked .ii-computed checkboxes, one per
// proposed field with its formula/classifier evidence line); the apply payload
// grows computed:[{table,fields}] for the checked ones and echoes the
// proposal's linkConfidence so apply re-derives with the same threshold
// (inline-import segment; runInlineImport now takes the whole autoImport).
// Length + hash recaptured.
// 5.0 Analytics view — the app splits into two hash-driven views: Analytics
// (the landing surface: Dashboards sidebar, dynamic dashboard tabs, docked
// assistant) and Configure (the existing three-column workspace). The floating
// assistant panel is retired — the chat's #rail-* nodes live in the Analytics
// dock; dashboards open as closable, deduped tabs with the width-based "⋯ N"
// overflow; assistant-created dashboards route to #/analytics/<id> everywhere
// a record would open; a transient plain-language status line acknowledges
// tool work. Length + hash recaptured.
// 5.0 live dashboards — the sandboxed page bridge gains a read-only SQL
// surface (window.lattice.sql → the parent broker → the server-enforced
// /api/analytics/sql endpoint), so dashboards aggregate live data in one
// portable SELECT instead of fetching whole tables. Length + hash recaptured.
// 5.0 merge — clarification questions meet the Analytics dock: the
// #question-cards strip renders inside the dock above the composer; the
// questions segment derives "cards on screen" from the Analytics hash
// (qDockShowing/qShowDock replace the retired floating-panel open/close), a
// new question switches to the Analytics view, the dot re-evaluates on
// hashchange, and onboarding's SSE handler carries BOTH the tool_use status
// line and the in-turn question card. Length + hash recaptured for the
// merged bundle.
// UX-review batch (non-destructive question surfacing + confirmations +
// a11y): a background 'question' feed event no longer force-navigates to the
// Analytics view while the user is mid-build in the computed-table builder
// (#/computed/*) — refreshQuestions now surfaces via the trigger dot + a
// dismissible toast (qUserIsEditing / qNotifyNewQuestion) instead of flipping
// the hash, and only auto-opens the dock when idle. The Ask trigger's
// aria-label reflects the pending-question count and a polite #q-live region
// announces new questions (qAnnounce), so the CSS-only dot is no longer the
// sole signal; dismissing a question now confirms first. A freshly-created
// computed view with AI-derived fields shows a "still filling" banner on the
// collection page (fsComputedAiBanner). Deleting a computed table (cbDelete)
// or a dashboard (analytics ⋯ Delete) now confirms before the DELETE. Length +
// hash recaptured.
// Analytics batch: workspace-switch stays in the current view; a permanent
// "New Dashboard" tab + empty-state prompt box (→ chat); "+ New Dashboard"
// header button; the brand logo toggles Analytics↔Configure; the Ask Gladys
// dock is width-adjustable. Length + hash recaptured.
// Analytics polish batch: the composer drops "Enter to send" and Cmd/Ctrl+Enter
// inserts a newline (create-database-wizard composer + the home prompt box); the
// dashboard "+" is a bare plus glyph; Version history becomes its OWN takeover
// (opened via the header clock, not a Settings sub-tab) so selectDrawerTab hides
// the Settings tab row while history shows; the analytics tab strip moves onto
// its own row below the WORKSPACE header. Length + hash recaptured.
// Version-history header drops its leading 📜 entity-icon (plain "Version
// history" heading). Length + hash recaptured. (The header clock trigger becomes
// an SVG icon — but that lives in the app.ts HTML shell, not this bundle.)
// Version-history panel drops its redundant "Version history" heading (the
// takeover header already titles it) and moves the entity filter into a compact
// .history-subhead row. Length + hash recaptured.
// Connected external-DB (db-source) tables now appear on the Objects page:
// mtBuildModel carries connectorToolkit through, and foldersModel keeps
// source-tier tables that are connected (the empty state's "add a source"
// promise). Length + hash recaptured.
const ORIGINAL_LENGTH = 679493;
const ORIGINAL_SHA256 = 'eb73e9adfc25e74b78e4427c274556d4f3518e3f23bc423d00035a955065f789';

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
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- intentional: parse-only syntax check of the internally-composed bundle
    expect(() => new Function(normalized)).not.toThrow();
  });
});

describe('analytics tab strip isolation', () => {
  // The Analytics strip was recovered from the original dynamic tab machinery,
  // whose identifiers still exist in tabs.ts for the Configure strip. Both
  // segments live in ONE IIFE, and a duplicate function declaration is legal
  // JS — the later one would silently REPLACE the Configure implementation
  // with every unit test still green. Assert the recovered copy carries no
  // bare legacy identifier (all its symbols/element ids are an-/antab-prefixed).
  it('redeclares no identifier from the Configure tab strip', () => {
    // Match against CODE only: comments and string literals legitimately
    // mention tab words (prose, CSS classes, element ids), but an IDENTIFIER
    // collision is what would shadow the Configure implementation.
    const code = analyticsTabsJs.replace(/\/\/[^\n]*/g, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
    const legacy = [
      'tabs',
      'activeTabKey',
      'tabKeyForHash',
      'reconcileTab',
      'renderTabStrip',
      'closeTab',
      'setTabTitle',
      'findTab',
      'tabBtnHtml',
      'tabOverflowWired',
      'wireTabOverflowGlobal',
      'TAB_MIN_W',
      'GRAPH_HASH',
    ];
    for (const name of legacy) {
      const re = new RegExp('(?<![A-Za-z0-9_$])' + name + '(?![A-Za-z0-9_$])');
      expect(re.test(code), name + ' must not appear bare in analyticsTabsJs code').toBe(false);
    }
    // The Configure strip's mount + overflow element ids must not be targeted.
    expect(analyticsTabsJs.includes("getElementById('tabstrip-tabs')")).toBe(false);
    expect(analyticsTabsJs.includes("getElementById('tab-overflow-btn')")).toBe(false);
    expect(analyticsTabsJs.includes("getElementById('tab-overflow-menu')")).toBe(false);
  });
});
