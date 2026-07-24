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
// The connect wall gains an "or connect an OpenAI-compatible model" alternative to
// Connect with Claude (a collapsible base-URL/key/model form → POST
// /api/assistant/provider/openai-compat, then re-checks config.connected). The account
// menu + settings drawer label + disconnect are provider-aware (an OpenAI-compatible
// backend shows "Connected to <model>" and disconnects via the provider endpoint).
// Recaptured.
// The first-run connect wall is now a wizard (choose backend → Claude/OpenAI-compatible
// setup with a faded-until-filled Connect → "Testing your AI" → Analytics/back-with-error).
// The settings Assistant panel gains editable OpenAI model details (Save & test, revert on
// failure) and drops the inference-aggressiveness slider (now fixed at 0.9 for everyone).
// Recaptured.
// The assistant now responds to a files-only send (a dropped attachment with no text gets a
// synthesized directive); the chat error path re-shows onboarding when the backend
// disconnects; file drag-drop is scoped to one surface per view (chat dock in Analytics,
// the Inputs column in Configure) and expands a dropped folder into its files, falling
// back to the flat file list when the Entries API yields no entry. Recaptured.
// The dashboard iframe bridge gains a navigation-only act() (open Configure / an
// add-source flow / the assistant), and boot opens the seeded Welcome dashboard by
// default when it exists. Recaptured.
// The first-run "Other AI Endpoint" step now also covers the Claude API, and a failed
// onboarding model-test forgets the just-saved endpoint (so a broken provider can't be
// left connected and skip the wall). Recaptured.
// Chat text now streams live; a tool round's assistant_message_end carries hadTools, so
// the client reaps that round's pre-tool preamble bubble instead of leaving it. Recaptured.
// Async chat transport: POST /api/chat no longer holds a streamed SSE response open — it
// ACKs 202 {threadId, messageId} and the turn's events arrive over the /api/stream
// WebSocket as 'chat-progress' frames. The client (onboarding.js) now keys a turn's render
// state by messageId (chatTurns/applyChatEvent/finalizeChatTurn/onChatProgress), binds it
// on the 202, and rebinds a still-'streaming' turn on reload (loadThread recovery); the
// WebSocket dispatcher (offline-edit-queue.js) routes 'chat-progress' frames. The inline
// SSE reader (parseSse) is removed. Recaptured.
// Async-chat durability (adversarial-verify follow-up): on WebSocket reconnect the client
// reconciles bound turns against their persisted rows (resyncChatTurns) — the bus has no
// replay, so a terminal 'done' published during a disconnect would otherwise strand the
// composer; and reload recovery only rebinds an in-flight row as live when it is FRESH
// (chatTurnFresh) — a stale row orphaned by a dead process renders as an interrupted reply
// instead of a permanent typing bubble. Recaptured.
// Smart intent ack (ack-first): a turn can now open with a fast contextual `ack` event
// ("Got it — pulling your invoices…") rendered as a transient bubble before the answer
// streams; the client renders the new `ack` ChatStreamEvent in applyChatEvent. Recaptured.
// Single-layout reframe adversarial-review fixes (7): computed-builder route restored
// (#/computed/* → renderComputedBuilder, drawer closes first) + #/graph node drill-in
// normalized to the table tab; Graph drawer subtab gets a #dm-panel and node clicks open
// the in-drawer editor; file-delete routes to the files collection (not the invalid
// #/w/file/files); closeSettingsDrawer + workspace-switch preserve/clear the Configure
// hashes correctly; dashboard add-source opens the Inputs tab; markdown render-progress
// selectors repointed to #nav-md-tree. Recaptured.
// Re-verify follow-up (2 regressions the fixes themselves introduced): the #/computed
// router branch now bails on a soft/background render so it can't wipe the in-progress
// builder form; the Graph drawer subtab gets a definite height (CSS) so its canvas no
// longer collapses to 0. Recaptured.
// Third-order follow-up: the computed-builder's edit-mode load now commits on the route
// still matching (cbRouteMatches) instead of a renderGen match, so a soft render's gen
// bump can't orphan an in-flight edit load into a stuck spinner. Recaptured.
// Fourth-order follow-up: the edit-mode commit is additionally gated on a per-load token
// (cbLoadSeq) so a stale same-route re-entry can't repaint/clobber a newer load; stale
// module-header deps (renderGen/setContent) dropped from the comment. Recaptured.
// Single-layout polish: removed the permanent "New Dashboard" home tab (empty strip at
// home; anTabKeyForHash returns null; + opens/focuses the Welcome dashboard); Configure
// drawer scroll-lock (body.drawer-open toggle); sidebar Tables/Files/Markdown single-open
// accordion (enforceNavAccordion / NAV_ACCORDION_GROUPS). Recaptured.
// Polish review fix: the drawer close-hide timeout is now cancelable (drawerHideTimer) so
// a quick reopen can't strand body.drawer-open and freeze page scroll. Recaptured.
// Markdown redesign: removed the MARKDOWN sidebar section + its whole outputs.ts module
// (markdown tree) + the dead render-progress DOM overlay in event-stream.ts; removed the
// Formatted|Markdown toggle in favor of a "View Markdown"/"View Formatted" item in the ⋯
// menu (collection + record + file); collection markdown shows RAW source with a
// rowsToMarkdown fallback so a data table is never blank. Recaptured.
// Configure/sidebar polish batch: welcome "ask" chips SUBMIT to Gladys (sendChat) +
// add-source callers open the new Files/Connectors/Databases tabs; the single Inputs
// tab split into three (renderFilesTab/renderConnectorsTab/renderDatabasesTab, no
// subheadings); the Lattice tab's Workspaces module folded into User (renderWorkspacesPanel);
// configureRouteFor maps #/settings/{files,connectors,databases} + legacy inputs→files and
// lattice→user; the left sidebar's Dashboards section joined the single-open accordion
// (nav-dashboards), with TABLES kept as the default-open section (accordion index 0).
// A nav-accordion header click now always OPENS its section (clicking the only-open one is a
// no-op) so exactly one section stays visible — never a collapse-to-none. Recaptured.
// activeElement() now recognizes the 5.0 canonical Workspace routes #/w/(dash|table|file|md)/…
// (it previously matched only the retired #/analytics/<id>), so the currently-open dashboard/
// record is sent to chat as activeContext — fixing the assistant asking you to open an
// already-open dashboard. Recaptured.
// Schema-grouped TABLES + SQL-runner table page: the sidebar groups tables by provenance
// schema (server-stamped schemaKey/schemaLabel) with collapsible schema groups and drops
// the FILES section; the top-level table page is a SQL runner (renderTableSqlRunner +
// paintSqlResults over /api/analytics/sql) replacing the Formatted/Markdown collection view
// (removed collectionViewMode + rowsToMarkdown + fsComputedAiBanner + renderFilesRootView).
// Net shrink. Recaptured.
// Review fix: the SQL-runner row-click is decided PER ROW (r.id present + non-null) instead
// of result-wide, so a null/aliased id never navigates to a dead /null record. Recaptured.
// Chat file-uploader fixes: the clip button opens the picker (the hidden <input type=file>
// is sr-only, not display:none, so its <label for> works in the desktop webview); the
// composer Send always keeps focus on the chat (silent) so a files-only send gets a reply;
// and the typed message survives an ingest failure (sendChat runs in the reject path too).
// Recaptured.
// Design pass M3 — base classes added in markup: the import-wizard primary button carries
// 'btn primary' and the dashboard-tab menu button carries 'btn' (matching its other
// emitter), so the shared button chrome applies. Recaptured.
// MCP Connectors overhaul: the left-sliding connectors dialog is deleted (the
// panel renders inside the Configure drawer's renamed "MCP Connectors" tab);
// connectors-settings is rewritten as a multi-server list + inline add-by-URL
// form with a pre-registered-client fallback; sidebar rows navigate to the tab;
// the dashboard add-connector action opens the tab (no button click). Recaptured.
// Adversarial-review fixes: serverCard() closes its outer card div; the OAuth
// poll treats ANY status change on a known row as completion and reload()s on
// timeout; a typed URL always starts a fresh connection (clears a stale
// reconnect target); the dead sidebar renderSourcesConnectors is removed.
// Recaptured (on top of #144's schema-graph-refresh recapture).
// Databases tab redesign: the left Connect-a-database drawer is deleted; the
// Databases Configure tab renders a full-width, multi-column table of connected
// databases plus an inline add/edit form (renderDatabasesPanel/renderDbForm);
// the dashboard add-database action opens the tab. Recaptured.
// MCP Connectors tab redesign: the panel is now a full-width multi-column table
// (renderConnectorsTable/renderConnectorsAddForm in separate mounts), mirroring
// the Databases tab; connectors + databases both run edge-to-edge (dm-wide). Recaptured.
// Workspaces-panel switch failures now surface via fetchJson + toast (no silent reload); folder/file ingest results reported (ingested/skipped counts); files add-button relabeled "Add files or folder". Recaptured.
// Data Model detail: "Open object" link + "Edit columns & relationships" button removed
// (select-to-detail). Recaptured.
// Recaptured (includes question-subject + cap-copy + live ingest progress state modules).
// Ingest-progress hardening: explicit terminal flag on progress events (a capped run ends
// done < total, so counts can't signal completion), stale clear-timeout cancelled when a
// new batch reuses live state, past-tense terminal labels. Recaptured.
// Pending-question banner: store-backed cards collapse behind a one-line count banner
// (workspace-scoped store vs thread-scoped rail); expand in place on click. Recaptured.
// 5.0.1 workspace-switch fixes: instant full-screen overlay on click (Bug B),
// error-revert to the previous workspace (Bug D), Configure drawer refreshes to the
// new workspace on the same tab (Bug C), and skipping the middle-pane re-render on
// chat-only realtime writes (Bug A). Length + hash recaptured.
// 5.0.1 chat file-attach fixes (Bug 8): the composer no longer clears the staging
// tray before ingest — it locks Send + shows "Adding…" while files upload, keeps the
// files staged (and surfaces a toast) on ingest failure instead of sending the message
// without them, and a files-only send shows the attached file name(s) rather than a
// fabricated "take a look at this file" message. Length + hash recaptured.
// 5.0.1 brain-graph drill perf (Bug 9): the graph drill now reads rows through a
// bounded per-table cache (fetchRowsPageCached), invalidated by invalidate() on any
// mutation, so clicking through layers is instant instead of re-fetching every click.
// Length + hash recaptured.
// 5.0.x release-review fixes: staging-lock guards Enter (submitComposer order) + the
// brain-graph drill cache (graphRowCache) is cleared on workspace switch and
// invalidated via invalidate()/afterMutation. Length + hash recaptured.
// data-model planner: boot now fires a fire-and-forget on-open sweep
// (GET /api/data-model/plan) after the stale-connector syncs; and the Data Model
// tab renders a review panel in #dm-panel (auto-applied fixes + Apply/Dismiss
// suggestions from the planner). Length + hash recaptured (combined on this v5.1
// branch with the desktop auto-update status-indicator client changes).
// v5.1 merge — traceable rendered context (PR #176) folded in: lattice:// references in
// the record context doc render as trace chips opening a provenance card (row fields +
// tier + Open), per-file source chips summarize each context file's origin table/count;
// chat answers use inline word-links that open the provenance card in place, text_final
// replaces accumulated deltas with deterministic trace links, and a lattice-ref may carry
// ?f=<column> so the record view scroll-flashes that field (files shingle-match the
// passage). Length + hash recaptured for the combined v5.1 bundle (planner panel +
// desktop auto-update + traceable context).
// v5.1 managed-auth token display: the account menu + the Configure→Assistant
// panel now show the prepaid token balance (read from /api/assistant/config's new
// balanceCents, which the config route fetches from the metering proxy's
// /v1/balance) with an "Add tokens" link; and the chat renders a friendly red
// "out of tokens" notice for an insufficient_credit 402 (with a top-up link)
// instead of the raw provider error. Length + hash recaptured.
// Out-of-credit notice fix: renderAssistantHtml now linkifies plain http(s)
// markdown links (the top-up link rendered as literal markdown before, since the
// chat mdToHtml has no [text](url) support) — scheme-restricted + escaped.
// Length + hash recaptured.
// 5.1.1 instant graph navigation: the live force-graph reveals on the FIRST fit
// instead of blocking behind the spinner until the physics settles (~5s on every
// click), and tracks the camera as the layout expands so it animates into place;
// node positions are cached per graph (schema | entity:<table>) so a revisit — or a
// Graph↔Tables toggle — re-seeds already-placed with no re-settle (force-graph
// initialPositions/onSettle/positions() + system-tables graphPosCache, cleared on
// workspace switch in reloadEverything); a cold first-visit layout also cools faster
// (~120 vs ~300 ticks) while it animates. Length + hash recaptured.
// 5.1.1 Files breadcrumb fix: on a file record the "Files" object crumb pointed at
// #/w/file/<table> (a record route fed the table name as a row id → "Row not found");
// it now opens the files-table collection #/w/table/<table>, mirroring the deleted-
// record + delete-nav fallbacks (fsBreadcrumb w:file case). Length + hash recaptured.
// 5.1.1 record-view markdown fallback: a record with no rendered context file no longer
// shows the dead "No rendered markdown for this record yet." — loadFsContext now falls
// back to the row's OWN columns (rowToFallbackMarkdown: title heading + long-form fields
// + a key:value list), rendered read-only, matching what the assistant reads from the
// row. Length + hash recaptured.
// 5.1.1 chat attachment persistence: attaching a file AND typing a message then sending
// both no longer drops the file from the bubble — appendUserBubble(text, fileNames) now
// renders the attached files as persistent chips below the message (stacked when there's
// text), sendChat passes the real text + file names (not the synthesized effectiveText),
// files are recorded in chatHistory, and loadThread re-renders them. Length + hash
// recaptured.
// 5.1.1 silent import: a brand-new structured drop no longer shows a confirm card —
// handleAutoImport routes 'new-dataset' to runInlineImportSilent, which auto-applies the
// whole proposal (every base table + row + ALL detected computed views) via
// /api/import/apply with a compact live-progress card and no Apply gate; marginal-link
// questions still enqueue to the assistant panel. 'needs-confirm' (undated known
// re-import) keeps its card. Length + hash recaptured.
// 5.1.1 auto-tidy after import: iiAutoTidy fires the data-model planner
// (GET /api/data-model/plan) right after an import completes (silent + confirmed
// paths), so the freshly-imported tables get safe normalizations applied immediately
// (the rest surface as one-click suggestions) instead of needing a manual reorg; a
// re-refresh shows any auto-applied change at once. Length + hash recaptured.
// 5.1.1 chat-awareness of in-progress ingestion: inline-import tracks iiActiveImports
// (+ the shared ingestProgressState) via ingestOrImportActive(); the composer sends
// ingestInProgress to /api/chat so the server prepends a note telling the model some
// data may still be importing. Length + hash recaptured.
// 5.1.2 import-safety hotfix: handleAutoImport now routes a low-confidence new-dataset
// proposal (server scale guard tripped) to the confirm CARD instead of silent import, so a
// pathological import (hundreds of tables / mostly-template / doc fan-out) can be reviewed +
// declined; runInlineImport sends override:true on explicit Apply (past the server table cap);
// the silent path's failure copy now says "Kept as a file" (not "Import failed"); the card
// shows the guardReason. Length + hash recaptured.
// 5.1.1 release-review fixes: (a) the file-record breadcrumb LEAF crumb no longer 404s —
// fsBreadcrumb's w:file prefix drops the table segment so the self-link is #/w/file/<id>,
// not the invalid #/w/file/files/<id>; (b) chat-awareness now sees file-ingest batches —
// ingestOrImportActive reads an outer-scope iiBatchIngestActive that ingest-progress-state
// mirrors from the IIFE-local ingestProgressState; (c) a files-only send no longer double-
// renders on reload — appendUserBubble suppresses the text bubble when it equals the joined
// file names. Length + hash recaptured.
// 5.2 brand-is-home: the topbar logo gets a real click handler in wireSettingsDrawer —
// it closes an open Configure/History takeover and lands on the workspace home. The bare
// <a href="#/"> was a silent no-op with the drawer open, because the hash beneath the
// takeover is usually already '#/' (closeSettingsDrawer parks it there) so no hashchange
// could fire. Modified clicks (cmd/ctrl/shift/middle) fall through to the href for
// open-in-new-tab. Length + hash recaptured.
// 5.2 DATA sidebar: the left section relabels Tables → Data, and its per-schema groups
// become three FIXED subheads — TABLES (the lattice schema, keeping the historical
// nav-schema-lattice group key so persisted collapse state survives), CONNECTORS (all
// connector schemas merged, ordered by source label), DATABASES (connected databases).
// Length + hash recaptured.
// 5.2 welcome-first home: '#/' redirects to the seeded Welcome dashboard (or the first
// dashboard) whenever one exists — a fresh workspace opens onto Welcome, and the
// Ask-Lattice landing survives only as the zero-dashboards fallback. Gated on the LIVE
// hash so the render-beneath-the-Configure-drawer path never redirects. Recaptured.
// 5.2 identity + managed workspaces: the account menu gains a provider-generic
// Sign in / signed-in-as row (identity service discovered server-side; loopback or
// pasted-code completion; membership sync toast). Managed sessions (the
// managedWorkspaces seam, cached on state at boot) collapse the new-workspace wizard
// and virgin onboarding to a single name→create flow (manager-provisioned cloud),
// replace the token-invite dialog with email-only invite, list the manager's
// memberships (incl. INVITED pending rows) with Kick→revoke, and drop the token-join
// affordances. Recaptured.
// 5.2 Sources panel: a per-row remove (✕) control on source roots + loose ingested
// files (wired to the root-registration + files-row delete endpoints, with a confirm
// and a refresh of the open Files surface); a de-dupe so a file that is both a source
// root and an ingested row shows once and one ✕ clears both; and the Configure → Files
// tab is now GRID-ONLY (the list/grid toggle retired) with the nested folder structure
// kept as expandable tile groups. Length + hash recaptured.
const ORIGINAL_LENGTH = 812551;
const ORIGINAL_SHA256 = 'bedcf547abfd8c299c0f050958b49e708ffa7e626c9bc7fa9465252fafc242b7';

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
