# Changelog

All notable changes to `latticesql` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

---

## [5.0.0] — 2026-06-28

Major release. The GUI is reframed around the data-modeling story —
**Inputs · Model · Outputs** — and gains the ability to **connect an external
database as an Input**. Underneath, three substrate features land together: a
self-maintaining, cloud-safe, and tunable **native vector search substrate**; a
live **force-directed brain graph** across all GUI graph surfaces; and
**auto-update made visible on every surface** (with an opt-out). Untuned/non-cloud
behavior matches prior releases; the public API grows additively (a new external-
database connector).

### Security

- **External-database connections are read-only, enforced in depth.** A
  connected database is a data source — Lattice must never be able to write to
  it. Every pooled connection now starts with
  `default_transaction_read_only = on` (the server itself refuses writes), and
  the connection wrapper additionally refuses any non-read statement
  (SELECT/WITH/SHOW/EXPLAIN only) before it touches the network. The connect
  dialog takes host/port/user/password/database fields only — raw connection
  strings are no longer accepted (pasting an owner/admin URL wholesale was the
  risk), and the UI recommends a read-only database user.

- **CSRF / DNS-rebinding hardening for the local GUI server.** State-changing
  requests and the realtime WebSocket upgrade now require a same-origin request
  and a `Host` header matching the bound loopback authority, so a web page you
  visit while the GUI is running can't drive the local API as you. Binding the GUI
  to a non-loopback address now requires an explicit `--allow-remote` opt-in.
- **SSRF guard on the generic MCP connector.** A user-supplied MCP server URL is
  validated (scheme + DNS resolution) and private / loopback / link-local /
  cloud-metadata targets are refused before any request is made.
- **Per-member connector key isolation.** Connector rows are namespaced by the
  per-member connection, so two members connecting the same external instance no
  longer collide on the shared primary key; connector sync errors are sanitized so
  a conflicting key value can't leak.
- **OAuth callback pinned to loopback** — the connector `redirect_uri` is derived
  from the bound loopback authority, not the request `Host`.

### Performance

- **Instant undo/redo state.** Header undo/redo availability is computed with
  bounded `COUNT` queries + an index instead of loading the session's entire audit
  log (with row snapshots) on every edit and navigation.
- **Credential key derivation is cached**, removing an event-loop stall during a
  large connector sync; the sync reuses one MCP transport across the run instead of
  reconnecting per parent, and prunes vanished rows in a single transaction.
- **Scoped realtime refresh** — a collaborator's edit invalidates only the changed
  table's cache, not the whole cache; relation chips skip heavy text columns.
- **The GUI shell is served with brotli/gzip** content negotiation.

### Added

- **External databases import their relational structure.** Single-column
  FOREIGN KEYs on the remote are introspected at connect time and materialized as
  graph edges between the imported tables (same machinery as the other
  connectors), so a connected database's rows arrive already linked.
- **Per-connection table namespacing.** Imported table names now carry a short
  connection-id suffix in addition to the database name, so two connections whose
  databases share a name (every Supabase database is `postgres`) can never merge
  into the same imported tables.
- **Table imports surface like file ingests.** A successful database import (and
  each refresh) publishes an activity-feed summary — the same live-feedback
  contract as dropping files.

- **MCP-backed connectors — connect any MCP server as an Input.** Connectors are
  now powered by the Model Context Protocol: Lattice runs as a **local MCP client**
  and pulls a server's read tools in as connected data types. Everything runs on
  your machine — a remote server is reached over Streamable HTTP or SSE with that
  server's **own OAuth** (tokens stored in the machine-local encrypted store), and a
  local server runs as a **stdio** child process. Nothing is routed through any
  cloud middleman. Ships with **Gmail**, **Google Calendar**, and **Google Drive**
  (typed schemas; point them at a Google-Workspace MCP server), **Jira** (Atlassian
  Remote MCP) and **monday.com** (both pre-pointed at their hosted endpoints),
  **Trello**, and a **generic "custom MCP server"** connector you point at any URL.
  Connector data keeps the same conventions as before — typed connected tables,
  per-member `private` visibility, FTS, graph edges, and rendered context. New
  public API: `McpConnector` / `isMcpConnector`, `McpConnectorBase` /
  `SimpleMcpConnector`, `introspectiveConnector`, the per-provider connector
  factories, and the `@modelcontextprotocol/sdk` optional dependency.
- **Folders view — objects as folders (now the default center tab).** A new
  **Folders** tab (first, and the landing view) shows the workspace's objects as a
  grid of folders. Double-click a folder to open it: its rows appear as "files"
  (icon by file type) and its linked objects nest as sub-folders (a linked object A
  shows inside B and B inside A). Clicking a file opens that record's page. A folder
  can be renamed in place (renames the object). Graph and Tables remain as sibling
  tabs.
- **Collapsible layout columns.** Each of the three columns — Inputs, Model,
  Outputs — has a collapse toggle in its header that shrinks it to a thin rail
  (state persisted in localStorage); the grid always keeps a flexible track, so you
  can focus any column.
- **Wire / Merge moved above the tab line and made global.** The **+ Wire** and
  **Merge** buttons now sit on the tab strip (beside Folders / Graph / Tables) and
  work in every view. **Drag** one object onto another to link them (many-to-many);
  **Shift-drag** to merge one into the other — on both the Folders tiles and the
  Tables cards. On the Graph, the buttons drive a click-to-pick flow (click a
  source node, then a target) so it doesn't fight the graph's own node dragging. Esc
  cancels a pick.
- **Inputs · Model · Outputs GUI reframe.** The desktop GUI / `lattice gui` is
  reorganized into three columns: **Inputs** (Files, Connectors, Databases),
  **Model** (two top-level tabs — **Graph** and **Tables** — where Tables is a
  tiered schema explorer (Source / Model / Derived / Surface) with Entity/Field
  views, a detail panel of fields + table/field lineage, relationship edges drawn
  between the tiers, and a **"+ Wire"** mode to link two tables), and **Outputs**
  (Artifacts, a Markdown view of the rendered context tree, a Tables mirror of the
  Model view, plus Server Docs / API Docs / MCP). Opening an object shows its rows
  as a table (mirroring the file list), with breadcrumbs rooted at Tables. The
  assistant moves from a docked rail to a floating **"Ask Lattice"** panel in the
  upper-right, and the live activity feed moves to a header popover next to the
  version-history clock. One shared client serves both the terminal GUI and the
  desktop app, so the reframe lands on both at once.
  - **Artifacts** are their own object/table view (a rows table at its own route),
    and opening an artifact roots its breadcrumb at Artifacts rather than Files.
  - A record has a **Formatted | Markdown** toggle: Formatted shows the rendered
    (compiled) markdown document; Markdown shows that same markdown in an editable
    textarea that writes round-trippable field edits straight back to the record
    (`PUT /api/tables/:t/rows/:id/context`). The old column-by-column field dump is
    gone, and a record now shows a single compiled document (no duplicate sections).
  - Clicking a Markdown file in Outputs opens it in the **center pane** (with a
    breadcrumb), replacing the slide-in detail drawer.
  - The **+ New workspace** dialog is a single step — enter a name (and, for a
    cloud workspace, the Postgres connection) and click **Create**; the optional
    starter-entities and review steps are gone (entities are added from the
    workspace itself).
  - Tables-explorer relationship edges render as **solid** strokes drawn **above**
    the cards (never hidden behind a table), and links between same-column tables
    loop out into the side gutter so they read clearly.
  - Object + Artifacts pages **paginate**: a Prev/Next pager with an "A–B of T"
    total (rendered "T+" when the count is large). The object page fetches one
    page at a time (server `limit`/`offset`); the total is an approximate,
    bounded, RLS-scoped count.
- **`Lattice.boundedCount(table, opts)`** — a new public query method: like
  `count`, but it stops after `opts.cap + 1` matching rows (default cap 1000) so it
  stays cheap on large tables, returning the exact count when `<= cap` or `cap + 1`
  to signal "more than cap". Used to compute the GUI's approximate pagination total
  without an unbounded `COUNT(*)`.

- **Tables-explorer "Wire" and "Merge" interactions.** In Model → Tables, both the
  "+ Wire" mode (link two tables many-to-many) and a new "Merge" mode work by
  clicking a source then a target **or** by dragging one table card onto another.
  While a source is held, invalid targets grey out (the source itself, junctions,
  and — for Wire — already-linked pairs). Merge moves the source's rows into the
  target and removes the emptied source via the same reversible primitive the
  assistant uses (`POST /api/schema/entities/:source/merge` — audited and
  restorable from history).

- **Edit a record as markdown.** A record's **Markdown** view is now an editable
  textarea; saving it writes the round-trippable fields (YAML frontmatter +
  `key: value` body) back to the row via `PUT /api/tables/:t/rows/:id/context`,
  using the same parser the file-watcher uses. Free-form prose that maps to no
  column is a deliberate no-op (never guessed at), and secret columns are never
  round-tripped (their served value is masked).

- **Connect an external database as an Input.** A new credential connector imports
  an external Postgres-family database (AWS RDS Postgres, Supabase, or generic
  Postgres) — by connection string or host/user/password — introspecting its schema
  and importing its tables as connected data types via the shared sync engine, so
  they appear under the Source tier. Credentials and the introspected schema are
  stored only in the machine-local encrypted store; imports are bounded (keyset/
  offset paged with a hard page cap).

- **Live force-directed brain graph across all three graph surfaces.** A new,
  dependency-free force-directed layout engine (many-body repulsion, degree-biased
  link springs, collision resolution, weak centering, alpha-cooled integration —
  DOM-free and fully unit-testable) drives a live SVG renderer with continuous
  animation, drag-to-pin, pan, pinch/wheel zoom, neighbor highlight/dim,
  zoom-to-fit, and incremental fly-in growth. It drives the schema **Graph** tab;
  the renderer loads out of band from `/gui-assets/force-graph.mjs`, so the inline
  host script only maps the schema model to a generic node/edge shape and wires the
  routing. (Object and folder pages now render as tables, not graphs.) The old
  static graph builders + hand-rolled layout simulation were removed.

- **Tunable + observable native vector index.** New optional knobs (all default to
  prior behavior): `embeddings.index = { m, efConstruction }` sets the pgvector HNSW
  build parameters, and `search()` / `hybridSearch()` accept `efSearch` to set
  query-time HNSW search breadth (`hnsw.ef_search`). A small internal registry
  (`__lattice_vector_index`) records each built index's dimension, params, source
  count, and build time; an auto-rebuild after a bulk refresh reuses the recorded
  params. New CLI: `lattice reindex <table>` (rebuild) and `lattice index status`
  (per-table index health), plus `lattice doctor --fix` to rebuild any index it
  reports as stale. (Configurable distance metric is deferred to a follow-up — it
  changes scoring semantics across the scan + both backends and warrants its own
  per-metric recall validation.)
- **Opt-in half-precision (`halfvec`) index storage** (pgvector ≥ 0.7) via
  `embeddings.index.quantization = 'halfvec'`: stores the derived ANN index at
  16-bit half precision — roughly halving its memory — while the embeddings store
  stays full precision, so the scan fallback (and any later full-precision rebuild)
  remains exact. Build, incremental maintenance, and query all cast to the index's
  actual column type. Default `'none'` (full-precision `vector`) is unchanged.
  Sharding / replication / a distributed index remain out of scope (see
  `docs/retrieval.md` § Scale) — Lattice runs against a single Postgres/SQLite;
  reach for a dedicated vector database when you outgrow that.
- **Semantic + hybrid search now work for cloud members, confined to the rows
  they may see.** A scoped cloud member has no grant on the internal embeddings
  store or the native vector index, so `search()` / `hybridSearch()` previously
  could not serve them. The vector arm now reaches the store only through a new
  `SECURITY DEFINER` function (`lattice_visible_embeddings`) that returns just the
  chunk vectors for rows the caller can see — filtered by `lattice_row_visible`,
  keyed on the member's own role — and scores them in-process. The member scan is
  exact (no recall loss) and has no over-fetch channel by which a member could
  infer the existence of rows hidden from it; row materialization additionally
  re-checks visibility via row-level security on the base relation (or the masked
  audience view). The routing is automatic — owners and local/non-cloud callers
  are unchanged.
- **`--no-auto-update` (and `LATTICE_NO_AUTO_UPDATE=1`) pin the GUI/desktop to the
  current version.** A new `autoUpdate` option on `startGuiServer` (default on) is
  the master switch: when off, the in-process update poll never runs (no registry
  or manifest fetch, no install, no relaunch) and `GET /api/update/status` reports
  `autoUpdate:false`. Intended for testing, air-gapped, and reproducible-demo runs.
- **The desktop app surfaces an "Update available — Restart to update" hint.** It
  probes the same release manifest its bundled updater applies from — read-only, so
  it never downloads or relaunches until you act — meaning a window left open for
  days still notices a new version. Acting on it applies the update via the bundled
  updater and relaunches.

- **Data provenance for every object.** A new `GET /api/provenance?table=<t>` (and
  `…/row?table=<t>&id=<id>`) traces where an object's data came from across three
  tiers — **raw** (uploaded files, connectors), **computed** (Lattice-created
  artifacts, imports), and **observation** (AI / learning-loop edits) — returning a
  generic tier-typed `{ nodes, edges }` graph. In the GUI an object's page now
  defaults to this provenance view (a force-directed graph or a grouped source
  table), and a single row's detail view gains a collapsed, lazy-loaded "Data
  provenance" panel. Reads are bounded (grouped aggregates / indexed lookups).
- **Lineage substrate (additive).** A new internal `__lattice_lineage` table records
  durable source→object edges (file-extraction, import-materialization), and a new
  nullable `_lattice_gui_audit.source` column persists which actor (`gui`/`ai`/…)
  produced each change — the basis for the observation tier. Both are additive (no
  data loss); the lineage table is `__lattice_`-internal (hidden from the Objects
  list, brain graph, and cloud-member grants).

### Changed

- **The legacy table/detail editor is absorbed and retired.** The record page's
  actions menu gains "Edit fields" — the structured typed-field editor plus the
  inline relationship manager (chips unlink, the picker links, both atomic) that
  previously lived only in the legacy `#/objects` view. `#/objects/*` now
  redirects to the unified pages, and the old table + detail renderers are
  deleted. Junction/system leftovers ("Other files") no longer display in the
  Markdown column.

- **One record page for everything.** Regular records, files, and artifacts now
  share a single page: the Formatted | Markdown toggle (a file's Markdown view
  shows its source; an artifact edits in place), visibility/privacy/sharing
  controls, the collapsible Data provenance panel, Connected objects, and a
  record actions menu (Version history + Delete) — on every record. Files and
  artifacts are sharable exactly like other rows. The separate file/artifact
  document renderer and its parallel view-mode state are deleted.

- **The right column is one Markdown view.** Renamed from Outputs; the separate
  Artifacts and Tables sections (which listed the same content as the markdown
  tree) are gone. The single tree lists every entity as a folder — same emojis
  as the Objects grid — with its markdown files inside, and Artifacts as just
  another category.

- **The Outputs Markdown tree mirrors the Tables list exactly.** One node per
  (non-junction) table, grouped in the same Source/Tables categories as the
  Tables mirror; each expands to the table's rollup + per-record folders.
  Junction context never appears (by construction), and stray root files no
  table claims trail under "Other files". Tables with no rendered context are
  listed with an empty state so the two lists never disagree.
- **One markdown surface.** Clicking a rendered .md in the Outputs tree now
  resolves it to its record and opens the record page (with its editable
  Formatted | Markdown toggle) — the separate read-only markdown viewer and its
  raw file-read endpoint are removed.
- **Nested tables indent under their parent in the Tables explorer.** A
  belongsTo (1:N) child renders indented to its nesting depth; the connector
  LINES between cards now mean many-to-many only.
- **Nesting and relationships are mutually exclusive.** Between any two tables,
  a belongsTo nesting and a many-to-many relationship can no longer coexist —
  and two tables can never nest into each other. Enforced in the shared
  junction-creation primitive (covering the assistant and auto-linking too),
  both schema routes, and mirrored in the pickers/drag targets with clear,
  surfaced errors.

- **Source-tier tables are excluded from the Objects grid and the graph.** Files,
  connector-synced tables, and imported database tables are raw inputs — they're
  browsed from the Inputs column and listed under the Tables explorer's Source
  column, never as first-class objects in the Objects/Graph views.

- **The Model → Tables explorer drops the "Derived · AI loop" column.** The tiered
  schema view is now three columns — Source · inputs, Model · entities, Surface ·
  app. Tables that were classified as derived (embeddings, proposals, learnings,
  observations, …) now group under Model like any other entity. The `Tier` type and
  its `classifyTier` heuristic drop the `derived` tier accordingly.
- **The native vector index now stays in sync with writes.** Previously
  `buildVectorIndex` produced a point-in-time snapshot that silently went stale as
  rows changed, so semantic search could return outdated results until the index
  was manually rebuilt. Now, once an index exists:
  - inserts / updates / deletes mirror the affected row into the index
    incrementally on Postgres/pgvector (on the same background path as the
    embedding write);
  - `refreshEmbeddings` reconciles the index after a bulk backfill;
  - `search()` verifies the index is in sync with the stored vectors before using
    it (a cheap count-parity check), and otherwise falls back to the exact
    in-process scan — so a drifted index is never silently served: at worst a
    slower query, never a wrong result.

  Backward compatible: tables without a native index are unaffected, the public
  API is unchanged, and default behavior matches prior releases.

- **`GET /api/update/status` now reports a surface-aware `action`**
  (`upgrade-in-place` for an npm install, `restart-to-update` for the desktop app,
  `none` otherwise) plus `autoUpdate`. The GUI's existing upgrade link uses it to
  show the right affordance per surface, instead of appearing only for a supervised
  npm install.
- **A development / linked checkout is badged `vX.Y.Z (dev)`** on the version chip
  (with an "auto-update disabled" tooltip), so a stale dev build can't be mistaken
  for an auto-updating install.

- **The brain graph shows object↔object relationships only.** `files` is a data
  _source_, not an object, so it is no longer rendered as a node in the brain graph
  (it remains a first-class entity everywhere else — the Objects list, the Sources
  tree, `/api/entities`). This changes the `/api/graph` payload content, not its
  shape.
- **Collapsible sidebar groups.** The top-level sidebar organizers (Files, Built by
  Lattice, Connectors, and Objects/System) are now collapsible, with state
  persisted per group.
- The object-type page's prominent "New &lt;object&gt;" tile is replaced by a "New"
  header action; row browsing remains available via "List view".
- **The assistant finishes a merge instead of leaving cleanup to you.** When you ask
  it to consolidate / merge one object into another, it now migrates the rows with
  the reversible `move_to` path and removes the emptied source itself — without
  asking first, and without ending the turn by telling you that you "can now delete
  the old object." The whole merge is recorded in version history, so it can be
  restored. (An explicit request to delete an object's data outright is still a
  separate, confirm-first path.)
- **Workspace switch (and boot / post-mutation reloads) no longer block on a disk
  scan.** The Objects list is served by a new `GET /api/entities-summary` that
  returns the tables + row counts WITHOUT the O(files) rendered-file scan the full
  `/api/entities` does — the GUI never read the scanned field. The schema-only
  brain graph (`/api/graph?schema=1`, the GUI's only graph mode) likewise skips that
  scan. Switching a large workspace now renders the sidebar / Tables / graph
  immediately instead of hanging until the scan finishes. `/api/entities` is
  unchanged for any consumer that wants the rendered-file list.

### Fixed

- **Back/Forward history is per-workspace.** The header navigation buttons now
  walk an app-managed history scoped to the active workspace — previously they
  used the browser history, which spans workspace switches (a switch is a soft
  reload), so Back could land on a record from the PREVIOUS workspace and render
  "Unknown object". A switch now lands on the new workspace's own last location
  (home on first visit), each workspace keeps its own stack for the session, and
  the buttons disable when there is nowhere to go.

- **The rendered Context/ tree reconciles itself — safely.** Table rollup files
  finally have a lifecycle record: the manifest now tracks every phase-1 rollup
  (`tableFiles`) and keeps a `retiredFiles` ledger of paths no longer produced
  (an `outputFile` change, a dropped table — e.g. the legacy root-level rollup a
  config upgrade re-homed). Reconciliation prunes retired files and stale
  entity trees under one hard rule: **a file whose content differs from
  Lattice's own last write is never deleted** — it is left in place with a loud
  warning, and the ledger retries only after it is gone. A renamed entity
  directory root now sweeps its old tree (previously orphaned forever), the
  ledger survives crashes between render and cleanup (entries persist until the
  file is actually removed), and reconciliation runs at workspace OPEN as well
  as after mutations — so rows deleted or un-shared while the app was closed no
  longer linger. A pre-upgrade manifest with no rollup history prunes nothing
  it cannot prove.
- **Manual file edits can no longer be lost to a render.** Every auto/background
  render first DRAINS pending manual edits into the database (changelog-
  versioned, marked `file-edit`) before rewriting any file — previously an edit
  made within the file watcher's debounce of a mutation-triggered render was
  overwritten on disk and vanished without a trace. Edits to generated table
  rollups (which do not round-trip by design) now produce a loud notice before
  the render restores them, instead of a silent clobber.

- **Junction tables no longer render their own context folders.** The canonical
  context derivation now excludes link tables on every surface (owner, member,
  openWorkspace) via one shared classifier — previously the member path excluded
  them and the owner path did not, so `Context/<Junction>/` trees and raw
  `<JUNCTION>.md` dumps appeared on some machines. A junction's content still
  renders where it belongs: as the many-to-many rollup inside each endpoint's
  context. Payload columns added to a junction later no longer silently promote
  it to a first-class entity.
- **Legacy root-level rollup files stop regenerating.** Early create paths
  persisted `outputFile: <NAME>.md` at the Context root into the config; the
  writer fix never migrated existing configs, so orphan rollups (e.g. a table
  rollup next to its own per-record folder) re-appeared on every render and
  could not be deleted. Opening a workspace now silently rewrites those values
  to the hidden `.schema-only/` home (idempotent, comment-preserving), and the
  owner-published cloud layout is sanitized the same way so members never
  hydrate the legacy shape.

- **Connect-a-database works, fails atomically, and never corrupts an import.**
  Connecting an external Postgres crashed with `no such table: __lattice_edges`
  and left a phantom connection behind. Three defects, all fixed: (1) composite-
  primary-key record ids were joined with a control character that the row
  sanitizer strips at storage time, so every freshly imported composite-PK row was
  judged vanished and soft-deleted by the same sync that inserted it — ids are now
  a sanitizer-safe JSON array of the key parts; (2) the prune's raw edge cleanup
  ran against a `__lattice_edges` table that a db-source workspace never creates —
  it now self-ensures the table (and runs before the soft-delete commit, so a
  failure can't strand hidden rows), and the exported `removeEdge` got the same
  guard; (3) a failed initial import now rolls the whole connection back (registry
  row, stored credentials, schema descriptor, imported rows) so a failed connect
  leaves nothing behind. A connected database also no longer double-lists under
  Connectors — it appears only in the Databases section.
- **The assistant handles dates.** It was never told the current date, so "the
  meeting I had today" resolved against the model's stale training cutoff and
  returned months-old rows; and `list_rows` read oldest-first by the row's
  `created_at` (insert/sync time), so "the most recent" surfaced the oldest match.
  Now the system prompt carries a `# Current date` section (server wall-clock +
  viewer timezone); `list_rows` returns newest-first by a real event-time column
  (a meeting's `start_at`) in preference to `created_at`, and exposes `orderBy` /
  `orderDir` / a date-range `filter` to the model; and the LIKE search fallback
  (the scoped-cloud-member path) now orders newest-first so a recent match can't be
  dropped by the row limit.
- **Every table gets a `deleted_at` column on open.** A table created without the
  soft-delete envelope (an import, or an older/non-standard path) had no
  `deleted_at`, so reversible delete, merge, and undo refused it ("no `deleted_at`
  column to reversibly remove"). The on-open data upgrade now backfills the
  standard nullable `deleted_at` on any user table missing it — existing rows read
  as live (NULL), no data changes — so the soft-delete envelope is universal. It's
  self-idempotent (only alters tables that currently lack the column) and
  fault-isolated per table. `deleted_at` was already a non-removable system column.
- **Secret values no longer leak into a record's Markdown view.** The rendered-
  context redaction only matched a plain `col:` line, so a secret column rendered in
  the default `- **col:** value` bullet crossed the wire in plaintext. Redaction now
  covers the bold-bullet, inline, and frontmatter shapes (the column name is regex-
  escaped).
- **Schema mutations are cloud-owner-gated.** Every config- or DDL-mutating schema
  route — create/rename/delete a table, add/change columns, add/remove a link, merge,
  and purge — now returns 403 for a scoped cloud member. These edit the owner's
  on-disk config (a raw file write that Postgres RLS does not protect, and which some
  routes perform before any DB DDL), so RLS alone can't gate them; local and
  cloud-owner paths are unaffected.
- **Multi-line field values now round-trip through the rendered Markdown.** The
  default renderer inlined a value's newlines into a single `- **key:** value`
  bullet, and the reverse-sync parser read one line per field — so a multi-line
  value (a description, a note, a PEM key) was silently truncated to its first line
  the next time any field on that record was saved. The renderer now writes each
  extra line as a 2-space-indented continuation line and the parser accumulates
  them, so a value survives a full render → parse → render cycle unchanged —
  including interior blank lines, a value whose first line is blank, and lines that
  look like bullets/headings/`key: value` pairs. A defense-in-depth guard still skips
  a "value is only the stored value's first line" derivation so a stale parse can
  never drop lines. Secret multi-line values are masked whole (every continuation
  line, across interior blank lines), not just their first line, before the context
  crosses the wire.
- **The schema-only brain graph no longer runs the O(files) rendered-file scan.**
  `GET /api/graph?schema=1` (and the table-filtered history route) gathered table
  names via the full disk scan before building the graph; they now use the no-scan
  loader, completing the workspace-switch speedup for the graph the ingest animation
  depends on.
- **The Tables explorer no longer shows a previous workspace's relationships after a
  switch.** Its cached relationship edges and any in-flight Wire/Merge selection are
  reset on workspace switch, so the new workspace's schema is drawn from scratch.
- **Drag-to-wire/merge cleans up after a cancelled gesture.** A touch-scroll or OS
  gesture-takeover (`pointercancel`) now tears down the drag (its document
  listeners, the dragged-card highlight, and the greyed-out targets) instead of
  leaking them across gestures; `.mt-card` sets `touch-action: none` so a touch drag
  doesn't scroll the page mid-gesture.
- **A record's Markdown edit can't save into a record you've navigated away from.**
  The debounced write-back captures the render generation and bails if the view has
  been superseded, so a pending save — or its failure notice — never lands on a
  no-longer-visible record.
- **Merging one object into another is now lossless, safe, atomic, and asks when it
  can't proceed.** The merge (drag-to-merge, or the assistant's `move_to`) could drop
  source-only fields, duplicate rows on a history restore, declassify a secret,
  hard-fail with jargon over its size cap, and — worst — throw partway through and
  leave rows split between the two objects. Now it: adds any missing fields to the
  target so nothing is dropped; refuses a source whose rows aren't soft-deletable
  (they can't be reversibly removed); refuses to move a secret field into a
  non-secret target; over the auto-merge size limit, hands the decision back to ask
  the user instead of dead-ending the assistant; type-checks every value against the
  target's columns up front (so an incompatible value aborts before anything moves);
  and runs the entire move inside a single database transaction, so it either
  completes fully or changes nothing — it can never leave the two objects half-merged.
  Backed by a new public `Lattice.transaction(fn)` primitive: every write `fn`
  performs commits together or rolls back together, with read-your-writes inside the
  transaction, scoped per async context so concurrent callers never share one.

- **Merge carries inbound links across instead of dead-ending.** Merging an object
  that another table links to used to fail with "these links point at it — remove
  those links first," forcing you to manually unlink everything before merging. Now
  the merge rewires those links onto the target: each linking table's foreign keys
  are updated to the moved rows and its relation is repointed to the merged object,
  all inside the same transaction as the move. The link table and its column keep
  their names. (A plain delete of a linked-to table still refuses — there's no
  target to move the links to — but now suggests merging instead.)

- **Link tables are hidden from every object list, not just the graph.** Junction /
  link tables (e.g. `Files_<entity>`) cluttered the Outputs > Markdown panel AND the
  Model > Tables/Entities list with apparent duplicates. They're now hidden from the
  Markdown panel, the Tables/Entities list, the sidebar, and graph nodes — the same
  way the brain graph draws junctions as edges, not nodes. This also catches
  _physical_ link tables created without declared relations (e.g. an AI-built
  `files_<entity>` shaped `(id, name, x_id, y_id)`) via a display-only column-shape
  rule that never touches the strict, deletion-safe junction check.
- **Outputs Markdown no longer leaks across workspaces.** Switching workspaces
  refreshed entities, the sidebar, and the chat rail but not the Outputs column,
  so the Markdown context tree (and Tables mirror) kept showing the _previous_
  workspace's rendered context until a hard reload. `reloadEverything()` now
  re-renders Outputs on every switch, scoped to the active workspace.
- **The brain graph now populates in realtime during ingestion.** When the graph
  was opened on an empty workspace it showed the empty-state and never created a
  live renderer, so objects added afterward (e.g. while ingesting files) didn't
  appear until a manual refresh. The ingest animation now does a full graph render
  when no live handle exists yet, so the first objects fly in as they're created.
- **The brain graph stays in the viewport.** Panning, zooming, or dragging a node
  can no longer push the objects out of the visible window — the stage translation
  is clamped so the graph's bounding box always remains on-screen (fully inside
  when it fits the pane, always covering the pane when zoomed in), and a dragged
  node is held within the visible area.
- **The `sqlite-vec` index build is now atomic** — its rows are populated inside a
  single transaction, so an interrupted build can no longer leave a half-filled
  index that looks complete.

---

## [4.3.8] — 2026-06-25

Patch release. Finishes the job 4.3.7 started: makes the **entire class** of
open-time forward-migration failure non-fatal, so a 3.x-created cloud whose schema
has drifted from what 4.x declares always opens.

### Fixed

- **Opening a 3.x-created cloud no longer aborts when the legacy `files` backfill
  runs before its target columns exist.** The `files` reference-model backfill ran
  `UPDATE files SET ref_kind = …, ref_uri = path, ref_provider = 'fs' WHERE …` but
  on a 3.x `files` table the 4.x reference columns (`ref_kind` / `ref_uri` /
  `ref_provider` / `blob_path`) don't exist yet — the schema reconcile that adds
  them is backgrounded on a cloud open — so the synchronous backfill threw `column
"ref_kind" does not exist` and aborted the open. The backfill is now
  **self-sufficient**: it introspects the `files` columns once and adds only the
  missing reference columns (all `TEXT`, matching the native schema) before the
  `UPDATE`. Adding only the _missing_ columns keeps it idempotent across re-opens
  on SQLite too (whose `ADD COLUMN` is not idempotent, and the legacy `path` keeps
  the backfill gate live).

### Changed

- **Every open-time data upgrade is now fault-isolated — a failing migration is
  warned and skipped, never fatal to the workspace open.** A 3.x-origin schema can
  drift from what 4.x declares in ways no single migration anticipates; rather than
  fix each statement reactively (a `timestamptz` `deleted_at`, then a missing
  `files` column, then …), the open-time data-upgrade pass now runs each step under
  fault isolation and continues. Each step is a sentinel-gated, single-statement
  `db.migrate` — atomic and idempotent — so a skipped step leaves no partial state
  and re-runs on the next open (its sentinel is only stamped on success),
  self-healing once the schema converges. Schema-reconcile DDL (creating declared
  tables, the embeddings/full-text-search index builds) deliberately stays
  fail-fast: those steps are multi-statement and not yet atomic, so a failure there
  is surfaced loudly rather than silently degraded into a half-migrated table.

## [4.3.7] — 2026-06-25

Patch release. The real Postgres-cloud upgrade-blocker fix.

### Fixed

- **Opening a 3.x-created Postgres cloud whose `deleted_at` column is a real
  `timestamptz` no longer aborts the workspace open.** The legacy `deleted_at = ''
→ NULL` normalization ran `UPDATE … WHERE deleted_at = ''` over every table with
  a `deleted_at` column. On a `timestamptz` column that predicate forces Postgres
  to parse `''::timestamptz` at **plan time** — invalid input that throws
  regardless of the data (a `timestamptz` column can't even hold `''`) — so it
  aborted the entire open with `invalid input syntax for type timestamp with time
zone: ""`. The normalization is now **type-aware** (it only touches text-typed
  `deleted_at` columns — the only ones that can hold the legacy `''` sentinel; a
  `timestamptz` one is correctly skipped) and **per-table fault-isolated** (one
  un-normalizable table is warned and skipped, never fatal). This is the actual
  root cause that 4.3.3's `strftime` change did not address; 4.3.6's failing-
  statement diagnostic pinpointed it.

## [4.3.6] — 2026-06-25

Patch release. Postgres error diagnostics.

### Changed

- **A failing Postgres query now names its statement in the error.** A bare
  Postgres message — e.g. `invalid input syntax for type timestamp with time
zone: ""` — identifies neither the query nor the table/column, so a failure deep
  inside an open-time convergence was undebuggable from the message alone. The
  adapter now appends `[lattice-sql] failing statement: <sql>` to any query error
  (once, across all query paths incl. transactions). No behavior change on the
  success path. This makes the kind of upgrade-time cast error that 4.3.3
  addressed self-locating if one still surfaces on a specific deployment.

## [4.3.5] — 2026-06-25

Patch release. A desktop-only fix so the downloadable app is usable on Windows
(**additive — no library API change**; every 4.3 caller runs unchanged).

### Fixed

- **The desktop app now opens on Windows.** On some Windows machines the embedded
  WebView2 host fails to create its environment and aborts the process natively —
  before any window appears — even though the GUI server is already serving. The
  abort throws no catchable error, so the app left the user with no window. The
  desktop app now opens the GUI in the user's default browser on Windows (it
  renders the exact same local server); macOS and Linux keep the native window.
  Two env overrides: `LATTICE_DESKTOP_BROWSER=1` forces the system browser on any
  OS, and `LATTICE_DESKTOP_WEBVIEW=1` forces the native window (for when the
  Windows webview host is fixed upstream).

## [4.3.3] — 2026-06-25

Patch release. Postgres-cloud upgrade-blocker fix.

### Fixed

- **Opening a 3.x-created Postgres cloud workspace on 4.x no longer fails with
  `invalid input syntax for type timestamp with time zone: ""`.** 3.x persisted
  nullable TEXT timestamp columns as the empty string `''`; the SQLite-compat
  `strftime` polyfill cast its argument straight to `timestamptz`, so an open-time
  query over a legacy `''` value threw and aborted the whole workspace open (a hard
  upgrade blocker — the only workaround was staying on 3.x). The polyfill now
  returns `NULL` for an empty, whitespace, or otherwise unparseable time string —
  matching SQLite's `strftime` semantics — instead of casting and throwing. It is
  installed with `CREATE OR REPLACE` (inside a privilege-safe `DO` block), so an
  already-secured cloud's prior, unsafe function is **upgraded** the next time the
  owner opens it; a scoped member's no-op replace can't abort its transaction.
- **3-arg `strftime(format, timestring, modifier)` now works on Postgres.** The
  changelog retention prune emits SQLite's 3-arg form (`strftime('%Y-…','now','-N
days')`); Postgres had no 3-arg overload, so the prune raised `function
strftime(…) does not exist`. Added the overload (applies the modifier as an
  interval, empty/invalid → `NULL`).

## [4.3.2] — 2026-06-25

Patch release. Workspace data-isolation fix.

### Fixed

- **Source roots no longer leak across workspaces.** The Files sidebar's
  registered folder roots were stored in a single machine-global `sources.json`,
  so switching to — or creating — another workspace still showed the previous
  workspace's folders. Each workspace now keeps its own roots registry next to
  its config (`dirname(configPath)/sources.json`), scoped to that workspace and
  never shared. Installs that registered roots before this release adopt them,
  once, into the first workspace opened after upgrade — the legacy global file is
  then **retired**, so no other or newly created workspace re-inherits them.

## [4.3.1] — 2026-06-25

Patch release. Bug fixes on 4.3.0.

### Fixed

- **On-device voice dictation** — fixes "no available backend found / Importing a
  module script failed". onnxruntime-web loads its wasm backend via a runtime
  dynamic `import()` of `ort-wasm-simd-threaded*.mjs`, which esbuild does not
  inline; the build now ships those `.mjs` next to the `.wasm` under
  `/gui-assets/ort/`. The visible "Downloading voice model…" state is removed
  (silent), and the worker + model are warmed up in the background on launch so
  dictation is ready on first use.
- **Form elements** — the generic input rule and the modal field-input rule both
  styled radios/checkboxes as boxes (`width:100%` + border), mangling them. Both
  now exclude radio/checkbox (native rendering, accent-tinted), and the
  New-workspace "Kind" selector is a clean set of cards with a blue-highlighted
  selection.
- **Files tree** — an expanded folder no longer snaps shut when an in-progress
  ingest re-renders the sidebar; expanded folders + their lazily-loaded children
  are preserved across the re-render.
- **Brain Graph tab** — clicking through object-to-object graph exploration could
  leave the shared Brain Graph tab renamed to a record's name; the record renderers
  now only retitle a record (`item:`) tab, never the graph tab.

### Added — macOS `.pkg` download (no "damaged" block)

The macOS download is now an **unsigned `.pkg` installer** wrapping the same
self-contained desktop app (no Node prerequisite), built in the release workflow
(`scripts/build-mac-pkg.sh` + `desktop:build:mac:pkg`). A browser-downloaded
`.app`/`.dmg` is quarantined and (pre-notarization) hard-blocked by Gatekeeper as
"damaged"; a `.pkg` instead gets the soft "unidentified developer" prompt and
**installs the app into /Applications itself**, so the installed app is not
quarantined and launches cleanly. The `.dmg` is still published as the in-app
auto-update artifact (`latest.json` is unchanged), so existing installs keep
updating. Developer-ID signing + notarization slot into the same script once the
Apple account is approved.

## [4.3.0] — 2026-06-25

Minor release. Two additive features — **connectors** and inline **HTML files**
in the GUI assistant. Additive on 4.2 (every 4.2 caller runs unchanged); the
connector layer and its optional dependency are inert until a connector is
configured.

### Added — Connectors

Sync external sources into Lattice as a new kind of table, the **connected data
type**.

- **Connected data types.** A table can declare `source` on its
  `TableDefinition` to mark it as backed by an external system. The framework
  adds connector-lineage columns (`_source_connector_id`, `_source_model` —
  immutable; `_source_synced_at`), stamped at ingest. The natural key is the
  primary key, so re-syncs upsert idempotently and the lineage is preserved on
  conflict. New module `src/schema/connected.ts` (`ConnectorSource`,
  `connectedColumns`, `ConnectedSourceImmutableError`); new accessors
  `db.getConnectedSource(table)` / `db.connectedTables()`.
- **Connector framework** (`src/connectors/`). A small fetch/auth SPI
  (`Connector`: `authorize` / `completeAuth` / `listChanges` / `disconnect`, with
  an optional credential `connect` for token-based sources), an on-demand registry
  (`__lattice_connectors`), a sync engine, and a teardown cascade. Driven entirely
  by per-model descriptors — no per-product code in the core.
- **Jira connector** (`src/connectors/jira/`). Talks to Jira Cloud's REST + Agile
  APIs directly via the **optional** dependency `jira.js` (lazy-loaded — the
  package compiles and runs without it; a clear error is thrown only when the
  connector is actually used), authenticated with the user's own Atlassian
  credentials (site URL + email + API token, HTTP Basic) — no broker service, no
  extra API key. Six connected data types (projects, issues, comments, users,
  boards, sprints) with FK relations that derive graph edges and FTS on text
  columns; comments are fetched per issue and sprints per board.
- **Sync engine.** `syncConnector` (idempotent upsert, per-parent fetch for
  comments, vanished-row pruning, graph-edge derivation), plus `syncIfStale` /
  `syncStaleConnectors` for "sync on connect, on load if older than an hour, and
  on manual refresh" — no scheduler. `syncStaleConnectors` is scoped per member.
  Reads are bounded + projected; an external-sync failure is recorded on the
  connector and re-thrown (never swallowed).
- **Incremental per-parent sync.** A per-parent model whose parent declares an
  `incrementalColumn` (Jira comments → the issue `updated` timestamp) only
  re-fetches children of parents changed since the last sync — bounding an
  O(parents) crawl on a large source. (The incremental pass skips pruning, since
  its seen-set is partial.)
- **Disconnect teardown.** `disconnectConnector` soft-deletes every ingested row
  (children before parents), prunes rendered context files, marks the connector
  disconnected (or removes it in hard mode), and drops the stored credentials.
  Soft-deleted rows drop out of queries, search, and graph traversal
  automatically.
- **Cloud ACL.** `enableConnectorRls` enables per-member Row-Level Security on
  the registry + a toolkit's connected tables and applies each type's default
  visibility (`private` per member, or `everyone`). `secureConnectorTables` lets
  the owner define + secure every toolkit's tables on workspace open (so a table
  first created in a member's session is still RLS-protected); the GUI runs it on
  load. Connectors key per-member identity on the cloud `session_user` (the role
  RLS ownership uses) so the connector partition and row ownership agree. All
  owner-only; no-ops on SQLite / non-cloud / non-owner. Derived enrichment over
  connected rows inherits source visibility via the existing source-gated fold.
- **GUI connectors.** A **Connectors** settings tab to enter your Jira
  credentials (site URL + email + API token) and connect / refresh / disconnect,
  backed by server routes (list / connect / refresh / disconnect + a
  `sync-if-stale` load hook). Credentials are validated on connect and stored in
  the machine-local encrypted credential store. Connected data types are marked
  with a "Connected" badge in the Objects list (`/api/entities` reports a
  per-table `connectorToolkit`).

### Added — GUI layout redesign

The desktop/web GUI is reorganized around the data graph.

- **Tabbed center pane with the brain graph as the default view.** The schema /
  data-model graph moves out of Settings and becomes the main center view: a
  permanent, non-closable **Brain Graph** tab plus one closable tab per opened
  object, file, or page (router-driven — a tab is a hash, so re-opening dedups and
  closing the active tab falls back to a neighbor). Clicking a graph node opens
  that object's table in a tab. The graph shows only objects that have rows
  (non-empty filter). Schema/column editing stays in **Settings → Data Model**,
  now an entity list + editor.
- **Sources sidebar.** The left sidebar is reorganized into three peer sections —
  **Files** (a lazy, infinitely-nestable tree of on-disk roots; "Files never leave
  your computer"), **Artifacts** (Lattice-created files), and **Connectors**.
  Adding a file or folder uses a native OS picker and ingests it in place
  (`local_ref`, no copy); a folder is a bounded breadth-first ingest. A new
  local-only `sources-routes` backend (gated by `LATTICE_LOCAL_OPEN`) registers
  roots in a machine-local store, lists **one directory level at a time**
  (entry-capped, confined to a registered root, symlink-safe), and never touches a
  path outside a root. The flat Objects list remains in Advanced view.
- **Single top-right status indicator.** The scattered progress/update pills
  (offline queue, applying-update, workspace switch, background render) collapse
  into one indicator in the tab strip that shows exactly one status at a time
  (highest priority, ties → most recent); a still-active lower-priority status
  resumes when a higher one clears. An ingest burst surfaces an "Ingesting…"
  status. The cloud-connection dot stays in the workspace switcher; per-card
  render bars stay.
- **Live brain-graph ingestion animation.** While the graph is the visible view,
  ingesting files animates the result in place: new object nodes bubble in and new
  edges draw, live, with no reload. The animation re-fetches the authoritative
  graph, seeds existing node positions from the prior layout + runs a short relax
  (so settled nodes barely move), and animates only the delta (capped, with a
  whole-stage fade above the cap; honors `prefers-reduced-motion`). A background
  refresh no longer rebuilds the graph out from under the animation.
- **File / artifact document view: two views, in-place edit, version history,
  soft-delete.** Opening a file or artifact shows the **formatted view only** (no
  column-by-column dump) with a toolbar: **View Source** toggles to the raw
  markdown/HTML/extracted text (per-tab, independent); **Version History** lists
  the row's edit trail from the audit log (`GET …/rows/:id/history`, now
  implemented + bounded) with Revert; **Remove** is a recoverable **soft-delete**
  that never touches the on-disk file. Editing an artifact's body writes
  `extracted_text` on the **same row** (`PUT …/rows/:id/content`, audited → kept in
  history) — it never spawns a new file.

### Changed — GUI redesign refinements

- **Realtime activity flashes in the top-right status indicator** instead of
  rendering persistent pills in the right rail. Each change shows briefly as it
  happens, then clears; the rail is reserved for the assistant conversation. The
  live brain-graph ingestion animation is unchanged (ingests still land on the
  graph).
- **Brain graph.** Every relationship renders as a solid **green** many-to-many
  link — the foreign-key edge style and the FK/many-to-many legend are removed
  (foreign keys are deprecated). Scroll-to-zoom is now smooth and proportional
  (scales by the scroll delta rather than a fixed step) and is capped at the fit
  view — the outermost objects plus their padding — so you can't zoom out into
  empty space.
- **File / artifact view.** The toolbar buttons are consolidated into a dropdown
  menu beside the title (**View source**, **Version history**, **Delete**). View
  source and Version history are now full-page modes that replace the body (no
  overlay panel); **Remove** is renamed **Delete**. The tab now shows the file's
  name (e.g. "Properties Dashboard") rather than the object name.
- **PDF preview renders inline again.** The blob route's `sandbox`
  Content-Security-Policy — which also blanked the browser's built-in PDF viewer —
  is no longer sent for `application/pdf`; `X-Content-Type-Options: nosniff` plus
  the declared type still prevent a non-PDF being interpreted as HTML.
- **Files sidebar lists ingested source files**, not only registered on-disk
  roots — so existing files show even before a folder is added. Adding a single
  file ingests it (it appears as a loose file) instead of registering a one-file
  root that would double it.
- **Default inference aggressiveness is now 0.85** (was 0.5).
- **Drag-drop / paperclip uploads stage first.** Dropping files on the rail (or
  picking them with the paperclip) now stages them in a review tray — each file
  listed with a ✕ to drop it, plus **Send** to ingest the batch or **Cancel** to
  discard — instead of auto-ingesting on drop. Send runs the existing
  bounded-concurrency ingest.
- **The object page is a focused graph.** Opening an object (e.g. "Insured
  Properties") shows a zoom-in of the brain graph: the object at the center, its
  entity rows around it (bounded fetch with a "Show more"), and its related
  objects on the rim. Clicking an entity opens its tab; clicking a related object
  zooms into that object's graph. A "List view" toggle keeps the tile grid.
- **Files open as their on-disk folder hierarchy.** The Files object page shows the
  registered folder roots and any loose files as graph nodes; clicking a folder
  drills into it (`#/folder/<path>`) and shows that folder's immediate sub-folders
  and files, and so on. A file's breadcrumb runs through its folders
  (`Home ▸ Files ▸ Downloads ▸ claude-ai.svg`); each folder crumb is clickable.
- **Tab overflow.** Tabs shrink to fit the strip (no horizontal scrollbar); past a
  minimum width the trailing tabs collapse into a "⋯" menu that lists them with a
  ✕ to close. The active tab stays visible; the strip re-fits on resize.
- **Connectors moved to a left-sliding "Add a Connector" dialog** (opened from the
  Sources sidebar), out of the Settings drawer. The panel is data-driven off
  `/api/connectors` — each toolkit renders as a card with its logo, a credential
  form built from its declared fields, and refresh/disconnect when connected.
- **Sidebar labels.** "Files never leave your computer" gains a lock icon and
  reads "Secured: files never leave your computer"; "Artifacts" → "Built by
  Lattice"; the brain graph shows the build caption "A live force-directed graph
  that builds as Claude streams" and uses smaller node labels.

### Fixed — GUI + assistant

- **Google Analytics counts one machine as one user.** The embedded webview drops
  gtag's own client-id cookie between sessions, so active users inflated to roughly
  one-per-session. The server now mints a stable, machine-local, anonymized
  analytics id (a random UUID — no PII) and the GUI pins GA's `client_id` to it.
- **Live brain graph updates on any structural change**, not only ingests — an
  assistant-created object (or a row that takes a table from empty to non-empty)
  appears without a manual refresh.
- **The file-actions dropdown no longer sticks open** (its `display:flex` was
  overriding the UA `[hidden]` rule).
- **Schema edits are steered away from managed objects.** Adding a column to a
  managed object (files/secrets/…) is refused with a deterministic, user-facing
  message that points to modeling the new attribute as its own object the records
  link to — so the assistant never mangles a managed table.
- **A chat message is connected to the files attached to it.** Files dropped into
  the composer are now ingested FIRST, then the message is sent referencing the
  just-added files, so the assistant works on exactly what was attached (any file
  type, single or many) with its existing file tools — instead of replying that it
  "doesn't see any attached files". The model-facing note is grounded against the
  visible files table (stale/invented ids are dropped). See
  `docs/bugs/2026-06-25-chat-attached-files-not-connected.md`.
- **The Files tree mirrors the real filesystem.** A folder nested inside another
  registered root no longer also appears at the top level; the containment check is
  separator-agnostic so it holds on Windows too.

### Added — Trello connector + data-driven connector layer

Sync **Trello** into Lattice as connected data types (boards, lists, cards,
members, labels, comments, checklists — 11 namespaced `trello_*` tables, with
junction tables for the many-to-many edges). Authenticated with your own Trello
API key + token (validated on connect, stored encrypted); no broker service and
no new dependency (it talks to Trello's REST API over the built-in `fetch`).

The connector layer is now **data-driven for scale**: a `CredentialConnector` SPI
plus a `presentation()` (label + logo) on every connector, a single
`builtinConnectors()` catalog as the one registration point, and multi-connector
routes — so adding a connector is a module plus one catalog line, with **zero**
GUI changes. Sources stay distinct and namespaced (`jira_*` vs `trello_*`): no
shared tables, no cross-source edges. Jira is migrated onto the same SPI.

### Added — On-device voice dictation (keyless)

The assistant composer's 🎙 dictation now works with **no API key and no setup**,
fully **on-device**: speech is transcribed in the browser by Whisper (WASM, via
transformers.js) running in a module Web Worker — audio never leaves the machine.
The model (~`whisper-tiny.en`, quantized) downloads once on first use from a
public host and then caches; no voice data is ever uploaded. Dictation in the GUI
is **always on-device** — there is no voice-provider choice in the UI and the 🎙
mic always shows. The keyed cloud Whisper / ElevenLabs transcription route stays
available to **API** callers for backward compatibility (`voice_provider` and
`POST /api/assistant/transcribe` are unchanged), but the GUI never calls it.
Failures are surfaced loudly (worker/model-load, decode, empty transcript) and
never insert empty text.

The on-device assets (the worker bundle + ONNX-Runtime WASM) ship in the package;
the model weights do not (download-on-first-use). The build step that vendors them
is **fail-soft** — built from an optional build-time dependency
(`@huggingface/transformers`, a devDependency); if it is absent the package still
builds, and on-device dictation then fails loudly at use time (the GUI has no
silent cloud fallback). `GET /api/assistant/config` still reports `voiceMode` +
`localVoiceAvailable` for API callers, and the assets are served from `GET
/gui-assets/*` (same-origin, path-traversal-safe).

### Added — Inline HTML files

Inline HTML files in the GUI assistant; this also retires the never-published
`lattice connect` surface in favour of it.

- **Create & edit HTML files from chat, rendered inline.** The GUI assistant gains
  two tools — `create_html_file` and `edit_html_file`. Ask it for a page, a report,
  or a chart of your data and it authors a complete standalone HTML file that is
  saved like any other file and rendered live in the main content view (a sandboxed
  `srcdoc` frame). Ask for a change while viewing it ("make it a pie chart",
  "recolour the header") and the open view updates in place — no page refresh. HTML
  files are distinguished from markdown artifacts in the file list and preview.
- **Tool-delegated authoring.** The HTML authoring runs as a focused sub-call —
  its own HTML-specific system prompt and a larger output budget (`TurnParams`
  gains an optional `maxTokens`) — on **the strongest model the resolved auth can
  actually run**: a stronger model (`claude-sonnet-4-6`) for an Anthropic **API
  key** (entitled to all GA models), and the **chat model** (`DEFAULT_MODEL`) for
  a connected Claude **subscription**. A subscription is entitled only to the
  models on the user's plan — a model the plan lacks returns a
  `429 rate_limit_error` on _every_ call (even a one-token one), so a hardcoded
  model would make authoring fail 100% of the time for those users. Picking by
  auth kind keeps authoring strong for API keys and working for subscriptions. It
  uses the same machine-local Claude auth as the rest of the assistant.
- **Live data + offline charts.** Authored pages read live data through an injected
  `window.lattice` bridge (`.query` / `.get` / `.search`), which a read-only,
  table-gated parent broker services against the existing read API
  (`/api/tables/:table/rows`, `/api/search`) — no new HTTP endpoints. A charting
  library is bundled with the GUI and injected into the frame, so pages draw charts
  with no CDN and fully offline.

### Security

The authored HTML is treated as **untrusted code** and runs fully isolated:

- **Origin-isolated frame.** Rendered in an `<iframe sandbox="allow-scripts">` (no
  `allow-same-origin`, `allow-popups`, `allow-top-navigation`, or `allow-forms`), so
  it loads in an opaque/null origin and cannot reach the host GUI's
  window/DOM/storage/cookies or the chat.
- **No network egress.** The injected Content-Security-Policy is emitted as the
  unconditional first element of the document (the authored markup is confined to
  `<body>`, so it can never run before the policy), with `connect-src 'none'` plus
  `child-src` / `frame-src` / `object-src` / `worker-src` / `manifest-src 'none'`
  and `img-src`/`font-src`/`media-src data:` — the page cannot `fetch`, open a
  socket, beacon, or load a remote resource.
- **Read-only, mediated data access.** The frame has no direct API access; all reads
  go through the parent broker over `postMessage`, which (a) only honours messages
  whose source is the frame's own window, (b) allows exactly three **read** ops, and
  (c) refuses `secrets` / `chat_*` / `_lattice_*` tables. Server-side RLS still
  applies, so a cloud member only ever reads rows they may already see.
- **Executable artifacts are provenance-gated.** `artifact_type='html'` — the marker
  that makes a file render as an executable page — can be set ONLY by the trusted
  `create_html_file` / `edit_html_file` tools (`guardReservedFileColumns`); generic
  `create_row` / `update_row` / `bulk_update` and the HTTP row routes are refused.
  The same gate also reserves rewriting an existing html artifact's BODY
  (`extracted_text`) to the trusted edit tool, so a caller (or a prompt injection)
  can neither plant a new executable page nor swap the contents of one another
  member would render.
- **Known residual.** A sandboxed frame can still navigate _itself_ (e.g. `location =`),
  which no cross-browser CSP directive blocks; this is inherent to in-browser
  rendering of untrusted scripts. It is bounded by the provenance gate (only
  first-party-authored pages execute) and RLS (the broker serves only the viewer's
  own data), so it does not exceed the assistant's existing prompt-injection surface.
  Rendering on a distinct throwaway origin is recorded as a future hardening.

The design was adversarially reviewed (multi-agent red-team with independent
verification) and the findings folded into the above.

### Removed

- **The `lattice connect` command** and its `--dashboard <file|folder>` "serve your
  own HTML at `/`" surface (added in an unreleased branch, never published) are
  removed — superseded by AI-authored inline HTML files. The encrypted,
  machine-local Claude key it used to onboard is unchanged; set or change it from
  the GUI's assistant settings.

### Changed

- **Cloud query pool routes through Supabase's transaction-mode pooler.** A
  cloud workspace on a `*.pooler.supabase.com` connection now opens its query
  pool against the transaction pooler (port 6543) instead of the session pooler
  (5432). Session mode pins one scarce upstream slot per pooled client for its
  lifetime, so a small `pool_size` (commonly 15) was exhausted by the pool + the
  realtime `LISTEN` client + a burst of concurrent queries — surfacing as
  `EMAXCONNSESSION` and failing queries under load. Transaction mode hands the
  upstream connection back at COMMIT and multiplexes many clients over far fewer
  slots; the adapter holds no cross-statement session state, so it is
  transaction-pooler-safe. The realtime broker keeps its dedicated session-mode
  connection (LISTEN/NOTIFY requires it). Only Supabase pooler hosts on :5432 are
  rewritten; direct/non-Supabase/already-:6543 URLs are untouched. Set
  `LATTICE_PG_SESSION_POOLER=1` to opt out.
- **A connected Claude subscription is strictly preferred over an API key.** When
  both are configured, the assistant uses the subscription (OAuth). It previously
  did too — except a transient OAuth token-refresh failure was caught and the code
  **silently fell back to the API key**, quietly running the assistant on a
  different credential/billing. Now a refresh failure is surfaced (logged) and the
  connected subscription is kept (the existing access token is used); the API key
  is reached only when no usable OAuth credential is configured at all.

### Fixed

- **The Windows desktop app now opens its window.** On boot the app created its
  data directory at `$HOME/.lattice`, falling back to the current working
  directory when `$HOME` was unset. `$HOME` is Unix-only, so on Windows the
  fallback resolved to the app's install directory — read-only for a normal
  user — and the `mkdir` threw before the window opened. The data directory is
  now resolved from `os.homedir()` (correct and writable on every platform) and
  the path is built with `path.join` so the separator is native. macOS and Linux
  are unaffected.

---

## [4.2.4]

Adds the downloadable desktop app and a pair of GUI single-source-of-truth
fixes (**additive — no library API change**; every 4.2 caller runs unchanged).

### Added

- **Downloadable desktop app (`deno desktop`).** A native, double-click build of
  the Lattice GUI for macOS (`.dmg`) and Windows (`.msi`), in addition to the
  `lattice gui` CLI. It serves the same GUI server in a native window and uses a
  `node:sqlite`-backed adapter (`DenoSqliteAdapter`) in place of the native
  `better-sqlite3` addon, which cannot load under Deno — the npm/Node build is
  unchanged and still uses `better-sqlite3`. External links / OAuth open in the
  system browser (a webview has no tabs). Upgrade-on-run via `Deno.autoUpdate()`;
  installers + a `latest.json` manifest publish to GitHub Releases on a version
  tag. Requires a Deno canary to build; v1 installers are unsigned. See
  [docs/desktop.md](docs/desktop.md).

### Fixed

- **The assistant "Connected with Claude" state is now derived in one place.**
  The onboarding feed and the settings panel computed it from different fields,
  so an API-key-only setup could show "Connected with Claude" in one and "not
  connected" in the other. A single `claudeAuth(cfg)` helper now derives it
  solely from `claudeAuthKind` — "Connected with Claude" means a connected
  subscription everywhere.
- **A local (SQLite) workspace no longer flips to "cloud — disconnected" on a
  socket drop.** The realtime disconnect handler hardcoded the cloud mode, which
  could divert writes into the offline queue on a workspace that has no cloud; it
  now preserves the known mode.

## [4.2.3]

Patch release on 4.2 (**additive — no API change**; every 4.2 caller runs
unchanged).

### Fixed

- **Same-titled entities no longer overwrite each other on render.** Each entity
  row is rendered into a directory named by its slug. When two rows produced the
  **same** slug (e.g. two records with an identical title), they resolved to the
  **same** directory, so one silently clobbered the other and a row that exists
  in the data never got its own rendered context. Per-row slugs are now made
  **unique within each table's render**: a slug used by exactly one row is left
  unchanged (no churn for the common case), while colliding rows are
  disambiguated with a short, stable suffix derived from their primary key. The
  result is deterministic and order-independent — the same row keeps the same
  directory across renders regardless of row order — so both rows now get their
  own distinct directory with content. Custom `slug` functions are unaffected
  (the disambiguation wraps the result rather than replacing the function), and
  the existing slug sanitization + path-traversal validation are preserved.
- **Cleanup now removes the directories of entity contexts that became collapsed
  relations.** When a table stops being a first-class entity context — for
  example a join table that the symmetric many-to-many change folds into a
  relation and drops from the rendered set — its previously written directory
  tree was never revisited by cleanup and lingered as orphaned directories
  forever. Cleanup now sweeps a table that was an entity context in the previous
  render but is no longer one, using the previous manifest as the record of what
  the renderer managed — so only directories the renderer created are removed;
  unrelated top-level directories and custom-`directory()` contexts are left
  untouched. Respects the existing dry-run / orphan-callback options.
- **One-time re-render to apply both fixes.** Both changes alter what reaches
  disk for existing data, so the render-output format version is bumped: the
  **first open after upgrading does a one-time full re-render** that de-collides
  same-slug directories and sweeps the collapsed-context directories; subsequent
  opens skip again once the manifest is re-stamped.

---

## [4.2.2] — unreleased

Patch release on 4.2 (**additive — no API change**; every 4.2 caller runs
unchanged).

### Fixed

- **Render-logic changes now auto-apply to workspaces rendered by an older
  version.** The renderer records a render-output FORMAT version in each
  workspace's manifest, and the open-time staleness gate skips re-rendering when
  everything the tree depends on is unchanged. The 4.2 change that made
  many-to-many junctions render symmetrically (the remote entity is emitted on
  BOTH sides of a join table, not just one) altered the bytes a clean render
  produces — but the format version was not bumped alongside it. Workspaces
  rendered by the older version therefore matched the unchanged version, the
  gate skipped, and they kept serving the cached one-sided output even though
  the fix was already in the code. The render-output format version is now
  bumped, so the **first open after upgrading does a one-time full re-render**
  and picks up the new output; subsequent opens skip again once the manifest is
  re-stamped. The one-time re-render reads all entities once (the normal cost of
  a full render) — there is no ongoing per-open cost. Going forward, any change
  to how the entity-context is derived or templated must bump this version so
  the new output reaches existing workspaces.

---

## [4.2.1] — unreleased

Patch release on 4.2 (**additive — no API change**; every 4.2 caller runs
unchanged).

### Fixed

- **Self-healing SQLite engine across a Node-runtime change.** The local SQLite
  backend is powered by the `better-sqlite3` native module, whose compiled
  binary is pinned to the Node ABI present at install time. When the runtime's
  Node changes (a package-manager bump, a different Node in CI vs. local, etc.)
  the prebuilt binary no longer loads and the SQLite path used to crash at
  module init with a cryptic native `NODE_MODULE_VERSION` error. The module is
  now loaded **lazily** (matching the existing `pg` loader) and **self-heals**:
  on a detected ABI mismatch it rebuilds `better-sqlite3` for the current
  runtime in-process, then continues. A clear, system-agnostic error is
  surfaced only as a last resort — the module is genuinely not installed, the
  rebuild can't complete, or auto-rebuild was opted out. Set
  `LATTICE_SQLITE_NO_AUTOREBUILD=1` to disable the automatic rebuild. New
  internal module `src/db/load-sqlite.ts` (exported helpers `loadSqlite`,
  `resolveSqliteCtor`).

## [4.2.0] — unreleased

Feature release on 4.1 (**additive** — every 4.1 caller runs unchanged): import
structured data by dropping a file into the assistant — plus correctness and
security hardening (below).

### Added

- **Structured-source importer — drop a file in the assistant chat.** Turn a JSON
  or `.xlsx` source into a Lattice schema (entities, dimensions, junctions) and
  materialize it (deduped, persisted to config). Excel sheets become records by
  detecting the header row + data region; per-slice tabs that are a view of a
  master become read-only **views** (no duplicated rows). **Point-in-time
  snapshots:** an as-of date is detected from the file's contents, name, Excel
  preamble, then a Claude fallback — or per-row from a date column — so re-importing
  a newer period keeps a dated snapshot beside the prior one. **Re-import
  recognition:** a new upload is fingerprinted and matched to the tables already in
  the workspace, so it lands as a new snapshot instead of duplicate tables. The
  importer is reachable ONLY by dropping a file into the assistant rail: a confident
  match + detected date imports silently as a dated snapshot; otherwise an **inline
  confirm card** proposes the schema, as-of date (and per-row date column), and mode
  before anything is written, applied via `POST /api/import/apply`. New library
  exports: `inferSchema`, `inferFieldType`, `normalizeName`, `sourceRecords`,
  `materializeImport`, `detectAsOf`, `detectAsOfCandidates`, `detectAsOfColumns`,
  `parseCellDate`, `matchSchemaToExisting`, `renameEntities`, `excelToRecords`,
  `dedupeAndDetectViews` (+ types).

### Changed

- **The retrieval-quality gate can now actually fail.** As first shipped (4.1) the
  golden corpus was ~6 disjoint single-topic docs, so the committed baseline sat at
  a perfect 1.0 ceiling and only a catastrophic break tripped the gate. The corpus
  is now ~20 docs with deliberate cross-topic lexical overlap, so the real
  `search()` scores good-but-imperfect; the committed baseline
  (`tests/fixtures/eval-baseline.json`) is **generated by running the real search**
  (`npm run eval:baseline`) and is sub-perfect (`mrr ≈ 0.92`, `ndcg@3 ≈ 0.94`) —
  never hand-authored. A new `npm run eval:gate` evaluates the current `search()`
  against that baseline and exits non-zero on any metric dropping past tolerance;
  it runs as a required CI step and is mirrored by a suite test that also asserts
  the baseline has headroom (`mrr < 1`), so the gate can't silently go blind.
- **The benchmark proves a real native index before timing the vector phase.** A
  new Postgres integration test (`benchmark-indexed-postgres.test.ts`) runs the
  benchmark against a real pgvector cluster and asserts the harness built the native
  index BEFORE the vector timing loop (`report.vectorIndexed === true`) — so
  `vector.p95` reflects the indexed path, not the O(n) in-process scan. Where
  pgvector is unavailable (the local disposable cluster ships none) the test skips
  with a clear message rather than passing green-by-construction; CI exercises it
  for real on the pgvector image.

### Added

- **Advisory latency SLO gate (`npm run slo:gate`).** Runs the real benchmark at a
  committed scale and checks observed p95 latencies against committed thresholds
  (`tests/fixtures/slo-thresholds.json`). It is **advisory, never build-blocking** —
  shared CI runners are too latency-noisy to gate a merge on — so its CI job runs
  with `continue-on-error: true`. Every number it reports is measured, not
  fabricated; the thresholds carry generous headroom over real measurements and the
  output marks whether `vector.p95` reflects a native index or the in-process scan.

### Fixed

- **Many-to-many junctions render symmetrically.** A join table is rendered so each
  side shows the REMOTE entity (a contact shows its meetings, a meeting shows its
  contacts) instead of only the foreign key pointing back at the parent. Both
  endpoints emit the reciprocal relation by construction, so the render is symmetric
  for every junction shape (pure or payload-bearing); a test locks the invariant in.
- **Credential store: a contended write no longer drops on Windows.** The
  cross-process credential-store lock retried only on `EEXIST`; on Windows an
  O_EXCL open racing another process mid-create/delete on the lockfile surfaces
  transiently as `EPERM`/`EACCES`, which crashed the writer and lost its update.
  Those transient codes are now retried (with the existing stale-reclaim + backoff,
  bounded by the lock timeout); POSIX behavior is unchanged.

### Security

- **Realtime delete events are scoped per recipient.** A deleted row's pk +
  existence are no longer fanned out over the realtime stream to members who could
  not read the row; delete events are gated from a pre-delete visibility snapshot,
  matching how upserts are scoped (corrects the 4.x realtime note above). Deletes
  remain excluded from reconnect catch-up; clients reconcile deletions on refetch.
- **Import file-size cap (both paths).** The streaming upload caps the source at
  50 MB; the import-apply route now re-enforces that same 50 MB cap when it re-reads
  the retained bytes from disk (it `statSync`s before reading), so an oversized or
  swapped-on-disk JSON/`.xlsx` — including one reached via a `local_ref` that never
  went through the upload — can't be streamed whole into memory and OOM the process.
- **Bounded reads on hot paths.** `/api/history` clamps its `limit` (a client can
  no longer request the whole audit table); semantic search clamps `topK` before
  the candidate over-fetch; and the no-index embedding scan takes an optional
  `maxScanChunks` that fails loudly (`EmbeddingScanTooLargeError`) rather than load
  an unbounded vector set into memory — off by default, never silently truncated. These are bounding mechanisms in the library, not a fix for any particular egress bill — a large real-world overage is usually driven by a consumer application's sync/render patterns, and is addressed there.

## [4.1.0] — 2026-06-22

Fast-follow feature release on 4.0. Turns latticesql into a measurable,
production-grade retrieval substrate: a retrieval-eval + health + benchmark
layer, indexed vector search with chunking, hybrid fusion + reranking, governance
(provenance + trust), reliability (retry + resumable migrations), graph-augmented
retrieval, declarative computed columns, and a fuller query surface. **Additive
only** — every 4.0 caller runs unchanged; each feature is a new optional field or
method that is inert unless a table opts in.

### Added

- **Retrieval evaluation (`evaluateRetrieval`).** Standard IR metrics —
  Precision@k, Recall@k, MRR, nDCG@k (graded gains), MAP — over any ranked
  retriever (`(query) => rankedRowIds`), with a per-query breakdown and optional
  multi-cutoff report. `detectRetrievalRegressions(baseline, candidate, tolerance)`
  powers a regression gate that runs in the test suite — a golden set evaluated
  against the real `search()` and compared to a committed baseline — so a change
  that lowers retrieval quality below tolerance fails the build. (Correction: as
  first shipped the golden corpus was small and single-topic, so the baseline sat
  at a perfect ceiling and only a large regression tripped the gate; 4.2 expands
  the corpus and commits a generated, sub-perfect baseline so smaller regressions
  are caught too.)
  Empty input / non-positive `k` throw rather than report a meaningless zero.
- **Retrieval health doctor (`diagnoseRetrieval`, `lattice doctor`).** Read-only
  diagnostics: per-table full-text and embedding coverage (soft-deleted rows
  excluded), extension availability (FTS5, sqlite-vec, pgvector, pg_trgm), and
  severity-ranked issues for missing/stale indexes or embeddings. The CLI
  `lattice doctor [--json]` prints a report and exits non-zero on any error so it
  can gate a deploy.
- **Benchmark harness (`benchmarkRetrieval`, `checkSlos`).** Reproducible
  speed-to-answer numbers — p50/p95/p99 for filtered query, full-text, vector, and
  aggregate, plus ingest throughput and peak memory — on synthetic data at a
  configurable scale, both dialects, exercising the real code paths. The vector
  phase builds the native index first, and the report's `vectorIndexed` flag marks
  whether the vector numbers reflect the index or the in-process-scan fallback —
  so you can tell whether a number reflects the index or the in-process-scan fallback (check the flag) rather than mistaking the scan for the index. (4.2 adds a test that asserts the index actually builds against a real pgvector service before the vector phase is timed.) `checkSlos`
  flags latency-SLO violations against thresholds you set for your own hardware
  (shared-runner latency is too noisy to gate a build on by default). Default
  scale is CI-fast; `LATTICE_BENCH_*` env vars scale it up.
- **Text chunking for embeddings (`semanticChunker`, `EmbeddingsConfig.chunker`).**
  A dependency-free, boundary-aware splitter (paragraph → sentence → word) with
  optional overlap, so a row is embedded as several small, coherent chunks instead
  of one blurred whole-row vector — higher precision@k and fewer tokens to a
  correct answer. `EmbeddingsConfig.contextPrefix(row)` prepends per-row context
  (e.g. a title) to every chunk; `modelId` is stored with each vector.
- **Indexed vector search (`buildVectorIndex`).** An opt-in per-table native
  approximate-nearest-neighbor index — pgvector HNSW on Postgres (auto-enabled via
  `CREATE EXTENSION IF NOT EXISTS vector`), sqlite-vec on SQLite (when the extension
  is loaded into the connection) — built from the stored embeddings, turning the
  O(n) in-process scan into an indexed ~O(log n) lookup; semantic search uses it
  automatically when present and falls back to the in-process scan (reported by
  `lattice doctor`) otherwise.
- **Incremental embedding refresh (`refreshEmbeddings`).** Backfill missing,
  re-embed model-stale or changed rows, and sweep orphaned embeddings — instead of
  re-embedding everything on any change.
- `SearchResult` now carries `chunkIndex` + `matchedContent` for chunked
  embeddings (a precise, low-token snippet of the matching chunk).
- **Hybrid search (`hybridSearch`, `Lattice.hybridSearch`).** Fuses semantic
  (vector) and lexical (full-text) retrieval with Reciprocal Rank Fusion (k=60),
  so results have both embeddings' recall and exact-term precision. Each result
  carries a score breakdown for `--explain`. Full-text-only when a table has no
  embeddings; soft-deleted rows excluded.
- **Ranking signals (`RankingOptions`).** Deterministic, model-free boosts from
  existing columns — recency (half-life decay), reward (saturating
  `_reward_total`), and a custom signal — folded into the hybrid score.
- **Reranking (`SearchOptions.reranker`, `HybridSearchOptions.reranker`).** An
  optional bring-your-own second-stage reranker over the retrieved candidates,
  with graceful fallback to the first-stage order if it throws or returns nothing
  usable. Lattice never calls a model.
- **`lattice search "<query>" --table <t> [--explain] [--topk N] [--json]`** — a
  CLI hybrid search; `--explain` prints the per-result score breakdown.
- **Query primitives.** `QueryOptions.projection` (`string[]` / `{include}` /
  `{exclude}`) returns only the columns you need; `QueryOptions.maxRows` +
  `LatticeOptions.defaultMaxRows` + `BoundedReadError` guard against accidental
  unbounded full-table reads; `filters` now accept recursive `or`/`and` groups
  and per-clause `jsonPath` extraction into JSON/JSONB columns.
- **SQL-side aggregation (`Lattice.aggregate`).** `COUNT`/`SUM`/`AVG`/`MIN`/`MAX`
  (and `COUNT(DISTINCT)`) with `GROUP BY`/`HAVING`/`ORDER BY`, computed in the
  database so only the grouped result rows transfer — not the underlying rows.
- **Keyset pagination (`Lattice.queryPage`).** Cursor-based paging ordered by
  `(orderBy, pk)` with an opaque cursor — stays fast arbitrarily deep into a
  result set, unlike OFFSET. Returns a page plus `nextCursor`/`hasMore`.
- **`QueryOptions.distinctOn`.** One row per distinct value of the given
  column(s) (Postgres `DISTINCT ON`, SQLite `ROW_NUMBER()` window), the survivor
  chosen by `orderBy`.
- **`QueryOptions.include`.** Expand declared relations on each row — `belongsTo`
  attaches the related row, `hasMany` an array — each fetched in a single batched
  `IN (...)` query (no N+1).
- **Durable retry (`withRetry`).** Re-runs an idempotent operation through
  decorrelated-jitter backoff on transient DB failures (SQLite `SQLITE_BUSY`,
  Postgres serialization/deadlock/connection errors, dropped sockets), with a
  nested-retry guard so composed helpers don't multiply attempts.
- **Online, resumable migrations (`applyChunkedMigration` / `resumeMigration` /
  `revertMigration`).** Walks a table's primary key in batches — each a short
  transaction, no long table lock — checkpointing progress, so a killed
  migration resumes after the last checkpoint instead of restarting from zero.
- **Immutable provenance (`TableDefinition.provenance`).** Opt a table into
  `ingested_via` / `source_uri` / `ingested_at` columns stamped at creation;
  `ingested_at` is auto-stamped and any `update()` that changes a provenance
  column throws `ProvenanceImmutableError`, so lineage can't be rewritten.
- **Trust / verification (`TableDefinition.trust`).** Gate untrusted ingest:
  new rows default to `unverified`; `markRowForReview` / `verifyRow` move them to
  `needs_review` / `verified`, and `rowsNeedingReview` / `verifiedRows` filter by
  state.
- **Graph-augmented retrieval.** A typed-edge graph over rows (`addEdge` /
  `neighbors` / `traverseGraph` with bounded BFS, `extractEdges` for zero-LLM
  edge extraction from foreign keys) plus `graphSearch` — hybrid search re-ranked
  by graph adjacency to anchor entities, so relationship-relevant rows rank
  higher. Depth and visited-node hard caps prevent runaway traversal.
- **Computed columns (`TableDefinition.computed`).** Stored columns derived from
  other columns by a pure function, computed on insert and recomputed when a
  dependency changes (`refreshComputedColumns` for a full pass). Dependency
  cycles are rejected at init.
- **Materialized rollups (`TableDefinition.materializedRollups`).** Stored
  aggregates over a child table (e.g. `comment_count`), maintained incrementally
  as children change and recomputable in full via `refreshMaterializedRollups`.
- **Seamless cloud file-byte access (`enableCloudFilePresigning`, cloud
  Postgres).** An in-database SigV4 presigner: a keyless cloud member fetches file
  bytes with zero config — `lattice_presign_file` computes a short-lived (≤ 60 s)
  presigned URL inside Postgres, gated on the member's row-visibility, using the
  owner's key which never leaves the database (a member-role test asserts the
  secret table is not member-readable). Enabling S3 on a cloud turns it on for all
  current + future members (re-granted on every reconcile); the GUI file-byte route
  uses it automatically for keyless member fetches. SigV4 signing is verified
  against AWS's published GET test vector plus an independent reference for PUT.
  Keyless **upload** (presigned PUT) is forthcoming in a 4.1.x follow-up — the
  signer supports it; the ingest-route wiring lands separately.

### Changed

- **Semantic search now respects `deleted_at`** — soft-deleted rows are excluded
  from `Lattice.search` results (they could previously be returned), and a stored
  vector whose dimensionality differs from the query's now throws
  `EmbeddingDimensionMismatchError` instead of silently mis-scoring.
- The internal `_lattice_embeddings` store is now chunk-aware
  (`chunk_index`/`content`/`embedding_model`/`embedded_at`/`vec_dim`); an older
  store is migrated forward automatically and idempotently on init.
- **Indexed full-text search is now relevance-ranked.** `FtsHit.score` is
  populated by the indexed tier (`ts_rank` on Postgres, `-bm25` on SQLite FTS5)
  and results are ordered by relevance — previously indexed full-text results
  came back in physical/rowid order.

### Fixed

- **Rendered-file body edits were silently not imported.** The default
  entity-context render writes each field as a bold bullet — `- **key:** value`,
  with the colon _inside_ the bold — but the reverse-sync body parser only
  recognized `**key**: value` / plain `key: value`. So an edit to a rendered
  file's body parsed to zero fields and was reported "not auto-importable
  (custom/computed render)", even for a plain structured record. (Latent until the
  reverse-sync starvation above was fixed, which is when file edits started
  running at all.) The parser now also reads the render's own
  colon-inside-the-bold format; a new test renders-then-parses the real on-disk
  shape rather than a hand-written one.
- **Spurious full re-renders driven by chat / bookkeeping writes.** The GUI's
  eager per-viewer re-render fired on _every_ realtime change, including writes to
  internal tables (the assistant's `chat_messages`/`chat_threads`, every
  `_lattice*` table). On a cloud workspace, each assistant message wrote a
  `chat_messages` row → change-feed `NOTIFY` → a full background render — so an
  ongoing conversation re-rendered the whole workspace every turn, wasting egress.
  It also starved the file-loopback reverse-sync, which is deferred while a render
  is in flight: with renders firing constantly, a user's on-disk `.md` edit never
  got written back. The eager re-render now filters out feed-hidden tables (the
  same `isFeedHiddenTable` guard the activity feed uses), so only changes to the
  rendered entity tree trigger a re-render.
- **Member-cloud file edits silently dropped.** On a masked member open, base-table
  `SELECT` is revoked and granted only on the per-viewer masking view. The render
  engine read through that view, but the reverse-sync engine read the base table
  directly — hitting a permission error that was swallowed, so a member's `.md`
  edit was never written back to the database or recorded in history. The
  per-viewer read-relation resolver now lives on the shared read layer
  (`SchemaManager`), so render **and** reverse-sync read through the same relation
  — one resolver, routed by access rights, rather than a second read path.
- **Loading-frame flash on background in-place re-renders.** The advanced-mode
  toggle (same hash) and the workspace-switch reload (already on `#/`) re-rendered
  the content pane with a bare call that synchronously painted the loading frame,
  flashing during background activity. Both now request a soft (in-place) refresh.
- **Embedding writes on Postgres.** `storeEmbedding` used a SQLite-only
  `INSERT OR REPLACE`, which the Postgres adapter refuses to translate — semantic
  embedding writes therefore failed on Postgres. Now uses a portable
  `INSERT ... ON CONFLICT DO UPDATE` upsert that both engines accept.

## [4.0.1] — 2026-06-19

### Fixed

- **The update-check cache now lives in `~/.lattice`, not a separate `~/.latticesql`.**
  `checkForUpdate` wrote its cache to `~/.${pkgName}` — the one path in the codebase
  that didn't follow the `.lattice` convention everything else uses (the installer's
  managed Node, the legacy user-config, the workspace root marker). It now writes to
  `~/.lattice/update-check-<pkg>.json`.

## [4.0.0] — unreleased

Major release. **Most upgrades need no action** — the GUI silently migrates an
existing 3.0+ config and its data forward on open (see "Silent backwards-compat
auto-upgrade" below and [MIGRATING-4.0.md](docs/MIGRATING-4.0.md)). The items tagged
**BREAKING** are breaking only for **library / non-GUI consumers** (who open via the
library `init()` path and so don't get the on-open migrations) and for **API
consumers** of a removed export; for them the most data-safety-critical step is
normalizing legacy empty-string `deleted_at` to `NULL` before upgrading. Internally
this release also decomposes the three largest source files into focused modules and
adds optimistic-concurrency, atomic-commit, and bounded-read hardening —
behavior-preserving except where tagged BREAKING.

### Added

- **Silent backwards-compat auto-upgrade on open.** Opening a 3.0+ workspace in the
  GUI now silently migrates its config + data forward to the 4.0 shape, preserving
  comments and data — so existing configs keep working without a manual migration,
  and migrate forward on disk so a future major can drop the back-compat tolerance
  cleanly. (1) The config parser tolerates the legacy `ref:` field shorthand
  (converts it to a `belongsTo` in-memory) and `src/config/config-upgrade.ts`
  rewrites it on disk to an explicit `relations:` block. (2)
  `src/framework/data-upgrade.ts` normalizes legacy `deleted_at = '' → NULL` and
  backfills a legacy `files.path`-only row into a `local_ref`, each gated
  once-per-database via `internal:upgrade:*` sentinels. The `deleted_at`
  normalization runs as ONE server-side `DO`-block migration on Postgres (looping
  the `deleted_at` tables in-database), not a per-table loop — a cloud with 100+
  tables would otherwise issue one pooled transaction per table and stall the
  workspace switch past its open timeout. (3) On a cloud owner open,
  `reconcileCloudMemberAccess` re-grants the per-cloud member group to the cloud's
  own members (scoped to its `__lattice_member_invites` registry — never the
  cluster-global legacy group). Each migration is idempotent and a no-op on a
  4.0-native database. Library / non-GUI consumers apply the equivalents themselves
  (documented in MIGRATING-4.0.md).

- **Change-detection gate for the `watch()` render loop (SQLite).** The poll loop
  previously called `render()` unconditionally every tick (default 5s). `render()`
  already skips unchanged files (manifest hash-diff) and is interval-throttled, so
  the residual idle cost is the per-tick read of every table. The loop now consults
  an OPTIONAL, O(1), GUARANTEED-COMPLETE change probe before rendering and skips the
  tick's render (and its cleanup) when the database provably has not changed since
  the last render. On SQLite the probe composes `PRAGMA data_version` (detects
  commits by OTHER connections/processes) with `total_changes()` (detects this
  connection's own row mutations, including trigger- and cascade-driven ones); the
  pair is complete — the composite token moves on any committed row change from any
  origin and is stable on a no-op statement or an idle DB. The probe token is
  captured BEFORE each render reads and adopted as the baseline at that moment, so a
  write committed mid-render differs from it and the next tick re-renders — the gate
  can cost at most one extra render, never a skipped-but-needed one. The first tick
  always renders. Postgres has no equally-cheap global complete counter, so its
  adapter deliberately leaves the probe unimplemented and the Postgres watch loop
  renders every tick exactly as before. Any adapter without the probe falls through
  to the prior full-render-every-tick behavior. Exposed as the optional
  `StorageAdapter.changeProbe()` seam (and `RenderEngine.changeProbe()`); leaving it
  undefined is always safe.
- **Opt-in incremental writeback file reads (`WritebackDefinition.incrementalRead`).**
  Default (`undefined`/`false`) is byte-for-byte the prior behavior: the pipeline
  reads the WHOLE file every tick (`readFileSync`) and parses from the absolute
  byte offset. Set `incrementalRead: true` and the pipeline reads ONLY the bytes
  at/after the stored offset (one `readSync` of `currentSize - offset` bytes),
  passing that slice to the parser with `fromOffset = 0`; the parser's
  slice-relative `nextOffset` is translated back to an absolute byte offset
  before it is stored. This avoids re-reading (and re-billing the egress of) the
  whole file every tick on an append-only log. The slice is decoded with an
  incremental `StringDecoder`, so a multi-byte UTF-8 codepoint straddling the
  trailing edge is never split into a replacement char — its incomplete trailing
  bytes are held back and consumed on the next tick. HARD PRECONDITION: the
  parser must operate purely on the byte-slice (no reliance on bytes before the
  offset). The deferred offset-advance ordering invariant is preserved in both
  modes — the offset is stored only after the whole batch persists, so a
  mid-batch persist throw leaves it un-advanced.
- **Opt-in bounded dedupe set on `InMemoryStateStore` (`{ maxSeenPerFile }`).**
  Default is `Infinity` — unbounded, exactly the prior behavior. Pass a finite
  cap and the per-file seen-set retains only the most recent N keys (oldest
  evicted first, by insertion order), bounding memory for long-running daemons
  tailing append-only logs. The cap is a memory-safety guard, NOT a durability
  substitute (an evicted key could re-process if it reappears); the class JSDoc
  recommends the durable `SQLiteStateStore` for long-running daemons instead.
- **`getActive` and `queryTable` accept an optional `{ limit, offset }` bound.**
  Omitting it is byte-identical to the prior unbounded read (every existing caller
  is unchanged); a bound appends a parameterized `LIMIT ? [OFFSET ?]` (validated as
  non-negative integers; a bare `offset` without `limit` is ignored, since SQL
  `OFFSET` requires `LIMIT`). Lets a consumer cap a read instead of pulling a whole
  table. (The GUI's own list endpoints are already bounded at the route layer.)
- **Scale-safety bound on the explicit dedup scan (`DEDUP_MAX_SCAN_ROWS`, default
  50,000).** `findTableDuplicates` (the assistant `dedup` tool) compares every
  candidate row, so it cannot cap its read with a `LIMIT` without silently missing
  duplicates. Instead it now counts active rows **in SQL first** (`COUNT(*)` reads
  no row bodies → near-zero egress) and **refuses loudly** — throwing an Error that
  names the table, count, and cap — when the active count exceeds the ceiling,
  rather than scanning the whole table or truncating. The thrown Error propagates
  through the assistant dispatch into a structured tool result the model relays, so
  the caller is told to narrow the scope or raise the cap (never a silent empty
  result). The soft-delete filter is also pushed into the read
  (`deleted_at IS NULL`) instead of loading every row and dropping trashed ones in
  JS; results are identical, with fewer bytes read.

### Changed

- **Internal — the GUI server request dispatch is now a single explicit ordered route registry (`src/gui/server.ts`).** The contiguous `if (await handleX(...)) return;` chain becomes an ordered `RouteEntry[]` iterated by a for-loop; dispatch order, per-entry bodies, prefix/method guards, and the post-loop 404 fallback are unchanged. No behavior change.
- **Internal — the changelog write-half is extracted into `ChangelogWriter` (`src/changelog/writer.ts`).** The table-existence check, create/additive-migrate DDL, the gated + ungated changelog INSERTs, and the retention prune move out of the `Lattice` facade into a focused collaborator (mirroring the existing read-half `ChangelogService`). The facade keeps each private method as a thin delegator to a lazily-constructed `ChangelogWriter` (deps injected, so the collaborator never reaches into `Lattice` internals). No public API change; behavior is byte-identical.
- **Internal — the generic read surface is extracted into `QueryCore` (`src/query/core.ts`).** The six most-called read methods (`query`, `count`, `get`, `getActive`, `countActive`, `getByNaturalKey`) plus the private filter-clause builder they share move out of the `Lattice` facade into a focused collaborator. The facade keeps each public method as a thin delegator (it performs the `init()` guard, then forwards to a lazily-constructed `QueryCore`; deps are injected so the collaborator never reaches into `Lattice` internals). The load-bearing decryption asymmetry is preserved exactly — `query`/`get` decrypt sealed columns before returning, while `getActive`/`getByNaturalKey` return the raw stored row — and is now pinned by a characterization test. No public API change; behavior is byte-identical.
- **BREAKING — the legacy `files.path` and `files.kind` columns are removed.**
  The native `files` entity no longer declares them; file resolution now flows
  through the content-addressed columns (`sha256` / `blob_path`) for owned bytes
  and the reference model (`ref_kind` / `ref_uri` / `ref_provider`) for files that
  live elsewhere. An ingested local file is recorded as a `local_ref` whose
  `ref_uri` is its absolute OS path (previously stored in `path`); a browser drop
  with no path is retained as an owned `blob`. Consumers that read `row.path` /
  `row.kind` must read `ref_uri` (local_ref) or `blob_path` (owned blob) instead.
  Drop the columns from a physical schema with
  `ALTER TABLE files DROP COLUMN path; ALTER TABLE files DROP COLUMN kind;`
  (SQLite ≥ 3.35 for `DROP COLUMN`; PostgreSQL unaffected). See
  [MIGRATING-4.0.md](docs/MIGRATING-4.0.md) for the backfill SQL.
- **The per-field `ref:` shorthand is deprecated in favor of an explicit
  entity-level `relations:` block — but still accepted (NOT a breaking change).**
  A field carrying `ref: <table>` still auto-creates a `belongsTo` (relation name
  derived by stripping a trailing `_id`), exactly as in 3.x — so an existing config
  opens unchanged. Going forward, declare the foreign key as a plain field and add a
  `relations:` map on the entity, naming the relation yourself:

  ```yaml
  ticket:
    fields:
      assignee_id: { type: uuid }
    relations:
      assignee: { type: belongsTo, table: user, foreignKey: assignee_id }
  ```

  The GUI silently rewrites a legacy `ref:` to this `relations:` form on open
  (see the auto-upgrade entry above), so configs migrate forward and a future major
  can drop the shorthand cleanly. A malformed _explicit_ `relations:` entry (not an
  object, missing `type`/`table`/`foreignKey`, a non-`belongsTo` `type`, or an empty
  `references`) still fails loudly — only the legacy `ref:` shorthand is tolerated.
  See [MIGRATING-4.0.md](docs/MIGRATING-4.0.md).

- **BREAKING — the soft-delete predicate is simplified to `deleted_at IS NULL`.**
  Earlier versions treated a row as "live" when `deleted_at` was **either** NULL
  **or** the empty string (`''`), via a legacy `OR deleted_at = ''` back-compat
  branch. That branch is removed from the three read paths that still carried it:
  the natural-key lookup family (`getByNaturalKey` / `upsertByNaturalKey` /
  `enrichByNaturalKey` / `softDeleteMissing`), the seed link resolver, and
  full-text search (both the indexed and the LIKE-fallback paths). The main
  `query` read path, `getActive` / `countActive`, the report builder, and the
  structured `{ col: 'deleted_at', op: 'isNull' }` filter family already used
  bare `deleted_at IS NULL`, so they are unchanged — this release makes the
  predicate consistent everywhere.

  The library only ever writes a timestamp (on delete) or NULL (on
  insert/restore), never `''`, so a database that has only ever used this library
  to soft-delete is unaffected. But any row whose `deleted_at` holds `''` (legacy
  or externally inserted data) will now read as **deleted**, and a natural-key
  upsert against such a hidden row can insert a duplicate. **Consumers MUST
  normalize every `deleted_at = ''` row to NULL on every `deleted_at` table
  BEFORE upgrading.** See [MIGRATING-4.0.md](docs/MIGRATING-4.0.md) for the
  required, ordered migration (normalize → verify zero empty-string rows → then
  upgrade).

### Fixed

- **Report builder hardens its SQL identifiers + bounds unbounded sections.** `buildReport`
  interpolates a section's table, filter columns, and orderBy column into SQL; each is now
  validated with `assertSafeIdentifier` (rejected loudly if not a plain identifier), and a
  section with no explicit `limit` is capped at a 50k-row safety ceiling that **warns** when
  it truncates rather than silently returning a partial section or reading a whole large table.
- **Security: a column masked at runtime is no longer re-exposed to cloud members.**
  Marking a column secret in the GUI (or any runtime `setColumnAudience`) masks it via
  the `<t>_v` view + `__lattice_column_policy`, but the in-memory schema audience
  (populated only from the declared config) stayed empty. `reconcileCloudMemberAccess`
  read that stale in-memory source to decide whether a table was masked, so on the next
  workspace open it saw a runtime-masked table as unmasked and re-GRANTed members
  `SELECT` on the base table — letting a member read the hidden column directly off the
  base, bypassing the masking view. reconcile now decides masked-ness from the
  DB-canonical `__lattice_column_policy` (the same source the views are built from),
  loaded in one query, so a runtime mask survives reconcile. Config-declared masking is
  unchanged (it is seeded into the policy table before reconcile runs).
- **SESSION.md write-apply targets the real primary key.** An `update`/`delete` on a
  table with no `id` column guessed the primary key as the FIRST declared column, so
  the `WHERE` could match the wrong column and update/delete the wrong rows (or none).
  It now resolves the target column as `id` → the declared single-column primary key
  (PRAGMA `pk`) → first column only as a last resort.
- **The `db.watch()` loop no longer hides render failures or skips stale-file cleanup.**
  A render/cleanup error now surfaces via `console.error` when no `onError` handler is
  supplied (it was silently swallowed), and orphan cleanup now receives the post-render
  manifest (4th arg) — matching every other `cleanup()` caller — so it can remove stale
  files in surviving entities (`omitIfEmpty` / removed files), not just orphaned
  directories.
- **GUI auto-dedup on file ingest surfaces its failures.** The post-upload auto-dedup
  block swallowed every error silently; it now logs the failure (still falling through
  to normal enrichment so the upload lands) so a systematic dedup/merge bug is visible.
- **Duplicate-merge can no longer leave a half-merge if it fails partway.** `mergeDuplicates`
  previously interleaved per-source link/unlink and then deleted the sources, so a failure
  mid-merge could relink some edges while having already removed others (and partly deleted
  sources) — an inconsistent state with no clean recovery. A single composing DB transaction
  is not available (each mutation runs the adapter plus changelog/render/audit hooks), so the
  fix is ordered crash-safety, not rollback: the merge now runs in three strict phases —
  link every survivor edge first (insert-or-ignore, additive), then unlink all source edges,
  then soft-delete the sources. Because links are written to the survivor before anything is
  removed, a crash at any point leaves a consistent, over-linked, re-runnable state — never a
  half-merge. Any thrown error is re-thrown (never swallowed) annotated with the failed phase,
  the survivor/source ids in flight, and that the merge is safe to re-run. The success-path
  end state and return value are unchanged.
- **Writeback no longer drops entries when a `persist` throws mid-batch.** The pipeline
  advanced the file offset (and marked entries seen) BEFORE calling `persist`, so a
  `persist` that threw partway through a batch left the offset past the un-persisted tail
  and the failing entry marked seen — silently dropping it on the next sync. An entry is
  now marked seen only after `persist` succeeds, and the offset advances only after the
  whole batch lands, so a failed batch is re-read (dedup skips the entries that already
  persisted) until every entry is written — honoring `persist`'s "exactly once per
  dedupeKey" contract across a transient failure.
- **Cloud member-access reconcile does fewer round-trips.** `reconcileCloudMemberAccess`
  (run on every cloud-owner workspace open) now grants each table in a single
  round-trip — a masked table batches its two GRANTs (`SELECT` on `<t>_v` + DML on the
  base) into one multi-statement query instead of two. Per-table fault isolation and
  the skipped-tables report are unchanged (each table is still its own try/catch); only
  the round-trip count drops.
- **Workspace open no longer hangs on a degraded Postgres.** `openConfig` awaited the
  realtime broker's `start()` (connect + `LISTEN`) with no timeout; a backend that
  accepts the TCP connection but never completes the startup handshake could hang
  every open path (boot, workspace switch, create, reopen) indefinitely. The connect
  is now bounded (default = the existing switch cap, `SWITCH_OPEN_TIMEOUT_MS`); on
  timeout it tears the half-open broker down in the background and throws loudly
  rather than wedge or silently degrade. **Behavior change:** a broker connect that
  _hangs_ at server boot now fails the boot loudly instead of eventually booting in
  degraded local-mode — a genuine connect _rejection_ still degrades to local mode as
  before (only the previously-unhandled hang now surfaces).
- **The GUI offline-edit queue now self-heals transient failures and ages out
  poison edits.** A queued edit that fails to replay with a 5xx or a network error
  no longer waits for the next `online`/reconnect event to retry — the drain
  re-arms itself on a bounded exponential backoff (2s, doubling, capped at 60s,
  reset on a clean drain or a real connectivity event), so a cloud that stays
  "connected" but 5xxes individual edits (or a blip that never fires `online`) can
  no longer leave edits unsynced indefinitely and silently. Each edit now tracks a
  persisted attempt count and is dead-lettered (marked `failed`, surfaced in
  pending edits) once it has failed 8 times, so a poison edit can neither retry
  forever nor be lost. An edit is still removed from IndexedDB only on a 2xx; a 4xx
  still dead-letters immediately as before.
- **A failed render no longer leaves new files on disk under the prior manifest,
  and a swallowed auto-render failure is surfaced.** Render now runs a pre-flight
  writability probe over its stable target directories (the output root, the
  `.lattice` manifest dir, and each entity-context directory root) before writing
  any live file, by writing and deleting a sentinel inside each one. This converts
  the common disk-full / read-only-mount failure into a clean pre-commit throw
  with no live files touched. The manifest is written last and atomically, so it
  is the single commit point: a render that throws never commits a new manifest
  over a partially-written tree — the prior context + manifest stay the record and
  the next render self-heals (unchanged files are skipped, the rest are completed,
  cleanup reconciles). Auto-render failures are now re-raised through the existing
  error channel carrying the underlying error code and an actionable message
  instead of being lost. Attach-copy failures (the binary/reference attachment
  step) are no longer silently swallowed — they propagate to the same commit gate.
  The honest guarantee is manifest-atomic + tree-eventually-consistent, not full
  multi-file tree atomicity: a crash between the first file write and the manifest
  commit leaves the prior manifest describing a tree with some newer files, which
  the next render reconciles.
- **Migrate-to-cloud surfaces files whose local blob bytes were left behind, and
  asserts per-table row counts.** `migrateLatticeData` copies `files` rows but not
  their owned-local blob bytes (under `<root>/data/blobs/`), so after the source
  is archived those rows are dangling references on the cloud. The migration now
  counts such rows and reports `blobsNotMigrated` on the result, surfaced to the
  operator as a warning, instead of leaving the loss silent. It also re-counts
  each table on the target after copy (soft-delete-consistent) and aborts loudly
  on a mismatch — defensive insurance against a future write path that could drop
  rows. (Uploading the blob bytes to the cloud's object store during migration is
  a deferred follow-up.)
- **Reverse-sync no longer silently overwrites a concurrent change.** When an
  external edit to a rendered context file is swept back into the database, the
  engine now verifies the underlying row hasn't changed since it was rendered —
  an optimistic-concurrency check against a row version captured in the manifest
  at render time. If the row did change (a concurrent database/cloud edit), the
  file edit is **rejected and reported as a conflict** instead of clobbering the
  newer value, and the GUI file-loopback surfaces a notice so the edit can be
  re-applied against the current record. Manifests written before this release
  fall back to the prior behavior until their next render.
- **BREAKING — the render manifest is now v2-only.** The legacy v1 entity-files
  shape (a bare `string[]` filename list, no content hashes) is no longer written,
  and the `isV1EntityFiles` / `normalizeEntityFiles` helpers are removed from the
  public API. Manifests are always the hashed `{ filename: { hash, ... } }` map.
  An old v1 `.lattice/manifest.json` on disk is still handled gracefully — its
  filenames are read so cleanup can detect orphans, write-back treats it as
  having no baseline (skips it), and the first render regenerates it in the v2
  shape — so no action is required on upgrade.
- **BREAKING (cloud + members only) — the member group role is now per-cloud.**
  Postgres roles are cluster-global, so the old hard-coded `lattice_members` group
  was shared by every cloud co-located on one Postgres cluster — co-mingling
  unrelated clouds' members and contending on one role's catalog during concurrent
  provisioning. The group name is now derived from the cloud's own
  `(database, schema)` namespace (`lattice_m_<md5(db:schema)[:20]>`), so each cloud
  has its own isolated group. The exported `MEMBER_GROUP` constant is removed,
  replaced by `memberGroupFor(db)` (resolver) and `LEGACY_MEMBER_GROUP` (the old
  name, for migration only). On the owner's next open the new group + its grants
  self-heal AND the cloud's own members (from its `__lattice_member_invites`
  registry) are automatically re-granted the new group — scoped to this cloud, never
  the cluster-global legacy group, so members are never cross-pollinated between
  clouds. So a cloud whose members were provisioned through Lattice needs no action;
  only an out-of-band (DBA-created, never-invited) role needs a manual re-grant (see
  MIGRATING-4.0.md). Single-user / SQLite deployments are unaffected.

## [3.4.7] - 2026-06-19

### Fixed

- **`lattice gui` is now a singleton — relaunching reuses the running instance
  instead of starting a duplicate.** When a GUI was already serving the port, a new
  launch (the installer, double-clicking the desktop app, or repeated `lattice gui`
  runs) silently bound the _next_ free port and started a SECOND instance — its own
  browser tab and its own background auto-update supervisor. Repeated launches piled
  up instances and tabs at drifting versions, which could exhaust and crash the
  browser. `lattice gui` now probes the target port first and, if a Lattice GUI is
  already there, opens it and exits. (Reported: the one-line installer launched a
  fresh GUI each run and crashed the browser.)
- **The seamless-update auto-reload can no longer loop.** The page reloads when the
  server reports a version different from the one it was served with (the auto-update
  trigger). If that mismatch ever persisted, every fresh page reloaded again — an
  unbounded loop. Auto-reloads are now capped (a few per minute) and then surface the
  mismatch instead of spinning, as a hard backstop against any reload loop.

## [3.4.6] - 2026-06-19

### Fixed

- **The GUI assistant can now store a secret.** Asked to save a credential, the
  assistant previously declined ("I don't have a tool to create secrets") — the
  `secrets` table is deliberately hidden from the assistant so it can never read a
  decrypted credential, which also left it no way to create one. A new **write-only
  `create_secret` tool** lets the assistant store a secret by name: it inserts
  directly (so the cleartext value never enters the undo/redo audit log), the value
  is encrypted at rest, and on a cloud the secret is owner-private. The assistant
  still cannot read, list, or echo existing secret values.

## [3.4.5] - 2026-06-19

### Added

- **"Update available — Upgrade" link next to the version indicator.** A manual
  fallback to the automatic updater: it appears only when a newer, installable
  version is published, and clicking it installs the latest and restarts the GUI
  onto the new version (the same install + relaunch the background updater uses).
  Normally unseen because auto-update handles it — this is the explicit escape
  hatch to force an update.

### Fixed

- **A workspace with no active database can now be deleted.** Deletion operates on
  the workspace registry rather than the open DB, so a workspace whose database
  fails to open (or the last remaining workspace) can be removed — reverting the GUI
  to the welcome screen — instead of being stranded and un-deletable. New
  `POST /api/workspaces/delete` shares the same file-cleanup logic as the
  active-DB delete path.

### Removed

- **Dropped the one-to-many `ref:` "removed in 2.0" deprecation warnings.** The 2.0
  removal plan is superseded; one-to-many `ref:` fields remain fully supported, so
  the per-field console warnings on every parse/re-render are gone.

## [3.4.4] - 2026-06-18

### Fixed

- **Cloud: a member can now add/edit/delete through the GUI assistant.** Three
  member-write failures on a shared cloud are fixed: the audit log's INSERT policy
  rejected the entry a hard delete writes for an already-removed row (now written in
  the same transaction, before the row is gone); undo/redo/revert and the redo-stack
  purge need UPDATE/DELETE on the audit log (granted, scoped by the existing per-op
  RLS so a member only touches audit rows for entities it can see); and adding a row
  with a brand-new field needs DDL a scoped member can't run (routed through an
  owner-side `SECURITY DEFINER` helper that validates the table, rejects internal
  tables, and whitelists the column type).
- **Cloud: private uploads stay private end-to-end.** A file uploaded with the
  "private" toggle (and everything derived from it — enrichment entity rows, the
  fallback note, and the file↔entity junction links) is now stamped private at
  insert, instead of inheriting a shared table default and leaking to the workspace.
- **Cloud: the API key no longer breaks an OAuth session, and Clear is
  authoritative.** When connected with Claude (OAuth), the client now sends only the
  bearer token and never an `x-api-key` (previously the SDK defaulted the key from
  the environment and sent both, which the API rejected as invalid). OAuth always
  takes precedence over a stored/env key, and clicking Clear now persists — it
  suppresses both the stored key and the environment fallback until a new key is
  saved — so the settings UI reflects reality.
- **GUI: opening (or auto-updating) no longer re-renders the whole context tree.**
  The open-time render is now gated on a manifest-recorded change cursor (template
  version + the change-log high-water mark + a sharing-graph digest, read through the
  current viewer's scope). When nothing the tree depends on has changed, the render
  is skipped entirely; otherwise a content-hash backstop suppresses work for unchanged
  entities. Fails open (re-renders on any uncertainty) and is per-viewer correct (a
  member-visible edit, a new observation, or an owner un-share each still re-render).
- **GUI: "share with specific people" is now one save for many people.** The picker
  stages a multi-person selection and commits it in a single batch instead of
  applying (and collapsing the panel) on every checkbox, and the open panel survives
  a background refresh.
- **Background auto-upgrade now activates for real global/local installs.**
  Install-context detection resolved the package root from the raw launch path, which
  for a global/local install is an unresolved bin symlink — so it fell back to
  "unknown" and silently disabled the self-update supervisor. Both the module path and
  the working directory are now symlink-resolved.

## [3.4.3] - 2026-06-18

### Fixed

- **A bulk file drop no longer freezes the GUI.** Dropping many files on the
  assistant rail at once fired one upload request per file in parallel. A browser
  allows only ~6 HTTP/1.1 connections per host, so a large batch consumed the
  whole connection budget with multi-minute upload requests, and every other
  request — entity lists, rows, navigation — queued behind them with no recovery,
  leaving the app unresponsive until the batch finished (the middle pane stuck on
  a loading spinner). Uploads now drain through a small bounded-concurrency queue
  (a few at a time), so the connection budget stays free for the rest of the GUI
  no matter how many files are dropped. The realtime/feed streams already share a
  single WebSocket off this budget; uncapped bulk uploads were the last way to
  exhaust it. Holding uploads to a few at a time also eases the AI rate limit each
  ingest hits server-side, so large imports finish more reliably.

### Added

- **Batch-upload progress bar.** A multi-file drop now shows an "Analyzing N of M…"
  bar pinned to the top of the assistant feed, alongside the per-file cards, so the
  overall progress of a large import is visible at a glance.

## [3.4.2] - 2026-06-18

### Fixed

- **Security: the GUI audit log is now scoped by row visibility on a cloud.** The
  undo/redo + version-history log (`_lattice_gui_audit`) was granted to members
  with no row-level security, so a member's version-history read returned every
  member's edits — and its `before_json` / `after_json` carry raw row data. A
  Postgres RLS policy now scopes it: a member sees an audit entry for a row only
  when they can see that row (`lattice_row_visible` — shared / owned / everyone);
  schema-level entries (no row id) stay visible to all; the cloud owner sees the
  full history. (Known follow-up: the before/after JSON of a shared row is not yet
  column-masked, so a shared-on member could see an owner-only column's value in
  history — still strictly more private than the previous no-RLS state.)

### Added

- **Cloud members now render the full context tree.** The owner's entity/render
  layout (entities + entityContexts) is published to a members-readable cloud
  table on migrate + owner-open, and a joined member hydrates its local config
  from it on open (CLI + GUI), keeping its own scoped `db:` credential. Members
  previously got `entities: {}` and rendered an empty/degraded tree. A cloud
  workspace with no published layout now surfaces a clear message instead of
  silently rendering zero files.

## [3.4.1] - 2026-06-18

### Fixed

- **Security: assistant chats are now strictly private to their author on a
  cloud.** A cloud member could see other members' assistant conversations. Two
  causes, both fixed: the GUI chat reads had been changed to trust Postgres RLS
  and dropped their app-layer owner filter — but the app connects as a `BYPASSRLS`
  role, so RLS never filtered it; and new threads/messages were being written with
  a NULL owner (world-readable). Now every chat read is filtered by the connected
  user's identity and fails closed (an unresolved identity returns nothing, not
  everything), every thread + message — including the assistant's replies — is
  stamped with its author, and a `RESTRICTIVE` Postgres policy on `chat_threads` /
  `chat_messages` (keyed on the owner, fail-closed on NULL) enforces the same
  isolation at the database for non-bypass members. Orphaned NULL-owner chats
  become invisible to everyone.
- **A member could no longer render at all if another member created the
  SQLite-compat polyfills first.** The `json_extract` / `strftime` polyfills were
  re-registered with `CREATE OR REPLACE FUNCTION` on every connect, which Postgres
  only allows the function's owner to run — so every other member's registration
  raised "must be owner of function" and, sharing the render transaction, aborted
  it (empty render). Registration is now create-if-absent (a present function is a
  no-op for any role), and the polyfills are re-owned to the members group so a
  future definition change can be applied by any member.
- **A workspace open / cloud change no longer re-renders the entire context
  tree.** The background render is now incremental: a change re-renders only the
  affected entity context (the changed table plus any context that sources from
  it) instead of all tables, and a full open render is no longer followed by a
  redundant second render. On a large cloud this turns a ~60s full pass into a
  near-instant per-entity update.
- **Switching workspaces refreshes the header logo.** The workspace switch
  re-fetches the active workspace's branding (cache-busted by its logo etag), so
  the logo updates with the name instead of showing the previous workspace's mark
  until a hard refresh.

## [3.4.0] - 2026-06-17

### Added

- **The assistant can add a field to an existing object.** A new `add_column`
  tool lets the assistant add a column to a table on request ("add a priority
  field to projects") — registered live (no reopen), persisted, audited/revertible,
  and on a cloud the masking view is rebuilt so members see the new field. It had
  been able to create whole tables but, inconsistently, not add a single column.
- **The assistant reads your rendered context.** A new `get_row_context` tool
  lets the GUI assistant pull a record's organized, pre-joined rendered context
  (its own fields + related records + the combined summary) in a single call, and
  it's instructed to prefer that over stitching together many raw reads — so it
  leverages the rendered context tree Lattice already maintains instead of
  re-querying the database for everything. It falls back to the direct row tools
  when a record hasn't been rendered yet. (Injecting the rendered index into the
  prompt is a tracked follow-up.)
- **A cloud member's rendered context is their own scoped projection.** On a cloud,
  the background render now reads every table THROUGH the member's row-level-security
  connection and through the per-column masking view — so the rendered markdown a
  member's assistant reads off disk contains only the rows they may see, with
  owner-only columns blanked, and with the per-viewer enrichment values they're
  allowed to see folded in. When sharing changes — a row shared or un-shared — the
  affected member's context tree re-renders promptly (no manual refresh), so it
  never lingers on a stale view. This also fixes a member render of a table with a
  masked column, which previously failed outright. Owners and local single-user
  workspaces render the full tree exactly as before.
- **Edits to the rendered context files now flow back into the database.** When
  the GUI is serving a workspace, editing a rendered `.md` file on disk is
  captured into the DB through the normal write path — so it lands in the
  changelog (versioned/undoable) and shows up live, exactly as if the change had
  been made in the GUI. Structured frontmatter and body `key: value` fields
  round-trip automatically (no hand-written `reverseSync` needed); a file whose
  changes can't be safely parsed (free-form/custom render) is surfaced as a
  notice rather than guessed at, so a lossy render can't corrupt a row. Render
  echoes are suppressed via the manifest, so there is no write loop. New
  `Lattice.reverseSyncFromFiles(outputDir, opts)` exposes the changelog-aware
  reverse-sync for embedders.
- **The browser GUI now updates itself.** When `lattice gui` is launched from an
  installable copy (a global or project-local install), it runs as a small
  supervisor that silently installs the latest published version before opening,
  and keeps checking in the background while you work. When a new version lands it
  installs it and relaunches the server on the same port; the open tab reconnects,
  notices the version changed, and reloads onto the new build — no manual refresh,
  no reinstall step. A copy running from a git checkout or `npx` is left untouched
  (auto-update is disabled there). A failed install is surfaced in the GUI rather
  than swallowed. New `GET /api/version` and `GET /api/update/status` report the
  running version and update state.

### Changed

- **Assistant system prompt trimmed (no behavior change).** Removed instructions that deterministic code already enforces — the "only fetch a URL the user typed" rule (enforced by the ingest_url gate) and the verbose "what you're viewing" block (replaced by resolved record data) — and merged the overlapping "non-technical / do it yourself / don't tell the user to run commands" rules into one.
- **A plaintext database URL in a config is healed on open.** If a workspace
  config still stores a raw `postgres://…` connection string (with its password)
  in the `db:` line, opening it now moves the URL into the encrypted credential
  store and rewrites the line to a `${LATTICE_DB:<label>}` reference — so the
  secret no longer lingers in cleartext on disk. Idempotent; configs already using
  a reference, or a SQLite path, are untouched, and an existing credential is
  never overwritten. The credential store's master-key creation and every
  load-modify-write are now serialized by a cross-process lock and written
  atomically (temp + rename), so concurrent opens — two GUIs launching at once, or
  parallel workers — can't lose an entry or write a divergent master key.
- **Cloud sharing internals consolidated (no behavior change to live features).**
  Removed never-surfaced masking machinery — per-cell grants and app-role
  assignment (their tables, `SECURITY DEFINER` functions, and the unreachable
  `/api/cloud/cell-share` route) and the `role:` / `subject:` / `source:`
  column-audience clauses. The live sharing features are unchanged: row
  `private` / `everyone` / custom "specific people" sharing, table
  `default_row_visibility` + `never_share`, and the `owner` secret-column mask.
  The duplicated owner-check and never-share check across the share/grant
  functions are now single `SECURITY DEFINER` helpers (`lattice_require_owner`,
  `lattice_table_is_never_share`) — message-for-message identical. A one-time,
  idempotent convergence rewrites any legacy/unrecognized column audience to
  `owner` (strictly more restrictive, never widening) so existing clouds upgrade
  safely. All changes are additive/idempotent and converge on an owner's next
  secure.
- **Member access is now provisioned from one declarative registry.** What a cloud
  member may read/write — the GUI/identity/changelog bookkeeping tables, the
  polyfill EXECUTE grants, and the per-table user grants — is centralized in a
  single source of truth that the secure/reconcile path derives from (and a test
  asserts: every readable object granted, every owner-only object not). This
  removes the hand-enumerated GRANT sites behind the recurring "the member's GUI
  degraded because we forgot to grant X" regressions. No behavior change — the
  converged grant state is identical.

### Fixed

- **An assistant bulk change no longer double-shows as "another client".** A bulk change made in this session (e.g. the assistant's bulk_update) emits one summary while its realtime echo arrives per-row; those echoes are now recognized as our own and suppressed, so the change shows once (as the assistant/you), not again as a separate "CLI / another client" card.
- **The file-loopback no longer re-ingests a render's own output.** A large render takes longer than the watcher's debounce, so a reverse-sync pass could run mid-render, read the render's half-written files before the manifest hash caught up, and re-import them as spurious "file-edit" changes (e.g. "Updated 9006 rows … file-edit", which also showed out of order in the activity feed). The watcher now defers while a render is in flight and runs once it settles, so the echo check recognizes the render's writes and skips them.
- **An open record now updates live after the assistant changes it.** When a change triggers a re-render, the open card's rendered-context panel refreshes once the render COMPLETES, instead of showing the pre-change markdown until a manual reload (the post-render refresh was being coalesced away by an earlier one).
- **"This card" and pasted in-system links now resolve to the actual record.**
  The assistant deterministically resolves the record you're viewing — and any
  record you paste a local GUI link to (`…/#/fs/<table>/<id>`) — to its real data
  (via the permission-gated read) and puts that in context, instead of asking
  "which card?" or replying "I can't fetch local URLs." Resolution happens in
  code, not by prompting the model to guess; the prior verbose "what you're
  viewing" instruction is replaced by the concrete resolved data.
- **One un-manageable table no longer takes down the whole cloud workspace.** The
  open-time cloud converge is now per-table fault-isolated: if the connecting role
  can't `ALTER`/`GRANT` a table (most often because it was created by a different
  Postgres role), that one table is skipped and every other table still
  reconciles — instead of the whole converge aborting and degrading every object
  to "Failed to fetch". The skip is reported with an actionable reason ("owned by
  role X, but this workspace connects as Y — fix with: `ALTER TABLE … OWNER TO
Y`"), surfaced via `GET /api/dbconfig` as `convergeWarnings` rather than a lone
  console line.
- **Schema reload without a restart.** `POST /api/workspaces/reload` re-reads the
  config and re-registers entities in place, so a table added out-of-band surfaces
  without killing and relaunching the GUI process.
- **An uploaded document (`.pptx`, `.docx`, `.xlsx`, `.csv`, …) could not be
  previewed, downloaded, or opened — only its extracted text survived.** A
  browser drag-drop arrives as raw bytes with no local path, and the upload route
  retained a content-addressed blob only for images and PDFs; every other type
  had its bytes discarded after text extraction. The file view then had no
  underlying file to serve, so `GET /api/files/:id/blob` 404'd ("this file has no
  underlying blob here"). Uploads now retain the original bytes for documents and
  media — images, PDFs, Office/OpenDocument files, `text/*`, JSON/XML/YAML, RTF,
  and audio/video — while still discarding arbitrary/unknown binaries (archives,
  executables, …), which keep their extracted text + description but no blob.
  Retention is gated on the file type, not on extraction success, so a document
  whose text fails to extract is still downloadable. (Already-ingested files
  whose bytes were discarded are not recoverable; re-upload to get a retained
  copy.)
- **The file view offered no way to fetch a non-previewable file.** A file with
  bytes that a browser can't render inline (an Office doc, audio, video) now
  always shows a **Download** action, so the underlying file is reachable even
  when "Open in Finder" is unavailable (a remote GUI, or `LATTICE_LOCAL_OPEN=0`);
  local bytes additionally offer "Open in Finder" when local-open is enabled.
- **Dropping a single file into the assistant rail now opens the resulting
  record.** After a one-file ingest the GUI navigates to the new file (or the
  dedup survivor if it merged a duplicate); multi-file drops do not navigate.
- **The "Drop to ingest" overlay no longer sticks after a cancelled drag.** The
  drag overlay is tracked with an enter/leave counter plus window-level
  `dragend`/`drop` backstops, so leaving via a child element or cancelling the
  drag outside the window always clears it; it also only appears for file drags.
- **A deleted record no longer lingers on screen.** When the open record is
  deleted (by the assistant, another client, or a hard delete), the detail/item
  view now navigates to the parent table/folder instead of repainting the
  tombstone; a removed entity/table returns to the dashboard. An explicit trash
  view still shows soft-deleted rows.
- **Ingest enrichment no longer reads as contradictory, and badges are correct.**
  The capture-as-a-note fallback no longer asserts a record "didn't fit any
  existing record" (which contradicted a dedup merge that can run in the same
  ingest) — it now reads as a neutral "Captured … as a note". Enrichment feed
  events are attributed to the actual originator, so the AI-path enrichment shows
  the AI badge instead of always `ingest`.
- **URL ingestion handles bot-protected pages.** The crawler now sends a
  browser-like User-Agent + headers (so help centers behind Zendesk/Cloudflare
  stop returning 403), and on a 401/403/429 it retries via a headless browser
  before giving up. If a page still blocks automated access, the error is clear
  and actionable ("open it and paste the text to ingest manually") rather than a
  cryptic HTTP code.
- **The members list refreshes after sending an invite.** A newly invited member
  now appears ("Invited") immediately, without a manual reload.
- **Chat history survives a refresh — even mid-turn.** The active conversation is
  remembered per workspace and restored on reload (instead of jumping to the
  newest thread). The assistant's reply is now checkpointed to the database as it
  streams (upserted under a stable id), so refreshing in the middle of a long
  batch turn recovers the work so far rather than losing the whole turn. A failure
  to save is surfaced to the user (a warning in the stream) instead of being
  swallowed.
- **The assistant no longer hangs on a vague "system error".** A turn now stops
  after repeated consecutive tool failures (circuit-breaker) and reports the real
  underlying error instead of looping while the model paraphrases it into a
  "system issue" and the typing indicator hangs.
- **Search works on a migrated cloud.** `migrate-to-cloud` now builds the
  full-text index for searchable tables after copying the rows, so search (and
  the assistant's entity lookup) finds migrated records instead of returning
  empty — previously the cloud had all the data but no `__lattice_fts_*` index.
  New `Lattice.rebuildFtsIndexes()` exposes a re-index for embedders. (Making
  members' cloud search RLS-correct over the shared index is a tracked follow-up.)

## [3.3.5] - 2026-06-16

### Fixed

- **The GUI's middle pane flashed/reloaded repeatedly, especially during a
  background render.** A live refresh re-rendered the current view by first
  wiping it to a loading spinner (`renderRoute`'s frame-first paint, right for a
  user navigation, wrong for a background refresh), and the background render
  fired a full reconcile on _every_ table-done (~23× for a 23-table render), so
  the pane wiped-and-rebuilt over and over. Background refreshes now re-render
  **in place** — the existing view stays on screen and is swapped only once the
  new data is ready — and the render reconciles **once** at completion, letting
  the per-card progress overlay communicate progress meanwhile. User navigation
  still paints the instant loading frame.

- **The settings drawer reopened itself.** Opening it via a `#/settings/*` link
  left that hash in the URL after the drawer was closed; because renderRoute
  reopens the drawer for that hash, a later re-render (submitting a chat message,
  a live refresh) popped the panel back open. Closing the drawer now resets the
  URL to the dashboard it overlays, so the URL always reflects what's on screen
  and the panel never self-reopens.

- **The chat assistant pushed back on bulk requests and falsely reported
  completion.** Asked to change many rows ("make every row private", "retag all
  X as Y"), it worked in small per-row batches, hit the tool-loop cap, and
  claimed "done" after changing only a fraction. The system prompt no longer
  tells it to batch defensively or police the request's size, and a new
  **`bulk_update`** tool lets the model describe the change once — a table, a
  filter (the same `{col, op, val}` filters reads use; omit it for all rows), and
  what to set (column values and/or `visibility`). The handler applies it to
  every matching row in one tool call and returns the **true** affected count, so
  the job completes regardless of size and the assistant reports the real number.

### Security

- `bulk_update` enforces the **same** per-row gating as the single-row tools — no
  privilege bypass. Column writes go through the audited `updateRow` path, so
  Postgres RLS confines a member to rows it may edit (a non-owned row is skipped,
  not counted); visibility changes pre-filter to owned rows and still run through
  the owner-only `SECURITY DEFINER` function. Hidden tables (secrets, chat
  storage) remain unreachable, soft-deleted rows are excluded, and every change
  is individually audited + undoable.

## [3.3.4] - 2026-06-16

### Fixed

- **A cloud member's `lattice render` / library `init()` failed with "permission
  denied for schema public."** `init()` ran `applySchema` (`CREATE TABLE IF NOT
EXISTS` / `CREATE OR REPLACE VIEW` / `CREATE INDEX`) on every connect, and
  Postgres checks the `CREATE`-on-schema privilege _before_ the `IF NOT EXISTS`
  short-circuit — so a scoped member (no `CREATE`) was denied even though every
  object already exists. `init()` now auto-detects a member on a provisioned
  cloud (Postgres + `__lattice_owners` present + the role cannot create roles)
  and skips schema DDL entirely (introspect-only), the same path the GUI already
  used. Members no longer need — and should not be granted — `CREATE ON SCHEMA
public`. Owner / SQLite / fresh-database behavior is unchanged.

- **The member GUI's System sidebar errored ("permission denied for table
  \_\_lattice_changes").** `GET /api/system-tables` counted every internal table
  and threw on the first one a member can't read, 500-ing the whole endpoint.
  It now tolerates a per-table count failure (permission-denied, or an
  optimistically-listed native table that isn't present) by listing the table
  with an unknown count instead of failing the sidebar; genuine faults still
  surface.

- **A cloud member rendered 0 context files.** A member joins with `entities: {}`
  (the render layout lives only in the owner's config, which the cloud model
  never ships), so the renderer had nothing to render. The member now synthesizes
  a default per-row context tree from the tables it can introspect (the database
  is the source of truth — the same `deriveCanonicalContexts` the owner uses on
  its config), so render produces the full per-row tree instead of nothing. No
  schema is shipped between owner and member; junction tables stay excluded.

- **Noisy per-connect polyfill warnings on a cloud member.** The SQLite-compat
  polyfills (`json_extract`, `strftime`) are owner-created and member-`EXECUTE`-
  granted, but a member's adapter still attempted to (re)create them on connect
  and logged three `permission denied for schema public` warnings each time. That
  expected-and-recovered case is now a single debug line; a genuine
  (non-permission) polyfill failure still warns.

### Security

- Member access to the internal substrate stays least-privilege: the owner-only
  bookkeeping tables (`__lattice_owners`, `__lattice_row_grants`,
  `__lattice_cell_grants`, `__lattice_member_roles`, `__lattice_cloud_settings`,
  `__lattice_member_invites`, `__lattice_changes`, the table/column policies, the
  native-entity + migration ledgers) are **not** granted to members — every
  legitimate member read flows through a `SECURITY DEFINER` function keyed on
  `session_user`, so a direct grant would leak another member's row existence,
  ownership, sharing graph, or identity. Only `__lattice_changelog` (already
  per-viewer-filtered by its RLS policy) is reconciled as a self-healing grant.

## [3.3.3] - 2026-06-16

### Fixed

- **Invited cloud members could connect but the GUI silently degraded to
  read-only / "save as document," with an empty render.** A member's scoped role
  was left without privileges on the bookkeeping objects the GUI and CLI need, so
  reads/writes failed with "permission denied" on connect. `reconcileCloudMemberAccess`
  — which runs on the secure cutover AND on every owner open, so existing clouds
  self-heal — now also:
  - grants the member group the GUI bookkeeping tables (`_lattice_gui_meta`,
    `_lattice_gui_column_meta`, `_lattice_gui_audit`) and the identity table
    (`__lattice_user_identity`) the member reads/writes directly on connect;
  - grants the member group `EXECUTE` on the SQLite-compat polyfills
    (`json_extract`, `strftime`) — owner-created, so a member never needs (and
    cannot, post-revoke) `CREATE` on schema `public` to register them;
  - adds `deleted_at` to any user entity table missing it (idempotent
    `ALTER TABLE … ADD COLUMN IF NOT EXISTS`), so a cloud migrated from a
    pre-soft-delete SQLite no longer breaks the render and exact counts (which
    filter `WHERE deleted_at IS NULL`).

  The owner-only governance table `__lattice_cell_grants` is **not** granted to
  members — it is reached only through `SECURITY DEFINER` functions, so a direct
  member grant would leak every cell-sharing decision; member cell-visibility
  continues to flow through `lattice_cell_visible` unchanged.

## [3.3.2] - 2026-06-16

### Fixed

- **A cloud member saw junction (link) tables listed as objects in the sidebar.**
  A member joins with no entity config (relations are config-only and never live
  in the database), so the GUI discovered every table from the catalog and listed
  link tables as first-class objects — while the owner's config-driven sidebar
  correctly omitted them. The member now classifies junctions from the physical
  table shape (a lattice junction is exactly `id` + two `*_id` columns with no
  payload) and keeps them out of its table set entirely. The database stays the
  single source of truth — no schema is shipped to members; a member still sees
  exactly the tables they can access, minus junctions.

- **"Shared with specific people (0)" now reads as Private.** A row shared with
  nobody is only visible to its owner (RLS), so it must read as private. Two
  causes are fixed: opening the "Specific people…" panel no longer eagerly flips
  the row to `custom` before any grantee is chosen (the first grant flips it
  server-side; revoking the last leaves it custom-with-0-grantees), and the
  sharing indicator/label now renders an owner's custom-with-0-grantees row as
  private everywhere. A member viewing a row shared _with_ them still reads
  "Shared with you" (unchanged).

- **GUI froze ("Switching…" forever, clicks that never resolved) with more than
  one tab open.** The GUI opened three long-lived Server-Sent-Event streams per
  tab (realtime, activity feed, render progress). Browsers cap HTTP/1.1 at six
  connections per host, so two open tabs consumed all six slots and every data
  request — entities, rows, workspace switch — queued indefinitely with no
  recovery. The three streams are now multiplexed onto **one WebSocket**
  (`/api/stream`) carrying typed `{ type, data }` messages. WebSocket connections
  live in a separate, far larger browser pool than HTTP/1.1 requests, so the
  whole six-connection HTTP budget stays free for data requests no matter how
  many tabs are open. The client reconnects with backoff if the socket drops
  (WebSocket has no built-in auto-reconnect); per-recipient realtime visibility
  filtering, internal-table feed filtering, and self-echo de-duplication are all
  preserved. Adds a `ws` runtime dependency.

- **Version showed as "unknown" in published builds.** `getVersion()` read
  `package.json` via `import.meta.url` at runtime, which fails once the code is
  bundled and installed under `node_modules` — so the CLI `--version` and the GUI
  version chip showed "vunknown". The version is now injected at build time
  (tsup `define`), with the file read kept as a dev fallback.

- **Assistant could report a sharing change it lacked permission to make.** The
  `set_visibility` tool relied solely on the Postgres RLS function to reject an
  unauthorized change, so a no-permission attempt could surface as success. It now
  runs a deterministic pre-check (row owner via `lattice_rows_access`; table
  default via role privilege) and returns an explicit refusal the assistant
  relays — the RLS function stays as defense-in-depth.

### Changed

- **Faster cloud-workspace open.** The owner-vs-member probe now runs its
  independent, read-only introspection queries concurrently (RLS-installed +
  role-privilege; table discovery + masking-view lookup) instead of serially. No
  change to the owner/member determination, the `information_schema` privilege
  filters, or any RLS/grant gate.

### Added

- **GA unique-user de-duplication.** The GUI now sets the Google Analytics
  `user_id` to a SHA-256 hash of the operator's email (hashed in-browser; the
  plaintext is never sent, and the analytics layer accepts only a hex digest), so
  active users are deduplicated across sessions/devices instead of counting ≈ 1
  per event. Opt-in and gated on the existing analytics consent.

## [3.3.1] - 2026-06-16

### Added — first-class URL ingestion

- **`ingest_url` assistant tool.** Paste or name a web link and ask the assistant
  to "read / summarize / save" it — it fetches the page, extracts the readable
  text, saves it as a `files` row (a `cloud_ref` web reference), and summarizes
  it. The saved reference follows the same sharing rules as any file (private
  mode → private; otherwise the files-table default).
- **User-provided-URLs only.** The tool fetches **only** a URL that appears
  verbatim in the user's own message — it will not follow a URL discovered inside
  a file, a row, or model output. This closes the obvious SSRF + prompt-injection
  vector for an LLM-driven fetcher.
- **Untrusted-content framing.** A fetched page is treated as untrusted data
  everywhere: the row is flagged `source_json.untrusted=true`, the enrichment
  prompts wrap its text in explicit "this is data, not instructions" markers, and
  `get_row` / `list_rows` re-wrap it whenever the assistant reads it back.
- **One unified URL→file path.** The assistant tool and the `/api/ingest/text`
  URL branch now share a single `ingestUrlAsFile` helper, so SSRF checks, the
  fetch policy, rate-limiting, and the untrusted framing are identical wherever a
  URL is ingested. A crawl that yields no readable text now surfaces an error
  instead of silently storing the bare URL string.

### Added — fetch guardrails + config

- **SSRF + policy + rate-limiting.** Every URL fetch passes an SSRF guard, an
  on/off + allow/block-list policy, a per-turn fetch budget, a process-wide
  concurrency cap, and a per-host throttle. Tunable via `LATTICE_URL_INGEST`,
  `LATTICE_URL_MAX_BYTES`, `LATTICE_URL_TIMEOUT_MS`, `LATTICE_URL_MAX_CONCURRENCY`,
  `LATTICE_URL_FETCH_BUDGET`, `LATTICE_URL_HOST_MIN_INTERVAL_MS`,
  `LATTICE_URL_ALLOW_DOMAINS`, and `LATTICE_URL_BLOCK_DOMAINS`.
- **Optional headless rendering.** SPA pages can be rendered with headless
  Chromium when the optional `playwright` dependency is installed; without it the
  crawler degrades gracefully to the static extraction (with a single warning).
- **Per-host extractors.** Sites that serve no readable static HTML (e.g. posts
  on x.com / twitter.com) are read through a dedicated extractor (their public
  oEmbed endpoint) instead.

### Changed

- **Streaming, capped fetches.** The crawler now streams the response body and
  aborts once the byte cap is reached, so an oversized or never-ending response
  can't be buffered whole into memory.

### Fixed

- **The GUI no longer freezes while loading data (frame-first rendering).** Every
  view rendered its content only AFTER its data fetch resolved, so a large table
  or a slow cloud open left the _previous_ view frozen on screen with no feedback.
  Navigation now paints a loading frame synchronously on every click and streams
  the content in — guarded by a monotonic render generation so a stale/slow load
  can't clobber a newer view. The workspace switcher does the same, so switching
  shows the new workspace opening rather than freezing on the old one. The UI
  stays interactive regardless of data size or connection latency, and it scales
  to hundreds/thousands of rows.

- **Workspace switch could hang the GUI indefinitely (both directions).** A switch
  `await`s opening the target workspace and tearing down the previous one; neither
  was time-bounded, so a slow or wedged Postgres (cloud) connection froze the GUI
  on "Switching…" forever — and because the switch never returned, the rest of the
  SPA was stuck too. Two root-cause fixes:
  - **`RealtimeBroker.stop()` no longer hangs.** Its graceful `client.end()` waits
    for a server close-ack that never arrives on a wedged / half-open pooler
    connection (the silently-dead LISTEN the watchdog exists for). `stop()` now
    caps the close and **force-destroys the socket** on timeout, so it always
    returns promptly and the connection is **released, not leaked** (the prior
    teardown band-aid bounded the wait but abandoned the broker, leaking its
    connection — repeated switches could then exhaust the cloud's connection pool).
  - **Opening the target workspace is time-bounded.** If a cloud open (peek
    connection + init + owner bootstrap converge + LISTEN) doesn't complete within
    the cap, the switch keeps the **current** workspace active and surfaces a clear
    error instead of spinning forever; the slow open is disposed in the background
    so it can't leak. SQLite workspaces (no broker, local file) are unaffected.

## [3.3.0] - 2026-06-15

### Added — assistant artifacts

- **Markdown artifacts.** Ask the assistant to "write a doc / note / summary" and
  it creates a Markdown **artifact** — saved as a `files` row (flagged
  `artifact_type='markdown'`, content inline), shown with an "✦ Artifact" badge,
  rendered as formatted Markdown, and auto-opened in the viewer. Artifacts follow
  the exact same sharing rules as any file (private mode → private; otherwise the
  files-table default), enforced by cloud Row-Level Security.

### Added — self-describing schema

- **Column + table definitions.** New columns and tables get a concise one-line
  definition generated automatically (a cheap, non-blocking, fail-silent model
  pass) and shown as hover tooltips on table headers, field labels, the sidebar,
  and dashboard cards. Built-in definitions ship for the native entities. The
  assistant can author or correct one with the `set_definition` tool, and the
  definitions are injected into its schema context so it categorizes better.

### Added — seamless de-duplication

- **Automatic file de-duplication.** Uploading a byte-identical file now merges
  it onto the original automatically (the copy is soft-deleted, recoverable from
  Trash / Undo) — no modal, no prompt. The assistant can also de-duplicate any
  table on request (`dedup` tool); fuzzy-merge liberalness follows the
  inference-aggressiveness slider.

### Added — workspace branding (cloud)

- **Workspace logo.** A cloud owner can upload a square PNG/JPEG logo that
  replaces the default Lattice mark in the topbar for every member (Settings →
  Workspace → Display). Owner-only to set; member-readable; cached by content
  hash so it's fetched once per version. SVG is rejected (it can carry script).

### Added — per-row sharing

- **"Share with specific people".** Restored the per-row custom-share checklist:
  a row owner can grant/revoke individual members access to a single cloud row
  (owner-only, enforced in the database), alongside the existing
  private ↔ everyone toggle.
- **Privacy indicators everywhere.** Each object shows a small faint lock (private
  to you) or eye (shared) marker — in the sidebar object list, on the entity page
  next to its visibility line, and in the corner of every folder/collection card
  tile — so a row's sharing is visible at a glance. Every indicator has a hover
  tooltip explaining what the lock/eye means (state- and ownership-aware), driven
  by one shared component. The per-row sharing controls now also appear in the
  simple object view, not only the advanced data view.
- **`set_visibility` assistant tool.** The assistant can change the sharing of a
  row or a whole table (private ↔ everyone) on request, limited to what the
  asking user is allowed to change. Assistant-initiated sharing changes are
  undoable like any other change.

### Added — first run + onboarding

- **Zero-workspace welcome.** Lattice no longer force-creates a default
  workspace. On first launch (and after deleting your last workspace) it shows a
  "Welcome to Lattice" screen with Create / Join wizards (identity-first; local,
  cloud, or join-by-invite). The last workspace can now be deleted.
- **Boot loading screen.** A brief full-screen "Loading…" interstitial masks the
  half-rendered shell during startup and fades out once the app is ready.
- **Connect your assistant during onboarding.** After the name/email step, the
  wizard offers an optional "Connect with Claude" step (reusing the same
  subscription-OAuth flow as Settings) so a new workspace can have a working
  assistant from the start. It's fully skippable — "Skip for now" continues to
  create/join, and an already-connected account is detected and shown as such.

### Added — connect a Claude subscription

- **Connect with Claude.** The assistant can now authenticate with your Claude
  Pro / Max / Enterprise **subscription** via OAuth (PKCE) instead of a pasted
  API key — "Connect with Claude" is the primary action; the API-key field moves
  under an "Advanced" disclosure. Endpoints/client are overridable via
  `ANTHROPIC_OAUTH_*` env vars; the loopback redirect is derived per session.

### Changed

- The composer attach control is now an upload icon (the native multi-file
  picker is the whole flow).
- The activity feed attributes automatic, system-initiated changes to "Lattice".
- The top bar shows the running Lattice version next to the settings gear.
- A file entity page now renders its formatted Markdown document above the
  column-by-column data view, so the readable content is what you see first.
- The assistant explains things in plain language and does what you ask through
  its tools, rather than describing database internals or API calls.
- **One cloud-connection form everywhere.** Creating or migrating to a cloud now
  uses a single structured connection form (Host / Port / Database / User /
  Password) across the onboarding wizard, the "New workspace" wizard, and "Migrate
  to cloud" — all routing through the same `migrate-to-cloud` setup (which installs
  row-level security and makes you the owner). The separate `postgres://`
  connection-string input has been retired, so there's one way to connect, not two.

### Fixed

- **Image previews no longer fail for files with non-ASCII names.** A filename
  carrying a character outside Latin-1 (e.g. the narrow no-break space in a macOS
  screenshot name) made the blob response's `content-disposition` header invalid
  and the preview 500'd; the header is now RFC 5987 encoded (ASCII fallback +
  `filename*=UTF-8''…`), so the image loads.
- **"Open in file manager" reveals the file** in the OS file browser (Finder /
  Explorer / the desktop file manager) instead of opening it in an editor — and
  for a content-addressed blob (stored as `data/blobs/<hash>`, no name/extension)
  it now reveals a **named copy** carrying the original filename + extension, so
  you see your actual "Screenshot ….png" rather than a hash-named "Document".
- **A too-large upload now reports a real error instead of "Failed to fetch".**
  When a request body exceeded the size cap, the server reset the socket, which
  the browser surfaced as an opaque "Failed to fetch" (e.g. saving a large
  workspace logo). It now returns a clear `413` with the reason, and the logo
  uploader reaches its precise "max 64 KB" validation message.
- **"Share with specific people" works.** Switching a row to per-person sharing
  failed with `invalid visibility "custom"` — the visibility setter rejected the
  `custom` mode the underlying row-level-security function accepts. It now accepts
  `custom`, so the member checklist loads and you can grant individual people.
- **"Connect with Claude" works during first-run onboarding.** The optional
  Connect step runs before any workspace exists, but the zero-workspace guard
  rejected every assistant route with "No active workspace". Assistant
  credentials are machine-level (not stored in a workspace), so configuration,
  API-key, and subscription-OAuth endpoints now work with no active workspace.
- **Assistant-driven changes are undoable.** A change the assistant makes on your
  behalf is now recorded under the active session, so it shows up in the header
  undo stack just like a manual edit.
- **Scoped members can connect to a freshly secured cloud.** The SQLite-compat
  helper functions are now created by the owner before the security cutover
  revokes schema-create from members, so a member's first connection no longer
  hits a permission error trying to create them.
- **Migrating to a cloud no longer needs a manual refresh.** After the switch to
  the cloud, the app re-fetches and re-renders immediately (entities, per-row
  sharing indicators, realtime) — previously only the settings panel updated and
  the rest of the UI showed stale pre-migrate data until you reloaded.
- **`upsert()` fires write hooks.** It previously only scheduled an auto-render,
  so sync / outbox / cache-invalidation subscribers silently missed every upsert;
  it now fires the same write hooks as `insert`/`update`/`delete`.
- **`addColumn()` mirrors the registered table definition.** A runtime-added
  column now shows up in `getRegisteredColumns()`, so the Teams `share` schema
  serialization propagates it to teammates instead of silently dropping it.
- **Realtime survives a silent `LISTEN` drop.** A transaction-mode pooler /
  managed-Postgres proxy can drop the `LISTEN` registration without closing the
  socket, leaving the stream silently dead. A periodic backstop poll now re-runs
  the bounded, visibility-gated catch-up query and delivers any missed changes
  (configurable via `startGuiServer`'s `realtimeWatchdogMs`; `keepAlive` is also
  enabled on the realtime socket). See the new managed-Postgres / AWS RDS notes
  in the docs.

### Added

- **`startGuiServer` is exported** (with `StartGuiServerOptions` /
  `GuiServerHandle`), so a library consumer can embed the GUI server without
  shelling out to the CLI.
- **Managed-Postgres deployment guide** (AWS RDS / RDS Proxy, Cloud SQL, Neon):
  use a session-mode/direct endpoint for the realtime `LISTEN`, identity survives
  a pooler, no `search_path` pinning is needed, and a recommended parameter group.
- **`maxRowBytes` option.** An optional `LatticeOptions.maxRowBytes` cap rejects an
  insert/upsert/update whose row payload exceeds the limit — a guard against a
  member writing oversized rows as a denial-of-service. Off by default.
- **Durable `FileSourceKeyStore`.** A file-backed `SourceKeyStore` (optionally
  AES-256-GCM encrypted at rest) so crypto-shred source keys survive a process
  restart, where the default in-memory store would lose them. Complements the new
  `docs/security.md` (threat model, deployment hardening, launch checklist).

## [3.2.1] - 2026-06-14

### Fixed — cloud member access converges on every owner open

- **Internal chat tables are always per-owner private.** The assistant's
  conversation storage (`chat_threads` / `chat_messages`) is now forced
  `never_share` on every secure / owner open, so a member can never read another
  member's chat — even if a bulk "share everything" or a restore left those
  tables stamped `everyone`. Row-Level Security enforces it at the database, so
  it can't be bypassed by the share path or a route bug.
- **Member grants self-heal after a privilege-dropping restore.** The per-table
  member `GRANT` is re-issued on every cloud owner open (ungated, no row scans),
  so a table that shows as shared is always actually readable. Previously the
  grant lived only inside a version-gated per-table migration, so a restore that
  kept the RLS policy but dropped privileges (e.g. a `pg_dump --no-privileges`
  round-trip) left members unable to read shared tables. Granting is limited to
  RLS-secured tables, so it can never widen an unsecured table.

### Fixed — GUI

- **A cloud member no longer sees a broken entity for a table it can't read.**
  Tables the member has no column access to (privilege-filtered to zero columns)
  are skipped at open instead of being registered as an empty-schema entity that
  failed every read with `unknown column "deleted_at"`.
- **Sidebar nav highlight matches on a path-segment boundary.** Clicking an
  object no longer also highlights siblings whose name starts with the same word
  (e.g. selecting "Files" lit up "Files Project" / "Files Projects").

## [3.2.0] - 2026-06-14

### Added — ask the assistant about Lattice itself (3.2)

- **`lattice_help` tool.** The chat assistant can now answer questions about
  Lattice's own features ("what is private mode?", "how do I invite a member?")
  by searching Lattice's documentation, instead of guessing or searching your
  data. It reads the SINGLE canonical docs source — the repo's `docs/*.md`, which
  are the GitHub docs and now ship in the npm package (`files` includes `docs`) —
  so there's no separate, drift-prone copy.

### Added — chat knows the record you're viewing (3.2)

- **The assistant resolves "this".** The chat now sends the record currently open
  in the GUI (table + id) as context, so "delete this file", "summarize this", or
  "share this row" act on it directly instead of asking which one. The hint is
  validated server-side (table must exist) and every action still flows through
  the permission-gated tools, so it can't widen access.

### Fixed — chat rail follows the active workspace (3.2)

- **Switching workspaces now resets the chat rail.** `chat_threads`/`chat_messages`
  live in the workspace DB, but a workspace switch/create left the previous
  workspace's conversation on screen. The rail now clears and reloads the new
  workspace's threads on every switch.

### Fixed — file view: inline image + Open/Download buttons (3.2)

- **Uploaded images preview inline again.** The preview only rendered when the
  stored `mime` started `image/`; an upload that didn't record a mime showed no
  image. It now also detects images by filename extension.
- **Open in Finder / Download are mutually exclusive + correctly gated.** A file
  with bytes on this machine shows **Open in Finder** (when `LATTICE_LOCAL_OPEN`
  is enabled — now the **default**; set `=0` to disable, which hides the button
  rather than offering a dead one); a cloud (S3) file with no local copy shows
  **Download**. Never both.

### Fixed — GUI activity feed + data-model sharing (3.2)

- **No feed pills for internal plumbing tables.** Writes to the assistant's own
  `chat_threads`/`chat_messages` storage (and any `_lattice*` bookkeeping) no
  longer surface as activity-feed pills — only real user-data activity does.
- **"Added column(s)" events group instead of duplicating.** The auto-create
  emitter produces "Added columns a, b to X", which the feed's grouping regex
  didn't match (`/^Added a column/`), so a bulk ingest spammed an identical pill
  per file. They now collapse into one counted pill.
- **No "Share with workspace" button on never-share tables.** A never-share table
  (e.g. `secrets`) is a hard-private floor, so its data-model panel shows a static
  "never shared" note instead of a share toggle.

### Fixed — members panel + kick (3.2)

- **Kicking a member works on managed Postgres.** `revokeMemberRole` did
  `REASSIGN OWNED` / `DROP OWNED` unconditionally, which a restricted-superuser
  owner (e.g. Supabase's `postgres`) can't do for a role it isn't a member of —
  it raised "permission denied to reassign objects" and the kick failed. A scoped
  member owns no objects, so that insufficient-privilege error is now tolerated
  (logged) and the role is still dropped; any other error — and a failed DROP ROLE
  — still surfaces.
- **Members list shows people, not roles, with the right status.** A pending
  (un-redeemed) invite now shows the invitee email + an **Invited** status instead
  of the raw Postgres role labeled "Member"; redeemed members show as **Member**.

### Fixed — member reads of masked tables + row-access enrichment (3.2)

- **Members can read audience-masked tables again.** A secured cloud REVOKEs base
  `SELECT` from members for any table with a column audience and grants only the
  `<table>_v` masking view, but the read path still queried the base table — so a
  member got `permission denied` (and column masking gave the read path zero
  protection). Member SELECTs now route to the masking view (writes still target
  the base under RLS); the view is never exposed as a separate sidebar object.
- **Per-row `_access` no longer 500s for members.** The sharing-affordance
  enrichment read `__lattice_owners` directly, which members have no grant on, so
  every member row fetch failed. It now goes through `SECURITY DEFINER`
  `lattice_rows_access` / `lattice_row_grantees`, which return only the rows the
  caller can see (and grantees only for rows the caller owns).

### Fixed — realtime, egress + misc cloud hardening (3.2)

- **Realtime actually delivers other clients' changes.** The change feed's op
  domain is `upsert`/`delete`, but the SSE merge matched `INSERT`/`UPDATE`/`DELETE`
  — so every remote change mapped to null and was dropped. And the payload parser
  read `team_id`/`owner_user_id`/`client_ts` (never emitted) while dropping
  `owner_role` (the editor), so "last edited by" never resolved. Both now mirror
  the NOTIFY trigger exactly.
- **Realtime fan-out is filtered per recipient.** The NOTIFY stream is global; a
  member's stream forwards only `upsert` changes for rows it may actually read
  (probed through the same RLS visibility function), so an unreadable upserted
  row's pk / existence / editor is not disclosed. (Correction: delete events at
  this version were still fanned out to every member, with the editor stripped —
  so a deleted row's pk + existence were visible to members who could not read it.
  Per-recipient scoping of delete events lands in 4.2, gating them from a
  pre-delete visibility snapshot.)
- **Realtime catches up after a gap.** A broker that drops its `LISTEN` (sleep,
  network blip) replays the changes it missed on reconnect, via a bounded
  `SECURITY DEFINER lattice_changes_since(seq, limit)` that returns only the
  caller-visible upserts — so a brief disconnect no longer silently loses updates.
- **Offline edits that can't replay are surfaced, not retried forever.** A write
  that can never apply (row gone / RLS-invisible) now returns 409, and the client
  marks the queued edit failed + surfaces it (dead-letter) instead of looping on
  it. Any 4xx during replay is treated as terminal; only 5xx/network retries.
- **Edit time is honored.** A row write may carry `x-lattice-client-ts`; the
  audit/history timestamp now records when the edit was MADE (so an offline edit
  replayed later isn't stamped at sync time). A future timestamp is rejected.
- **Bounded row pages.** `GET /api/tables/:table/rows` validates `limit`/`offset`
  (400 on non-numeric, was `LIMIT NaN`) and clamps `limit` to ≤ 1000 — an
  unbounded page was a full-table egress on a cloud hot path.
- **Salted invite-audit email hash.** The invitee-email hash in the audit table is
  peppered with a per-cloud salt instead of a bare SHA-256.
- **Generic 500s are logged.** The shared request wrapper now logs the failing
  error (message + stack) server-side before returning a 500, so a swallowed
  cloud-op failure is no longer invisible.

### Fixed — cloud role lifecycle + offline integrity (3.2)

- **Offline edits replay idempotently.** The GUI stamps every row write with a
  stable `x-lattice-edit-id` and replays queued writes after a reconnect (or when
  the original response was lost after the row committed), but the server ignored
  the header — so a replayed `POST` created a duplicate row. The row-create path
  now derives a deterministic id from the edit-id and treats a replay whose row
  already exists as a no-op (HTTP 200, same id), never a duplicate. Scoped to the
  edit-id path; the assistant/ingest create paths are unchanged.
- **Invites are one-time-use, with revocation + expiry enforced.** A leaked or
  replayed invite token was redeemable until expiry, and a revoked invite was
  never checked on redeem. The member now atomically CLAIMS its invite on join via
  a `SECURITY DEFINER` `lattice_claim_invite()` (keyed on `session_user`, so a
  member can only burn its own invite): a second redeem, a revoked invite, or an
  expired one is rejected before any workspace is created.
- **Re-inviting an email no longer orphans the prior role.** Each re-invite mints
  a fresh suffixed role; the prior pending invite's role is now revoked + dropped
  (and expired-but-unredeemed invite roles are swept) at invite time, so scoped
  roles don't pile up and a superseded token goes dead. `revokeMemberRole` is now
  idempotent on an already-gone role.

### Fixed — data-model sharing controls restored (3.2)

- **Per-object sharing is back in the Data Model panel.** The 3.0 RLS rewrite
  stopped setting the `ownedByMe` / `shared` fields the client gates the sharing
  controls and the red/amber/green node border on, so they vanished entirely. The
  server now sets them for a cloud owner — `ownedByMe = true`, and `shared` maps to
  the table's rows defaulting to everyone-visible (the 3.1 RLS semantic). The
  "Share with workspace / Make private" toggle is repointed to the existing
  default-row-visibility endpoint (the old `/share` endpoint was removed in the
  rewrite, so the button had been 404ing).

### Fixed — cloud members + invites (3.2)

- **Members can connect again on Supabase pooler hosts (was breaking).** The
  minted member username now derives the pooler tenant ref from the owner's
  connection-string username (`postgres.<ref>`), not `session_user` (which is the
  bare role on the pooler) — so the member username keeps its `.<ref>` suffix.
- **Re-inviting an existing member no longer errors on Supabase.** The role-exists
  ALTER branch sets only `LOGIN PASSWORD`, not the `NOSUPERUSER`-class attributes
  (restating them tripped supautils 42501 since the owner isn't a true superuser).
- **Members list shows real people, not the Postgres role.** It now lists each
  member's name + email (owner from the workspace identity; members from the
  stored invitee email) with an Owner/Member status, and no longer double-counts
  the owner. A new owner-only `POST /api/cloud/remove-member` + a "Kick" control
  wire the previously-unreachable `revokeMemberRole`; revocation reassigns/drops
  the member's objects and surfaces failures (internal guideline) instead of swallowing them.

### Fixed — cloud RLS hardening (3.2)

- **Runtime-created cloud tables are now secured.** A table made from the
  data-model panel / assistant / ingest on a secured cloud is RLS-enabled +
  ownership-stamped + member-granted (via a `secureNewCloudTable` helper factored
  from `secureCloud`), instead of being left wide open.
- **Changelog visibility fails closed on an empty source set.** A derived
  observation with an empty `source_ref` was visible to every member (the
  `NOT EXISTS` over an empty array was vacuously true); it now requires a
  non-empty source array (mirrors `fold.ts`). The changelog policy runs directly
  (converges on owner open) like the rest of the bootstrap.

### Fixed — cloud join creates a new workspace + resilient member open (3.2)

- **Joining a cloud now CREATES a new workspace (and switches to it)** instead of
  repointing — hijacking — the currently-open one (which overwrote the user's
  existing local workspace: wrong name, orphaned data, no switcher entry). The new
  workspace is named after the cloud (the owner stamps `workspace_name` into the
  invite), and the join is **atomic**: if the cloud can't be opened, the
  half-created workspace + saved credential are rolled back.
- **Member open is resilient.** Owner-side maintenance that needs schema write
  grants (native-entity reconcile, legacy-secret cleanup, the identity-mirror
  upsert) is skipped / best-effort on a cloud-MEMBER open, so a member no longer
  fails to connect with "permission denied for schema public / \_\_lattice_user_identity".
- New end-to-end Postgres test boots a real owner GUI + member GUI and asserts the
  member lands on a new, correctly-named, active cloud workspace (local untouched).

### Fixed — cloud join path + schema detection (3.2)

- **Join no longer silently lands a member on an empty local DB.** A
  `${LATTICE_DB:<label>}` reference whose label was malformed (e.g. the default
  join label "Cloud workspace", which has a space) used to fall through to
  filesystem-path resolution — creating a literal `${LATTICE_DB:…}` file (0-byte
  on Windows) and a silent empty SQLite DB. `resolveDbPath` now THROWS on a
  shaped-but-invalid reference (new shared `parseDbRef`/`isDbRefShaped` helpers),
  and the join flow sanitizes the credential key / `${LATTICE_DB:…}` reference
  (via `slugify`) while keeping the human display name — so the credential
  actually resolves.
- **`cloudRlsInstalled` resolves via the search_path**, not a hardcoded `public.`,
  so a cloud installed into a non-public schema is detected correctly.

### Fixed — cloud bootstrap converges on owner open (3.2)

- **The cloud object bootstrap now converges.** `installCloudRls` /
  `installCloudSettings` run their idempotent DDL directly (serialized by the
  shared `pg_advisory_xact_lock`) instead of behind a one-shot version gate, and
  run on every cloud-OWNER open. So an object added to the bootstrap in a later
  release (e.g. `__lattice_member_invites`) now reaches clouds already stamped at
  an earlier version, and "secure this cloud" no longer no-ops. The expensive
  per-table ownership/RLS backfill stays version/secure-gated (internal guideline — no
  whole-table scans on open).

### Changed — concurrent background render (3.2)

- **Entity-context tables now render concurrently** (bounded fan-out) instead of
  strictly one-after-another, so several render at once and each card's progress
  advances at its own rate. The cap keeps in-flight whole-table reads small.
- **`ProgressThrottle` is now per-table keyed**, so a fast table can't consume the
  shared throttle window and starve a slow table's progress updates.
- `mapWithConcurrency` moved to a package-root module (re-exported from its old
  path) so the render engine can share it without inverting layering.

### Fixed — assistant never overflows the context window (3.2)

- **Big reads no longer blow the prompt.** Each tool result is now budget-capped
  before it enters the turn's prompt (which is re-sent on every tool-loop step), so
  a few wide 200-row reads can't recompound past the model's context window.
- **Invisible auto-recovery.** If the provider still rejects a turn as too long,
  the assistant trims the oldest bulky tool result and retries automatically — the
  user never sees a "prompt is too long" error.
- **Friendly fallback, never the raw 400.** If recovery is exhausted, the user gets
  a short actionable message instead of the raw provider error JSON (the real error
  is logged for ops).
- **`list_rows` pagination.** `list_rows` accepts `limit` + `offset` so the
  assistant pages through large tables deliberately; the system prompt now tells it
  to batch large work instead of loading whole tables.

### Fixed — ingest auto-link surfaces failures (3.2)

- **No more silent auto-link failures (internal guideline).** When ingest auto-linking can't
  run or a link/junction write fails (e.g. a cloud permission/RLS error), the
  reason is now logged loudly AND surfaced in the activity feed, instead of a bare
  `catch { return []; }` that left "nothing linked" with no explanation. The
  LLM-client-init failure path, the classify failure, and per-match junction/link
  failures all surface now.

### Fixed — activity feed grouping (3.2)

- **Relationship-link activity now collapses.** Junction-materialization events
  ("Linked files ↔ project", "Linked authors ↔ books") arrived as schema ops that
  matched no grouping rule, so each spammed its own pill in the assistant feed.
  A run now collapses into one counted "Linked N relationships" bubble.

### Added — opt-in Google Analytics (3.2)

- **Anonymous, opt-in product analytics (GA4).** Gated on the existing "Send
  anonymous analytics" preference (and `DO_NOT_TRACK` / `SCARF_ANALYTICS` env):
  gtag.js is loaded lazily only after consent, so there is zero network contact
  while opted out. Configured with `send_page_view:false`, `allow_google_signals:
false`, `allow_ad_personalization_signals:false`, `anonymize_ip:true`.
- **Strict anonymization.** Event params are whitelisted to booleans / finite
  numbers / short enum tokens — table and column names, row ids/content, file
  names, queries, chat text, display name, email, paths, and the port are never
  sent. `page_view` reports a synthetic route-type location, never the real hash.
- Wired events: `app_open`, `page_view`, `row_create`/`row_update`/`row_delete`,
  `file_ingest`, `assistant_message`, `assistant_thread_new`, `history_action`
  (undo/redo/revert), `member_invite`, `table_create`/`table_delete`,
  `data_model_share`, `workspace_create`/`workspace_switch`, `search`,
  `setting_change`, `analytics_opt_in`/`analytics_opt_out`. All params are coarse
  enums/counts only. The preference reports `analytics_effective`.

### Changed — settings layout (3.2)

- **Chat system prompt moved into Settings → Workspace.** The standalone "Chat"
  settings tab is gone; the cloud system-prompt editor is now a "System Prompt"
  subsection directly beneath "Database connection", shown only to the workspace
  owner (it's absent for members and local workspaces). Endpoint unchanged.

### Fixed — GUI polish (3.2)

- **Render progress label.** The per-card background-render indicator reads
  "Rendering NN%..." instead of a bare "NN%".
- **Top-bar dropdown stacking.** The top bar now establishes an explicit stacking
  context, so its `backdrop-filter` no longer traps the workspace-switcher / search
  dropdowns beneath the dashboard cards.
- **Objects ordered alphabetically.** The sidebar object list (and the history and
  add-link pickers) are sorted by display label.

### Added — GUI polish (3.2)

- **Auto-emoji for objects.** An object with no custom icon and no built-in mapping
  is given an apt emoji derived from its name (falling back to the default icon when
  nothing fits).
- **Private-mode indicator on local workspaces.** On a single-user local workspace
  the assistant "Private mode" toggle renders checked + disabled (local data is
  always private); it stays interactive on a cloud workspace.

## [3.1.0] - 2026-06-14

### Added — email-bound cloud invites + members list (3.1)

- **Email-bound invite tokens.** `POST /api/cloud/invite` takes an invitee email,
  provisions a fresh scoped `lm_*` role (asserted non-privileged — never a
  superuser / `CREATEROLE` / `BYPASSRLS` / owner role), and returns ONE opaque,
  email-bound token. AES-256-GCM; the key is `HKDF(random token secret)` salted by
  `scrypt(email)` with the email as AAD, so a token decrypts only with the matching
  email. The member redeems it with their email in "Join a cloud"
  (`POST /api/cloud/redeem-invite`) — the member UI never handles a `postgres://`
  string. The pooler-correct user is baked in for Supabase hosts. Owner-only audit
  in `__lattice_member_invites` (email hashed; password never stored). New
  `src/cloud/invite.ts`; threat model documented in `docs/cloud.md`.
- **Members list.** `GET /api/cloud/members` lists the owner plus every role in the
  member group; the owner Database-Connection panel renders it.
- **`__lattice_user_identity` granted to the member group** in `secureCloud`, so a
  member can drive the GUI (previously hit `permission denied`, blocking every
  member on connect).
- **Chat system prompt** now edits inline in its own "Chat" settings section
  (replacing the modal).

### Fixed (3.1)

- **Cloud sharing UI restored.** Row reads re-attach the per-row `_access` summary
  (`rowAccessSummaries` over `__lattice_owners` + `__lattice_row_grants`) that the
  3.0 RLS rewrite dropped without a replacement, so the per-row sharing affordance
  renders again. Bounded to one query per page; no-op off a secured cloud.
- **Assistant writes are no longer silently dropped.** The GUI mutation layer
  auto-creates columns the table lacks (instead of filtering them away while
  reporting success), persists the value, regenerates the cloud audience view, and
  records the schema change to the activity feed. `update()` also no-ops a
  fully-filtered `SET` instead of emitting invalid SQL.
- **GUI settings.** The Advanced View toggle moved from the sidebar into
  Settings → Lattice; the active workspace row is highlighted and clicking another
  switches it AND closes the drawer; the voice provider gains a "No Voice" option
  that disables voice; error toasts render above modal overlays instead of behind.

### Added — all cloud config stored + enforced in Postgres (3.1)

- **Per-table policy (`__lattice_table_policy`).** A table now carries an
  owner-controlled `default_row_visibility` (`private` | `everyone`) and a
  `never_share` flag, both **enforced in Postgres** (the per-table insert trigger
  stamps new rows with the table default; `never_share` forces them private). So a
  raw `psql` insert obeys the same defaults as the app. Owner-only setters
  `setTableDefaultVisibility` / `setTableNeverShare` (SQL: `lattice_set_table_*`,
  gated on `rolcreaterole`); `getTablePolicy` / `getAllTablePolicies` to read.
- **Never-share exclusions.** `lattice_set_row_visibility` / `lattice_grant_row` /
  `lattice_grant_cell` now RAISE for a `never_share` table — Secrets/Messages-class
  tables can never be shared, at the data-model level (`secrets` is seeded
  never-share by `secureCloud`). Closes the gap where any table could be elevated.
- **Column-audience spec moved into Postgres (`__lattice_column_policy`).** The
  per-column `audience:` spec is now stored canonically in the DB (was on-disk YAML
  compiled once at init); `setColumnAudience` writes it and **regenerates the mask
  view from the DB**, so masking is identical across members and re-masks on change
  without a re-init. YAML specs are seeded into the DB on upgrade.
- **DB-enforced secret columns (`owner` audience).** New `lattice_is_owner`
  predicate + an `owner` column audience: a secret column is masked to everyone but
  the row owner in Postgres (the `<table>_v` view). Marking a column secret in the
  GUI now also sets this; the assistant-side redaction is rescoped to model-context
  safety, not the privacy boundary.
- **Chat "private mode".** A composer toggle that forces rows the assistant creates
  to stay private regardless of the table default. The row is stamped private
  **atomically at insert** (`Lattice.insertForcingVisibility` sets a transaction-local
  GUC the insert trigger reads), so it is never momentarily visible at the table
  default and the change-feed `NOTIFY` (deferred to COMMIT) fires only once it is
  already private — no create-then-demote window.

### Security — cloud-config review hardening (3.1)

- **Pinned `search_path` on every cloud `SECURITY DEFINER` function.** A definer
  function with an unpinned `search_path` resolves unqualified relation names via
  the caller's `pg_temp` first, so a member could `CREATE TEMP TABLE
__lattice_owners(...)` to shadow the ownership bookkeeping and bypass row RLS.
  All cloud definer helpers (bootstrap, per-table trigger, workspace settings) now
  pin `search_path = "<schema>", pg_temp` (pg_temp **last**), and the installer
  revokes schema `CREATE` from `PUBLIC` as defense-in-depth. Bootstrap, per-table,
  and settings install versions bumped so existing clouds re-install on upgrade.
- **Change-log history is owner-only.** A `__lattice_changelog` ground-truth/audit
  entry carries every column in cleartext, including ones the `<table>_v` mask hides
  from a non-owner. The read policy now requires `lattice_is_owner` for those
  entries (was "row is visible"), so a member who can see a shared row can no longer
  read its full history and unmask columns. Per-viewer **derived** observations are
  unaffected (still source-visibility gated).
- **`never_share` is retroactive.** Turning on a table's never-share flag now resets
  any already-shared row to private and drops every row/cell grant on the table, so
  flagging an existing table never-share doesn't leave previously-shared rows
  visible.
- **One-time column-policy seed.** The YAML→DB audience seed runs exactly once per
  table (marker-gated), so a later `secureCloud` can't silently re-mask a column the
  owner has since cleared.
- **Render abort is checked per file**, not only per row, so a workspace switch tears
  down an in-flight render promptly instead of finishing the current entity's files.

### Added — async background render (3.1)

- **Non-blocking workspace open.** `lattice gui` no longer blocks on a full
  `db.render()` when opening/switching a workspace — it serves immediately and
  renders in the background, so a cloud workspace with large junction tables opens
  instantly. Progress-bearing render API (`RenderOptions { onProgress, signal }`,
  `RenderProgress`, `ProgressThrottle`), `Lattice.renderInBackground` with a shared
  single-flight guard, `RenderProgressBus`, and `GET /api/render/progress` (SSE) +
  `GET /api/render/status`. The GUI shows live per-table render progress (bottom bar
  - pill) on each card; switching aborts the prior render. The `--no-render` flag is
    removed (fast-open + background render is the single default path).
- **Workspace-switch spinner restored** on the stable header button (regressed in
  the 3.0 GUI rewrite).

## [3.0.0] - 2026-06-11

### Breaking — clouds are now a shared Postgres DB secured by row-level security

A "cloud" is now a **shared Postgres database that every user connects to
directly as their own scoped, non-superuser role**, with real Postgres
Row-Level Security as the only security boundary. The server/replica model is
**deleted**. A cloud and a "team" are the same thing — one concept.

**Removed (breaking):**

- **`lattice serve` and the entire HTTP/bearer server.** There is no Lattice
  server process in front of Postgres anymore — no `serve --team-cloud`, no
  bearer-token auth, no `__lattice_api_tokens`, no team-server routes.
- **The replica / sync client** (`TeamsClient`, the outbox/DLQ, and the
  `__lattice_team_*` tables: `_identity`, `_connections`, `_outbox`, `_dlq`,
  `_members`). Members read and write the shared database live over their own
  scoped connection.
- **App-layer row ACLs as the security boundary.** Row visibility is enforced by
  Postgres RLS policies, not by application `WHERE`-injection.
- **The direct-cloud reconnect banner** and the "hosted Lattice Teams URL"
  affordance.

**Added:**

- **RLS installer (plain idempotent SQL).** `installCloudRls` + `enableRlsForTable`
  install `FORCE ROW LEVEL SECURITY` and per-table policies keyed on
  `session_user`, plus ownership/grant bookkeeping (`__lattice_owners`,
  `__lattice_row_grants`) and a `__lattice_changes` change feed (drives realtime
  via `pg_notify`). Rows are **private by default**; the owner shares a row with
  `lattice_set_row_visibility(table, pk, 'everyone' | 'private')` or grants a
  specific member with `lattice_grant_row` (owner-only `SECURITY DEFINER`
  functions). SQLite is a no-op — it stays a single-user local store.
- **Scoped member provisioning.** `provisionMemberRole` creates a `NOSUPERUSER
NOCREATEROLE` LOGIN role in the `lattice_members` group; `generateMemberPassword`
  / `memberRoleName` / `revokeMemberRole` / `setRowVisibility` round it out. The
  credential a member holds is a dead end for privilege escalation.
- **`Lattice.init({ introspectOnly })`** — open an already-provisioned database
  issuing NO DDL. This is how a scoped member (no CREATE/ALTER privilege) opens a
  cloud: the GUI discovers the member's privileged tables from `information_schema`
  and registers them, then opens introspect-only.
- **`probeCloud(url)`** now reports `{ reachable, dialect, isCloud }` — `isCloud`
  detects an established cloud (Postgres with `__lattice_owners` installed) via
  `to_regclass`, so even a member denied SELECT on the bookkeeping gets a truthful
  answer. `canManageRoles` / `cloudRlsInstalled` are exported helpers.
- **Three GUI flows on the new model:** migrate a local Lattice into a cloud
  (you become the owner, RLS installed, you own the migrated rows), join an
  existing cloud with the scoped credentials the owner issued (the invite IS the
  credentials — there is no token redemption), and invite a member (an owner with
  `CREATEROLE` provisions a scoped role and hands over the connection blob).
- **Offline editing is preserved** as the client-side local edit queue, decoupled
  from any server.

**Per-column audiences & per-viewer values (experimental, off by default).** Two
primitives take RLS from whole-row to the cell and to per-viewer values; a column
with no `audience` behaves exactly as before:

- **Per-column masking** — declare `audience:` on a column and Lattice generates a
  cell-masking view (`<table>_v`): the column compiles to a `CASE` mask over
  `session_user`-keyed `SECURITY DEFINER` helpers (`lattice_has_role` /
  `lattice_is_subject` / `lattice_source_visible`), members read the view (base
  `SELECT` revoked), and a masked cell reads `NULL`. Owner-managed app roles
  (`__lattice_member_roles` + `lattice_assign_role`); members can't self-promote.
  (`enableAudienceView`, `audiencePredicate`.)
- **Per-viewer values** — an enrichment is recorded as a per-viewer OBSERVATION,
  not written into the shared row: `Lattice.observe()` appends a derived
  observation (no canonical mutation, so the row's `updated_at` doesn't move and a
  viewer who can't see the source can't even tell an enrichment exists), and
  `Lattice.foldForViewer()` folds the observations a viewer may reach onto the
  ground-truth row (latest-visible-per-attribute wins). A value derived from a
  source a member can't reach never appears for them; un-sharing the source reverts
  it with no residue. On a cloud the substrate is sealed by RLS
  (`enableChangelogRls`) so a member only ever reads observations whose sources it
  can see. Deterministic; cache with `FoldCache`.
- **Crypto-shred** — `sealUnderSource` / `shredSource` cryptographically erase a
  sensitive source's derived values (destroy the per-source key → unrecoverable,
  backups included); `observe()` seals sensitive observations and `foldForViewer()`
  reverts them once the key is gone.
- **Per-card overrides** — a row owner can grant one member one masked cell with
  `grantCell()` / `POST /api/cloud/cell-share`, without changing the column's
  schema-level audience; the generated mask view ORs it in.
- **Cutover in place** — `secureCloud()` / `POST /api/cloud/secure` turns an
  already-populated Postgres into a secured cloud (install RLS + own the existing
  rows), not only migrate-from-SQLite.
- The change-log is reconciled to one table (`__lattice_changelog`, Postgres-valid
  with a monotonic `seq`) and gains provenance columns (`source_ref`,
  `change_kind`, …); all of `insert`/`update`/`delete` accept provenance, and an
  AI enrichment stamps the source-set it was derived from instead of discarding it.
  The enrichment pass pins the cheapest model. See `docs/cloud.md`.

**Owner-set chat system prompt per workspace.** A cloud owner can set a chat
system prompt (in workspace settings) that's bundled into every member's assistant
chat for that cloud — injected into each member's system message alongside the live
schema. Owner-only to view and edit: it's stored in `__lattice_cloud_settings`
(reached via `SECURITY DEFINER` `lattice_get_cloud_setting` / `lattice_set_cloud_setting`,
the setter gated on `rolcreaterole`), the member group has no grant on the table, and
`GET /api/cloud/system-prompt` returns the text only to an owner. Secrecy is
**app-mediated** (hidden from the UI + API, not cryptographic — a member's own chat
must inject it, so a member who digs can read it); documented in `docs/cloud.md`. New
exports: `installCloudSettings`, `getCloudSetting`, `setCloudSetting`,
`CLOUD_SETTING_SYSTEM_PROMPT`. Postgres-only; no-op on local SQLite.

**S3-backed file bytes for cloud workspaces (opt-in, off by default).** When a
cloud enables S3, an uploaded file's bytes go to S3 in addition to the uploader's
local disk, so any member who can SELECT the `files` row can pull the bytes down
in the viewer. Previously the metadata row was shared via RLS but the bytes lived
only on the uploader's machine.

- **No new access machinery — it rides the `files`-row RLS.** The serve route's
  `db.get('files', id)` runs as the member's scoped role; a member only ever
  learns an object's (content-addressed) key for a row RLS lets them SELECT. IAM
  is `GetObject`+`PutObject` only — **no `ListBucket`, no `Delete`** — so the key
  is the only handle, and the RLS row is the only place it appears.
- **Per-member, machine-local credentials.** S3 config is stored AES-GCM-encrypted
  on each member's machine (the `db-credentials.enc` store), never in the shared
  DB; env-var fallback (`LATTICE_S3_BUCKET`/`_REGION`/`_PREFIX`/`_ENDPOINT` + the
  standard `AWS_*` chain) for headless/CI. Owner-only `GET`/`POST
/api/cloud/s3-config` (secret redacted on read).
- **Hybrid copy.** The uploader keeps the local blob (instant local preview); every
  other member streams from S3. Content-addressed key `<prefix>/<sha256>`;
  idempotent put. Reuses the existing reference model (`ref_kind='cloud_ref'`,
  `ref_provider='s3'`, `ref_uri='s3://<bucket>/<key>'`, `source_json`) — **no schema
  migration**.
- `@aws-sdk/client-s3` is an **optional dependency, lazy-imported** like `sharp`:
  absent SDK throws a typed `S3UnavailableError` and uploads fall back to local-only
  (never 500). `forcePathStyle` when a custom `endpoint` is set (R2 / MinIO /
  LocalStack). New exports: `createS3Store`, `s3Key`, `S3UnavailableError`,
  `RemoteBlobStore`, `S3StoreConfig`, `resolveActiveS3Config`, `activeWorkspaceLabel`,
  `S3Config`, `mergeS3ConfigForSave`.
- **The local-only fallback is never silent.** A failed S3 PUT on an enabled cloud
  still succeeds locally but the upload response carries `s3: { status: 'failed',
error }` (a clean push returns `status: 'stored'`), so the uploader knows the bytes
  didn't reach the shared bucket and won't share a file other members would 404 on.
- **Serve hardening.** `/api/files/:id/blob` sends `X-Content-Type-Options: nosniff`
  and a no-allowances `Content-Security-Policy: sandbox`, since both the bytes and the
  row's `mime` are member-writable — without them a member could stage `text/html` in
  the shared bucket and have it execute in another member's GUI origin.
- **Security ceiling is documented, not hidden:** byte-access is app-mediated (not
  S3-enforced), revoking row visibility doesn't retract bytes a member already
  fetched, the shared credential is a single point of compromise, and there's no
  per-member S3 audit. See the S3 section + caveats in `docs/cloud.md`.

**Migration:** a direct `postgres://` connection string is no longer a Lattice
cloud connection — each user needs their own scoped role. Stand the cloud up by
migrating a local Lattice into a fresh Postgres (installs RLS + makes you owner),
then invite members; each member connects with their issued credentials. See
`docs/cloud.md`.

## [2.3.0] - 2026-06-11

### Fixed

- **Dropped documents now extract on every install — the parsers are no longer
  optional.** The native document parsers (`mammoth` for `.docx`, `unpdf` for PDF,
  `word-extractor` for legacy `.doc`, `fflate` for the OOXML/ODF/EPUB zip formats),
  the `file-type` sniffer, and the `@anthropic-ai/sdk` used to summarize and
  classify an ingested file were declared as `optionalDependencies`. Any install
  that omits optional dependencies — `npm install --omit=optional`,
  `npm ci --omit=optional`, a Docker layer that prunes them, or an optional native
  build such as `sharp` failing and taking the whole optional group down with it —
  silently shipped **without** them. A dragged `.docx`/PDF/spreadsheet then
  extracted nothing, produced no summary, and linked to nothing, with no error
  surfaced. The parsers and the SDK are now regular `dependencies`, present on
  every install, so document ingest works out of the box. `pg`, `playwright`, and
  `sharp` stay optional — a Postgres backend, browser crawling, and image
  down-scaling are genuinely opt-in and already degrade gracefully when absent.
- **A document parser that fails to load is now logged loudly** instead of
  silently degrading the file to an empty extraction. Because the parsers now ship
  as regular dependencies, an import failure means a broken or partial install and
  is reported on the console (the extractor still returns gracefully and never
  throws).

### Changed

- `@anthropic-ai/sdk`, `mammoth`, `unpdf`, `word-extractor`, `fflate`, and
  `file-type` moved from `optionalDependencies` to `dependencies`.

## [2.2.4] - 2026-06-11

### Fixed

- **Drag-and-drop ingest never fails on a required `files` column.** A `files`
  table that declares a column `NOT NULL` — a legacy schema, a customized table, or
  one synced from a cloud — now ingests cleanly instead of 500-ing (e.g. "NOT NULL
  constraint failed: files.path"). Ingest fills any required **text** column from
  the upload's filename. Detection is by **physical table introspection** (`PRAGMA
table_info` / `information_schema.columns`), so it reflects the actual table, not
  Lattice's declared schema, and fires only for columns the table genuinely
  requires: a nullable native `files.path` is left null, so a byte upload is still
  served from its retained blob rather than shadowed by a filename written into
  `path`. A non-browser/desktop client that knows the dropped file's real OS path
  may send it via an `x-filepath` header, which is then recorded as `path`.

## [2.2.3] - 2026-06-10

### Security / Breaking

- **A cloud is reachable only through a user-authenticated server.** A regular
  GUI pointed straight at a cloud's `postgres://` connection is now **refused**:
  a raw connection string can't tell members apart, so anyone holding it would
  read every table and row regardless of sharing. When the GUI detects a cloud
  (a database that hosts `__lattice_team_identity`) reached over a direct
  `postgres://` connection, it serves **no** team context and **no** tables, and
  prompts the operator to reconnect through a server (sign in as a user). The
  server is the single connection model and the security boundary — it holds the
  database connection and filters every member's sync so they only ever receive
  rows they're allowed to see; members never hold the connection string. The
  server process itself (`lattice serve --team-cloud`) is the sole legitimate
  direct holder of the connection. **Migration:** stand up a server in front of
  the cloud Postgres and have members reconnect via invite; the direct
  connection string is retired.
- Using Postgres as your **own**, single-user storage backend — a workspace with
  no team — is unaffected and keeps connecting directly.
- The GUI surfaces a `cloudReconnectRequired` state on `GET /api/dbconfig` and a
  notice in the UI when a workspace is on the refused direct path.

### Changed

- **Documents parse natively, with no external CLI.** Ingest no longer shells out
  to the optional `markitdown` Python CLI (a dragged document silently extracted
  nothing on any machine without it installed). Text is now extracted in-process
  for **PDF** (`unpdf` — a serverless pdf.js build, no native/canvas deps),
  **Word** (`.docx` via `mammoth`, legacy `.doc` via `word-extractor`),
  **PowerPoint** (`.pptx`), **Excel** (`.xlsx`), **OpenDocument**
  (`.odt`/`.ods`/`.odp`), **EPUB**, and **RTF** (the OOXML/ODF/EPUB formats via the
  tiny `fflate` zip reader; RTF via a built-in de-RTF). Scanned/image-only PDFs
  with no text layer still fall back to Claude's native PDF read. Every parser is
  a lazily-loaded **optional dependency**, so a format whose parser isn't
  installed degrades to a `skip` rather than failing, and core latticesql users
  who never ingest documents pull none of them.
  - Legacy **binary** `.xls` and `.ppt` (pre-2007 BIFF/PPT) have no clean,
    non-vulnerable pure-JS parser and are referenced + marked
    `extraction_status='skipped'`.
  - The `MARKITDOWN_BIN` env var is no longer read (removed from `.env.example`).
  - **Hardened against hostile documents.** All XML tag scanning is linear (no
    global lazy-quantifier regex, which is O(n²) on an unclosed-tag flood); the
    unzip step caps per-entry and aggregate decompressed size (zip-bomb guard);
    each extractor stops accumulating at the text cap; the PDF read has a timeout;
    and `/api/ingest/file` now enforces the same byte cap as the upload route.
  - **Extraction-quality fixes** in the native parsers: RTF strips `\*`
    destinations (hyperlink/bookmark/field metadata no longer leaks into text)
    and decodes `\'xx` as Windows-1252 (smart quotes, em dashes — not invisible
    C1 controls); PowerPoint/Word runs join within a paragraph without inserting
    spurious mid-word spaces; EPUB resolves percent-encoded spine hrefs (no more
    silently dropped chapters); XLSX preserves shared-string slots across a
    self-closing `<si/>` and strips CJK phonetic guides; ODS reads numeric cells
    stored only in `office:value`.

### Fixed

- **Drag-and-drop ingest no longer fails on a `files` table with a `NOT NULL`
  `name` (or `title`).** Ingest now fills `name` and `title` from the upload's
  filename on every new `files` row — the same auto-population already done for
  `slug`. They're written only where the table physically carries those columns
  (e.g. a cloud whose `files` table declares `name NOT NULL`) and harmlessly
  dropped for the native `files` entity, so an uploaded file never trips a
  `not null constraint failed: files.name` again.

## [2.2.2] - 2026-06-10

Team-cloud GUI hotfixes.

### Security

- **Unowned tables no longer leak to other members.** On a team cloud a table
  with no ownership record (created via raw SQL, or when a reconcile was
  skipped because the creator's identity didn't resolve) was visible to every
  member — `isVisibleInTeam` returned `true` for an undefined owner — while the
  Workspace Settings / Data Model graph labelled it "private" (it's not in the
  shared set). The visibility gate and the label now agree: an unowned, unshared
  table is visible only to the **cloud creator**, never to other members, so the
  "private" label is truthful. The creator's own data is not hidden, and
  explicitly-shared tables are unaffected.

### Fixed

- **Drag-and-drop ingest no longer fails on a `files` table with a `NOT NULL`
  slug.** Ingest now auto-derives a `slug` (from the filename, with a short
  unique suffix) on every new `files` row. It's populated only where the table
  physically carries a `slug` column — e.g. a cloud whose `files` table declares
  `slug NOT NULL` — and harmlessly dropped for the native `files` entity, fixing
  `not null constraint failed: files.slug` on Postgres-backed clouds without
  changing SQLite behaviour.
- **The Data Model share indicator recolours immediately.** Toggling a table's
  share status now rebuilds the schema graph, so the node's shared/private
  colour updates without a manual refresh.
- **The assistant knows who it's assisting.** The operator's display name (from
  `~/.lattice/identity.json`) is now included in the assistant's system prompt,
  so it addresses the user and resolves "me"/"my" instead of asking for a name.

### Changed

- **Breaking: the direct `postgres://` deprecation is now silent.** The GUI
  banner (and the connect-time console warning) shown for a grandfathered direct
  `postgres://` team connection have been removed, along with the `directCloud`
  field on `GET /api/dbconfig`. The deprecation itself is unchanged — **new**
  direct connections are still rejected at the register/redeem boundary; existing
  ones keep working without row-level security (network-isolate the cloud
  Postgres until you migrate). Documented here rather than surfaced at runtime.

## [2.2.1] - 2026-06-10

Hotfix for two regressions in the 2.2.0 row-level-permission work on team clouds.

### Security

- **Assistant chats are now isolated per member on a team cloud.** Chat threads
  and messages are stored in the shared cloud database, but the chat read routes
  queried them with no per-user filter — so a member could list and replay
  another member's assistant conversations (and the assistant's responses).
  `chat_threads` / `chat_messages` gain a nullable `owner_user_id` column
  (additively reconciled onto existing clouds, no migration needed); new chats
  are stamped with the creating member's cloud id; and every chat read
  (`GET /api/chat/threads`, `GET /api/chat/threads/:id/messages`, and the
  cross-turn history rehydration) filters by the operator's id when a team
  context is present. A thread can only be reused/replayed by its owner, so a
  guessed thread id can't be hijacked. Local single-user databases (no team
  context) are unaffected — chats with a NULL owner stay fully visible.

### Fixed

- **Composite (and `id`-less) primary keys no longer break row permissions.**
  The 2.2.0 row-permission read path keyed every row on the first primary-key
  column, defaulting to `id`. A table with no single `id` column — a
  composite-key junction table, or any table reached via raw SQL — hit the `id`
  fallback and the query emitted `CAST(t."id" AS TEXT)`, throwing
  `column "id" does not exist` and taking down `queryVisible`,
  `countVisibleMany`, and the dashboard with it; a registered composite table
  keyed only its first column, so rows sharing that column collided. The
  change-log + row-ACL key now encodes the **full** primary key (a single
  canonical serialization shared by the write and read paths), and a table with
  no Lattice-addressable key is treated as unkeyable (no per-row ACL; its rows
  follow the table default and never reference a missing column). Single-column
  keys are unchanged — existing data and behaviour are preserved.

## [2.2.0] - 2026-06-09

**Row-level permissions for Teams.** Sharing a table no longer means every
member sees every row. Each shared row now has an **owner** (its creator) and a
**visibility** — `private` (owner only), `everyone` (all members), or `custom`
(an explicit grant list) — enforced for the REST API, the AI assistant, and the
cloud sync itself, so a member never receives the bytes of a row they can't
read. Existing shared tables default to `everyone` on upgrade, so nothing
changes until an owner opts a table (or a row) into `private`.

**Security note.** Enforcement is **application-layer**, performed by the
hosted Teams server (and by each Lattice process for its own reads) — there
are no Postgres `CREATE POLICY` rules on the cloud database. Anyone holding a
SQL connection string to the cloud Postgres can read and write every row;
treat the database as the hosted server's private backend and network-isolate
it. Grandfathered direct `postgres://` team connections (see _Deprecated_)
bypass row-level security entirely.

### Added

- **Row visibility model.** New cloud-internal tables `__lattice_row_acl`
  (per-row owner + visibility) and `__lattice_row_grants` (custom grant list),
  plus `__lattice_shared_objects.default_row_visibility` (the visibility new
  rows are born with, table-owner-set). Installed + backfilled idempotently on
  both SQLite and Postgres via `installRowPermsSchema`.
- **`Lattice.queryVisible(table, opts)`** — an indexed, in-SQL, decrypt-reusing
  read that returns only the rows a given member may see in a team.
- **`Lattice.listChangesForRecipient(...)`** — the hosted change-log pull,
  filtered per recipient so the Teams server is a hard enforcement point.
- **`src/teams/row-access.ts`** — `resolveRowAcl` / `canAccessRow` /
  `isRowOwner` / `tableDefaultVisibility` / `listVisibleRows` and owner-gated
  `setRowVisibility` / `addRowGrant` / `removeRowGrant` /
  `setTableDefaultVisibility`, with typed `RowAccessError` (→ HTTP 404, hide
  existence) / `RowOwnerOnlyError` (→ HTTP 403).
- **GUI** — a per-row visibility eye on the table view (owner toggles
  everyone↔private; non-owner sees a faded status), a detail-view control, and
  a Data Model "new rows default to" select. New endpoints:
  `POST /api/tables/:t/rows/:id/visibility`, `POST`/`DELETE`
  `/api/tables/:t/rows/:id/grants`, and
  `POST /api/schema/entities/:name/default-row-visibility`.
- **GUI: grants checklist.** The detail view's visibility line grows a
  "Specific people…" / "Manage access" control — an owner-only member
  checklist wired to the grant endpoints, so `custom` visibility is fully
  manageable from the GUI. Switching a `custom` row to everyone/private now
  asks for confirmation first (the grant list is kept server-side and
  reapplies if the row returns to specific people).
- **GUI: direct-connection deprecation banner.** A workspace holding a
  grandfathered direct `postgres://` team connection shows a dismissible
  amber banner ("Direct database cloud connections are deprecated and don't
  support row-level security. Migrate to a hosted workspace."), driven by a
  new `directCloud` field on `GET /api/dbconfig`.

### Security

- **`GET /api/search` now applies the row ACL.** The REST search route
  returned full-text hits without the per-row post-filter the assistant's
  search tool already applied, so a member could read snippets of rows shared
  privately or with other members. Both paths now share one batched filter
  (`filterVisiblePks` — one ACL query + at most one grants query per table).
- **Dashboard counts no longer reveal invisible rows.** Entity tiles counted
  physical rows (`pg_class.reltuples` / exact COUNTs), telling a member that
  hidden rows exist and how many. In team mode the tiles now run the same
  visibility predicate as `Lattice.queryVisible`, aggregated into a single
  round-trip (`Lattice.countVisibleMany`, capped at 50 tables per pass), so
  counts always match what the rows view lists.

### Changed

- **Enforcement is wired into every path.** The REST row routes, the row
  mutation primitives, and the AI assistant's `list_rows` / `get_row` /
  `search` tools all honour the row ACL (the assistant previously bypassed it
  entirely). Denied reads return 404.
- **Hosted sync is per-recipient.** Linked rows record an ACL; the change-log
  pull is filtered per member; delete / unlink / member-kick now fan out a
  targeted `unlink` to each member who can see the row before tearing the ACL
  down (a broadcast unlink would be dropped by the new filter).
- **Dashboard counts (Postgres).** For the suspicious subset of tables whose
  approximate `pg_class.reltuples` reads 0 or is absent (under autovacuum's
  ANALYZE threshold), the dashboard now issues one aggregated exact-count
  round-trip — correcting the "tile shows 0 while drill-in shows rows" case
  without reintroducing a per-table fan-out. Capped at 50 tables (logged +
  skipped on overflow).
- **A cloud IS a workspace with members — no "convert to team" concept.**
  `TeamsClient.upgradeToTeamCloud(...)` is renamed to
  `TeamsClient.registerCloudOwner(...)` (same signature + behaviour: bootstraps
  the first member as owner, rejects direct `postgres://` per the deprecation
  below). The "upgrade/convert a cloud into a team" framing is gone from the API,
  the `--team-cloud` CLI help, and the docs — opening a cloud yourself connects
  you directly (eye-icon row permissions active); `lattice serve --team-cloud`
  is just the deployment role that hosts the cloud as a shared, auth-gated server
  for _remote_ members. **Breaking:** external callers of the old method name
  must update to `registerCloudOwner`.

### Deprecated

- **Direct `postgres://` team-cloud connections.** They can't enforce
  row-level security, so new direct connections are rejected with guidance to a
  hosted Teams server; existing direct connections keep working but warn on
  connect. Unrelated to using Postgres as a Lattice's own storage backend.

## [2.1.1] - 2026-06-09

**The assistant rail speaks in activity cards — and links to what it found.**
What the assistant did now shows as the same full-width activity cards as the
live feed — one card per action type, collapsed, and scoped to the conversation —
instead of inline tool-call pills. And when it points you at a specific record it
now renders a **clickable object pill** inline in its answer. The library API is
unchanged (GUI-only).

### Added

- **Inline object-link pills.** When the assistant references a specific row —
  e.g. you ask it to "link me to" or "open" a record — it emits an inline link
  (`[label](lattice://<table>/<id>)`) that renders as a clickable 🔗 pill and
  opens that object (mode-aware, the same navigator the activity feed uses). It's
  instructed to prefer the user-facing record over an internal `files` id and to
  only link ids it actually retrieved.

### Changed

- **One unified activity-card style across the rail.** The assistant's actions
  render as the activity-feed card (operation icon + human summary), not the
  separate inline pill chips. Cards **collapse by type even across different
  objects** — a bulk run shows a single card ("Deleted 19 tables", "Removed 49
  rows across 9 tables") instead of dozens of near-identical rows. Read-only tool
  calls (list / get / search) change no data, so they produce no card.
- **The activity feed is per-conversation.** Each assistant turn persists the
  data-change events it produced; reopening a conversation replays them as the
  same collapsed cards. The global last-20 audit backfill on stream connect is
  removed — the feed SSE now carries new events only, and history comes from the
  conversation it belongs to.

### Fixed

- **Persisted / reloaded schema events now collapse and show the 🛠 icon.** The
  live feed publishes `op: 'schema'` while the audit-sourced replay used the
  fine-grained `op: 'schema.delete_entity'`; the rail matched only the former, so
  reloaded schema deletes neither grouped nor picked an icon (they showed a bare
  "•"). Both forms are normalized now.
- **The typing indicator stays pinned to the bottom.** Activity cards that stream
  in mid-turn now insert above the assistant's "typing…" bubble instead of below
  it, so the dots no longer appear in the middle of a reply.
- **Activity cards show the task DURATION, not a relative "ago".** Each card now
  reads how long its work took ("4s", "4m 2s") — start-to-finish for a single
  action, first-start to last-finish for a grouped run — anchored to the turn's
  start (persisted per-event timestamps + turn start, so a reloaded conversation
  shows the same durations as the live stream).
- **A long bulk run no longer splits into several cards.** Live grouping is now
  scoped to the assistant turn (no fixed time window) instead of a 15s rolling
  window, so deleting many tables against a remote DB collapses into one
  "Deleted N tables" card even when the run takes longer than the old window —
  the lone leftover delete that escaped the group is gone.
- **Switching to a cloud workspace shows the spinner until it's done.** The
  switch menu used to close right after the (fast) switch POST and run the slow
  cloud connect/reload with no visible feedback (it looked frozen); the menu now
  stays open with the item's spinner through the whole reload, matching the local
  switch.
- **The settings of a cloud workspace you're connected to no longer ask for an
  invite token.** Workspace settings could show a "not a member yet — paste an
  invite token" state for a cloud workspace you'd already joined (or created).
  That state is impossible — you can't reach a team cloud without an invite, so a
  live connection always implies membership — and it has been removed. Joining via
  invite lives only in the Join Workspace flow; settings always shows the
  connection details and members.
- **Encrypted secret values render as the mask, not raw ciphertext.** A value
  stored encrypted-at-rest (the native `secrets` table, etc., carrying the `enc:`
  sentinel prefix) showed its raw `enc:…` ciphertext in table and detail views.
  It now renders as •••••••• like any other masked secret, everywhere a cell value
  is shown.

### Changed (settings)

- **Assistant settings are decluttered.** The voice section now shows a single
  **Use for voice** provider dropdown ("Select provider…", "OpenAI",
  "ElevenLabs") and reveals only the chosen provider's key field, instead of
  listing every provider's key box at once. Removed the redundant
  "keys are stored encrypted… also work" helper paragraph and the
  "set the `ANTHROPIC_OAUTH_*` env vars to enable" hint (the subscription link
  only appears when OAuth is actually configured).

## [2.1.0] - 2026-06-08

**Assistant search + a guarded, reversible table delete — and a batch of GUI
fixes.** The `lattice gui` search box now hands your query to the assistant
(which answers using its search/read tools) instead of running a plain text
match, the assistant gains a safe `delete_entity` tool, and the activity feed,
voice notes, uploads, and live counts get a round of polish. The library API is
additive and backwards-compatible.

### Added

- **The search box asks the assistant.** Typing a query and pressing Enter sends
  it to the assistant rail, which answers conversationally using a re-added
  full-text `search` tool (it never sees the conversation-storage or secret
  tables). The old as-you-type dropdown is retired.
- **Reversible, guarded table delete via the assistant (`delete_entity`).** The
  assistant can delete a table on request, with safeguards so a careless prompt
  can't destroy data: built-in tables are refused, tables another table links to
  are refused, an **empty** table is soft-deleted immediately, and a **non-empty**
  table is **not** deleted until you decide what to do with the data — the tool
  reports the row count and asks, then you choose to delete the rows too
  (soft, reversible) or move them into another table first. Every step is audited
  and revertible from history; the physical table + rows are kept (no hard drop).
- **AI-generated chat thread titles.** A new conversation is named from a short
  AI summary of its first exchange (e.g. "Adding New Notes About Cheese") instead
  of a truncated copy of your first message.
- **`Lattice.unregisterTable(name)`** — the inverse of `defineLate()`. Removes a
  runtime-registered table from the live schema registry without a reopen (and
  without touching the physical table), so the GUI's soft delete no longer has to
  dispose + rebuild the connection. Library-additive.

### Fixed

- **The ingest pipeline no longer swallows server-side errors (Rule: no silent
  failures).** A failed file enrichment used to bubble to a generic 500 with
  nothing logged — the real cause flashed in a toast and vanished. Failures are
  now logged to stderr with their stack, recorded durably on the file row
  (`extraction_status='enrichment_failed'`), and surfaced to the client; the
  top-level GUI request handler logs any unhandled error before responding.
- **The data-model graph no longer shows internal conversation tables.** The
  `chat_threads` / `chat_messages` storage was already hidden from the Objects
  list and sidebar but still drawn in the Data Model visualization; it's now
  filtered there too (single source of truth: `isInternalNativeEntity`).
- **Conversation tables are browsable under "System".** `chat_messages` /
  `chat_threads` now appear in the Advanced → System list and open read-only,
  instead of routing to "Unknown entity".
- **Search no longer returns conversation messages or secrets.** The full-text
  search endpoint excludes the assistant's own storage + the secrets table.
- **Voice notes don't desync the composer.** While recording/transcribing, the
  text box is read-only with a "Listening… / Transcribing…" placeholder and the
  Send button is disabled; the transcript drops in when you stop.
- **File-upload progress shows real elapsed time** instead of a stuck "0s".
- **The activity feed groups identical events even when interleaved.** A burst of
  the same op on the same table collapses into one counted bubble within a short
  window, not just for strictly consecutive events.
- **Home counts and the open entity view update live.** Any insert/update/delete
  now refreshes the dashboard counts and the current table without a manual page
  reload (previously only schema changes did, and only on the cloud path).
- **More spacing above the sidebar "SYSTEM" heading.**

### Changed

- **Voice-provider preference and inference aggressiveness are user settings, not
  workspace secrets.** They moved out of the workspace `secrets` table into
  machine-local `preferences.json`, so they persist across workspaces, stop
  appearing in the Secrets object, and aren't visible on a shared cloud database.
  Legacy rows are retired automatically on the next open.

## [2.0.0] - 2026-06-04

**The AI assistant arrives.** `lattice gui` gains a built-in assistant rail — a
**Context Constructor** that turns dropped files and pasted text into linked
Lattice objects. The library API is unchanged and fully backwards-compatible:
the assistant is GUI-only and completely inert until credentials are configured,
so a bare `new Lattice(path)` / Postgres-URL consumer and the headless
`render`/`generate`/`reconcile`/`watch` commands are unaffected. The major
version marks the new product surface (and the workspace-architecture line that
shipped across 1.16.x), not a breaking change.

### Added

- **The assistant remembers what it read across turns.** Prior tool calls and
  their results (row ids included) are replayed into the model's context, so a
  follow-up like "now update that row" reuses the id it just listed instead of
  guessing one. Replay is bounded to the recent turns within a size budget and is
  secret-redacted; set `LATTICE_CHAT_REHYDRATE=false` to disable it. The
  assistant's `list_rows` is now deterministically ordered (by `created_at`, else
  the primary key), so listing the same table twice returns the same rows instead
  of conflicting values.
- **AI library surface (`import { … } from 'latticesql'`).** A first-class,
  GUI-independent AI API — inert without an LLM client: `organizeSource` (sort a
  source into your own schema: summarize + classify + link, creating a new
  object only when nothing fits), `describeImage` (image vision), `crawlUrl`
  (SSRF-guarded URL fetch + readable-text extraction), `enrichKnowledge`, plus
  the `summarizeText`/`classifyLinks` primitives and `LlmClient` types. New
  optional deps: `sharp` + `file-type` (lazy-loaded); `jsdom` + `@mozilla/readability`.
- **Assistant rail (chat + activity feed).** A resizable sidebar (mobile
  bottom-drawer) with a Claude tool-calling chat loop streamed over SSE
  (`POST /api/chat`) and a live activity feed (`GET /api/feed/stream`). Every
  assistant edit flows through the same audited, undoable mutation chokepoint as
  a manual edit — so it lands in the version history and can be reverted.
- **Context Constructor — drag-drop / click-upload / paste ingest.** Drop files
  on the rail (or use the paperclip) and they're referenced as native `files`
  rows (not copied), **extracted** (text via optional `markitdown` for PDFs/Office;
  **images via Claude vision**; a pasted **URL is crawled** for readable text and
  the source URL preserved), summarized with **Claude Haiku**, and classified
  against your existing records. Then, all reversible: **add** the source object,
  **enrich** its description, **link** it to related records —
  **auto-creating the junction table when none exists yet** — and, when a source
  fits nothing and aggressiveness is high, **auto-create a new object** for it.
- **"Connect Claude" + subscription OAuth.** Encrypted API-key storage in the
  native `secrets` entity (env-var fallback: `ANTHROPIC_API_KEY`). A standard
  Authorization-Code + PKCE flow for connecting a Claude subscription is built
  and unit-tested; it stays hidden until the `ANTHROPIC_OAUTH_*` env vars are
  configured.
- **Inference Aggressiveness control.** A single behaviour slider
  (Conservative ↔ Aggressive, `PUT /api/assistant/aggressiveness`) that drives
  the model sampling temperature, how liberally the classifier proposes links,
  and whether ingest auto-creates a missing junction (gated ≥ 0.25) vs. suggests it.
- **Native chat entities.** `chat_threads` + `chat_messages` persist conversations
  across sessions; the rail has a thread switcher.
- **Voice input.** Optional speech-to-text via OpenAI Whisper or ElevenLabs
  (`OPENAI_API_KEY` / `ELEVENLABS_API_KEY`), with an explicit provider choice.
- **Processing feedback.** A transient "Analyzing…" spinner row appears while a
  dropped file ingests; the real add/enrich/link events stream in over SSE.

### Notes

- **Cloud:** the assistant runs against local SQLite and a direct
  `postgres://` connection (single-user). The full parity loop — ingest →
  auto-junction → link — is covered by a Postgres-gated integration test. The
  assistant rail is **not** mounted in hosted multiplayer team-cloud mode yet
  (gated behind `!teamCloud`); that lands in a follow-up.
- `markitdown` is an **optional external CLI** (`MARKITDOWN_BIN`); without it,
  PDFs/Office files are referenced and marked `extraction_status='skipped'`.

### Security

- **The chat assistant can no longer read decrypted column secrets.** Its
  `list_rows` / `get_row` tools now redact any column marked secret (via
  `set_column_secret`, recorded in `_lattice_gui_column_meta`) before the row
  reaches the model — mirroring the redaction the HTTP row-context endpoint
  already did. Previously a `password`/`api_key` column on a user table would be
  returned in cleartext (the `secrets` table itself was already hidden).
- **The assistant can no longer touch its own conversation storage.**
  `chat_threads` / `chat_messages` join `secrets` in the assistant's hidden-table
  set, so the model can't `list`/`read`/`update`/`delete` them — closing a
  prompt-injection path to erasing or rewriting chat history. (`files`/`notes`
  stay editable — they're audited + reversible.)

### Internal

- **The data-model editor's create-table / create-relationship endpoints now
  use the same no-reopen primitives as the chat and ingest paths**
  (`createUserEntity` / `materializeJunction`). One creation path instead of
  two: the REST handlers no longer reopen the whole database, and table DDL +
  canonical-context registration + audit live in one place. The editor's typed
  name is preserved (a `normalize:false` opt-out), and team-owner recording
  moves to a post-create step (no reopen ⇒ no reconcile race to beat).
- **Consolidated duplicated GUI internals** (no behaviour change): one
  `feedSummary` now serves both the live feed and the audit-log backfill (was
  two copies); `createFileJunction` / `createUserJunction` share a single
  `materializeJunction` core; the GUI `summarize` module re-exports the
  library's `parseObjects`/`parseMatches` + shared types instead of duplicating
  them; the config-document + DDL IO helpers (`execSql` / `loadConfigDoc` /
  `saveConfigDoc`) moved out of the request dispatcher into `gui/config-io.ts`;
  and a parity test pins the `rowLabel` ↔ `fsDisplayName` contract so the server
  and client label logic can't silently drift.
- **Schema-op primitives extracted into `gui/schema-ops.ts`** (pure mechanical
  move, no behaviour change): physical-table introspection
  (`physicalTableExists` / `physicalColumnExists`), the audited + revertible
  `recordSchemaOp` (+ cloud `emitDdlEnvelope`), canonical-context (re)derivation,
  and the entity/junction creators (`createUserEntity` / `createUserJunction` /
  `createFileJunction` / `materializeJunction`) now live in one module that
  `server.ts` re-imports. The creation path is no longer interleaved with HTTP
  routing and is independently testable; `server.ts` shrank ~350 lines. `ActiveDb`
  is a type-only import in the new module (the runtime edge is server → schema-ops
  only, so there is no import cycle).

### Performance

- **The workspace config is no longer re-parsed on every `/api/entities`
  call.** A small mtime+size-keyed cache in `loadGuiData` means a bulk operation
  and its activity-feed refetches parse the YAML once, not dozens of times; a
  config write (which bumps the mtime/size) or a workspace switch invalidates it
  automatically.

### Fixed

- **GUI assistant + workspace polish.** Repeated tool pills collapse into one
  counted pill ("Listed N rows"); the composer textarea wraps + auto-grows and
  tracks the rail width, and assistant replies render Markdown. The activity
  cards show relative timestamps ("3 days ago") with no "stale" flag. Internal
  conversation tables (`chat_threads` / `chat_messages`) are hidden from the
  Objects list (still queryable). Workspace display names accept special
  characters (the on-disk slug is derived from them). The microphone button is
  disabled with a tooltip when no input device is present; all blocking `alert()`
  dialogs are now inline toasts; and token / secret inputs opt out of
  password-manager popups. The header workspace switcher no longer desyncs from
  the served database — it tracks the open workspace and reconciles the registry
  at boot. A missing-row `update` / `delete` now fails loudly instead of
  recording a phantom-success audit entry.
- **A bulk chat task that hits the tool-step limit now says so.** When the
  assistant reaches its per-message tool-call cap with work outstanding (e.g.
  "create one row per line of a 150-row CSV"), it emits a warning ("…the task
  may be incomplete. Send 'continue' and I'll finish the rest.") instead of
  ending with a clean "done" that looked complete (no silent
  truncation).
- **Adding a relationship now updates the linked tables' context immediately.**
  A new junction's rollup now appears on the EXISTING tables it links without a
  reopen — `syncCanonicalContexts` re-derives every canonical context (via a new
  overwrite-capable `redefineEntityContext`), not only the brand-new table.
- **Chat-rail robustness:** a `loadThread` response is discarded if a newer load
  superseded it (no more clobbered conversation on a fast refresh + switch), and
  the bubble-text setter guards against a finalized/detached bubble.
- **Activity cards no longer vanish when a conversation loads.** The chat and
  the activity feed share the rail, and loading a conversation reset the whole
  rail — so auto-loading the most recent thread on refresh wiped the backfilled
  activity cards. Clearing a conversation now removes only its chat bubbles; the
  workspace-global activity cards persist (and a workspace switch explicitly
  resets them + reconnects the feed to the new workspace).
- **The activity rail collapses repeated events.** A run of identical mutations
  (same op + table) — e.g. linking 20 rows during a bulk operation — now folds
  into a single bubble with a count ("Linked 20 rows in people_projects")
  instead of 20 near-identical rows. The run breaks when a different event or a
  chat message lands, so distinct actions stay separate.
- **Assistant chat rail polish.** Four fixes to the conversation experience:
  (1) an animated **typing indicator** now shows in the assistant bubble while a
  turn is generating (and a turn that ends with only tool calls no longer leaves
  a dangling empty bubble); (2) **conversations reload with their rich
  structure** — the per-turn text bubbles + tool pills are persisted and
  replayed, instead of collapsing to one wall of concatenated text; (3) the
  **most recent conversation auto-loads** on page refresh, so history isn't lost;
  (4) the **conversation dropdown is tied to the active workspace** — switching
  workspaces now resets and reloads the thread list (conversations live in the
  workspace DB).
- **Runtime-created tables now render their context automatically — creation and
  "make it renderable" are one step.** When the chat assistant or the Context
  Constructor creates a table at runtime (no DB reopen), it now registers the
  table's canonical entity context inline — on both the Lattice schema (so
  auto-render writes the markdown) and the GUI's row-context snapshot (so the
  view can find it). Previously only the data-model editor (which fully reopens
  the DB) re-derived contexts, so a chat/ingest-created entity showed "No
  rendered context for this row" until a manual page reload. The context
  registration is best-effort and never fails the creation itself. Also:
  `create_entity` now normalizes a natural name ("People" → `people`) instead of
  silently rejecting it.
- **Assistant API keys are now machine-level, not per-workspace.** The Claude /
  OpenAI / ElevenLabs keys (and the Claude subscription OAuth token) moved out of
  each workspace's database into a machine-local encrypted store
  (`<config>/assistant-credentials.enc`, AES-GCM under the master key, the same
  scheme as `db-credentials.enc`). Creating or switching a workspace no longer
  "de-attaches" the key — a key is a property of the user + machine, not of one
  database. A key saved in a workspace before this change is read back (and
  promoted to the machine store) for backward compatibility — but that
  back-compat read + promotion runs ONLY for a local SQLite workspace, never for
  a shared team-cloud / direct-Postgres `secrets` table (which may hold another
  member's credential row), so it can't harvest someone else's key. The OAuth
  callback that first connects a Claude subscription also writes machine-level,
  matching the refresh + API-key paths.
- **The assistant chat can now create tables and relationships on request.** It
  previously refused ("there is no projects table… I cannot create it") because
  schema mutations were excluded from its toolset. It now has `create_entity`
  and `create_relationship` (a many-to-many junction between two tables), wired
  to the same audited, **no-reopen, reversible** primitives the Context
  Constructor uses — so "create projects from tickets and link them" works end
  to end. `list_entities` also no longer reveals the `secrets` table.
- **The assistant chat now knows your schema, so it stops guessing.** Each turn
  the system prompt is built with the live table list (names, columns, row
  counts) plus guidance that an attached file's content lives in its `files`
  row's `extracted_text` column. Previously the model received no schema context
  and blindly guessed table names — producing "Unknown table" → "Could not fetch
  row" / "Could not list rows" errors — and, because persisted history is
  text-only, lost that context every turn. The prompt now also tells the model
  not to claim success after a failed tool call. The tool-loop + output budget
  (`MAX_TOOL_LOOPS` 8→16, `MAX_TOKENS` 2048→4096) were raised so multi-step bulk
  work (e.g. "create one row per line of an attached CSV") isn't truncated.
  _(Capacity tuning, not a workaround.)_ The
  credential-bearing `secrets` table is now hidden from the assistant entirely —
  excluded from its callable tables and from the schema context — so a request
  (or instructions injected via an attached file) can't induce it to read and
  spill decrypted API keys / OAuth tokens.
- **Auto-created objects now have human-readable names.** The Context
  Constructor gives every inferred entity a leading `name` column and fills it
  with the object's extracted label, so a card reads "Acme Consulting Agreement"
  instead of a bare `#fea4b07f`. Activity-feed bubbles are named to match —
  "Added Acme Consulting Agreement to consulting_agreements" rather than "Added
  a row to …" — both live and when the rail backfills from the audit log on
  reload. Rows with no conventional label column fall back to their first
  meaningful cell value (the same logic drives the card title and the bubble).
- **New objects from the Context Constructor now appear in the sidebar live.**
  When ingest inferred a brand-new entity, the nav list stayed stale until a
  manual page reload — and routing to the new object showed "Unknown entity".
  The activity-feed stream now triggers a live entity-list refresh on a `schema`
  event, so an inferred table shows up in the sidebar the moment it's created.
- **The activity feed no longer goes silent after a data-model edit.** Creating
  an entity, adding/renaming a column, or sharing a table re-opens the workspace
  to pick up the new definitions; that reopen used to swap out the in-process
  feed bus and orphan every connected `/api/feed/stream` subscriber, killing the
  rail (and the live sidebar refresh) for the rest of the session. The feed bus
  is now preserved across a same-config reopen.

## [1.16.5] - 2026-06-08

### Added

- **`renderSkipsEmpty` option** (`LatticeOptions`, default `false`). When enabled,
  `render()` skips both the full-table read **and** the file write for tables
  registered without a `render` spec — those compile to a no-op that would only
  emit an empty `.schema-only/<table>.md`. Previously `render()` read every
  registered table off the wire (a full `SELECT *`) before discovering the
  render produced nothing, which is wasteful for databases with large tables.
  Default-off preserves the original behavior exactly (the table is still
  scanned and an empty schema-only file written); tables with an explicit
  `render`/`outputFile` are unaffected either way. Internally, spec-less tables
  now share a single `NOOP_RENDER` sentinel so the render engine can
  identity-detect them.

### Fixed

- Corrected the legal entity name punctuation in `NOTICE`.

## [1.16.4] - 2026-06-02

GUI patch. **One model: a workspace _is_ a Lattice DB.** Removes the
"database mode" duality — there is no longer a separate config-file switcher
that appears only when the GUI is opened outside a `.lattice` root. Every
install the GUI opens now has a `.lattice` root, and every database (local or
cloud, created or joined) is a single switchable **workspace**. No library API
changes — a bare `new Lattice(path)` / Postgres-URL consumer and the headless
`render`/`generate`/`reconcile`/`watch` commands are unaffected (they keep
working with no root).

### Changed

- **Single workspace switcher.** The header now shows exactly one switcher,
  backed by the workspace registry (`/api/workspaces`). The legacy second
  "database" switcher and the no-root "database mode" fallback are gone.
- **The "+ New workspace…" button always opens the create/join wizard**
  (New local / New cloud / Join existing cloud), replacing the old inline
  local-only name form.
- **The GUI ensures a `.lattice` root on launch** (`ensureRootForGui`): when
  opened against a bare config with no root, it creates a root in place and
  **adopts the existing config + database non-destructively** (referenced where
  they already live — no files moved), then opens it as the active workspace.
- **Settings → Lattice lists the workspace registry** — the exact same list as
  the header switcher (previously a divergent filesystem scan).
- **Terminology:** "workspace" is the user-facing term everywhere; "database" is
  reserved for a specific DB's connection details (the connection panel in
  Workspace Settings).
- **Two cloud operations only: migrate to a cloud, or join a team via invite.**
  The standalone "Connect to existing cloud" (join-a-cloud-on-its-own) path is
  removed — its modal/UI is deleted. The create wizard's third option is renamed
  from "Join existing cloud (invite)" to **"Join a team (invite)"** and the
  "join an existing cloud / join via cloud invite" wording is gone. Joining via
  invite is unchanged.

### Added

- **Cloud workspaces are registered in the workspace registry**, so they appear
  in the header switcher and are switchable: on **join** (invite), on **create
  cloud** (wizard), and on **migrate-to-cloud / connect-existing** (the active
  local workspace flips to cloud in place, same id).
- **Boot-time reconciliation** imports stray sibling configs — including
  previously-joined team configs written by an older binary — into the registry
  so already-joined cloud workspaces become visible/switchable.
- **`POST /api/workspaces/delete`** — registry-aware deletion (switches away if
  active; removes the scaffolded folder for a local workspace; for a cloud
  workspace forgets only the local pointer + unused credential, never the shared
  remote DB).
- **Share tables when inviting a member.** The "Invite member" modal again lists
  the workspace's tables with checkboxes, **all checked by default** — generating
  the invite shares the checked tables with the new member in one step. Uncheck
  any to keep them private.

### Fixed

- **Shared tables were invisible to members.** On a direct-Postgres team every
  member shares the same physical Postgres, so a shared table always physically
  exists for the member — but `applySchemaSpec` only registered (`defineLate`) a
  table when it did NOT physically exist, so the member's Lattice never learned
  about the shared table and `/api/entities` returned empty ("ask the owner to
  share a table with you") even after the owner shared it. Now an existing shared
  table is registered too (idempotent, non-destructive), and `openConfig`
  re-captures the live registered set after the team schema auto-sync so the
  table reaches `validTables`/the dashboard. Regression test added.

- **Joined cloud workspaces were invisible in the header switcher** and could
  not be switched to: `handleJoin` saved a credential + sibling config but never
  registered a workspace, so the header (registry-backed) and Settings
  (scan-backed) showed different lists. Both now read the one registry; joining
  registers a workspace and auto-switches to it. Leaving/kicking removes the
  registry record.
- **Renaming a workspace now updates the header switcher** — the rename is
  mirrored into the registry's display name (previously only the YAML/team name
  changed, which the registry-backed switcher didn't read).
- **"New cloud (Postgres)" works for Postgres URLs.** Creating a cloud workspace
  in the wizard previously errored (`Request cannot be constructed from a URL
that includes credentials`) because it used the HTTP `/api/auth/register`
  path. It now initializes the cloud directly via Postgres
  (`registerDirectViaPostgres`), and the wizard switches into the new cloud
  workspace so starter entities land there.
- **Deleting a cloud workspace is owner-only** (via `/api/workspaces/delete`) —
  only the team owner may delete a cloud Lattice DB workspace; a member who
  wants to drop their local copy uses "Leave workspace" instead.

### Notes

- The dead `renderDatabasesPanel` + `showConnectExistingModal` (the removed
  connect-to-raw-cloud UI) were deleted. One now-unused GUI helper
  (`showCreateTeamModal`) and the now-unused
  `POST /api/databases/{switch,create,delete}` server endpoints remain in place
  (dead, not reachable from the UI) and are slated for removal in a follow-up
  cleanup.

## [1.16.3] - 2026-06-02

GUI patch (live cloud-sharing demo + UI review). No library API changes — a bare
`new Lattice(path)` consumer is unaffected. The headline change is conceptual: a
**cloud database is simply a cloud workspace with members** — the separate "team"
concept is retired from the user experience (the underlying member/share plumbing
is unchanged and now initializes automatically).

### Added

- **Data Model graph shows share status.** On a cloud workspace, each entity node is
  outlined by visibility — **yellow = shared with the workspace, red = private (owner-only),
  green = selected** — with a legend. Local (single-user) databases are uncolored (share
  status is N/A). The owner can toggle a table's sharing from the entity editor; non-owners
  see read-only status.
- **Pending invitations in the member list.** Cloud-workspace settings now list people who
  were invited but haven't joined yet (with an "invited"/"expired" tag), below the active
  members. Backed by a new member-only `GET /api/teams/:id/invitations` (and its GUI proxy).

### Fixed

- **Inline editor no longer corrupts long-form fields.** Clicking into and back out of a
  multi-line field (e.g. `bio`, `description`, `notes`) used to silently rewrite it and
  re-render it as oversized text. Root cause: the inline editor returned a single-line
  `<input>` for long-form columns outside a small hardcoded set; focusing it stripped the
  newlines, so a no-op click+blur looked like an edit and fired a spurious `PATCH`. Every
  long-form field (and any value containing a newline) now opens a `<textarea>`, so an
  unedited field is never written and edits round-trip losslessly.
- **Cloud sharing now persists.** Migrating to / connecting to a cloud database left it
  without the member/share machinery, so "share this table" had nowhere to record the share
  and invitees saw nothing. Cloud databases now initialize that machinery automatically
  (see _Changed_), so per-table sharing writes and propagates to every member as intended.
- **Settings re-render after deleting the active database.** Deleting the active workspace
  from its Danger Zone now re-renders settings to the new active workspace (or closes the
  drawer) instead of leaving a stale view of the deleted one.

### Changed

- **A cloud database is a cloud workspace — the "team" step is gone.** The separate
  "Upgrade to team cloud" action has been removed; a database becomes a shareable cloud
  workspace the moment you migrate or connect it to Postgres, and its member/share
  machinery is created automatically (the workspace name is used as the identity; an
  existing un-initialized cloud initializes on open, with the opener as owner). All
  user-facing "team" wording is now "cloud workspace" / "member". The `cloud-connected`
  intermediate state was collapsed, and `POST /api/dbconfig/upgrade-to-team` was removed.
- **Create new objects on a dedicated page, not a modal.** The simple-view "New" tile now
  navigates to an inline create view (`#/fs/<table>/new`) styled like the object page,
  rather than opening a modal.
- **"Database" → "Workspace" in the UI.** New Workspace, Workspace Settings, Delete
  Workspace. The inner **Database connection** box keeps its name (it is literally the DB
  connection).
- **Generic empty-state copy.** An empty database now reads "This workspace is empty" with
  guidance to create an entity (or, on a cloud workspace, ask the owner to share one),
  instead of advice to edit a config file that a joined member can't act on.
- **New databases start empty.** A freshly created workspace no longer ships a starter
  `items` entity; its `entities:` map is empty.

### Removed

- **The per-row Delete button + "Action" column** from the Lattice/Workspaces settings
  list. Rows remain click-to-switch; deleting a workspace lives in that workspace's
  Settings → Danger Zone.

## [1.16.2] - 2026-06-02

GUI bug-fix + cloud-settings patch (1.16.1 demo follow-up). No library API changes —
a bare `new Lattice(path)` consumer is unaffected.

### Fixed

- **Version History no longer shows "Invalid Date".** The `_lattice_gui_audit.ts` column relied on a SQLite-only `strftime(...)` DEFAULT, so on the Postgres/cloud path it wasn't a parseable ISO string. `appendAudit` + `recordSchemaAudit` now set `ts` explicitly to `new Date().toISOString()` at insert (mirroring `client_ts`), and the client `formatTs` guards against an invalid value. Works on both adapters.
- **An already-joined member of a team cloud is no longer shown the "paste invite token" panel.** `resolveTeamContext` left `myUserId` empty when neither the mirrored identity email nor a saved connection resolved the cloud user-id, so membership read as false (→ `team-cloud-needs-invite`). It now falls back to resolving membership directly — matching a live `__lattice_team_members` row to the local identity email, or treating a saved redeemed connection as proof of membership — so a member correctly renders as `team-cloud-member`.

### Changed

- **Cloud Database settings — members + Danger Zone.** The owner's invite flow now also shows the cloud **connection string with the password redacted** (`postgres://user:****@host:port/db`) alongside the one-time token, so an invitee gets everything they need. Membership-exit actions moved out of the member-row list into a dedicated **Danger Zone**: **Disconnect** (owner — disconnects the database from the cloud, kicking all members) and **Leave** (member — removes only you; the cloud DB keeps running). The members list keeps per-row **Kick** for the owner.
- **Simple (file-system) view: create new objects in place.** A "**New**" tile (folder box with a +) opens a create form styled like the object page — blank fields for intrinsic + foreign-key columns, plus a select-menu + "+ Add another" for each many-to-many link. Reuses the existing field renderer and the row-create + `/link` endpoints (no new backend).
- **Lattice/Databases settings: click a row to switch.** The whole (inactive) database row is now clickable to switch; the per-row "Switch" button was removed. Delete stays (and no longer triggers a switch).

### Removed

- **The "Recent Activity" section on the dashboard homepage** — redundant with Version History. The `/api/dashboard` payload no longer computes or returns `recent`.

## [1.16.1] - 2026-06-02

GUI bug-fix + polish patch from the 1.16.0 demo. No library API changes — a bare
`new Lattice(path)` consumer is unaffected.

### Fixed

- **Redo no longer reports "Nothing to redo" after an undo.** Undo/redo _actions_ are session-scoped (they replay only your own edits, not other clients'/processes'), but `GET /api/history` computed the toolbar's `canUndo`/`canRedo` over _all_ sessions — so undone entries left by a previous server process lit up ↷ for a fresh session that had nothing of its own to redo. The gate counts are now session-scoped to match the actions; the history _list_ and per-entry **Revert** stay global.
- **Editing a column on a built-in entity (`notes` / `files` / `secrets`) no longer corrupts the schema.** These framework entities aren't in the YAML `entities:` map, so rename/add-column ran `ALTER TABLE` and then threw on the config write ("expected YAML collection …"), leaving the physical schema ahead of the config. Rename-column, add-column, and rename-table now **refuse built-in entities** (clear 400), **validate the config edit before touching SQL** (no physical/config drift, per Rules 15/16), and **reject duplicate target column names** with a friendly error instead of a raw adapter failure. The rename rebuilds the fields map by key rather than a deep `deleteIn`/`setIn`.
- **Inline cell edits that don't persist now fail loudly.** `updateRow` throws when a requested change leaves the row byte-identical (the signature of a read-only/blocked write), surfacing "Save failed" instead of a phantom "Updated". No false positives: genuine no-op edits and type-coerced values are recognized as unchanged.
- **"+ New workspace…" in the header switcher now opens the name input** instead of silently closing the menu. Clicking it replaced the menu's inner HTML, detaching the button, so the document click-outside closer (whose `contains(target)` test then failed) closed the menu. The handler now stops propagation, and the outside-click listener is attached once (it was re-added on every render).

### Changed

- **One-to-many links are labeled "→ one-to-many (legacy)"** in the Data Model editor (many-to-many junctions remain "↔ many-to-many"). New links are still created as M2M junctions; existing foreign-key (`belongsTo`) links keep working and rendering. Parsing a `ref:` field now emits a one-time deprecation warning — one-to-many `ref:` is slated for removal in 2.0 in favor of junctions.

### Removed

- **The standalone Activity rail** (right-hand live feed) — redundant with the Version History panel, which shows the same audited mutations with diffs and Revert. Multiplayer realtime convergence is unaffected (it runs on a separate realtime channel, not the activity feed); the server-side `/api/feed/stream` endpoint is retained.

## [1.16.0] - 2026-06-01

The stable 1.x line gains the domain-agnostic 2.0 features — the `.lattice`
workspace model + auto-render, full-text search, changelog history,
sources/references, a workspace dashboard, and a multiplayer cloud-editing
experience — with **no AI dependency**. (The AI assistant, chat, and ingest
summarization remain exclusive to the 2.0 line; 2.0 is this release plus that
AI layer.) A bare `new Lattice(path)` library consumer keeps a zero-overhead
`^1.x` contract: workspaces, FTS indexes, native entities, the changelog, and
all collaboration surface are opt-in or GUI-cloud-gated.

### Changed — GUI: Data Model, dashboard, auto-render, analytics copy

- **Data Model is an interactive force-directed schema graph** (vanilla SVG, no external lib): one node per table sized by row count, foreign-key (`belongsTo`) and many-to-many edges (junctions collapse into a single m2m edge rather than their own node). Drag to reposition, scroll to zoom (clamped so you can't zoom past the entities), drag the background to pan, click a node to open the entity editor.
- **Columns and links are edited separately, with no way to drop a table by accident.** The entity editor splits a table's fields into **Columns** (scalar data) and **Links** (foreign-key relationships):
  - **Columns:** system columns (`id` / `created_at` / `updated_at` / `deleted_at`) render read-only (name + type fixed). Editable scalar columns expose an inline name + a `secret` flag, staged behind **one "Save changes"** button. **Add column** offers only the scalar types `text` / `integer` / `real` / `boolean` (`uuid` is reserved for keys). Types display canonically (`text`, `uuid`, `datetime`) rather than the raw SQL column spec.
  - **Links:** read-only (`name → target`). Created via **"Add link"** (the FK column is named `<target>_id`); can't be edited once created, only **deleted individually** — and deleting a link drops _only_ that foreign-key column (`ALTER TABLE … DROP COLUMN`), never a table.
  - **Whole-table deletion is a separate, deliberate action.** A table is dropped only via a **"Delete table"** danger-zone button that requires typing the table name to confirm, and the server **refuses while any other table still links to it** (so a delete can't leave dangling references). This replaces the old per-table "Delete relationship" control.
  - **Backend-enforced** so a bad data model can't be created by hand: `POST …/entities/:t/columns` rejects system names, non-scalar types, and any `ref`; `…/columns/:c/rename` rejects system + FK columns; `POST/DELETE …/entities/:t/links` (create + delete only) and `DELETE …/entities/:t/links/:col` (drops the column only) are owner-gated; `DELETE …/entities/:t` (the sole table-drop path) is owner-gated, refuses inbound-FK references, refuses built-in entities, and surfaces any adapter error as a 400 (never a silent 500); the secret-toggle route rejects system + link columns. Canonical field types are surfaced on `/api/entities`.
  - **Fixed (data loss):** a first-class entity that happened to have exactly two foreign keys (e.g. `tasks` with `assignee_id` + `articles_id` + ordinary columns) was previously mis-classified as a junction table — the editor then showed a "Delete relationship" button wired to a `DROP TABLE`, so one click dropped the whole table. Junction detection (`isJunctionTable`, server + client, in lockstep) is now columns-aware: a table is a junction only if it carries nothing but its two FK columns and system columns. Such an entity now renders as a normal node/sidebar item and is fully editable; the wholesale junction-drop route was removed entirely. Regression tests cover both SQLite and Postgres.
  - **Saving updates the editor in place** — adding/renaming columns, adding/deleting links, sharing, and renaming no longer re-render the whole settings drawer (which reset scroll); only the editor panel + sidebar refresh, preserving scroll position.
- **Workspace GUI keeps rendered context synced at all times.** `lattice gui` on a `.lattice` workspace now derives canonical entity contexts for tables without one and enables auto-render, so every row has up-to-date context and the row view never shows "No rendered context for this row." A plain `lattice gui --config x.yml` is unchanged (serves only externally-rendered context). Fixes context going stale after edits.
- **Dashboard home** no longer shows the "entities" / "rows" count tiles (the per-entity cards already show counts); only the stale-data warning remains, and only when something is stale.
- **Analytics consent** is now a single **"Send anonymous analytics"** toggle covering the install ping and any Scarf pixel, with a one-line description ("Anonymous analytics will be shared with Lattice using Scarf"). Default on (opt-out), unchanged.

### Added — schema/data-model changes are tracked + reversible (soft-delete model)

- **Every schema change is now in Version History + the Activity rail, alongside row edits.** Creating/renaming/deleting a table, adding/renaming/deleting a column, and adding/deleting a link/relationship each append an entry to the same `_lattice_gui_audit` history (new `schema.*` operations; one additive nullable `session_id` column, reconciled automatically) with a one-line description ("Created table tasks", "Deleted table tasks", "Added column status to tasks", …) and a **Revert** button. Schema ops also participate in the header ↶/↷ undo/redo stack.
- **Undo/redo is session-scoped — you step through your OWN recent actions.** The header ↶/↷ stack (for both schema and row ops) is scoped to the current GUI session (one per server process), so in a shared cloud you undo what _you_ just did, not another user's edit. The per-entry **Revert** in Version History stays global — revert any entry, any session, any time.
- **Deletes are soft — data is never destroyed and reverts are exact.** A delete removes the entity/field from the config (hiding it from the GUI) but **never physically `DROP`s** the SQL table/column; the data stays in the database. Revert just re-adds the config entry, and re-opening reconciles idempotently (`CREATE TABLE IF NOT EXISTS` + skip-existing-column), so the table/column comes back with **all its rows/values intact** — no snapshot, no size limit, on both SQLite and Postgres. The only `DROP` the GUI ever performs is the explicit purge below.
- **Guards.** Reverts re-open the live DB so the in-memory schema never drifts, and surface any failure loudly rather than half-applying. Creating a table/column whose name matches a soft-deleted (orphaned) object is refused ("a deleted `<name>` exists — revert it instead"). Reverting a delete whose object was since purged is refused ("permanently purged"). Renames revert via real `ALTER … RENAME`.
- **Purge — API only.** `POST /api/schema/purge` (`{ type: 'table' | 'column', name, column? }`, owner-gated) physically drops an orphaned (soft-deleted) object to reclaim space and is **not surfaced in the GUI**. It's audit-logged as `schema.purge` and is irreversible.
- **Multiplayer.** Schema ops, reverts, and purges append a `ddl` change envelope in team/cloud mode so other clients re-fetch and converge (the broker treats `ddl` as a refresh signal, not a sharing toggle). Local SQLite is a single-writer no-op.

### Added — multiplayer cloud editing

When several people open the GUI against the same shared cloud (Postgres) DB:

- **Live share / de-share, no refresh.** Toggling a table's team visibility updates `teamContext.shared` + the visible table set in place (the share route for the initiating client, a realtime broker subscription for everyone else) instead of re-opening the DB and forcing a reload.
- **Realtime change envelopes for GUI edits.** GUI row writes now append a `__lattice_change_log` envelope (post-image payload, owner, `client_ts`), so the Postgres NOTIFY trigger fires and other clients learn of the change. Previously only the local audit log + activity feed saw GUI edits.
- **"Last edited by &lt;user&gt; · &lt;time ago&gt;"** on the row detail view, resolved from the change-log + the team roster (`GET /api/team/users`, `GET /api/tables/:t/last-edited`).
- **Live cues:** a row visible in the current view flashes when another editor changes it (honoring `prefers-reduced-motion`); changes to tables not in view bump a per-table unseen-change badge in the sidebar, cleared when the table is opened.
- **Offline editing.** When the cloud is unreachable, row edits are persisted to IndexedDB and replayed in edit-timestamp order the moment the realtime channel reconnects — no edits lost. A stable client `edit_id` makes replay idempotent (the server no-ops a re-sent edit via `findEnvelopeByEditId`); `client_ts` preserves true edit order without letting clock skew reorder the canonical `seq`. A top-bar pill shows the pending count.
- **Conflict handling.** Row edits are last-write-wins by edit timestamp, with every prior version recoverable from the change-log (`GET /api/tables/:t/rows/:id/history`). A write to a table that was de-shared under you returns a distinct `409 entity_unshared` so the client can refetch + toast. `schemaVersion` is surfaced per shared table on `/api/entities` as the optimistic-concurrency token for data-model edits (see `docs/collaboration.md` for the full policy).

### Changed — GUI: a single Workspaces switcher

- **In workspace mode (a `.lattice` root) the header shows ONE "Workspaces" switcher** instead of two overlapping menus. Previously a "database" switcher and a "workspace" switcher sat side by side, both showing the active workspace's name — confusing, since inside a workspace the database switcher only listed that one workspace's own config. Now, whenever workspaces exist, the database switcher is hidden and the Workspaces menu is the single switcher: it lists every workspace, carries the live cloud/local status dot, and gains a **"+ New workspace…"** action (a new `POST /api/workspaces/create` → `addWorkspace` + open + activate). Without a `.lattice` root (a plain `lattice gui` on a single config) the database switcher remains the fallback.

### Added — full-text search

- **Generic full-text search across entities.** A new `fullTextSearch(adapter, tables, opts)` (`src/search/fts.ts`, exported from the package root) returns hits grouped per entity with snippets, excluding soft-deleted rows, with two tiers:
  - **Indexed (opt-in).** A table opts in via `TableDefinition.fts` (`{ fields?: string[] }`; omit `fields` to auto-detect text columns). On `init`, Lattice builds an inverted index in a separate `__lattice_fts_<table>` table — **SQLite FTS5** / **Postgres `tsvector` + GIN** — kept current automatically by DB triggers (a generated `tsvector` column on Postgres). `fullTextSearch` uses the index when present; FTS5 `snippet()` / Postgres `ts_headline` produce the snippets.
  - **LIKE fallback.** Tables without `fts` are searched with a case-insensitive `OR`-of-`LIKE` over their text columns (`CAST(… AS TEXT)`, valid on both engines).
  - **Guardrail.** Index objects + triggers are created **only** for opt-in tables, so a bare `new Lattice(dbPath)` library consumer with no `fts` config gets no index, no triggers, and zero write-path overhead (a unit test asserts this).
  - **GUI search bar.** A debounced header search input calls `GET /api/search?q=&tables=&limit=` (scoped to the visible tables) and shows grouped results; click or Enter opens the row. Complements — does not replace — the embeddings-based semantic `Lattice.search`.

### Added — GUI: workspace dashboard

- **The GUI home is now a workspace overview, not a bare entity card-grid.** A new read-only `GET /api/dashboard` composes per-entity counts (reusing the pool-safe `entitiesWithCounts`), a freshness timestamp per entity (`MAX(updated_at|created_at|ts)` — one `UNION ALL` query on Postgres, in-process on SQLite), and a recent-activity list (the GUI audit log). The dashboard renders stat tiles (entities / rows / stale), per-card "last updated" with a stale flag (>14 days), and a recent-activity feed. Fully GUI-only + read-only — no core write-path behavior, so a library consumer of `latticesql` is unaffected.

### Security — DDL identifier & schema-spec validation

- **Team object sharing now validates every externally-supplied name, type, default, and constraint before it reaches DDL.** A shared object's `table`, column names, column types, defaults, and table constraints were previously rendered verbatim into `CREATE TABLE` / `ALTER TABLE`; on Postgres (simple-query protocol, empty params) a `;` could stack a second statement. New `assertSafeIdentifier` / `assertExternalIdentifier` (`src/schema/identifier.ts`) enforce a strict identifier grammar as a universal last-line defense inside the schema manager's `_ensureTable`/`addColumn` and `Lattice.addColumn`; `validateExternalSchemaSpec` validates the full spec (identifiers, the five primitive types, default grammar, constraint character-set, reserved `_lattice_` prefixes) at the `applySchemaSpec` trust boundary. Legitimate specs are unaffected. Regression tests in `tests/unit/identifier-safety.test.ts`.
- **Defense-in-depth on the core CRUD surface.** `insert` / `upsert` / `upsertBy` / `update` / `delete` / `query` / `count` and the natural-key methods now validate the `table` (and any dynamic column) identifier via `assertSafeIdentifier` before interpolating it into SQL — every legitimate identifier (including unregistered/dynamic tables) still passes.
- **Team row push/delete now require the object to still be shared.** `handlePushRow` / `handleDeleteRow` gained the `isObjectShared` precondition that `handleLinkRow` already enforced, so a stale row link cannot mutate a cloud table that has since been unshared.
- **SSRF guard:** documented the residual DNS-rebinding TOCTOU in `safeFetch` (each redirect hop is already re-validated); full socket-level IP pinning is noted as a deferred follow-up.

### Fixed — team member-list role drift + team-ops consolidation

- **The cloud member-list endpoint now surfaces the team creator with `role: 'creator'`**, matching the direct-Postgres path. The two implementations had drifted — `listMembersDirect` always surfaced the creator (even with a stale stored role, or no members row at all), while the HTTP `handleListMembers` returned the raw stored role. Both now delegate to a shared, auth-free core.
- **The cloud HTTP server (`routes.ts`) and the direct-Postgres path (`direct-ops.ts`) now share their team-operation cores** via the new `src/teams/team-core.ts`: `listTeamMembers`, `appendChangeEnvelope`, `shareObject`, `listSharedObjects`, and `unshareObject`. The `handle*` functions keep token-auth + role/authorization checks and delegate the DB logic; the `*Direct` functions keep only the cloud-connection lifecycle. This kills the duplication-with-drift bug class on those operations.
- **Change-envelope seq unified to per-team.** The two envelope writers had diverged — the HTTP path derived a _global_ max seq across all teams, the direct path a _per-team_ max. They are now both per-team (the correct cursor semantics; identical under the one-team-per-cloud model, and `handleListChanges` filters per team regardless).
- The row-level operations (`link`/`unlink`/`push`/`delete`) remain path-specific **by design** — the HTTP path mirrors row snapshots into a separate cloud table, while the direct path operates on the shared table in place; these are genuinely different logic, not duplication.

### Maintenance — dead-code removal & simplification

- Removed unreferenced internal symbols (the `src/lifecycle/index.ts` barrel, `RegisteredTable`/`RegisteredMulti`, `getStatusDirect`, `isInviteToken`).
- `reverse-seed` `_insertOrIgnore` now uses the `{ changes }` row count from `tx.run` instead of count-before/count-after SELECTs.
- Internal dedup: a `NOT_DELETED` soft-delete fragment constant (was inlined 5×), a single Postgres polyfill-registration helper, and a one-pass link index in `enrichKnowledge`.
- **`lattice.ts` modularization.** Extracted two cohesive collaborators from the `Lattice` facade — `ChangelogService` (`src/changelog/service.ts`: `history`/`recentChanges`/`rollback`/`snapshot`/`diff` + changelog-row parsing) and `ReportBuilder` (`src/report/builder.ts`: `buildReport` + duration parsing). The public method surface is unchanged: the facade keeps each method, performs the `init()` guard, and delegates to a lazily-constructed collaborator (deps injected, so the collaborators never reach into `Lattice` internals). `lattice.ts` shrank ~280 lines.
- **Shared GUI HTTP helpers (`src/gui/http.ts`).** `sendJson` / `readJson` / `tryHandler` were copy-pasted across the GUI route modules with divergent body-size caps and inconsistent error handling. Now a single source of truth: `readJson(req, { maxBytes })` defaults to 1 MB, with explicit per-endpoint overrides where a larger body is intended. The cloud Team server keeps its own copies (no GUI dependency).
- **`gui/app.ts` split.** The 5,436-line single-template-literal GUI document was split into `src/gui/app/css.ts` (stylesheet) and `src/gui/app/script.ts` (client script), assembled by a 114-line `app.ts` shell (`<style>${css}</style>` … `<script>${appJs}</script>`). The served HTML is **byte-for-byte identical** (verified: same length + SHA-256), and the no-build single-string output is preserved.

### Deprecated — `files.path` / `files.kind`

- **`files.path` is deprecated in favor of the reference model.** GUI local-file ingestion (`/api/ingest/file`) now records a v2.0 `local_ref` (`ref_kind='local_ref'`, `ref_uri`) via `referenceLocalFile()` instead of writing `path`. The blob/open routes and the GUI preview fall back to `ref_uri` (`resolveSource` already did). `files.kind` is an orphaned column (superseded by `mime` + `ref_kind`). Both columns are retained for back-compat — **not dropped** — and carry deprecation notes.
- **License metadata:** the Apache copyright holder is now consistent across `LICENSE` + `NOTICE`; the `NOTICE` package label was corrected to `latticesql` and the placeholder URL to the project homepage.

### Added — workspace model + auto-render (back end)

- **One `.lattice` root** — a single discoverable folder (via `LATTICE_ROOT` or by walking up from the cwd to a `.lattice/.config`) now holds machine-local config, the workspace registry, each workspace's database + blobs, and the rendered context. `configDir()` consolidates into `<root>/.config` once initialized, with a non-destructive copy migration of any legacy machine-local config (originals preserved) and a homedir fallback.
- **First-class workspaces** — `Lattice.openWorkspace()` opens a workspace under `.lattice/Workspaces/<name>/`, split into `Data/` (database + blobs) and `Context/` (the rendered SQL→markdown bridge). Registry helpers: `addWorkspace`, `listWorkspaces`, `getActiveWorkspace`, `setActiveWorkspace`, `resolveWorkspacePaths`.
- **Canonical `Context/` layout** — zero-config, DB-aligned rendering: table→folder, row→subfolder, `<ENTITY>.md` plus relation rollups (e.g. `PROJECTS.md` inside a file, `FILES.md` inside a project). Derived from the schema via `deriveCanonicalContexts`.
- **Auto-render** — `enableAutoRender(outputDir)` debounces a re-render on every insert/update/delete (coalesced into a single render; unchanged files skipped by the manifest hash-diff). Workspaces enable it by default so context is always current and there is never a "no rendered context" state. A bare `new Lattice(dbPath)` is unaffected unless it opts in.
- **CLI** — `lattice init` scaffolds a root + default workspace and renders the initial tree; `lattice workspace list|create|use` manages workspaces.

### Added — references (a row can index data that lives elsewhere)

- **Reference columns on `files`** — additive, nullable: `ref_kind` (`blob` | `local_ref` | `cloud_ref`; NULL ⇒ owned blob), `ref_uri` (absolute path or URL), `ref_provider` (`fs` | `web` | `gdrive`), `source_json` (provider metadata). Existing inserts are unaffected.
- **Ingestion API** — `referenceLocalFile(path)` records a local file **without copying it** (the file stays where it is); `referenceUrl(url)` records a cloud reference (validated, not fetched at record time). Both set `extraction_status: 'pending'`.
- **Unified resolver** — `resolveSource(row, root)` returns a `SourceHandle` (`readContent` / `getMetadata`) for blob, local-file, and URL sources alike, so one set of utilities works for local and cloud.
- **SSRF guard** — `assertSafeUrl` rejects non-http(s) schemes and private/loopback/link-local/metadata addresses (opt-out via `allowPrivate`).
- **No-copy render mode** — entity contexts can set `attachFileMode: 'reference'` to index an attached file in place (writes a `<name>.ref.md` pointer) instead of duplicating its bytes.

### Added — GUI: workspace switcher

- **Header workspace switcher** — when the GUI is opened inside a `.lattice` root, a header switcher lists the workspaces and switches the active one (`GET /api/workspaces`, `POST /api/workspaces/switch`); switching re-points the GUI at that workspace's config + `Context/`. The switcher is hidden on a plain (non-workspace) GUI, so nothing changes for non-workspace usage. `lattice gui` now opens the active workspace automatically when a root is present. The `Workspaces/` container is never browsed as a folder — switching is header-only.

### Added — analytics consent control

- **Anonymous install analytics is now an explicit opt-out consent setting.** Scarf install analytics ships on by default (`scarfSettings.defaultOptIn`); a new `analytics` user preference + a **Settings → User → "Anonymous install analytics"** GUI toggle let users opt out. `analyticsEnabled()` is the consent gate (env `DO_NOT_TRACK` / `SCARF_ANALYTICS` win, then the preference); `lattice update` / `autoUpdate()` reinstalls pass `SCARF_ANALYTICS=false` when opted out. README + SECURITY.md telemetry docs updated to describe the consent model. The original `npm install` ping remains governed at install time by the env-var opt-outs.

## [2.0.0] - 2026-05-29

Builds on 1.16.0 — it is the 1.16 non-AI feature set plus an AI layer. This is the GUI 2.0 release: `lattice gui` gains an AI assistant sidebar. The library API is unchanged and backwards-compatible; the assistant is GUI-only and inert until credentials are configured.

### Added — AI assistant sidebar

- **Chat with tools** — `POST /api/chat` streams a Claude tool-calling loop over SSE. A function registry mirrors the GUI's mutation primitives (`createRow`/`updateRow`/`deleteRow`/`link`/`undo`/`redo`), so assistant edits are audited, fed to the activity rail, and undoable.
- **Activity feed + realtime** — an in-process feed bus streams every audited mutation (UI, AI, ingest) to the rail via `GET /api/feed/stream`; the Postgres realtime broker is merged in so other clients' changes appear too.
- **Voice input** — `POST /api/assistant/transcribe` routes to Whisper or ElevenLabs Scribe, with an explicit provider choice.
- **File ingest** — reference local files or paste text (`/api/ingest/*`); text/code extracted directly, PDFs/office docs via optional `markitdown`. With a Claude key, an LLM summarizes + classifies relevance and auto-creates junction links; the files detail view renders markdown / office-doc previews safely inline.
- **Native chat entities** — `chat_threads` + `chat_messages` join `files`/`secrets` as first-class native entities; real per-conversation threads with a switcher.
- **Credentials & OAuth** — Claude/OpenAI/ElevenLabs keys stored encrypted in the native `secrets` entity; Claude subscription OAuth (PKCE) scaffolding reads `ANTHROPIC_OAUTH_*` env vars.
- **Responsive rail** — resizable sidebar (persisted) + a mobile bottom-drawer under 720px.
- **Browser e2e coverage** — Playwright specs for the assistant rail, composer key-gating, feed stream, and file-ingest preview (the rail-independent delete-database spec ships in 1.15.0).

### Added — file-system workspace (default view) + settings drawer

- **File-system workspace** — the default GUI is now a desktop-style file manager. The home dashboard is unchanged (a card per object), but clicking an object opens its rows as a grid of **folder/file tiles**, and clicking a tile opens an **item view**: the row rendered as a document built from its columns (long-form fields formatted as markdown), with the row's relationships shown as **sub-folders** you can drill into arbitrarily deep (e.g. _Authors → a person → Books → a book → Reviews_). A clickable breadcrumb tracks the path. New `#/fs/<table>[/<id>/<relation>/<id>…]` routes; resolution is entirely client-side over the existing endpoints (no API change). Relationships are derived from the schema — forward `belongsTo` (`ref:`) renders as a parent link; the reverse side + many-to-many junctions become the drill-in folders.
- **Click-to-edit** — in the item view, click any value to edit it in place; the change saves immediately via `PATCH /api/tables/:t/rows/:id` and is undoable. Identity/system/secret and native-file binary columns stay read-only.
- **Settings drawer** — a **gear** in the header (top-right) opens a slide-over drawer with **Database**, **Lattice**, and **User** tabs (the existing settings panels, relocated from the left nav) plus an **Advanced mode** toggle. Advanced mode switches the object/row views back to the classic editable **table + row** editor (`renderTable`/`renderDetail`, unchanged); the default is the file-system workspace. The legacy `#/settings/*` hashes still resolve and open the drawer.
- **Slim collapsible sidebar** — the left object nav is now collapsible (state persisted); settings links moved into the gear drawer.
- The assistant rail is unchanged in both modes. New Playwright spec `tests/e2e/fs.spec.ts` covers the folder grid, nested drill + breadcrumb, click-to-edit persistence, the Advanced-mode toggle, and the settings drawer.

## [1.15.0] - 2026-05-29

### Added — delete a database from the GUI (destructive, confirmation-gated)

A new `POST /api/databases/delete` endpoint plus a name-gated confirm modal removes a saved database's YAML config and (for local SQLite) its `.db` file and `-wal`/`-shm`/`-journal` sidecars. It switches to a sibling first when the active database is deleted, refuses to delete the only database, rejects unknown paths, leaves remote Postgres data untouched, and surfaces filesystem failures loudly rather than half-deleting.

### Added — Playwright e2e harness + Windows CI matrix

Browser-level e2e tests for the GUI SPA (`tests/e2e/*.spec.ts`, `playwright.config.ts`, `test:e2e` script) — each spec boots its own `startGuiServer({ port: 0 })`, no shared web server. CI splits into three jobs: linux (lint/format/typecheck/coverage/build + Postgres), windows (typecheck/test/build — catches Windows-only path regressions; service containers are Linux-only so PG tests skip there), and e2e (Playwright chromium, cached).

### Fixed — `lattice gui` crashed on Windows for `postgres://` databases

`openConfig()` ran `mkdir` on the `db:` value unconditionally, but a `postgres://…:5432/…` URL contains `:`, an illegal Windows path character — so opening any Postgres database in the GUI hard-crashed on Windows. The mkdir is now skipped for non-file `db:` connection strings. Separately, `lattice --version` crashed on Windows because it read a percent-encoded `import.meta.url` pathname; it now uses `fileURLToPath()`.

### Fixed — GUI `/api/entities` exhausted the connection pool at scale

The GUI listed entity counts with an unbounded `Promise.all` of one `COUNT(*)` per entity, so a ~95-entity cloud database fired ~95 concurrent counts and exhausted a 15-slot Postgres session pooler (`EMAXCONN`). Counts now run with bounded concurrency and a fast estimated-count path on Postgres (`pg_class.reltuples`, with an exact fallback when the estimate is `<= 0`).

### Fixed — Windows non-portable `db:` paths surfaced to the config / browser

The GUI Database panel's SQLite save used `path.relative`, which yields backslash separators on Windows and leaked a non-portable path into the committed YAML; relative `db:` paths are now POSIX-normalized. Logical paths surfaced to the browser/DB are likewise normalized to forward slashes.

### Fixed — `startGuiServer().close()` could hang on an open SSE connection

A browser tab subscribed to the long-lived `/api/realtime/stream` SSE route kept a keep-alive socket open, so `close()` hung waiting for it to drain (blocking programmatic shutdown / tests). `close()` now force-drops lingering connections via `server.closeAllConnections()` (Node 18.2+).

### Changed — de-flaked the parallel-pool Postgres timing test

The concurrent-vs-baseline pool test compared parallel wall-time against an absolute floor that was sensitive to connection-setup jitter on CI. It now warms the whole pool first, then asserts a concurrent batch beats a serialized baseline (a relative comparison that states the actual property under test).

### Fixed — shared-schema sync blanked a joined member's tables

A member on a team DB could refresh and see **none** of the shared tables. Applying a cloud schema that adds a `NOT NULL` column (no default) to an already-existing local table threw `Cannot add a NOT NULL column with default value NULL` (SQLite + Postgres both reject this via `ADD COLUMN`); that non-conflict error aborted the **entire** shared-schema sync, so the member got zero tables. `renderAddColumnType()` now adds such columns nullable on an existing table (the constraint can't be enforced on existing rows anyway, and cloud-synced rows still carry values), and `syncSharedSchemas()` isolates per-table failures — a single unappliable object is recorded as a conflict and skipped, so the rest of the team's shared tables still sync.

### Fixed — native `secrets.name` `NOT NULL` column lacked a `DEFAULT`

`secrets.name` was `NOT NULL` with no default, so merging the native shape onto a pre-existing table via `ALTER TABLE ADD COLUMN` (the adopt + team shared-schema sync paths) failed with `Cannot add a NOT NULL column with default value NULL`. It now carries `DEFAULT ''`; every insert sets `name` explicitly, so the default is never observed in practice. A regression test asserts every `NOT NULL` native column has a `DEFAULT` (or is the PK).

### Fixed — `seed()` silently dropped junction links to unresolved targets

`Lattice.seed()` skipped any `linkTo` link whose target row didn't resolve (`if (!target) continue`) and `link()` swallows non-matching inserts via `INSERT OR IGNORE`, so a record could cite a relationship in its rendered text while having no link in the graph — with no error, log, or signal. `SeedResult` now carries an `unresolvedLinks: UnresolvedLink[]` array surfacing every dropped link (source record, field, target name, junction, resolve table/column). The new `SeedConfig.onUnresolvedLink: 'collect' | 'throw'` option (default `'collect'`, preserving existing behavior) makes `seed()` throw a `SeedReconciliationError` listing all unresolved links for pipelines that must never leave a dangling reference. `SeedReconciliationError` and `UnresolvedLink` are exported from the package root.

### Added — Teams dead-letter queue is now inspectable, retryable, and purgeable

`__lattice_team_dlq` was write-only: failed pull envelopes landed there and could only be counted via `teams status`, never seen or replayed, so an envelope that failed because it arrived before its dependency was effectively lost behind the advancing pull cursor. New `TeamsClient.listDlq()` / `retryDlq(id?)` / `purgeDlq(id?)` and CLI `lattice teams dlq list|retry|purge --team <name> [--id <id>]` make the queue observable and recoverable — `retry` replays through the normal apply path, so a late-arriving dependency lets the envelope apply cleanly. `teams status` now points at `dlq list` when the depth is non-zero.

### Added — non-owner local edits are no longer silently overwritten on pull

A non-owner who edited a mirrored row locally produced no outbox entry (only owners push), so the owner's next update overwrote it with no trace. `__lattice_local_links` gains a `synced_hash` column (additive; backfilled on the next session, populated on each applied upsert). Before a last-write-wins overwrite of a non-owned row, the puller compares the current local row's hash against `synced_hash` and, on a mismatch, records a `divergence` entry in the DLQ capturing both the lost local content and the incoming row. The row still converges to the owner's state; the loss is now visible via `teams dlq list`.

### Changed — `docs/teams.md` documents the real sync semantics

Added a "Conflict resolution & sync semantics" section (last-write-wins, owner-only push, non-owner overwrite behavior, DLQ vs. outbox) and corrected the schema-reference description of `__lattice_team_dlq` (it holds pull-apply failures + divergence notices, not push-attempt failures — push retries live in the outbox).

## [1.14.0] - 2026-05-27

### Fixed — native entities (`files`/`secrets`) showed as cards but failed with "Unknown table"

`registerNativeEntities()` + `init()` create and register the native `files`/`secrets` tables on every GUI-opened database, and `/api/entities` listed them as cards — but the GUI's row endpoint allowlist (`validTables`) was built only from the YAML-declared tables, so clicking a native card returned `400 Unknown table`. `validTables` (and `softDeletable`) are now derived from the live Lattice schema (`getRegisteredTableNames()`, minus internal `__lattice_`/`_lattice_` tables), so any registered non-internal table — native entities, team-shared tables, programmatic `db.define()` — is queryable by the same registry that surfaces it as a card. Internal bookkeeping tables remain non-queryable (security boundary preserved).

### Fixed — rendered-context view bled across databases

The GUI resolved the rendered-context root (`outputDir`, holding `.lattice/manifest.json`) once at launch and reused it for every database switch, so the manifest-sourced "entities/files" view showed the launch directory's rendered content for _every_ database — a database with no rendered context of its own displayed another database's files. The switch/create paths now resolve `outputDir` per config, probing the config's own directory; a database with no co-located manifest correctly shows no manifest-sourced entities.

### Fixed — SQLite `ALTER TABLE ADD COLUMN` rejected parenthesised non-constant defaults

`SQLiteAdapter.addColumn` stripped `DEFAULT datetime('now')` / `CURRENT_TIMESTAMP` / `RANDOM()` before the ALTER (SQLite rejects non-constant defaults on add-column), but only matched the bare form. The native-entity defs use the parenthesised form `DEFAULT (datetime('now'))`, so adopting a legacy table that lacked `created_at`/`updated_at` threw `Cannot add a column with non-constant default`. The strip now tolerates an optional wrapping paren.

### Added — normalized native-entity concept + adopt/label existing tables

- `NATIVE_ENTITY_NAMES` / `isNativeEntity()` — a single source of truth derived from `NATIVE_ENTITY_DEFS`. Adding a key to `NATIVE_ENTITY_DEFS` now flows everywhere (creation, GUI surfacing, recognition) with no hard-coded `'files'`/`'secrets'` literals.
- `adoptNativeEntities(db, { onConflict? })` — post-init reconcile that records, in a new internal `__lattice_native_entities` registry, which physical table is bound to each native entity. A pre-existing `files`/`secrets` table is _adopted_ (its native column superset merged in, non-destructively) and labelled the native object rather than duplicated. Legacy plaintext `secrets.value` stays readable (decrypt passes non-`enc:` values through) and new writes encrypt. `listNativeBindings(db)` reads the bindings. The GUI runs this on every open and exposes `GET /api/native-entities`; `/api/entities` now marks native tables with `native: true`. New databases created through the GUI get the native tables at creation time (additive DDL — no breaking change; library `init()` default behaviour is unchanged).

### Changed — GUI settings consolidation (every config option in one place)

- The header database dropdown and **Lattice Settings → Databases** now read the same `/api/databases` list, so they are 1:1 and both show readable labels rather than raw filenames.
- **Database Settings** shows only the _active_ database (name, connection/state, and — for a team cloud — inline invite-token generation + member list). The separate "Cloud Databases" panel, its Create/Join buttons, and the "Destroy team" button were removed.
- The add-database flow offers a third option, **Join existing cloud (via invite)**, alongside new-local and new-cloud.
- **User Settings** is now identity + preferences only; the "Cloud accounts" section was removed.
- The Data Model graph no longer renders junction tables as nodes (filtered server-side in `buildGuiGraph`); they appear only as the many-to-many edge between the two objects they link, eliminating the brief junction-box flash.
- Database Settings name input is now black-on-white (was white-on-white in the dark theme).

### Added — per-table ownership + opt-in sharing for team cloud databases

Every member of a team cloud connects to the same physical Postgres, so every table physically exists for everyone at the SQL level. Visibility is now enforced at the application layer via a new internal `__lattice_object_owners` table (`team_id`, `table_name`, `owner_user_id`): each user-created table records its creator as owner, and a user sees only the tables they own **plus** tables explicitly shared to the team (present in `__lattice_shared_objects`).

- **Ownership is recorded at creation** (`recordObjectOwner`, first-writer-wins) and **reconciled on open** (`reconcileObjectOwners` assigns any unowned table — including the native `files`/`secrets` objects — to the team creator), so visibility is deterministic.
- **Native objects are private to the creator by default.** `files`/`secrets` are owned by the database creator and are no longer visible (or queryable) to other members unless explicitly shared. The visibility filter gates the queryable `validTables` allowlist, not just the display, so a member can't read another user's secrets.
- **Sharing is an explicit action**, not a side effect of creation. The Data Model entity editor shows a **Share with team / Unshare from team** toggle for tables you own (`POST /api/schema/entities/:name/share`); only the owner may toggle it. The previous default-checked "Share with cloud" checkbox on entity creation was removed — new entities are private until shared.
- The Data Model graph and `/api/entities` list are filtered to the visible set; `/api/entities` rows now carry `shared` / `ownedByMe` flags on team clouds.

### Fixed — Data Model was empty (no native entities or team-shared tables)

The Data Model graph (`/api/graph`) was built from the YAML-declared tables only, so framework-registered native entities (`files`/`secrets`) and team-shared tables never appeared — the page rendered just the legend. `buildGuiGraph` now accepts the runtime-registered tables (and a visibility filter), so native entities and visible team tables show as nodes.

### Fixed — kicking a team member failed with `column "id" does not exist`

The team-cloud internal tables (including `__lattice_team_members`, whose primary key is the composite `(team_id, user_id)`) were only registered on the active Lattice handle in the dedicated `--team-cloud` HTTP server mode, never in the normal direct-Postgres GUI. With the schema unregistered, `delete()` fell back to a non-existent `"id"` primary-key column. `openConfig` now registers the cloud internal tables whenever the active DB is a team-enabled Postgres, so composite-key deletes (kick, leave, destroy) target the right columns.

### Fixed — an already-joined member saw the "paste invite token to join" panel

Database Settings derived the team-cloud state from whether a token key-file happened to be on disk, so a joined member could resolve to `team-cloud-needs-invite` and be shown the join form again. State is now derived from the operator's resolved membership (does their identity map to a cloud member?). The join form only appears for operators pointed at a team cloud they have not joined; joined members get the member/creator view plus a **Leave team** (member) / **Destroy team** (creator) button.

### Changed — additional GUI consolidation + polish

- The header dropdown shows each database's friendly display name and a per-row **Cloud/Local** tag with the correct status color — inactive cloud databases no longer mis-render as Local. Joined-team config files now persist a `name:` key so the label resolves without opening the cloud.
- Renaming a cloud database is restricted to the team owner; members see the name field read-only.
- Joining a team via invite now auto-switches to the joined cloud database and refreshes — no manual page reload needed.
- The Data Model now lives inside **Database Settings** rather than as a separate sidebar item.
- Async action buttons disable and show an inline spinner while their request is in flight, preventing duplicate submissions during slow round-trips.
- Bare text inputs (Database Settings name, Lattice Settings, invite token) now render on the dark surface instead of light-on-white.

### Fixed — team-cloud member administration when the cloud DB is active

When the team cloud was itself the active database (direct-Postgres mode), the SPA's member list, invite, kick, and leave actions all failed with "No local team connection found" — they keyed off the local `__lattice_team_connections` row, which only exists in whichever DB was active when you joined, not in the cloud DB you're now viewing.

- The active team identity (`teamId`, `myUserId`, `isCreator`, `isMember`) is now resolved server-side from the cloud DB and exposed on `/api/dbconfig`; the SPA drives member admin off that instead of a local connection row. Server-side, `getConnection` falls back to a synthetic connection built from the active cloud DB when no local row exists.
- **Membership is authoritative** — `resolveTeamContext` checks for a live `__lattice_team_members` row, so a kicked/left operator correctly resolves to "not a member."
- **Kick is owner-only** — the kick route 403s a non-creator removing another member (the direct-Postgres path had no server in front to authorize it); removing yourself (leave) is always allowed.
- **Members list** marks "you", and your own row carries the **Leave** (member) / **Destroy team** (creator) action; other rows carry **Kick**, shown only to the creator. The separate top-level Leave/Destroy button was removed. The team owner is always shown in the list (resolved from `__lattice_team.created_by_user_id` and labeled `creator`) even when they have no explicit `__lattice_team_members` row.
- **Leaving tears down local access** — leave/destroy now removes the team's local sibling config + saved credential, so the left DB disappears from the dropdown and can't be switched to; the SPA switches to another database and navigates off the (now-gone) DB page. This keeps the API and the UI in lockstep: a database you can no longer see is also no longer reachable.
- The **Join via invite** modal locks the email + display-name fields (read-only, sourced from User Settings) so you always join as yourself and the email matches the invite binding.

### Reverted — restored the `@scarf/scarf` install-analytics postinstall

1.13.10 dropped the `@scarf/scarf` dependency in favor of a passive README pixel. That removal is reverted: `@scarf/scarf` is restored as a dependency with `scarfSettings.defaultOptIn`, the README **Telemetry** section again documents the postinstall ping (what is sent, what is not, and the `SCARF_ANALYTICS=false` / `DO_NOT_TRACK=1` / `--ignore-scripts` opt-outs), the SECURITY **Scope** note again lists the install ping, and the README tracking pixel was removed.

## [1.13.10] - 2026-05-27

### Changed — Replaced `@scarf/scarf` postinstall with a passive README pixel + public npm download stats

v1.13.8 shipped `@scarf/scarf` as a runtime dep to capture install analytics, and v1.13.9 left it in place. In testing against the published tarball we confirmed the postinstall is structurally unable to report direct `npm install latticesql` events — Scarf's `report.js` reads `scarfSettings.allowTopLevel` from the **consumer's** root `package.json`, not the dependency's, so a library author has no way to opt their package in. The hook ran but bailed silently with `"The package depending on Scarf is the root package being installed, but Scarf is not configured to run in this case"` on every direct install, and only emitted reports for the rare transitive-install case. Net effect: the postinstall delivered approximately zero of the install volume to the dashboard.

This release removes the postinstall machinery entirely and replaces it with two passive signals that require no instrumentation in the package itself:

- **`@scarf/scarf` removed from `dependencies`**, `scarfSettings` block removed from `package.json`. Direct installs are now strictly faster (one fewer postinstall script) and quieter (no swallowed error in npm logs). No env-var opt-out is needed because there's nothing to opt out of.
- **A 1×1 Scarf tracking pixel** added at the bottom of `README.md`, fired only when the README is rendered (e.g. on the npmjs.com package page). Standard ad-blockers and privacy-focused npm UIs prevent the request from firing; alt-text is empty so layout is unchanged.
- **Public npm download counts**, queried out-of-band against `api.npmjs.org/downloads/range/...` — same data npmjs.com itself publishes, no per-user info.

README § Telemetry and SECURITY.md § Scope rewritten to reflect the new posture: zero postinstall telemetry, zero runtime telemetry except the explicit caller-invoked `checkForUpdate()` / `autoUpdate()` against `registry.npmjs.org`.

## [1.13.9] - 2026-05-27

### Fixed — `lattice gui` crashed at boot on v1.13.8 because pg got inlined into the CLI bundle

v1.13.8's `src/gui/realtime.ts` used a top-level `import pg from 'pg'`, and `tsup.config.ts` did not list `pg` in the CLI build's `external` array. tsup happily inlined pg's CommonJS internals — including a `require('events')` shim and the native-binding glue — into the ESM CLI bundle (`dist/cli.js`, which ballooned from ~596 KB to ~770 KB). Every `lattice gui` boot then crashed at first module-evaluate with `Dynamic require of 'events' is not supported`, even for SQLite-only configs that never construct a `RealtimeBroker`.

v1.13.9 is a no-API-surface hotfix:

- **`src/gui/realtime.ts`** switches to a type-only `import type pg from 'pg'` plus a runtime `createRequire(import.meta.url)('pg')` lazy-load that runs only when the broker actually opens a Postgres client. Matches the existing pattern in `src/db/postgres.ts`. The error message when pg is missing is consistent with the PostgresAdapter: `RealtimeBroker requires 'pg'. Install with: npm install pg`.
- **`tsup.config.ts`** now lists `pg` in `external` on the CLI build (mirroring the library build), so a future regression that re-adds a static `import pg` still can't pull pg into the bundle. Belt and suspenders.
- **New regression test `tests/unit/cli-pg-bundling.test.ts`** asserts (a) `src/gui/realtime.ts` never statically value-imports `'pg'`, (b) both tsup build entries list `'pg'` in `external`, and (c) when `dist/cli.js` is on disk it contains zero pg-internal markers (`pg-types`, `pg-protocol`, `pg-pool`, `pgpass`, or a bare `require('events')`).

CLI bundle size after fix: ~596 KB (down 174 KB).

## [1.13.8] - 2026-05-27

### Added — Realtime cloud subscriptions

Cloud Postgres-backed lattices now stream changes to every connected GUI in realtime. Mechanism: a Postgres trigger on `__lattice_change_log` emits `pg_notify('lattice_changes', …)` after every insert; the GUI server holds a dedicated `pg.Client` with `LISTEN lattice_changes` and fans payloads out to browsers over a new Server-Sent Events endpoint `GET /api/realtime/stream`. The browser's `EventSource` invalidates the entity cache and refetches the active view; connection state drives a colored status indicator in the topbar (green = cloud live, yellow = local SQLite, red = cloud disconnected). SQLite databases are unchanged — LISTEN/NOTIFY is a Postgres-only feature, and the broker is skipped on those.

New surfaces:

- `GET /api/realtime/stream` — SSE; emits `state` and `change` events.
- `GET /api/realtime/status` — JSON snapshot of `{ mode, state, connected }`.
- `src/teams/internal-tables.ts` exports `installCloudInternalTriggers(db)` and `CLOUD_NOTIFY_CHANGE_LOG_SQL`. The installer runs automatically wherever the cloud-internal table set is registered (team-cloud server boot, `redeemInviteDirect`, `openCloud`).
- `src/gui/realtime.ts` adds `RealtimeBroker` — dedicated pg client, exponential-backoff reconnect, state + payload subscribers.

### Added — Information-architecture refactor: Cloud Database as the first-class concept

Lattice Teams remains the product, but the GUI no longer treats "Team" as a separable entity from the cloud database that hosts it. The mental model is now: one User per machine; many Databases; each Database is Local (single-user SQLite) or Cloud (Postgres, one or more invited team members). A "team" is just the set of members on a cloud database — you don't "Create a team" anymore, you create a cloud database, and a team emerges when you invite people.

- **Three-step Create Database wizard.** A unified modal handles new-DB creation from both the header dropdown and the new Lattice Settings page. Step 1: database name + Local|Cloud radio (with cloud URL + email when cloud). Step 2: starter entities, each with a pre-checked "Share with cloud" checkbox when cloud. Step 3: review and create.
- **Editable Database name.** Renamed from "team name"; one field for both local and cloud databases. Cloud renames broadcast to every team member via the realtime channel; local writes a `name:` key into the YAML config. New endpoint `POST /api/dbconfig/rename`. ParsedConfig gains an optional `name?: string`.
- **Header dropdown.** Each entry shows the friendly DB name + a Local|Cloud kind chip + a connectivity dot (green/yellow/red). The "Create blank database" inline form is gone; "+ New database" opens the wizard.
- **Settings sidebar reorganized.** Lattice Settings (catalog of every DB this lattice can reach + "Add new database"), Database Settings (renames Project Config; editable Name header at the top), Data Model, User Settings. The legacy `/settings/project-config` route still resolves for back-compat.
- **Migrate-to-Cloud per-table share checkboxes.** The migrate modal now lists every user-defined table with "Share with cloud" pre-checked. Uncheck tables you want kept on the cloud but unshared. After the migrate, only checked tables call `shareObject`.
- **New-entity flow.** Creating an entity from Data Model on a cloud-connected DB shows a pre-checked "Share with cloud" box. Share runs best-effort after the entity is created.
- **Vocabulary.** "Create team" → "Create cloud database". "Team Cloud" → "Cloud database". Team language is preserved everywhere it describes member management ("Invite Team", "Join Team", "Team Members") and remains the brand ("Lattice Teams").

### Added — User preferences: show system tables in sidebar

The sidebar's "System" section (tables prefixed `__lattice_*` / `_lattice_gui_*`) is now hidden by default. A new checkbox in User Settings → Preferences reveals them. Backed by `~/.lattice/preferences.json` and the new `GET`/`POST /api/userconfig/preferences` endpoint. `readPreferences()` / `writePreferences()` exported from `src/framework/user-config.ts`.

### Fixed — Modal label contrast + password masking

- `.modal .field label` and inputs no longer fall through to browser UA defaults, which produced unreadable light-gray-on-white labels in some themes. Both pin explicit `var(--surface)` / `var(--text)` for predictable contrast on every theme.
- `redactUrlCredentials` now masks passwords with the ASCII `'****'` instead of a bullet glyph, so `URL.toString()` stops percent-encoding the userinfo as `%E2%80%A2`.

### Added — Scarf install analytics (opt-out)

`latticesql` now ships with [`@scarf/scarf`](https://www.npmjs.com/package/@scarf/scarf) as a runtime dependency so we can collect anonymous install metrics — package version, Node version, OS, architecture — at `npm install` time. No runtime telemetry is added: the package still makes zero outbound calls after install except the explicit, caller-invoked `checkForUpdate()` / `autoUpdate()` requests to the npm registry.

Opt out per-install (`SCARF_ANALYTICS=false npm install latticesql`), project-wide (`scarf-analytics=false` in `.npmrc`), via the cross-tool standard (`DO_NOT_TRACK=1`), or by disabling postinstall scripts entirely (`--ignore-scripts`). Opting out does not affect functionality. See README § Telemetry and SECURITY.md § Scope for the full disclosure.

## [1.13.7] - 2026-05-27

### Fixed — Joining a team cloud is now seamless end-to-end (dropdown + entity auto-discovery)

This release closes out the "join a team and start working" UX. v1.13.5 made the invite redeem succeed against direct-Postgres clouds; v1.13.6 fixed the dozen team operations that crashed once you were a member. But the user still had to manually rewire YAML configs to actually USE the team's cloud, and even after switching to it the GUI greeted them with an empty SPA. 1.13.7 wires both pieces.

**1. Joined team's cloud DB now appears in the database dropdown.**

`POST /api/teams-gui/connections/join` (the GUI's "Join via invite" handler) previously saved the team connection but did nothing to make the team's cloud DB switchable — the user had no way to actually USE the team's cloud after joining. The credential lived in the local lattice's `__lattice_team_connections` table, but the database-switcher dropdown reads filesystem YAML configs.

Two helpers wire this together (the code shipped in 1.13.6's tarball but only became user-visible together with the entity-discovery fix below, so we credit the feature here):

- **`saveDbCredentialForTeam({teamName, teamId, cloudUrl})`** in `src/framework/user-config.ts` — persists the cloud URL into `~/.lattice/db-credentials.enc` under a sanitized label of the form `<team-name>.config`. If a label collision exists with a different URL, suffixes `-<short-team-id>` to keep them distinct. Returns the label actually used.
- **Sibling YAML write** in `src/gui/teams-routes.ts` `handleJoin` — after `saveConnection`, writes `<credential_label>.yml` to the active project's config directory containing `db: ${LATTICE_DB:<label>}` + an empty `entities:` map. `listConfigs()` picks it up on the next `/api/databases` poll.

The new helper `saveDbCredentialForTeam` is re-exported from the package root.

**2. Joined-team cloud now boots with the team's shared tables already populated.**

Even with the dropdown integration above, clicking the new entry opened to:

> _No entities yet. Define entities in your lattice.config.yml or register them via db.define(), then reload._

…because the sibling YAML carried `entities: {}` and the GUI's `/api/entities` endpoint read tables exclusively from `parseConfigFile(configPath).tables`. The cloud Postgres already had the team's shared tables (rows in `__lattice_shared_objects`), but nothing replayed them into the local Lattice's runtime schema or surfaced them to the SPA.

Two more pieces wire that together:

- **`openConfig` auto-discovers shared schemas on every boot.** After `attachWriteHooks`, the GUI server enumerates every row in `__lattice_team_connections` and calls `client.syncSharedSchemas(connection)`. That fetches each team's `__lattice_shared_objects` rows and `defineLate`s them into the local Lattice. The work is idempotent — re-opening the GUI just re-applies the same specs. Per-team failures are logged but isolated; a single unreachable cloud doesn't block GUI boot.
- **`/api/entities` merges runtime-registered tables with YAML-declared ones.** `entitiesWithCounts` (in `src/gui/server.ts`) now augments the YAML table list with everything the Lattice schema manager knows about that the YAML doesn't — minus the internal `__lattice_*` / `_lattice_*` bookkeeping tables. Tables auto-synced from a team's cloud show up in the dropdown immediately on the next reload.

The fix is purely additive — projects without any team connections behave exactly as before.

**End-to-end UX after this release:** user clicks "Join via invite," enters credentials, clicks Join. The team's cloud DB appears in the database dropdown as `<team-name>.config`. Clicking it opens the SPA with the team's shared tables in the Objects sidebar, ready to query. Zero YAML editing, zero manual schema registration.

---

## [1.13.6] - 2026-05-27

### Fixed — Team operations 400 against `postgres://` cloud URLs (share, list, link, me)

`v1.13.4` added direct-Postgres dispatchers to `listMembers`, `invite`, `kickMember`, `destroyTeam`, and `fetchChangeBatch`, but the same fix didn't propagate to the rest of the cloud-touching `TeamsClient` methods. Every one of them still routed through `fetchAuthed(cloudUrl + path)` — and the Fetch API hard-refuses URLs with embedded credentials. So the GUI's "Share a table" button, the row-link / row-unlink flows, the per-session sync loop, and the `me` identity probe all 400-ed before they left the browser when the operator's cloud connection was a saved Postgres URL (the dominant case after Migrate-to-cloud or Connect-to-existing-cloud).

`TeamsClient` methods that now dispatch on URL scheme — HTTP for `http(s)://`, direct-Postgres for `postgres(ql)://`:

- `shareObject` — calls `shareObjectDirect` (parameterized INSERT/UPSERT on `__lattice_shared_objects` + `applySchemaSpec` + `__lattice_change_log` envelope). Caller must pass `inviterUserId` for the direct path so the row stamps `created_by_user_id` correctly.
- `unshareObject` — calls `unshareObjectDirect` (soft-deletes the row, appends an `unshare` envelope).
- `listSharedObjects` — calls `listSharedObjectsDirect` (parameterized query, JSON-parses each row's `schema_spec_json`).
- `me` — calls `meDirect` (looks up the user by `__lattice_api_tokens.token_hash` matching the bearer; throws `Unauthorized` if the row is missing or the user is soft-deleted).
- `linkRow` — calls `linkRowDirect` (writes the `__lattice_row_links` row + appends a `link` envelope on the cloud DB, then upserts the local mirror in `__lattice_local_links`).
- `unlinkRow` — calls `unlinkRowDirect` (deletes the cloud row + appends an `unlink` envelope, then cleans up the local mirror).
- `drainOutbox` — short-circuits to `{pushed: 0, failed: 0}`. In direct-Postgres mode the operator's local Lattice IS the cloud Lattice; writes already landed in the same DB the cloud reads. There is no separate cloud to push to.
- `pullChanges` — short-circuits to `{applied: 0, last_seq: 0, dlq_count: 0}` for the same reason. `fetchChangeBatch` already had this short-circuit (added in v1.13.4), but `pullChanges` had its own loop that would have 400-ed against the credentialed URL.

New direct-Postgres helpers in `src/teams/direct-ops.ts`: `shareObjectDirect`, `unshareObjectDirect`, `listSharedObjectsDirect`, `meDirect`, `linkRowDirect`, `unlinkRowDirect`, plus a `getStatusDirect` for symmetry (the existing `getStatus` already worked because it only touches the local DB). All use parameterized writes through the `Lattice` insert/upsert/query/delete API — no template-string SQL.

### Fixed — GUI Share dialog now passes `my_user_id` so the direct-Postgres path can stamp the row

`POST /api/teams-gui/teams/:id/shared` (the GUI's "Share a table" endpoint) now passes `conn.my_user_id` to `TeamsClient.shareObject`. The HTTP path ignores the new arg; the direct-Postgres path requires it because there's no bearer-resolved user identity in the direct flow.

### Added (infrastructure only — full UX in 1.13.7) — `saveDbCredentialForTeam` + sibling YAML write on join

This release also lays the groundwork for the joined-team dropdown integration (`saveDbCredentialForTeam` in `src/framework/user-config.ts` + a sibling YAML write in `src/gui/teams-routes.ts` `handleJoin`), but the feature only becomes user-visible once 1.13.7 also auto-discovers the team's shared schemas on `openConfig`. See the 1.13.7 entry for the full description.

## [1.13.5] - 2026-05-26

### Fixed — `redeemInvite` fails with HTTP 404 against Postgres cloud URLs

The "Join via invite" flow (and `connectToExistingCloud` with an invite token) called `fetch(cloudUrl + '/api/auth/redeem-invite')` against the form's cloud URL. When that URL is a Postgres connection string (which is what the GUI's Migrate / Connect wizards save as the cloud URL), the Fetch API either refuses (URL with credentials) or returns 404 (no HTTP server at a pooler endpoint). Joining a team from a new local lattice was effectively broken.

Fix: new `redeemInviteDirect(cloudUrl, inviteToken, email, name)` in `src/teams/direct-ops.ts` runs the same INSERT sequence as the server's `handleRedeemInvite` directly against the cloud Postgres — same invariants (token hash match, email binding, expiry, un-redeemed-yet check). `TeamsClient.redeemInvite` dispatches on URL scheme: `http(s)://` keeps the HTTP path; `postgres(ql)://` uses the direct path.

`connectToExistingCloud` with an invite token now works against Postgres cloud URLs (the whole reason it didn't before).

### Changed — Cloud URL placeholders in Create-team / Join-team modals

Both modals' Cloud URL inputs previously placeholdered `http://localhost:4317` — implying users should enter an HTTP URL, even though the realistic case is a Postgres pooler URL the GUI's Migrate/Connect wizards saved earlier. Updated to `postgres://postgres.<ref>:password@aws-x-region.pooler.supabase.com:5432/postgres` so it's obvious which form to use. `autocapitalize="off"` + `autocorrect="off"` + `spellcheck="false"` added so case-sensitive tenant prefixes don't get auto-capitalized (mirrors the v1.13.2 form-input hardening).

## [1.13.4] - 2026-05-26

### Changed — GUI team card drops the "Sync now" button + outbox/DLQ stats

Lattice is realtime against whatever its `db:` line points at. When that's a direct Postgres URL, every read and every write the GUI does already hits the canonical store. When it's local SQLite, the same is true. There is nothing the user needs to "sync" — operations either succeed live, or they fail gracefully when the connection is down. The HTTP-mode outbox / change-log / dead-letter machinery is still available via `lattice teams sync` on the CLI for HTTP-team operators who genuinely have a local-vs-remote split, but the GUI no longer surfaces it as a user-facing action.

Removed from team cards: the "Sync now" button, and the Last seq / Outbox / DLQ / Local links stat tiles. The card now shows the team name + role pill + redacted cloud URL + members + actions (Invite, Destroy, Leave). Cleaner, accurate.

### Fixed — Team operations failed against direct-Postgres cloud URLs

`TeamsClient` methods for team operations (`listMembers`, `invite`, `kickMember`, `destroyTeam`, `fetchChangeBatch`) all routed through `fetchAuthed(cloudUrl + path)`. When `cloudUrl` is `postgres://user:password@host/db` (Migrate-to-cloud / Connect-to-existing wizards save the Postgres URL directly — no HTTP `lattice serve --team-cloud` server in front), the Fetch API hard-refuses with `Request cannot be constructed from a URL that includes credentials`. So `upgradeToTeamCloud` shipped a usable team to the cloud, but every subsequent action (Invite, Members, Destroy, Sync) failed silently.

Architectural shift: for direct-Postgres cloud URLs, the operator's local Lattice IS the cloud Lattice (the project's `db:` line points at the same Postgres URL the team-internal tables live in). Every operation that the HTTP path POSTs to the cloud server is now also available as a direct query/mutation against `this.local`.

New module `src/teams/direct-ops.ts`:

- `listMembersDirect(db, teamId)` — joins `__lattice_team_members` with `__lattice_users`, returns the same `MemberSummary[]` shape as the HTTP path.
- `inviteDirect(db, teamId, inviterUserId, inviteeEmail, expiresInHours?)` — generates a `latinv_…` token, SHA-256-hashes it into `__lattice_invitations`. Default 7-day expiry.
- `kickMemberDirect(db, teamId, userId)` — deletes the membership row.
- `destroyTeamDirect(db)` — clears the singleton identity row + all members + soft-deletes the `__lattice_team` row.

`TeamsClient.{listMembers, invite, kickMember, destroyTeam}` dispatch on `isPostgresUrl(cloudUrl)` — HTTP path for HTTP clouds, `direct-ops` for Postgres URLs. The `fetchChangeBatch` sync path returns an empty batch immediately for direct-Postgres clouds (local IS cloud, nothing to pull).

The GUI's invite route now passes `connection.my_user_id` as the inviter so the direct path can stamp `__lattice_invitations.invited_by_user_id` correctly. HTTP path ignores it (server resolves the inviter from the bearer).

### Fixed — Plaintext password in the team card's cloud-URL display

The team cards under Project Config → Teams rendered `escapeHtml(conn.cloud_url)` directly. When `cloud_url` is a `postgres://user:PASSWORD@host/db` URL, the password ended up rendered verbatim in the DOM and visible to anyone with screen access. Every cloud-URL render path now goes through a new `redactUrlCredentials(url)` helper that swaps the password portion for `••••••••` while keeping the username (often useful — e.g. Supabase tenant-prefixed users) and host visible.

### Fixed — Team role pill says "UNKNOWN" for the team creator they just registered

When the cloud's `listMembers` request failed (network blip, timing, etc.) or returned a list that didn't contain the user's `my_user_id`, the role pill collapsed to a bare `"unknown"`. Surfaced as "UNKNOWN" on a team the user had just created themselves — confusing because they're obviously the creator.

The role label now splits into three states: the actual role when it resolves, `"(cloud unreachable)"` when the members request fails (network), `"(not in member list)"` when the response is good but doesn't include the local user_id (kicked / stale `my_user_id`). The bare `"unknown"` fallback is gone.

### Fixed — `upgradeToTeamCloud` + `connectToExistingCloud` skipped the local connection row

The v1.13 high-level orchestration registers (or redeems an invite on) the cloud and writes the bearer token to `~/.lattice/keys/<label>.token`, but skipped the matching `saveConnection()` call. So the local `__lattice_team_connections` row was empty after upgrade-to-team or connect-existing — and every subsequent GUI team API call (members, invites, kick, destroy) couldn't find the `cloud_url` + `my_user_id` + `api_token_encrypted` triple it needed to authenticate.

The older `handleRegisterAndCreate` / `handleRedeemInviteAndJoin` routes always wrote the connection row; the v1.13 `TeamsClient.upgradeToTeamCloud` + `TeamsClient.connectToExistingCloud` paths now do the same.

Regression test in `tests/integration/teams-gui.test.ts` asserts the connection row appears after register-and-create.

### Fixed — `/api/system-tables` empty on Postgres-backed Lattices

The GUI's System sidebar (Objects → System) used to list every `_lattice_*` / `__lattice_*` internal table, with their column names + row counts. On Postgres-backed Lattices it silently rendered an empty list because the endpoint ran two SQLite-only queries:

- `SELECT name FROM sqlite_master ...` — table doesn't exist in Postgres.
- `PRAGMA table_info("<name>")` — Postgres has no `PRAGMA` statement.

Both threw and the catch-all silently produced an empty `tables: []`. Migrated cloud projects + team-cloud DBs saw no system tables at all even though they were correctly created during `db.init()`.

Fix: dispatch on `adapter.dialect` for the listing query (`pg_tables WHERE schemaname='public'` on Postgres; `sqlite_master` on SQLite — same `\_%` ESCAPE pattern either way), and replace `PRAGMA table_info` with the public, dialect-portable `Lattice.introspectColumns(table)` which already dispatches internally to `information_schema.columns` on Postgres.

New regression test in `tests/integration/gui-init-postgres.test.ts` opens the GUI server against a Postgres URL, hits `/api/system-tables`, and asserts all four expected system tables (`_lattice_gui_meta`, `_lattice_gui_column_meta`, `_lattice_gui_audit`, `__lattice_user_identity`) appear with their columns enumerated. Runs whenever `LATTICE_TEST_PG_URL` is set (always in CI's Postgres service container).

## [1.13.3] - 2026-05-26

### Fixed — `__lattice_user_identity` init crashes on every Postgres open

`__lattice_user_identity` declared `display_name` + `email` with `DEFAULT ""`. SQLite leniently accepts double-quoted `""` as an empty-string literal, but PostgreSQL treats `""` as a zero-length **delimited identifier** (i.e. an empty column name) and throws at `CREATE TABLE` time:

```
zero-length delimited identifier at or near """""
```

This crashed every cloud-DB open via `lattice gui` (and every Postgres-targeted Migrate / Connect / Switch through the GUI), even with correct credentials. The standard-conformant form is `DEFAULT ''` (single quotes for string literals; double quotes only for identifiers). Both columns are now defined with single quotes so the CREATE TABLE works on both engines.

New regression test in `tests/integration/gui-init-postgres.test.ts` opens the GUI server against a Postgres URL and asserts `/api/entities` serves cleanly — runs whenever `LATTICE_TEST_PG_URL` is set (always in CI's Postgres service container).

### Fixed — Upgrade to team cloud fails when cloud URL is a direct Postgres URL

`TeamsClient.upgradeToTeamCloud` (and `register`) called `fetch(url + path)` against the cloud URL. When the URL is `postgres://user:password@host:5432/db` (which is what the GUI's "Migrate to cloud" / "Connect to existing cloud" wizards save as the cloud credential), browsers refuse the request with `Request cannot be constructed from a URL that includes credentials` — a hard Fetch API restriction. The team-cloud HTTP register flow only works when the cloud is fronted by a `lattice serve --team-cloud` HTTP server; for direct-Postgres clouds there was no fallback.

Fix: new `registerDirectViaPostgres(cloudUrl, email, name, teamName)` runs the same INSERT sequence against the cloud Postgres directly. `TeamsClient.upgradeToTeamCloud` dispatches on URL scheme: `http(s)://` keeps the HTTP path; `postgres(ql)://` uses the direct path. Same invariants enforced both ways (refuses if any user already exists; refuses if the singleton team identity already exists).

New public exports from `latticesql`:

- `registerDirectViaPostgres(cloudUrl, email, name, teamName)`
- `isPostgresUrl(url)`
- `type DirectRegisterResult`

### Fixed — GUI dashboard renders empty for any non-hardcoded schema

`renderDashboard` filtered cards through a hardcoded `DASHBOARD_ORDER = ['meetings', 'people', 'messages', 'projects', 'repositories', 'files']`. Installs whose YAML declared different entity names (e.g. `clients`, `students`, `vendors`, `contracts`) saw a blank dashboard with no error or hint why — even though `/api/entities` returned the tables correctly.

Fix: render a card for every first-class entity (non-junction, non-system-table). `DASHBOARD_ORDER` is now a preference for ordering — entries in the list sort first; everything else follows in declaration order. New empty-state placeholder when no first-class entities exist at all.

### Improved — DB switch failures now surface the real error

`POST /api/databases/switch` previously relied on the top-level request handler's catch-all to surface errors as `500 <message>`. The SPA's toast then read just the status code. Common failure mode: switching back to a cloud DB whose saved credential was rotated or whose Postgres became unreachable showed an opaque 500 with no clue.

Fix: dedicated try/catch around `openConfig` in the switch handler logs the full error to the server's stderr (with code + stack) and returns a structured `Failed to switch to <path>: [SQLSTATE] <message>` JSON to the client, so the toast names the real cause.

### Improved — Validate-on-save in Migrate; Supabase URL pattern hints

The pre-v1.13.3 Migrate flow saved a credential first and probed only later — so an incorrect host / port / user (typical for Supabase: missing tenant prefix in the user, transaction-mode port 6543, wrong direct vs pooler host) got persisted as the active cloud credential and only blew up on the next open. Migrate now routes through the same `probeBeforeCredentialSave` helper Connect-Existing uses: the probe runs first; only on a clean probe does the actual migration kick off.

The same helper detects common Supabase patterns and surfaces inline warnings before the network probe:

- **Pooler host with bare `postgres` user.** Supabase pooler hosts (`*.pooler.supabase.com`) require the tenant-prefixed `postgres.<project-ref>` form. Without it, SCRAM auth fails silently with "password authentication failed for user 'postgres'".
- **Pooler with port 6543.** That's transaction mode; latticesql needs session mode on port 5432.
- **Direct host with tenant-prefixed user.** Direct hosts (`db.<project-ref>.supabase.co`) use a bare `postgres` user. Mixing the two forms produces the same SCRAM mismatch.

These checks fire on the client before any network call, so the form names the issue with a fix immediately instead of after a 30s timeout.

## [1.13.2] - 2026-05-26

### Fixed — GUI Postgres form: silent authentication failures from autocapitalize + paste whitespace

Several real-world failure modes the v1.13 Database wizard didn't defend against, all surfacing as opaque "password authentication failed" or "zero-length delimiter identifier" errors:

- **Autocapitalize on User / Host / Database / Label inputs.** macOS Safari and iOS default to `autocapitalize="sentences"` on plain `<input type="text">`. Pasting a Supabase tenant user like `postgres.<project-ref>` ended up as `Postgres.&lt;project-ref&gt;` on submit — Postgres roles are case-sensitive, so SCRAM auth failed silently with no hint about the case mismatch. Every text input in `postgresFormHtml` now sets `autocapitalize="off"`, `autocorrect="off"`, `spellcheck="false"`.
- **No `.trim()` on User or Password reads.** Clipboard pastes (especially from password managers and chat clients) frequently carry a trailing newline. The trailing newline ended up in the URL's password segment after `encodeURIComponent`, which the Postgres adapter then sent through SCRAM verbatim — failing with "password authentication failed" — or, for the host field, broke URL parsing into the "zero-length delimiter identifier" Postgres parse error. `readPostgresWizardForm` now trims every text field.

### Changed — "Connect to existing cloud" copy: switch, not discard

The Connect-Existing modal previously read "Your local SQLite data will be ignored — use Migrate to cloud instead if you want to push it." That wording mis-described the actual behavior: the local SQLite file is **preserved on disk** (the `db:` line in `lattice.config.yml` is rewritten to `${LATTICE_DB:<label>}`, the file itself is untouched). New copy reframes this accurately: "Switch this project to an existing cloud Postgres. Your local SQLite file is preserved — only this project's active connection changes. Switch back any time by editing `lattice.config.yml`'s `db:` line or via the Databases catalog under User Config."

Mental model going forward: one Lattice user manages multiple databases, some local + some cloud. Project Config's "Switch" creates a one-line YAML change you can reverse; the Databases catalog under User Config lets you jump between projects without editing YAML.

### Changed — `probeCloud` surfaces SQLSTATE + routine in `result.error`

When the underlying driver throws a structured error (Postgres `pg` errors carry `.code` SQLSTATE + `.routine`), `probeCloud` now folds those into `result.error` so the GUI's "Unreachable: …" message includes actionable detail. Example: `[28P01] password authentication failed for user "Postgres"` instead of just `password authentication failed for user "Postgres"`.

## [1.13.1] - 2026-05-26

### Fixed — GUI layout + table-cell overflow

- Replaced `grid-template-columns: 220px 1fr` with `220px minmax(0, 1fr)` on the main layout so wide table content no longer forces the whole page wider than the viewport. The previous `1fr`'s implicit `auto` minimum let chip-heavy cells push the layout past `100vw`, producing a horizontal page scrollbar.
- Object-table cells now truncate to 3 lines via a `.cell-clip` wrapper (`-webkit-line-clamp: 3`). Junction columns with many chips and intrinsic columns with long text blobs render at a consistent row height instead of growing into multi-line paragraphs.

### Fixed — GUI row-context discovery for programmatic entity contexts

The Database panel previously read entity contexts only from `lattice.config.yml` via the parser's `parsed.entityContexts`. Projects that register entity contexts programmatically (in a JS / TS schema module run by their own `lattice render` script — e.g. `lattice.schema.mjs`) never saw their rendered files: every row opened the "no rendered context — define an entityContext" placeholder, even when the on-disk files existed.

The convergence happens in two places now:

1. **`Lattice.entityContexts()`** (new public accessor) returns the full registered map — YAML entries + anything added later via `defineEntityContext()`. The GUI server consumes this instead of the parser's `entityContexts` field, so programmatic registrations on the live Lattice show up automatically.
2. **Manifest fallback.** When a table has no schema-registered entity context but the on-disk render manifest (`.lattice/manifest.json`) names it, the GUI derives a row → slug mapping heuristically from `row.slug` / `row.id` / `row.name` and surfaces the rendered files. This covers the "programmatic registration in an mjs file the GUI process never imports" case without requiring users to duplicate context definitions in YAML.

### Fixed — GUI output-directory discovery

`lattice gui` previously defaulted `--output` to `./context` unconditionally. Projects whose `lattice render` writes into the project root (`.`) or `./generated` would launch the GUI against an empty directory and see "no rendered context." When `--output` is not explicitly passed, the CLI now probes `./context`, `.`, and `./generated` in order and uses the first one containing a `.lattice/manifest.json` (announced via a one-line stdout log). Explicit `--output` is always honoured.

### Added — `Lattice.entityContexts()`

```ts
const db = new Lattice({ config: './lattice.config.yml' });
db.defineEntityContext('agents', {
  /* ... */
});
await db.init();
console.log(db.entityContexts()); // Map<string, EntityContextDefinition>
```

Returns a defensive copy — mutations to the returned map don't affect the schema.

## [1.13.0] - 2026-05-26

### Added — Local → Cloud → Team-Cloud progression

A one-way state machine for the GUI's Database panel, with matching public API on the npm package. Every new GUI action is a thin wrapper over an exported function:

- **`migrateLatticeData(source, target, options?)`** — copy every user-defined entity + native `secrets` / `files` row from one Lattice to another. Refuses non-empty targets. Encrypted columns round-trip through decrypt-on-read + encrypt-on-write so the operator's master key stays on the machine.
- **`openTargetLatticeForMigration(configPath, targetUrl, encryptionKey)`** — open a fresh target Lattice with the same user schema + native entities as the source's YAML config. Caller closes when done.
- **`archiveLocalSqlite(dbPath)`** — rename `<path>.db` (+ `-shm` / `-wal`) to `.db.local-bak`. Idempotent.
- **`probeCloud(targetUrl)`** — non-destructive `{reachable, dialect, teamEnabled, teamName?}` against any Lattice URL. Never throws.
- **`TeamsClient.connectToExistingCloud(opts)`** — wraps probe + (optional) `redeem-invite` + credential save + token-file write.
- **`TeamsClient.upgradeToTeamCloud(opts)`** — wraps atomic `register` + token-file write for the active cloud's label.

All exported from `latticesql` package index.

### Added — Cloud connection probe + connect-existing

GUI routes (thin wrappers):

- `POST /api/dbconfig/probe` — `probeCloud` wrapper.
- `POST /api/dbconfig/migrate-to-cloud` — migrate + archive + swap.
- `POST /api/dbconfig/connect-existing` — connect-existing + optional redeem-invite + swap.
- `POST /api/dbconfig/upgrade-to-team` — atomic register on the active cloud's label.

`GET /api/dbconfig` gains a `state` field — one of `local`, `cloud-connected`, `team-cloud-creator`, `team-cloud-member`, `team-cloud-needs-invite`.

### Changed — Project Config Database panel rewritten state-machine style

- Panel renders state-specific bodies + a color-coded badge (lime accent for connected, warn orange for needs-invite).
- Three new wizards: `showMigrateToCloudModal`, `showConnectExistingModal`, `showUpgradeToTeamModal`.
- "Create team" modal removed — replaced by the narrower "Upgrade to team cloud" wizard that's only available when state is `cloud-connected`.
- Old SQLite-only `POST /api/dbconfig/save` path preserved for local-state file-path edits; the Postgres save path is now `migrate-to-cloud` or `connect-existing`.

### Changed — User Config Databases catalog

- New `State` column per row (local SQLite rows report `LOCAL`; cloud labels report `UNKNOWN` until probed).
- New `Add a cloud DB →` button — creates a fresh project via the existing `/api/databases/create` then opens the Connect-to-existing wizard against it.

### Fixed — Form input + placeholder contrast

Step 7's dark-theme restyle didn't override the OS-default input/placeholder colors. Two global CSS rules now set:

- `input, select, textarea { color: var(--text); }`
- `input::placeholder, textarea::placeholder { color: var(--text-muted); opacity: 1; }`

Affects every form across the GUI: Data Model editor, Database wizard, User Config Identity, all team modals.

## [1.12.0] - 2026-05-25

### Added — Lattice Teams (Phase 5 + OSS-only redesign)

This release lands the full Lattice Teams feature (multi-user shared cloud Lattice databases) on top of v1.11's `lattice gui`. Highlights:

- **Atomic team bootstrap.** `lattice teams register --cloud <url> --email <e> --name <display> --team-name <team>` creates the user, the team, the creator membership, and the bearer token in one HTTP call.
- **Email-bound invitations.** `lattice teams invite --team <team> --invitee-email <e>` mints a `latinv_` token tied to the recipient's email; redemption with a different email is rejected `403`.
- **Native `secrets` + `files` entities** with at-rest encryption on `secrets.value`. Available to any Lattice via `registerNativeEntities()`; auto-registered by `lattice gui`.
- **Machine-local user config at `~/.lattice/`** — `identity.json`, encrypted `db-credentials.enc`, per-team `keys/<label>.token`, and an auto-generated `master.key`.
- **GUI restyle** matching the latticesql.com design tokens (dark theme, lime accent, Inter + JetBrains Mono).

Full architecture, schema, and HTTP surface: see [docs/teams.md](docs/teams.md).

### Added — OSS-only redesign on top of Phase 5 (feat/teams)

A follow-on PR layered on the five-phase Lattice Teams branch. Adds machine-local user config, a Database panel in Project Config, native `secrets`/`files` entities with at-rest encryption on plain `define()` tables, email-bound invitations + a singleton team-identity facade, and a GUI restyle that pulls design tokens directly from latticesql.com.

**Native `secrets` and `files` entities.** Every Lattice opened via the GUI server now has framework-shipped `secrets` and `files` tables registered before `init()`. `secrets.value` is encrypted at rest using a new `TableDefinition.encrypted?: boolean | { columns: string[] }` field (same shape as `EntityContextDefinition.encrypted`). The encryption resolver in `src/lattice.ts` walks both entity contexts and registered tables; `defineLate()` also wires encryption for late-registered tables with the `encrypted` flag.

- `src/framework/native-entities.ts` — `NATIVE_ENTITY_DEFS` + `registerNativeEntities(db)`. `secrets` columns: `id, name, kind, value (encrypted), description, created_at, updated_at, deleted_at`. `files` columns: a superset of the legacy `path`/`kind` shape plus content-addressed `sha256` / `blob_path` / `original_name` / `mime` / `size_bytes` / `extraction_status` / `extracted_text` / `description`.
- `src/framework/blob-store.ts` — `attachBlob(srcPath, latticeRoot)` writes a file into `<root>/data/blobs/<sha256>` (idempotent) and returns metadata suitable for a `files` row.

**Machine-local user config at `~/.lattice/`.** Files, not a Lattice DB.

- `master.key` — AES-256 master key, auto-generated chmod 0600 on first use. `LATTICE_ENCRYPTION_KEY` env var takes precedence.
- `identity.json` — `{display_name, email}`. Loaded into the active Lattice as `__lattice_user_identity` (singleton row, id='singleton') on every open.
- `db-credentials.enc` — AES-GCM-encrypted Postgres URLs by label.
- `keys/<label>.token` — per-team bearer tokens.
- `src/framework/user-config.ts` exports `getOrCreateMasterKey`, `readIdentity`/`writeIdentity`, `listDbCredentials`/`saveDbCredential`/`getDbCredential`/`deleteDbCredential`, `listTokens`/`readToken`/`writeToken`/`deleteToken`.

**`/api/userconfig/*` GUI endpoints.** Identity get/post (mirrors identity.json into the active Lattice on save) and a catalog of databases (sibling YAML configs + saved Postgres labels).

**Database panel in Project Config.** New `/api/dbconfig/*` endpoints:

- `GET /api/dbconfig` — current shape (sqlite/postgres + redacted params + `teamEnabled` flag from `__lattice_team_identity`).
- `POST /api/dbconfig/save` — Postgres saves to `db-credentials.enc` and rewrites the active YAML's `db:` to `${LATTICE_DB:<label>}`; SQLite rewrites the path in place using yaml round-tripping.
- `POST /api/dbconfig/connect` — re-opens the active config path so the YAML rewrite takes effect.
- `POST /api/dbconfig/test` — instantiates a probe `Lattice(url)` + `init()`; returns `{ ok: false, error }` on failure.
- `GET /api/dbconfig/labels` — saved Postgres labels.

YAML resolver in `src/config/parser.ts` honours `${LATTICE_DB:<label>}` (looks up via `getDbCredential`, throws on missing), `postgres://...` / `file:` / `:memory:` (passthrough), and the existing relative-path resolve for everything else.

**Email-bound invitations + singleton team identity.**

- `__lattice_users.email` becomes `NOT NULL`. Uniqueness still enforced at the route layer.
- `__lattice_invitations.invitee_email TEXT NOT NULL` — `redeem-invite` verifies the caller's claimed email matches the bound invitee (case-insensitive) and returns `403` on mismatch.
- New `__lattice_team_identity` singleton table (`id='singleton', team_id, team_name, creator_email, created_at`). Populated atomically by `POST /api/auth/register`.
- `POST /api/auth/register` is now an **atomic** bootstrap: body requires `{email, name, team_name}` and the handler creates the user, team, identity row, creator membership, and bearer token in one call. There is no longer a separate `createTeam` step.
- New singleton routes:
  - `GET /api/team` — identity + member list, or `{enabled: false}`.
  - `DELETE /api/team` — creator-only; drops the identity row + soft-deletes the underlying `__lattice_team` row.
  - `POST /api/team/invitations` — convenience alias for `/api/teams/:id/invitations` that resolves the id from the singleton.
- `TeamsClient.invite()` gains a required `inviteeEmail` argument; `InviteResponse` echoes the email back. CLI `lattice teams invite` adopts `--invitee-email`.
- The teams-gui invite endpoint (`POST /api/teams-gui/teams/:id/invitations`) requires `invitee_email` in the request body.

**Multi-team enumeration removed.** One cloud = one team. The following surface is gone:

| Removed                                                       | Replacement                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------- |
| `POST /api/teams` (create)                                    | `POST /api/auth/register` (atomic with bootstrap user)               |
| `GET /api/teams` (list)                                       | `GET /api/team` (singleton)                                          |
| `DELETE /api/teams/:id`                                       | `DELETE /api/team`                                                   |
| `TeamsClient.createTeam()` / `.listTeams()` / `.deleteTeam()` | `register()` (atomic) / `getSingleton()` (via GET) / `destroyTeam()` |
| `lattice teams create` (CLI)                                  | `lattice teams register --team-name <name>`                          |
| CLI `--name` overloaded as team name                          | `--name` = display name; new `--team-name` = team name               |

`TeamsClient.register()` now requires a `teamName` argument and returns `{ user, raw_token, team }`. Existing `/api/teams/:id/{objects,changes,members,invitations,rows,links}` routes (the load-bearing sync engine) are unchanged — the `:id` segment continues to identify the (one) team's UUID.

**GUI: identity + databases panels, email-driven invite modal.**

- User Config view now hosts an **Identity** panel (display_name + email, persisted via `/api/userconfig/identity`) and a **Databases** panel (local + cloud table from `/api/userconfig/databases` with switch-to action), with the existing "Cloud accounts" team-connection list moved below.
- Create-team and join-team modals prefill display name + email from `identity.json` so operators only type the per-team bits.
- The per-team-card "Invite" button now opens an email modal (`showInviteByEmailModal`) that threads `invitee_email` through.

**GUI restyle in latticesql.com design tokens.**

- `:root` lifts colors, spacing accents, and font families directly from `lattice-website`'s `tailwind.config.ts` (last-sync comment in the inline `<style>` block flags manual sync).
- Dark theme (`--bg: #0b0d10`, `--surface: #13171b`, `--accent: #bef264` lime, `--warn: #fb923c`, `--signal: #22d3ee`). Inter for body, JetBrains Mono for code.
- Primary buttons swap white-on-blue for dark text on lime with `--accent-glow` on hover.

### Added — Lattice Teams (Phase 5: GUI integration)

Fifth and final slice of **Lattice Teams**: the user-facing dev GUI (`lattice gui`) now drives the full Lattice Teams lifecycle. No new top-level sidebar — everything plugs into PR #10's existing **Project Config** and **User Config** settings views, which were placeholder "Coming soon" screens before this PR.

**`/api/teams-gui/*` endpoints (`src/gui/teams-routes.ts`).** A thin, unauthenticated dev-tool API that wraps the user's local `TeamsClient`. Available only in local GUI mode (`teamCloud=false`) — team-cloud mode disables this dispatcher, matching the existing database-switcher gating.

| Method | Route                                            | Wraps                                                                 |
| ------ | ------------------------------------------------ | --------------------------------------------------------------------- |
| GET    | `/api/teams-gui/connections`                     | `TeamsClient.listConnections()`                                       |
| POST   | `/api/teams-gui/connections/register-and-create` | bootstrap-register + createTeam + saveConnection                      |
| POST   | `/api/teams-gui/connections/join`                | `redeemInvite()` + `saveConnection()`                                 |
| DELETE | `/api/teams-gui/connections/:teamId`             | self-kick + `deleteConnection()` (creator → 400)                      |
| POST   | `/api/teams-gui/teams/:id/sync`                  | `pullChanges()` + `drainOutbox()` + refreshes the GUI's `validTables` |
| GET    | `/api/teams-gui/teams/:id/status`                | `TeamsClient.getStatus()`                                             |
| GET    | `/api/teams-gui/teams/:id/members`               | `listMembers()`                                                       |
| POST   | `/api/teams-gui/teams/:id/invitations`           | `invite()`                                                            |
| DELETE | `/api/teams-gui/teams/:id/members/:userId`       | `kickMember()`                                                        |
| DELETE | `/api/teams-gui/teams/:id`                       | `deleteTeam()` + `deleteConnection()`                                 |
| GET    | `/api/teams-gui/teams/:id/shared`                | `listSharedObjects()`                                                 |
| POST   | `/api/teams-gui/teams/:id/shared`                | serialises local schema + `shareObject()`                             |
| DELETE | `/api/teams-gui/teams/:id/shared/:table`         | `unshareObject()`                                                     |
| POST   | `/api/teams-gui/teams/:id/links`                 | `linkRow()`                                                           |
| DELETE | `/api/teams-gui/teams/:id/links/:table/:pk`      | `unlinkRow()`                                                         |
| GET    | `/api/teams-gui/links`                           | raw `__lattice_local_links` query                                     |

Upstream `TeamsHttpError`s surface as JSON with their original status code so the SPA can branch on auth/permission failures.

**Cached `TeamsClient` per active DB.** The GUI's `ActiveDb` now holds a `TeamsClient` instance, with `attachWriteHooks()` called on every `openConfig()` so any pre-existing local links resume tracking writes. The cached client is what the SPA's CRUD endpoints write through — a row update via the GUI dashboard fires the same outbox-capture hook as a CLI write.

**`validTables` refresh after sync.** Tables registered at runtime via `defineLate` (from a schema envelope) didn't make it into the GUI's `validTables` set, so the SPA's table viewer 400'd on freshly-synced shared tables. The sync handler now refreshes `validTables` from `lattice.getRegisteredTableNames()` after every pull.

**SPA — Project Config view.** Lists every joined team as a card with role pill, four-stat status grid (last_change_seq, outbox depth, DLQ depth, local links), and inline actions:

- **Sync now** — runs `/teams-gui/teams/:id/sync`, re-renders the card with fresh stats.
- **Generate invite token** (creator only) — opens a modal with the `latinv_`-prefixed token, click-to-copy.
- **Leave / Destroy team** — destroys for creators, leaves for members; both clean up the local connection row.
- **Shared tables** sub-section — list with per-row Unshare button; "Share another table" modal lets the user pick from currently-registered local tables.
- **Members** sub-section (creator-only) — per-member Kick button.
- **Create team** — register-and-create flow on a fresh cloud in one modal.
- **Join via invite** — paste cloud URL + invite token + email + name; redeem + save in one call.

**SPA — User Config view.** Cloud-account list (cloud URL + my user_id + joined_at) with per-cloud Sign out. Same "Add cloud" flow as Project Config's Join. Documents the v1 limitation that each team membership keeps its own bearer token.

**Per-row Link affordance (DEFERRED).** The `POST /api/teams-gui/teams/:id/links` + `DELETE /api/teams-gui/teams/:id/links/:table/:pk` endpoints ship in this PR, and the integration test exercises them end-to-end. The SPA button on the existing table-view row menu is a follow-up — adding it requires fetching link state on every row render, which interacts with the GUI agent's parallel work on the table view. The functionality is fully available via the CLI (`lattice teams link/unlink`) in the meantime.

**New `Lattice.getRegisteredTableNames()`.** Returns the SchemaManager's currently-registered table list. Used by the sync handler to refresh `validTables` and is broadly useful for any consumer that wants to discover runtime-added tables.

### Added — Tests

- `tests/integration/teams-gui.test.ts` — 5 cases covering the full GUI-driven round-trip: register-and-create, share + invite + join + sync (schema propagates to receiver, row updates flow through outbox to receiver), shared-list + members-list + invite generation, leave-as-creator returns 400, team-cloud mode rejects `/api/teams-gui/*` (auth gate fires first).

### Added — Lattice Teams (Phase 4: row link/unlink + sync engine)

Fourth slice of **Lattice Teams**: row-level link/unlink, write-hook capture into a local outbox, polling pull with a replay guard, and auto-unlink on member kick. End-to-end propagation of row updates between two locals now runs through one cloud.

**Cloud endpoints (row layer).**

- `POST /api/teams/:id/objects/:table/links` — link a row: body `{pk, row_snapshot}`. Owner is taken from the bearer token, not trusted from the client. Emits `link` + `upsert` envelopes.
- `DELETE /api/teams/:id/objects/:table/links/:pk` — unlink. Owner or team creator only. Emits `unlink`.
- `POST /api/teams/:id/objects/:table/rows` — push an owner-update for a linked row. Body `{pk, payload}`. Cloud rejects non-owners (403). Emits `upsert`.
- `DELETE /api/teams/:id/objects/:table/rows/:pk` — owner-side delete. Equivalent to unlink for Phase 4 v1.
- `DELETE /api/teams/:id/members/:userId` — extended: now also auto-unlinks every row owned by the kicked user before the membership row is removed. Each torn-down link emits an `unlink` envelope so other members' pullers drop the row from their local mirrors. Self-kick (= "leave") triggers the same path.

**New cloud table.** `__lattice_row_links` — composite PK `(team_id, table_name, pk)`, `owner_user_id`, `linked_at`.

**New local tables.** `__lattice_local_links` (composite PK, mirrors the cloud's view of which rows are linked + by whom), `__lattice_team_outbox` (pending pushes with `attempts`, `last_error`, `next_attempt_at` for exponential-backoff retry), `__lattice_team_dlq` (envelopes that failed to apply locally; one bad row doesn't stall the stream).

**`WriteHook` API widening (small breaking change in an unreleased internal API).** `WriteHook.handler` now accepts `() => void | Promise<void>` and `Lattice._fireWriteHooks` awaits the return. Callers that need to persist side-effects (the teams outbox is the canonical case) can do so atomically with the user's `await db.insert/update/delete(...)` instead of racing the response. All six `_fireWriteHooks` callsites in `lattice.ts` are now awaited.

**`TeamsClient` sync engine.**

- `linkRow(connection, table, pk)` — reads the local row, POSTs the snapshot, records the link locally, ensures the write-hook is attached for `table`.
- `unlinkRow(connection, table, pk)` — DELETEs the cloud link + drops the local link row.
- `ensureWriteHook(table)` — idempotent per-table hook registration. The hook captures local writes to linked rows into `__lattice_team_outbox`, but only for rows the local user actually owns (non-owner writes are local-only divergence; cloud is authoritative).
- `attachWriteHooks()` — scans `__lattice_local_links` and re-registers hooks for every linked table at session start (hooks are bound to the in-memory Lattice, not the DB).
- `drainOutbox(connection)` — FIFO drain in `created_at` order. 2xx → delete the outbox row. Failure → bump `attempts`, set `next_attempt_at` to a future ISO timestamp (exponential backoff to 60s).
- `pullChanges(connection)` — loops the `/changes` endpoint internally until drained. Inside the apply loop, sets `_isReplaying = true` so the write-hook skips outbox insertion — otherwise pulled envelopes would re-push immediately. Individual envelope failures land in `__lattice_team_dlq` so one bad row doesn't stall the stream. Advances `__lattice_team_connections.last_change_seq` after every successful batch.
- `getStatus(connection)` — surfaces `last_change_seq`, outbox depth + failing count, DLQ depth, and local-link count for the team.
- The write-hook re-fetches the full row via `lattice.get()` before queueing — Lattice's update hook fires with the partial diff (no PK, no unchanged columns), so the snapshot pushed to the cloud needs to be re-materialised.

**Cloud-side schema materialisation.** `handleShareObject` (Phase 3) now also applies the schema spec to the cloud's own lattice (via the new shared `applySchemaSpec` helper extracted from `TeamsClient.applyCloudSchemaLocally`). Without this, the cloud's lattice had no table to upsert linked rows into. The applier lives in `src/teams/schema-spec.ts` so both client and server share the logic.

**Replay guard correctness.** A pull that materialises Alice's link envelope on Bob's local must NOT immediately push the upsert back to the cloud — that would cause an infinite ping-pong. `TeamsClient._isReplaying` (set during `pullChanges`'s apply block) is checked in `captureWrite` before any outbox insertion.

**Ownership enforcement.**

- Cloud-side: 403 on row pushes from non-owners (security boundary).
- Local-side: the write-hook checks `__lattice_local_links.owner_user_id === my_user_id_for_this_team` before queueing — non-owners' writes silently no-op (cloud will overwrite via next pull). Belt-and-suspenders.

**CLI additions.** `lattice teams {link, unlink, pull, push, status}`. Each command calls `attachWriteHooks()` at startup so prior links resume tracking writes.

### v1 design notes (documented)

- **Phase 4 has no background polling.** Pull and push are explicit (`lattice teams pull` / `lattice teams push`). A polling loop is a transparent layer over these methods and can land in Phase 5 (GUI) or 4.5 without API changes.
- **Cursor is single-writer.** The cloud's change-log seq generation uses `MAX(seq) + 1` under the single-Lattice-process invariant. Adding HA cloud replicas later would need a transaction-scoped advisory lock — already documented in routes.ts.
- **`onUnlink` is "delete the mirrored row"** — `keep` mode is a future per-team setting; Phase 4 hard-deletes on every unlink envelope (with a try/catch for already-missing rows).

### Added — Tests

- `tests/integration/teams-sync.test.ts` — 7 cases covering the full sync flow: link → propagate → drain outbox → receiver pulls update, replay guard verified (receivers' pulls don't push back), non-owner cannot push or unlink (403), non-owner local writes don't reach the outbox, unlink propagates with hard-delete on receiver, kick auto-unlinks every owned row, outbox retry behaviour (success deletes the row; failure leaves it with bumped `attempts` for backoff).

### Added — Lattice Teams (Phase 3: object sharing + schema propagation)

Third slice of **Lattice Teams**: any member can share a table with the team, and other members' locals auto-register the schema on demand.

**Schema spec format (`src/teams/schema-spec.ts`).** Dialect-neutral structured representation of a TableDefinition: each column carries a normalised `type` (TEXT/INTEGER/REAL/BLOB/JSONB) plus `notNull` / `pk` / `default` flags. The serializer parses Lattice's raw SQL type strings into this shape (VARCHAR→TEXT, BIGINT→INTEGER, BYTEA→BLOB, JSON→JSONB, etc.); the deserializer renders dialect-appropriate DDL on the receiver (JSONB collapses to TEXT on SQLite; BLOB renders as BYTEA on Postgres). Relations: `belongsTo` propagates as descriptive metadata, `hasMany` is stripped.

**Cloud endpoints.**

- `POST /api/teams/:id/objects` — share or re-share a table. Re-sharing the same `table_name` bumps `schema_version` and replaces the stored spec.
- `GET /api/teams/:id/objects` — list shared objects (member-only).
- `DELETE /api/teams/:id/objects/:table` — soft-delete the share. Only the original sharer or the team creator may unshare.
- `GET /api/teams/:id/changes?since=<seq>&limit=<n>` — monotonic change-log feed. Phase 3 emits `schema` and `unshare` envelopes; Phase 4 adds row-level ops on the same stream.

**New cloud tables.** `__lattice_shared_objects` (composite PK `(team_id, table_name)`, holds the JSON-serialised spec + schema_version + soft-delete) and `__lattice_change_log` (monotonic `seq` per cloud, `(team_id, table_name, op, payload_json, created_at)`).

**TeamsClient additions.** `shareObject`, `unshareObject`, `listSharedObjects`, `pullChanges`, plus the orchestrator `syncSharedSchemas(connection)` which fetches the team's shared objects + applies each via `applyCloudSchemaLocally`. The applier handles three states:

1. **Table doesn't exist locally** → `defineLate` with the deserialised TableDefinition.
2. **Table exists, additive change** → `addColumn` for every cloud-only column (no-op when local already matches).
3. **PK mismatch** (different column name, different count) → `TeamsSchemaConflictError`. `syncSharedSchemas` catches per-table and surfaces conflicts in its return value; `applyCloudSchemaLocally` throws directly so callers can react.

Local extras (columns present on the receiver but absent from the cloud's spec) are preserved silently — when Phase 4 pushes a row, the payload will be filtered to the cloud's columns.

**Cursor semantics.** Phase 3 cloud is single-writer per process, so `nextChangeSeq = MAX(seq) + 1` over `__lattice_change_log` is safe inside the Node event loop. Phase 4's outbox-pushing concurrency will need a transaction-scoped advisory lock around the seq read+insert; documented in routes.ts.

**Lattice public additions.**

- `lattice.introspectColumns(table)` — thin wrapper around the adapter's introspect, used by the schema applier to read the current on-disk columns.
- `lattice.getDialect()` — returns `'sqlite' | 'postgres'` for dialect-aware DDL rendering.
- `lattice.getPrimaryKey(table)` — exposes the SchemaManager's PK lookup so the applier can verify compatibility before ALTER.
- `lattice.addColumn(table, column, typeSpec)` — runtime additive DDL with column-cache refresh; idempotent for already-present columns.
- `lattice.getRegisteredColumns(table)` — returns the raw column-DDL map for a registered table; used by `lattice teams share` to serialise the local def.

**CLI additions.** `lattice teams share <table> --team <name>` serialises the local TableDefinition and posts to the cloud; `lattice teams unshare`, `lattice teams shared`, `lattice teams sync` follow the same pattern. `sync` runs `syncSharedSchemas` and prints applied + conflict tables; non-zero exit on conflicts.

### Added — Tests

- `tests/integration/teams-sharing.test.ts` — 9 cases: schema-spec helpers (parse/render/serialize/diff), share + auto-register on a receiver, additive ALTER on schema-version bump, PK conflict reported by syncSharedSchemas, schema + unshare envelopes streamed via `/changes`, and unauth'd access blocked by 401.

### Added — Lattice Teams (Phase 2: team management)

Second slice of **Lattice Teams**: identity + team-management endpoints on top of Phase 1's auth scaffolding. `lattice teams <subcommand>` now drives the full create → invite → join → leave/destroy lifecycle.

**Cloud-side endpoints:**

- `POST /api/auth/register` — bootstrap-only (403 once any user exists); creates first user + initial token.
- `POST /api/auth/redeem-invite` — public; takes `{invite_token, email, name}`, validates + creates a fresh user (one per redemption — v1 limitation, documented below), adds to the team, issues a permanent API token.
- `GET /api/auth/me` — current user info (handy for debugging + the create-team flow).
- `POST /api/auth/tokens` — mint additional tokens for the caller.
- `DELETE /api/auth/tokens/:id` — revoke (idempotent; only the owner can revoke).
- `POST /api/teams` — caller becomes creator.
- `GET /api/teams` — teams I'm in.
- `DELETE /api/teams/:id` — soft-delete (creator only).
- `GET /api/teams/:id/members` — member-only.
- `POST /api/teams/:id/invitations` — creator only; returns `latinv_`-prefixed token + expiry.
- `DELETE /api/teams/:id/members/:userId` — creator can kick others; any member can kick themselves (= leave); creators cannot kick themselves (must destroy the team instead).

**New cloud-side tables:** `__lattice_team`, `__lattice_team_members` (composite PK), `__lattice_invitations`. **New local-side table:** `__lattice_team_connections` (per-team metadata + encrypted API token; Phase 2 currently stores plaintext — encryption-at-rest follow-up captured as a TODO).

**`TeamsClient` (`src/teams/client.ts`)** — local-side orchestrator wrapping the cloud HTTP API + local-table persistence. Idempotent table bootstrap via the new defineLate idempotency. Throws a typed `TeamsHttpError` carrying the response status so callers can branch on auth/permission failures.

**CLI:** `lattice teams <subcommand>` for `register | create | join | list | members | invite | leave | destroy`. Subcommands that operate on an existing team (members/invite/leave/destroy) look the team up locally via `--team <name>` or `--team-id <uuid>`; the create/join flow takes `--cloud --token --name [--email]` and persists the connection after the cloud call returns.

**Invitation tokens** use a distinct `latinv_` prefix and 24-byte (192-bit) entropy, hashed with SHA-256 like API tokens. The bearer-extractor's `lat_` prefix check rejects them — invitation tokens are exchanged via the redeem endpoint, never used as bearer tokens.

**`defineLate` is now idempotent.** A second call for an already-registered table is a no-op (CREATE TABLE IF NOT EXISTS handles the DB side; this skip avoids the SchemaManager throw). Lets `TeamsClient` bootstrap its internal tables on every session start without explicit checks.

### v1 limitations (documented for follow-ups)

- **Every invitation redemption creates a fresh cloud user.** A single human joining two teams on the same cloud ends up with two `user_id`s and two API tokens. Email-based identity merging is a Phase 5-or-later refinement.
- **Local API tokens are stored in plaintext.** The `__lattice_team_connections.api_token_encrypted` column name reserves the slot for encryption-at-rest; the integration with Lattice's existing AES-256-GCM layer (currently scoped to entity contexts) will land in a follow-up.

### Added — Tests

- `tests/integration/teams-management.test.ts` — 5 cases: full create → invite → join → list → leave → destroy round-trip across two locals + one cloud (one in-process), plus self-kick blocked for creators, invitation tokens rejected as bearers, token revocation, and `findConnectionByName` ambiguity error.

### Added — Lattice Teams (Phase 1: server mode + bearer auth)

First slice of the **Lattice Teams** feature: a single Postgres- or SQLite-backed lattice instance can now boot in **team-cloud server mode**, exposing the HTTP API over a non-localhost interface with bearer-token authentication. The rest of the feature (team management, object sharing, row link/unlink, sync engine, GUI integration) lands in subsequent phases.

- **`lattice serve` CLI command.** New subcommand alongside `lattice gui`. Accepts `--host`, `--port`, `--team-cloud`, and the usual `--config` / `--output`. Without `--team-cloud` it acts like `gui` but without auto-opening a browser; with `--team-cloud` it registers the internal teams tables and gates every request on a bearer token.
- **`Lattice.defineLate(table, def)`.** Mirror image of `define()` for post-`init()` table registration. Compiles the definition, registers it on the schema manager, and immediately applies its DDL through `SchemaManager.applySchemaForAsync` (which holds the same `pg_advisory_xact_lock` the boot path uses, so concurrent defineLate callers on Postgres serialize). Updates `_columnCache` for the new table so subsequent `query`/`insert`/`update` calls are aware of it.
- **`SchemaManager.applySchemaForAsync(adapter, name)`.** Per-table version of `applySchema` — pulled out into a shared `_applyOneTable` helper, then wrapped in a `withClient` block on Postgres so the advisory lock covers the DDL window. SQLite falls through to the existing direct-DDL path.
- **Bearer-token auth (`src/teams/server/auth.ts`).** Tokens are `lat_`-prefixed 256-bit random strings; only their SHA-256 hex hash is stored in `__lattice_api_tokens.token_hash`. `authenticate(req, db)` hashes the incoming bearer, looks it up directly, re-verifies with `timingSafeEqual`, and resolves the linked `__lattice_users` row (rejecting revoked tokens and soft-deleted users). `generateToken()` mints a new raw + hash pair for the issuer to store. scrypt/bcrypt are intentionally not used — they exist to slow down brute-forcing of low-entropy passwords; 256-bit tokens don't need slowdown.
- **Cloud-side internal tables (`src/teams/internal-tables.ts`).** `__lattice_users` and `__lattice_api_tokens` table definitions. Registered via `defineLate` when a lattice is booted with `teamCloud: true`. Teams, members, shared objects, row links, and the change log are added in later phases.
- **`startGuiServer` extensions.** `StartGuiServerOptions` gains `host?: string` (default `127.0.0.1`) and `teamCloud?: boolean`. In team-cloud mode: every API request requires a valid bearer token (401 otherwise), the database-switcher endpoints (`/api/databases*`) return 403 (single-user filesystem-trust assumption breaks under multi-user access), and the listen bind uses `host` instead of the previously-hardcoded `127.0.0.1`.

### Added — Tests

- `tests/unit/teams-auth.test.ts` — 11 cases covering: token hash/extract helpers (5), server boots in team-cloud mode and registers internal tables (1), 401 on missing/wrong-prefix/wrong-scheme/unknown-token Authorization headers (3), 200 on valid bearer (1), 401 on revoked token (1), 403 on the database-switcher endpoint in team-cloud mode (1).

## [1.11.0] — 2026-05-25

### Added

- **`lattice gui` CLI command.** Starts a local-only browser GUI for exploring and editing the data in a Lattice database. The server binds to `127.0.0.1`, auto-increments port `4317` when busy, and opens a single-page app for browsing entities, viewing relationship graphs, editing rows, and adding / removing junction-table links. All HTTP routes delegate straight to the existing `Lattice` CRUD methods — no separate state, no schema duplication. New flags: `--port <number>`, `--no-open`.

### Notes for upgraders

- **Three additive `_lattice_gui_*` tables are created in any database opened with `lattice gui`.** The first time the GUI runs against a given DB, it creates `_lattice_gui_meta` (per-entity icon overrides), `_lattice_gui_column_meta` (per-column `secret` flag), and `_lattice_gui_audit` (mutation log powering undo / redo). These are filtered out of `/api/entities`, hidden from the dashboard, and write to `.lattice-gui/*.md` rather than your declared `outputFile` paths — they do not appear in rendered context. **No fictional / demo rows are inserted: your existing data is what the GUI shows.** The schema mutation is one-way additive — there is no migration to remove these tables, but they are inert if you stop using `lattice gui`.
- **The GUI has no authentication and binds only to loopback.** Do not expose port 4317 (or its auto-incremented successor) on a non-loopback interface or proxy it to a public host. See [SECURITY.md](./SECURITY.md).

### Security

- **`SECURITY.md` contact updated** to `contact@automatedindustries.ai`. Supported versions updated to `1.11.x`. GUI HTTP surface added to the in-scope list.

---

## [1.10.0] — 2026-05-04

### BREAKING

- **`PostgresAdapter` no longer supports the synchronous `StorageAdapter` methods.** `run` / `get` / `all` / `prepare` / `introspectColumns` / `addColumn` now throw on Postgres with a clear error pointing callers at the async equivalents. `pg.Pool` is fundamentally async — there is no synchronous path on the Node main thread that doesn't go through a worker thread + `Atomics.wait`, and the `synckit`-bridged sync surface that 1.8.x/1.9.0 kept alive for back-compat has been removed. **Lattice core methods (`Lattice.query`, `.insert`, `.update`, `.delete`, `.count`, `.render`, `.reconcile`, `.search`, `.history`, `.rollback`, etc.) already route through the async surface as of 1.9.0** — typical consumers of `latticesql` see zero impact. Only callers that escape into `db.lattice.adapter.run/get/all` directly (rare — e.g. raw-SQL routes that reach into the adapter for one-off metadata queries) need to migrate to `runAsync` / `getAsync` / `allAsync` / `withClient`. The error message points the way.
- **`synckit` is no longer an `optionalDependency`.** Drop it from your install if you had it pinned via this package — `latticesql` no longer references it. `pg` remains an `optionalDependency` for Postgres consumers.
- **`postgres-worker.cjs` is no longer in the published tarball.** The synckit worker file that 1.6.2–1.9.0 shipped at `dist/postgres-worker.cjs` is gone (it served the now-removed sync surface). Anything that imported it directly will break — but nothing should have been doing that; it was an internal implementation detail.
- **`Lattice._ensureColumnCache` no longer lazy-populates via `introspectColumns` on cache miss.** Pre-1.10.0 it would call `adapter.introspectColumns(table)` synchronously and cache the result on first access. With sync introspect gone on Postgres, the lazy fallback is gone too. The method now returns the pre-populated cache (built at the end of `_initAsync` for every `define()`d table) or an empty `Set` for unregistered tables. Effective behavior change: code paths that mix raw `adapter.run('CREATE TABLE foo …')` (bypassing `define()`) with `Lattice.upsertByNaturalKey('foo', …)` no longer get column-detection on the unregistered table — you need to `define()` it. Production code using the documented `define()` workflow sees zero change. (The `crud-generic` integration test was the only call site that depended on the lazy fallback; it's been updated to use `define()` instead of raw DDL — which is the production-shape pattern anyway.)

### Changed

- **`PostgresAdapter` is now native against `pg.Pool`** with no worker thread. The previously-synckit-bridged `introspectColumns` and `addColumn` surfaces are now exposed as `introspectColumnsAsync(table)` and `addColumnAsync(table, column, typeSpec)` on the adapter, implemented natively against `pg.Pool`. The async surface (`runAsync` / `getAsync` / `allAsync` / `prepareAsync` / `introspectColumnsAsync` / `addColumnAsync` / `withClient`) is the only path that does work on Postgres now. `SQLiteAdapter` adds the same async methods as one-microtask wrappers around the sync versions so consumers can write a single async-preferring code path that works against both backends without branching on dialect.
- **Postgres polyfills (`pgcrypto` extension, `json_extract` SQL function, `strftime` SQL function) now register lazily on first pool use.** Previously the synckit worker registered them synchronously inside `open()`. With the worker gone, registration kicks off as a Promise (`_polyfillsReady`) when `open()` is called, and every async method awaits that Promise before its first query. By the time any user query runs, the polyfills are guaranteed to be in place. Net effect: `randomblob(N)`, `json_extract(doc, '$.a.b')`, and `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` keep working unchanged in user migrations on Postgres.
- **`StorageAdapter` interface gains optional `introspectColumnsAsync` and `addColumnAsync` methods**, mirroring the existing optional `runAsync` / `getAsync` / `allAsync`. Both built-in adapters implement them. Helper functions `introspectColumnsAsyncOrSync(adapter, table)` and `addColumnAsyncOrSync(adapter, table, column, typeSpec)` are exported from `db/adapter.ts` (mirroring the existing `runAsyncOrSync` family) for third-party adapters that haven't yet adopted the async surface.

### Removed

- **`synckit` import + worker bridge** from `PostgresAdapter`. The `_call(action)` synckit gateway, the `_workerPath` field, the `_syncFn` field, and the entire `dist/postgres-worker.cjs` build target are gone. `PostgresAdapter` shrinks from 482 LOC to ~370 LOC, plus the entire 168-line `postgres-worker.ts` source file is deleted. The third tsup build target (the worker CJS bundle) is removed.

### Notes for upgraders

- **Most consumers see zero impact.** Lattice 1.9.0 already routed all its internal DB I/O through the async surface. If your code calls `db.query(...)`, `db.insert(...)`, `db.render(...)`, etc., this release is a transparent upgrade.
- **If you escape into `db.lattice.adapter` for raw SQL**, audit those sites: replace `adapter.run` / `adapter.get` / `adapter.all` with `await adapter.runAsync(...)` / `await adapter.getAsync(...)` / `await adapter.allAsync(...)`, and replace any raw `adapter.run('BEGIN')` / `adapter.run('COMMIT')` blocks with `await adapter.withClient(async (tx) => { … })`. The thrown error surfaces the same advice.
- **If you registered a third-party `StorageAdapter`**, you'll want to add `runAsync` / `getAsync` / `allAsync` / `introspectColumnsAsync` / `addColumnAsync` / `withClient` implementations. The async-or-sync helper pattern (`runAsyncOrSync` etc.) means a third-party adapter that _only_ implements the sync surface still works — lattice falls back. But Postgres-style third-party adapters should expose async natively.
- **Connection budget on Postgres drops by 1 per adapter instance.** The synckit worker owned a separate `pg.Client` outside the pool. With the worker gone, a `PostgresAdapter` instance consumes only `poolSize` upstream connections (default 10). For the canonical setup (3 service replicas across dev + prod = 6 instances × 10 pool = 60 connections), that's a 6-connection reduction.

## [1.9.0] — 2026-05-04

### Changed

- **Lattice core now prefers the adapter's async surface over the sync surface at every internal call site.** Previously, even after 1.8.0 added `runAsync` / `getAsync` / `allAsync` to `StorageAdapter`, lattice itself still routed every read and write through the sync methods — meaning Postgres consumers were paying the synckit `Atomics.wait` cost on the Node main thread for every `lattice.query`, `lattice.insert`, `lattice.render`, and so on, even though `pg.Pool` was already available. This release flips that: `Lattice.{insert,upsert,upsertBy,update,updateReturning,delete,get,query,count,upsertByNaturalKey,enrichByNaturalKey,softDeleteMissing,getActive,countActive,getByNaturalKey,link,unlink,reward,history,recentChanges,rollback,snapshot,pruneChangelog,buildReport}`, the `RenderEngine` walk (single-table renders, multi-table renders, entity-context renders, cleanup), `SchemaManager.applySchema` / `queryTable`, `ReverseSyncEngine.process`, `ReverseSeedEngine.detect` / `process`, and the embeddings store/load helpers all consume DB I/O via three new internal helpers — `runAsyncOrSync(adapter, sql, params)`, `getAsyncOrSync(...)`, `allAsyncOrSync(...)` — exported from `src/db/adapter.ts`. Each helper prefers the async surface when present and falls back to sync when an adapter doesn't implement it. SQLite consumers see no behavioral change: SQLite has no `allAsync` / `getAsync` / `runAsync`, so every call falls through to the existing sync path. Postgres consumers now keep the Node event loop free during DB roundtrips — no more `Atomics.wait` on request-handling threads.
- **Several previously-synchronous internal helpers now return Promises.** `Lattice._appendChangelog`, `_pruneChangelog`, `_ensureChangelogTable`, plus `RenderEngine.cleanup` and `SchemaManager.applySchema` / `queryTable` are now async. The public CRUD methods that wrap them were already returning Promises; the change is internal-only for direct lattice consumers. The `Lattice.cleanup(...)` callsite inside `Lattice.reconcile` is now awaited.
- **`Lattice.init()` async tail reordering.** The synchronous validation phase of `init()` is preserved (encryption-key config check still throws synchronously, so `expect(() => db.init()).toThrow(...)` patterns remain green). What changed: `applySchema` moved into the async tail (`_initAsync`) because it now performs async DB I/O. Encryption setup was split into a sync `_validateEncryptionConfig` (throw-only, no DB access) and an async `_finalizeEncryptionSetup` (resolves columns via `introspectColumns`, runs after `applySchema`).
- **`removeEmbedding` and `ensureEmbeddingsTable` are now async.** `Lattice._syncEmbedding` continues to fire-and-forget — both branches (insert/update via `storeEmbedding` and delete via `removeEmbedding`) now route their rejection through the existing error handler chain, preserving the "embedding errors don't break the write" semantic.

### Fixed

- **`Lattice.softDeleteMissing` and `Lattice.countActive` now correctly return `number` on Postgres.** Both methods declared `Promise<number>` but returned the raw `cnt` field from a `SELECT COUNT(*) as cnt` query. SQLite returns `COUNT(*)` as a JS number, but the Postgres wire protocol returns it as a string for arbitrary-precision safety. Pre-1.9.0 the contract was honored on SQLite and silently violated on Postgres. Both methods now wrap the result in `Number(...)`, matching the behavior `Lattice.count` already had. Surfaced by the new `insert-update-async-postgres.test.ts` smoke against a real Postgres.

### Added

- **Postgres integration tests covering the four hottest call paths:**
  - `tests/integration/query-async-postgres.test.ts` — `Lattice.query` covering eq / in / like / isNull / isNotNull / numeric / orderBy / limit and the unknown-column rejection path.
  - `tests/integration/insert-update-async-postgres.test.ts` — `insert` / `upsert` / `upsertBy` / `update` / `updateReturning` / `delete` / `softDeleteMissing` / `link` / `unlink` end-to-end.
  - `tests/integration/render-async-postgres.test.ts` — full `Lattice.render(outputDir)` walk against a Postgres-backed schema with both table-level and entity-context renders. Asserts manifest contents and per-entity files.
  - `tests/integration/parallel-pool-query-postgres.test.ts` — fires 10 concurrent `Lattice.count` calls and asserts wall time is sub-linear in the batch size, proving `pg.Pool` concurrency. Regression test for the original symptom that motivated this whole rewrite (sync queries serializing through the synckit worker).

  All four follow the `describe.skipIf(!process.env.LATTICE_TEST_PG_URL, ...)` pattern; CI's existing `postgres:16` service container provides the env var so they always run on `main`.

### Notes for upgraders

- **No public-API breakage.** Methods that returned `Promise<T>` before still return `Promise<T>`; methods that were sync (e.g. `Lattice.close`) stay sync. The change is internal: lattice now routes through the async surface when the adapter offers one.
- **Postgres consumers should observe a substantial reduction in event-loop stalls.** Previously, a request that triggered a `db.query(...)` on the main thread blocked the event loop on `Atomics.wait` for the duration of the synckit roundtrip — typically tens to hundreds of ms per call, and serialized across concurrent requests. Post-1.9.0, those calls suspend cleanly via `await` and the event loop is free to handle other work. The original motivating symptom — a `~25-30s` health-probe stall during sync bursts — should drop to single-digit-second probes.
- **SQLite consumers see zero behavioral change.** The sync path is untouched and authoritative for any adapter that doesn't implement `allAsync` / `getAsync` / `runAsync`. The new helpers add a single microtask boundary on each call (`async` wrappers around `Promise.resolve(adapter.all(...))`) but no real overhead.
- **Internal-only async cascade.** Anyone subclassing `RenderEngine` or `SchemaManager` and overriding `cleanup` / `applySchema` / `queryTable` will see the return type change from `T` to `Promise<T>`. Update overrides to be `async` and await internal helpers — the parameter shapes are unchanged.

## [1.8.1] — 2026-05-02

### Fixed

- **`SchemaManager.applyMigrationsAsync` now uses the correct Postgres advisory-lock function name.** 1.8.0 shipped with the function name typoed as `pg_xact_advisory_lock` (advisory and xact swapped) — that function does not exist in Postgres. Every fresh boot crashed with `Fatal: error: function pg_xact_advisory_lock(unknown) does not exist`. The misleading `(unknown)` made it look like a parameter-typing problem; adding an `::bigint` cast reproduced as `function pg_xact_advisory_lock(bigint) does not exist`, surfacing that the function name itself was wrong. The actual Postgres function is `pg_advisory_xact_lock(bigint)` — advisory first, xact second. Fixed in `src/schema/manager.ts`. The `::bigint` cast is kept as belt-and-suspenders documentation.

### Added

- **Postgres integration test for `applyMigrationsAsync`** (`tests/integration/apply-migrations-async-postgres.test.ts`). Skips when `LATTICE_TEST_PG_URL` is unset; otherwise exercises the full end-to-end migration runner against a real Postgres. Covers: basic apply, idempotency, rollback on failure, and concurrent-boot serialization on the transaction-scoped advisory lock. Catches the regression that 1.8.0 shipped — the SQLite-only unit tests passed because they skip the advisory-lock branch entirely; this test runs the exact code path that broke.
- **Postgres service container in CI** (`.github/workflows/ci.yml`). Provisions a `postgres:16` service container and sets `LATTICE_TEST_PG_URL` on the test job so the new integration suite always runs in CI.

## [1.8.0] — 2026-05-02

### Added

- **Optional async surface on `StorageAdapter`** — `runAsync` / `getAsync` / `allAsync` / `prepareAsync` / `withClient`, plus a `dialect: 'sqlite' | 'postgres'` discriminator and a new `TxClient` interface for transaction-scoped query handles. Existing sync methods (`run` / `get` / `all` / `prepare`) are unchanged and still authoritative for SQLite consumers; the async surface is preferred by lattice itself when present. Adapters that don't implement async methods continue to work via the sync surface.
- **`PostgresAdapter` now exposes a native async surface backed by `pg.Pool`** alongside the existing synckit-bridged sync surface. New `PostgresAdapterOptions.poolSize` (default 10) controls the pool. The async path runs on the Node main thread without `Atomics.wait`, so the event loop is free to serve other work between awaited DB roundtrips. The synckit worker is kept alive for back-compat — sync `run`/`get`/`all` callers see no behavioral change. Total upstream connection demand per adapter instance is `1 + poolSize` while both surfaces are in use; in a future release the synckit path will be removed.
- **`SQLiteAdapter.withClient(fn)`** — wraps an async `fn(tx: TxClient)` in a `BEGIN`/`COMMIT` block on the single SQLite connection. Throws inside `fn` cause `ROLLBACK`. Provided for cross-dialect parity with `PostgresAdapter.withClient` so transactional callers don't need to branch on adapter type.
- **`SchemaManager.applyMigrationsAsync`** — runs the migration loop inside a single `withClient(fn)` block. On Postgres, also acquires `pg_xact_advisory_lock(LATTICE_MIGRATION_LOCK_ID)` at the top of the transaction so concurrent app boots queue and apply migrations serially instead of racing on `CREATE TABLE` / seed inserts. The lock is transaction-scoped, so it auto-releases at `COMMIT` — no explicit unlock and no risk of a leaked lock surviving a crashed boot. SQLite path uses the same withClient block but skips the advisory-lock branch (better-sqlite3's single-writer guarantee plus WAL + busy_timeout already cover concurrent boots). Falls back to the synchronous `applyMigrations` when the adapter doesn't implement `withClient`.
- **`Lattice.init()` and `Lattice.migrate()` now drive migrations through `applyMigrationsAsync`.** The synchronous validation phase of `init()` (encryption-key config check, etc.) is preserved as a non-async function so existing `expect(() => db.init()).toThrow(...)` patterns continue to surface config errors as synchronous throws, not promise rejections.

### Changed

- **Internal raw `BEGIN`/`COMMIT`/`ROLLBACK` call sites in `reverse-seed/engine.ts` and `reverse-sync/engine.ts` migrated to `withClient(fn)`.** Previously these relied on the synckit worker's single `pg.Client` to incidentally pin BEGIN/COMMIT to one connection. Under the new pool-backed async surface, raw BEGIN/COMMIT can land on different upstream connections and break atomicity silently. `withClient(fn)` checks out a single client for the full transaction — the surface is identical on SQLite and Postgres so the migration is mechanical.
- **`ReverseSeedEngine.process` and `ReverseSyncEngine.process` are now async** (return `Promise<ReverseSeedResult>` / `Promise<ReverseSyncResult>`). Callers inside lattice's own render loop are already inside async methods; downstream consumers awaiting the previous sync return value see no behavioral change since both engines were always invoked from `Lattice.render()` and `Lattice.reverseSeed()`, which already return Promises.

### Fixed

- **Migration runner is now safe under transaction-mode connection pooling.** Before this release, if a Postgres consumer pointed `PostgresAdapter` at a transaction-mode pgbouncer endpoint (e.g. Supabase port 6543), there was no upstream connection guarantee across the migration loop's individual `adapter.run` calls and concurrent boots could race on `CREATE TABLE IF NOT EXISTS` + seed inserts. The new `pg_xact_advisory_lock` inside `withClient(fn)` serializes concurrent migration runs.

### Notes for upgraders

- This release is **additive** at the `StorageAdapter` interface level — existing third-party adapters that implement only the sync surface continue to work unchanged. Lattice will use the sync path when `withClient` is undefined on the adapter.
- Postgres consumers gain real async DB I/O on the new `runAsync`/`getAsync`/`allAsync`/`withClient` methods. To benefit, downstream code should adopt the async surface (e.g. `await db.query(...)` already routes through the async path via the consumer's `DataStore` async wrappers in most cases).
- Raw `adapter.run('BEGIN')` / `adapter.run('COMMIT')` is **no longer a safe transaction idiom** if you call it on a future Postgres release where the synckit worker has been removed. Migrate now to `await adapter.withClient(async (tx) => { ... })` — the surface is the same on SQLite and Postgres.

## [1.7.0] — 2026-04-20

### Changed

- **`better-sqlite3` is now a `peerDependency` with range `>=11 <13`** (previously a regular `dependency` pinned to `^12.8.0`). Lattice only uses the stable, long-standing subset of the better-sqlite3 API (`new Database()`, `prepare`, `exec`, `pragma`, `transaction`, `function`, `close`), which is unchanged across 11.x → 12.x. Pinning a single major forced downstream projects already on `better-sqlite3@^11` to either upgrade in lockstep or hit `ETARGET` / peer-conflict errors on `npm install latticesql`. Moving it to `peerDependencies` also matches the library pattern (the host app owns the native sqlite driver build). Kept as a `devDependency` at `^12.8.0` so local tests still run.

### Fixed

- **`require('latticesql')` from a CJS consumer no longer crashes at module load.** `src/db/postgres.ts` used to call `fileURLToPath(import.meta.url)` and `createRequire(import.meta.url)` at the top level. Under tsup's dual-bundle CJS output, `import.meta` is rewritten to `{}` so `.url` is `undefined` — loading `dist/index.cjs` threw `TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string or an instance of URL. Received undefined` before any user code ran. Fix: lazy-resolve the module directory and local `require` via a small `moduleContext()` helper that prefers `import.meta.url` under ESM and falls back to Node's CJS-injected `__dirname` / `require` globals when `import.meta.url` is unavailable. The CI workflow's "Verify CJS require" step now passes.
- **Lint cleanups in the Postgres dialect translator (`src/db/postgres.ts`) and worker (`src/db/postgres-worker.ts`).** No runtime behavior change — replaces bare `sql[i]` indexed reads (flagged under `noUncheckedIndexedAccess`) with `sql.charAt(i)`, tightens regex-callback signatures so template-literal expressions are `string` rather than `any`, widens `hadInsertOrIgnore` to `boolean` so TypeScript doesn't narrow it to literal `false`, removes now-redundant `eslint-disable no-console` directives, and types `pg.Client.query<Record<string, unknown>>(...)` to propagate row-shape through to the worker's `Result` type. Restores green CI on `main`.

## [1.6.10] — 2026-04-14

### Added

- **`strftime()` Postgres polyfill** — Handles the common `strftime(format, 'now')` ISO-timestamp pattern plus arbitrary SQLite-style format strings by token-replacing to `to_char()` form. Also accepts ISO timestamps as the modifier arg.

## [1.6.9] — 2026-04-14

### Added

- **`json_extract()` Postgres polyfill** — On `PostgresAdapter.open()`, registers a SQL function `json_extract(doc text, path text) RETURNS text` that mimics SQLite's behavior by stripping the `9` prefix and splitting the remaining dotted path into a Postgres `#>>` array access. Lets migrations that use SQLite JSON syntax (e.g. `json_extract(metadata_json, '9contact_id')`) work on Postgres unchanged.

## [1.6.8] — 2026-04-14

### Added

- **`datetime('now')` translation** — Lattice internally emits `UPDATE ... SET deleted_at = datetime('now')` for soft-deletes and `DEFAULT (datetime('now'))` in some core schemas. Now translated to `NOW()` when the adapter is Postgres. `datetime()` with any other argument throws loudly.

## [1.6.7] — 2026-04-14

### Added — `CREATE VIEW IF NOT EXISTS` translation

- SQLite supports `CREATE VIEW IF NOT EXISTS v AS SELECT ...`; Postgres rejects it as `syntax error at or near "NOT"`. The translator now rewrites it to `CREATE OR REPLACE VIEW v AS SELECT ...`, which is the Postgres-native idempotent form (and works in SQLite too, though only the Postgres path runs the translation). 3 new unit tests cover the translation + a guard that `CREATE TABLE IF NOT EXISTS` is unchanged (tables ARE supported by both dialects).

## [1.6.6] — 2026-04-14

### Fixed

- **`INSERT OR IGNORE ... SELECT ...` with string literals in the SELECT body now translates correctly.** Previously the `ON CONFLICT DO NOTHING` clause was appended per code region in `translateDialect`, which put it directly after the column list when the SELECT body contained string literals (they split the SQL into multiple code regions in the tokenizer). The resulting SQL had the clause before the `SELECT ... FROM ... LIMIT N` tail, which Postgres rejected with `syntax error near '<string literal>'`. Fix: track the `INSERT OR IGNORE` flag across the whole statement and append `ON CONFLICT DO NOTHING` once at the END of the full SQL. Regression test added for the canonical `INSERT OR IGNORE INTO file ... SELECT 'uuid', id, 'name', ... FROM org LIMIT 1` pattern that downstream consumer migrations use.

## [1.6.5] — 2026-04-13

### Fixed

- **`PostgresAdapter` now uses `createRequire(import.meta.url)` to load `pg` and `synckit`.** The bundler's `__require` shim throws "Dynamic require of '…' is not supported" under ESM, which fell into the catch block and surfaced as the misleading "requires 'pg' and 'synckit'" error even when both packages were installed and reachable. Switched to `createRequire(import.meta.url)` rooted at this file's URL, which builds a real CJS require that walks up from `latticesql/dist/` and finds the consumer's `node_modules` entries. Error messages now include the underlying require error so future failures are diagnosable.

### Note

This is the fourth attempt at making the Postgres backend actually work end-to-end (1.6.0 missed the worker file, 1.6.2 added it as `.js` under `type: module` so Node refused to load it, 1.6.3 fixed the extension, 1.6.4 marked deps external, 1.6.5 fixes the require shim). With this version, `new Lattice('postgres://...').init()` succeeds against a real Supabase project.

## [1.6.4] — 2026-04-13

### Fixed

- **`pg`, `synckit`, and `@pkgr/core` are now external in the bundle.** 1.6.0 through 1.6.3 inadvertently bundled all three into `dist/index.js`. That broke under ESM consumers because `@pkgr/core` (a transitive dep of synckit) calls `createRequire(import.meta.url)` at module init — which throws when `import.meta` is the bundler's stub object (`{}`). The error fell into `PostgresAdapter.open()`'s catch and surfaced as the misleading `"requires 'pg' and 'synckit'"` message even though both were installed.
- After this fix, `pg` and `synckit` resolve from the consumer's `node_modules` at runtime (where they belong as `optionalDependencies`). End-to-end Postgres now works from ESM consumers.

### Note

Versions 1.6.0 / 1.6.1 / 1.6.2 / 1.6.3 are all affected by the bundling bug. 1.6.4 is the first version where `new Lattice('postgres://…').init()` actually succeeds.

## [1.6.3] — 2026-04-13

### Fixed

- **PostgresAdapter worker now runs.** 1.6.2 emitted `dist/postgres-worker.js` but the published `package.json` has `"type": "module"`, so Node 18+ treats every `.js` file in the package as ESM. The worker is built as CJS (it `require()`s `pg` and `synckit`), so loading it failed with `require is not defined in ES module scope`. The synckit `try/catch` masked this as the misleading "requires 'pg' and 'synckit'" message. Worker now ships as `dist/postgres-worker.cjs`; `PostgresAdapter` constructor resolves the `.cjs` extension. End-to-end Postgres connection now works under Node 18 / 20 / 22 / 24.

### Note

If you tried 1.6.2 and got the same misleading "requires 'pg' and 'synckit'" error, this is the actual fix. 1.6.0 / 1.6.1 / 1.6.2 should not be used with the Postgres backend.

## [1.6.2] — 2026-04-13

### Fixed

- **`PostgresAdapter` worker file now ships in the published tarball.** The 1.6.0 / 1.6.1 dist included the bundled library + CLI but not the `postgres-worker.js` file that `synckit` loads via `new Worker(workerPath)`. Result: any consumer that called `new Lattice('postgres://…').init()` got an immediate `"PostgresAdapter requires 'pg' and 'synckit'"` error even when both were installed — the catch block masked the real `Cannot find module 'postgres-worker.js'` error from synckit. `tsup.config.ts` now emits `dist/postgres-worker.js` as a standalone CJS bundle alongside the main library, with `pg` + `synckit` declared external so they resolve from the consumer app's `node_modules` at runtime.

### Note

If you tried 1.6.0 or 1.6.1 with a Postgres connection string and got the misleading "requires pg and synckit" error, upgrade to 1.6.2 — `pg` and `synckit` were correctly installed; the worker file just wasn't there to load them.

## [1.6.1] — 2026-04-13

### Added — extra `PostgresAdapter` dialect translations

The `PostgresAdapter` rewriter (introduced in 1.6.0) gains four more SQLite → Postgres translations so existing migration code that uses common SQLite idioms keeps working unchanged when pointed at a Postgres connection string:

| SQLite                     | Postgres translation                    | Notes                                                                                                                                                                                                                               |
| -------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INSERT OR IGNORE INTO …`  | `INSERT INTO … ON CONFLICT DO NOTHING`  | Strips `OR IGNORE`, appends `ON CONFLICT DO NOTHING` to the statement tail. Skipped if the user already wrote an explicit `ON CONFLICT` clause. Requires at least one unique constraint on the target table.                        |
| `INSERT OR REPLACE INTO …` | (intentionally not translated — throws) | The correct `ON CONFLICT (col) DO UPDATE SET …` form depends on the conflict target, which the translator can't infer. Surface the error so the operator picks the right form.                                                      |
| `randomblob(N)`            | `gen_random_bytes(N)`                   | Requires `pgcrypto`. `PostgresAdapter.open()` now runs `CREATE EXTENSION IF NOT EXISTS pgcrypto` idempotently — succeeds on Supabase / Neon / RDS, warns (non-fatally) on hosted Postgres providers that restrict CREATE EXTENSION. |
| `hex(<expr>)`              | `encode(<expr>, 'hex')`                 | Postgres lacks the SQLite `hex()` shorthand. Composite `lower(hex(randomblob(16)))` (a common 32-char hex-id pattern) translates to `lower(encode(gen_random_bytes(16), 'hex'))`.                                                   |

`INSERT OR IGNORE` translation is **string-literal aware** — the keywords are not rewritten if they appear inside quoted user data. `randomblob` / `hex` translations are not string-aware (the alternative breaks the common `hex('abc')` literal-argument case); the documented limitation is that storing the literal text `"hex(...)"` inside a single-quoted user data string will get the function name rewritten. Real migrations virtually never store SQL function names inside user data.

### Changed

- `PostgresAdapter.open()` now runs `CREATE EXTENSION IF NOT EXISTS pgcrypto` once per connection. Failures are warned (`console.warn`) but non-fatal — providers that restrict CREATE EXTENSION can still use the adapter as long as `pgcrypto` is enabled out-of-band.
- `_translateDialectForTest` exported from `src/db/postgres.ts` for unit testing of the new translation passes.

### Tests

12 new unit tests in `tests/unit/postgres-rewrite.test.ts` — `INSERT OR IGNORE` (5), `randomblob` / `hex` (5), `INSERT OR REPLACE` rejection (1), composite end-to-end (1). All 551 tests pass.

## [1.6.0] — 2026-04-13

### Added

- **Pluggable database backend.** Lattice now supports either SQLite (the existing default) or any Postgres-compatible database via a new `PostgresAdapter`. Pass a connection string and Lattice picks the right adapter:
  - `new Lattice('/path/to/db.sqlite')` — SQLite (unchanged).
  - `new Lattice(':memory:')` — in-memory SQLite (unchanged).
  - `new Lattice('file:/path/to/db.sqlite')` — explicit SQLite via `file:` scheme.
  - `new Lattice('postgres://user:pass@host:5432/db')` — Postgres.
  - `new Lattice('postgresql://...')` — Postgres (alternate scheme).
  - `new Lattice(anyPath, { adapter: myAdapter })` — bring your own adapter.
- **`StorageAdapter` interface gains two methods:** `introspectColumns(table)` and `addColumn(table, col, typeSpec)`. Implementations dispatch on their own dialect (SQLite uses `PRAGMA table_info`, Postgres uses `information_schema`; SQLite handles non-constant defaults via backfill, Postgres natively).
- **Public exports** for advanced consumers: `StorageAdapter`, `PreparedStatement`, `SQLiteAdapter`, `PostgresAdapter`, `PostgresAdapterOptions`.
- **`Lattice.adapter`** getter — portable accessor for the configured `StorageAdapter`. The existing `Lattice.db` getter still returns the better-sqlite3 handle but throws when the adapter isn't a `SQLiteAdapter`.

### Changed

- `Lattice` constructor signature is unchanged for SQLite users — the same `new Lattice(path)` form continues to work, with the same `wal` / `busyTimeout` options.
- `_addMissingColumns` and the four `PRAGMA table_info(…)` call sites in `Lattice` and `SchemaManager` now go through `adapter.introspectColumns(table)` and `adapter.addColumn(table, col, type)`. Behavior under SQLite is identical; the refactor enables the Postgres path.

### Implementation notes

- `PostgresAdapter` runs `pg` inside a `synckit` worker thread so the synchronous `StorageAdapter` interface can wrap an inherently async client. Each query pays ~1–3 ms of message-passing overhead — fine for Lattice's batch-insert + periodic-render workload, not OLTP-grade. If/when a workload genuinely needs async throughput, an async `StorageAdapter` variant can be added without breaking SQLite consumers.
- `?` placeholders are translated to `$N` automatically. The translator skips over single-quoted strings, double-quoted identifiers, and SQL comments, so `?` characters inside those are left alone.
- `BLOB` column types are translated to `BYTEA` automatically inside `addColumn`. `datetime('now')` and `RANDOM()` are translated to `NOW()` and `random()` respectively.
- `pg` and `synckit` ship as `optionalDependencies` — SQLite-only consumers don't pay the install cost. The `PostgresAdapter` constructor throws a clear error message if either is missing.

### Provider notes

- Any Postgres-compatible database that speaks the standard wire protocol on port 5432 should work — including managed providers like Supabase, Neon, and RDS.
- When using a connection pooler, prefer **session-mode pooling**. Transaction-mode poolers typically do not support prepared statements across transactions, which would break Lattice's `adapter.prepare()` pattern.

### Limitations (out of scope for this release)

- `lastInsertRowid` is `0` on the Postgres path. Use `TEXT PRIMARY KEY` (UUIDs) for portable schemas; if you need a fresh integer ID after insert on Postgres, write your own `INSERT … RETURNING id` query.
- Two SQLite-only paths remain: `fixSchemaConflicts(db)` (lifecycle helper) and the writeback session-apply machinery both take a raw better-sqlite3 handle. Postgres consumers shouldn't call them.
- A migration tool that dumps an existing SQLite Lattice DB into Postgres is not included. Use a generic SQLite → Postgres migration tool, or `INSERT … SELECT` row-by-row.

## [1.5.0] — 2026-04-08

### Note

Published to npm without a corresponding `CHANGELOG.md` entry. Reconstructed from `git log` between v1.3.1 and v1.5.0 — primarily formatting / tooling fixes (incremental changelog writes, Windows path-separator handling, prettier formatting, lint cleanup). No public API changes.

## [1.4.0] — 2026-04-08

### Note

Published to npm without a corresponding `CHANGELOG.md` entry. Reconstructed from `git log` — see notes for 1.5.0.

## [1.3.0] — 2026-04-04

### Added

- **Token-budget-aware rendering** — New `tokenBudget` and `prioritizeBy` options on `TableDefinition`. When rendered output exceeds the token budget, rows are pruned by priority and a truncation footer is appended. Token count estimated at ~4 characters per token.
- **Writeback validation** — New `validate`, `rejectBelow`, and `onReject` options on `WritebackDefinition`. Validate agent-written data before persisting — entries that fail validation or score below threshold are rejected. Supports sync and async validators.
- **Relevance-filtered rendering** — New `relevanceFilter` on `TableDefinition` and `setTaskContext()`/`getTaskContext()` on Lattice. Dynamically filter rows by relevance to the current task context before rendering.
- **Context enrichment pipeline** — New `enrich` option on `TableDefinition`. Array of transform functions applied to rows after filtering but before rendering — use for clustering, annotation, summarization, or cross-referencing.
- **Reward-scored memory** — New `rewardTracking` and `pruneBelow` options on `TableDefinition`, and `reward()` method on Lattice. Auto-adds `_reward_total` and `_reward_count` columns. Rows sorted by reward during render. Low-scoring rows auto-pruned via soft-delete.
- **Semantic search via embeddings** — New `embeddings` option on `TableDefinition` and `search()` method on Lattice. Bring your own embedding function. Embeddings stored in a companion table, cosine similarity computed in JS. Supports `topK` and `minScore` options.
- Exported new types: `WritebackValidationResult`, `RewardScores`, `EmbeddingsConfig`, `SearchOptions`, `SearchResult`.
- Exported new utilities: `estimateTokens()`, `applyTokenBudget()`.

## [1.2.3] — 2026-04-04

### Security

- **CRITICAL**: Fixed command injection in `autoUpdate()` — replaced `execSync` with `execFileSync` + semver validation
- **HIGH**: Fixed path traversal in entity slug rendering — validates slug characters and verifies resolved paths stay within output directory
- **MEDIUM**: Fixed SQL injection in reverse-sync — validates table names with same pattern as column names

## [1.2.0] — 2026-04-04

### Changed

- **Auto-combined entity context** — When an entity has multiple rendered files, the first declared file automatically becomes the combined output containing all connected context. No `combined` config needed — the primary entity file (e.g., PROJECT.md) always includes the full assembled context by default. Explicit `combined` config still works for custom output filenames or exclusions.

## [1.1.1] — 2026-04-04

### Fixed

- **ALTER TABLE with non-constant defaults** — `_addMissingColumns` now handles columns with `DEFAULT CURRENT_TIMESTAMP`, `datetime('now')`, or `RANDOM()` defaults. SQLite rejects non-constant defaults in ALTER TABLE ADD COLUMN. The fix strips the non-constant default for the ALTER statement, then backfills existing rows with `CURRENT_TIMESTAMP`. This resolves crash-on-startup when upgrading to a schema that adds new timestamp columns to existing tables.

## [1.1.0] — 2026-04-04

### Added

- **`autoUpdate()` export** — Call at app startup to automatically check npm for a newer version of `latticesql` and install it. Returns `AutoUpdateResult` with `updated`, `packages`, and `restartRequired` fields. Safe to call on every startup — skips if already on latest. Pass `{ quiet: true }` to suppress console output.

## [1.0.0] — 2026-04-04

### Changed

- **Stable release** — latticesql is now 1.0.0. The API is considered stable. Consumers using `^1.0.0` will automatically receive all non-breaking updates.

## [0.18.4] — 2026-04-04

### Added

- **CLI update checker** — `lattice` CLI now checks for new versions in the background and prints a notice when an update is available. Cached for 24 hours.
- **`lattice update` command** — self-update to the latest version from npm.

## [0.18.0] — 2026-04-03

### Added

- **Protected entity contexts** — Set `protected: true` on an entity context to prevent its data from leaking into other entities' rendered context files. Sources referencing a protected table return empty results; within the same protected table, sources return self-only. Access protected data via direct database queries.
- **At-rest encryption** — Set `encrypted: true` (all text columns) or `encrypted: { columns: ['value'] }` (specific columns) on an entity context for transparent AES-256-GCM encryption. Requires `encryptionKey` in `LatticeOptions`. Encrypted values stored as `enc:<base64>`, plaintext values pass through unchanged (migration-safe).
- **`encryptionKey`** option in `LatticeOptions` — master key for deriving AES-256 encryption keys via scrypt.
- **Encryption utilities** — `encrypt()`, `decrypt()`, `deriveKey()`, `isEncrypted()` exported for direct use.

## [0.17.0] — 2026-04-03

### Added

- **`insertReturning(table, row)`** — Insert a row and return the full inserted row (including auto-generated id and default values). Equivalent to `insert()` + `get()` in a single call.
- **`updateReturning(table, id, row)`** — Update a row and return the full updated row. Equivalent to `update()` + `get()`.
- **`migrate(migrations)`** — Run versioned migrations after `init()`. Useful for package-level schema changes applied at runtime. Supports string-based version identifiers (e.g. `"@mypackage:1.0.0"`).
- **Schema-only tables** — `render` and `outputFile` are now optional in `TableDefinition`. Tables defined without rendering produce schema but no output files.
- **Composite primary key auto-constraint** — When `primaryKey` is an array (e.g. `['user_id', 'tag_id']`), a `PRIMARY KEY(...)` table constraint is now automatically generated in the CREATE TABLE statement.

### Changed

- **Migration version type** — `Migration.version` now accepts `number | string` (was `number` only). The `__lattice_migrations` table uses `TEXT PRIMARY KEY` instead of `INTEGER PRIMARY KEY` to support both numeric and string-based versions. Existing integer versions continue to work (backward compatible).
- Migration sort order uses locale-aware numeric comparison (`localeCompare` with `{ numeric: true }`) instead of arithmetic subtraction.

## [0.16.2] — 2026-04-03

### Fixed

- Removed internal build-process file that was accidentally committed to the public repo
- Lint errors: unused `configDir` parameter in `config/parser.ts`, `let` → `const` in integration test
- `outputFile` path doubling when using config-parsed entity tables with relative paths

## [0.16.1] — 2026-04-01

### Fixed

- Export `contentHash()` from package index (documented but previously inaccessible)
- Resolve all 282 ESLint errors blocking CI (floating promises, non-null assertions, template expressions, unused imports)
- Update compatibility matrix for v0.16.0 features

## [0.16.0] — 2026-04-01

### Added

- **Reverse-sync**: Detects external modifications to rendered entity context files and sweeps changes back into the database before re-rendering. Opt-in per file via `reverseSync` function on `EntityFileSpec`. Supports dry-run mode (`reverseSync: 'dry-run'`).
- **Manifest v2**: Per-file SHA-256 content hashes stored in `.lattice/manifest.json` for change detection. v1 manifests are auto-migrated (reverse-sync skips files with no hash baseline).
- New types: `ReverseSyncUpdate`, `ReverseSyncResult`, `ReverseSyncError`, `EntityFileManifestInfo`
- New exports: `entityFileNames()`, `normalizeEntityFiles()`, `isV1EntityFiles()` manifest helpers
- `contentHash()` exported from `render/writer`

### Changed

- `ReconcileResult` now includes `reverseSync: ReverseSyncResult | null`
- `ReconcileOptions` accepts `reverseSync?: boolean | 'dry-run'` (default: `true`)
- Manifest `version` bumped from `1` to `2`; `entities` field changed from `string[]` to `Record<string, EntityFileManifestInfo>`

## [0.14.0] — 2026-03-28

### Added

- **Report framework**: `buildReport()` with time-windowed sections, duration parsing ('8h','24h','7d'), four format types (count_and_list, counts, list, custom)

## [0.13.0] — 2026-03-28

### Added

- **Seeding DSL**: `seed()` method for bulk upsert from structured data (YAML/JSON). Links to entities via junction tables, soft-deletes removed entries. SeedConfig, SeedLinkSpec types.

## [0.12.0] — 2026-03-28

### Added

- **Writeback persistence**: Pluggable `WritebackStateStore` interface. `InMemoryStateStore` (default), `SQLiteStateStore` (persistent across restarts). `createSQLiteStateStore()` factory. `onArchive` lifecycle hook on WritebackDefinition.

## [0.11.0] — 2026-03-28

### Added

- **Generic CRUD layer**: `upsertByNaturalKey()`, `enrichByNaturalKey()`, `softDeleteMissing()`, `getActive()`, `countActive()`, `getByNaturalKey()` — work on ANY table via PRAGMA introspection (no `define()` required)
- **Junction table helpers**: `link()` (INSERT OR IGNORE/REPLACE), `unlink()` (DELETE matching)
- Internal: `_ensureColumnCache()` lazily populates column cache for unregistered tables

## [0.10.0] — 2026-03-27

### Added

- **Write hooks**: `defineWriteHook()` fires after insert/update/delete with table + column filtering. `WriteHook`, `WriteHookContext` types.

## [0.9.0] — 2026-03-27

### Added

- **Entity render templates**: `entity-table`, `entity-profile`, `entity-sections` declarative templates for `EntityFileSpec.render`. Backward compatible with function form. Auto read-only header + frontmatter.

## [0.8.0] — 2026-03-27

### Added

- **Junction column projection**: `junctionColumns` on `ManyToManySource` — include junction table columns in results with optional aliasing
- **Multi-column ORDER BY**: `orderBy` accepts `OrderBySpec[]` array with per-column direction

## [0.7.0] — 2026-03-27

### Added

- **Enriched source type**: `{ type: 'enriched', include: { ... } }` — starts with entity row, attaches related data as `_key` JSON string fields via declarative or custom sub-lookups

## [0.6.0] — 2026-03-27

### Added

- **Source query options**: `filters`, `orderBy`, `orderDir`, `limit`, `softDelete` on `HasManySource`, `ManyToManySource`, `BelongsToSource`
- **sourceDefaults**: `EntityContextDefinition.sourceDefaults` merges into all relationship sources
- **Markdown utilities**: `frontmatter()`, `markdownTable()`, `slugify()`, `truncate()` — composable helpers for render functions

## [0.5.5] — 2026-03-27

### Fixed

- Removed all consumer-specific references from source code and documentation
- `READ_ONLY_HEADER` now uses generic text; `createReadOnlyHeader()` factory for custom headers
- `parseSessionMD` / `parseMarkdownEntries` accept `SessionParseOptions` for configurable entry types/aliases
- Added `scripts/check-generic.sh` guardrail wired into `prepublishOnly`

---

## [0.5.0] — 2026-03-23

### Added

**Entity Context Directories**

A new high-level API for generating parallel file-system trees that mirror your database schema — one directory per entity, one file per relationship type, and an optional combined context file per entity. Replaces ad-hoc `defineMulti()` patterns for per-entity context generation.

- `defineEntityContext(table, def)` — new `Lattice` method, must be called before `init()`. Returns `this` for chaining.
- `EntityContextDefinition` — top-level config type: `slug`, `index?`, `files`, `combined?`, `directory?`, `directoryRoot?`, `protectedFiles?`
- `EntityFileSpec` — per-file spec: `source`, `render`, `budget?`, `omitIfEmpty?`
- Five source types for per-file row resolution:
  - `SelfSource` (`{ type: 'self' }`) — entity row itself
  - `HasManySource` (`{ type: 'hasMany', table, foreignKey, references? }`) — rows on a related table pointing back
  - `ManyToManySource` (`{ type: 'manyToMany', junctionTable, localKey, remoteKey, remoteTable, references? }`) — rows from a remote table via a junction table
  - `BelongsToSource` (`{ type: 'belongsTo', table, foreignKey, references? }`) — single parent row via FK on this entity
  - `CustomSource` (`{ type: 'custom', query: (row, adapter) => Row[] }`) — fully custom query
- `resolveEntitySource(source, entityRow, entityPk, adapter)` — internal resolver (exported for testing)
- `truncateContent(content, budget?)` — truncates at `budget` characters with a `*[truncated — context budget exceeded]*` notice
- `combined` option — concatenates all rendered files with `\n\n---\n\n` dividers into a single combined file per entity, respecting an `exclude` list
- `omitIfEmpty` flag — skip writing a file when the source returns zero rows
- `budget` — per-file character limit with truncation notice
- `directoryRoot` — top-level directory owned by the entity context (defaults to table name); used by orphan cleanup
- `protectedFiles` — filenames Lattice must never delete during cleanup (e.g. `SESSION.md`)
- `directory(row)` — optional custom directory path function (overrides default `{directoryRoot}/{slug}` pattern)

**Lifecycle Management**

Tracks what Lattice has generated and removes orphaned files/directories when entities are deleted or definitions change.

- `reconcile(outputDir, options?)` — new `Lattice` method: runs a full render cycle then cleans up orphans. Returns `ReconcileResult` (`RenderResult` + `CleanupResult`)
- `ReconcileOptions` / `ReconcileResult` — new types
- `WatchOptions.cleanup?: CleanupOptions` — if set, the watch loop reads the previous manifest before each render and runs orphan cleanup after
- `WatchOptions.onCleanup?: (result: CleanupResult) => void` — callback fired after each cleanup cycle in watch mode
- `CleanupOptions` — `{ removeOrphanedDirectories?, removeOrphanedFiles?, protectedFiles?, dryRun?, onOrphan? }`
- `CleanupResult` — `{ directoriesRemoved, filesRemoved, directoriesSkipped, warnings }`
- `cleanupEntityContexts(outputDir, entityContexts, currentSlugsByTable, manifest, options, newManifest?)` — internal cleanup function (exported)

**Manifest**

After every render cycle that includes entity contexts, Lattice writes `.lattice/manifest.json` inside `outputDir`. The manifest is the authoritative record of what Lattice generated — it is what enables safe orphan cleanup.

- `readManifest(outputDir)` — read `.lattice/manifest.json`; returns `LatticeManifest | null`
- `writeManifest(outputDir, manifest)` — write the manifest atomically
- `manifestPath(outputDir)` — return the path to the manifest file
- `LatticeManifest` — `{ version: 1, generated_at, entityContexts: Record<string, EntityContextManifestEntry> }`
- `EntityContextManifestEntry` — `{ directoryRoot, indexFile?, declaredFiles, protectedFiles, entities: Record<slug, string[]> }`

**Documentation**

- `docs/entity-context.md` — complete guide to entity context directories
- Updated `docs/api-reference.md` — all v0.5 types and methods
- Updated `docs/architecture.md` — lifecycle module, manifest, cleanup
- Updated `README.md` — entity context and lifecycle sections

### Changed

- `package.json` version → `0.5.0`
- `RenderEngine._renderEntityContexts()` now returns `Record<string, EntityContextManifestEntry>` and manifests are written after each render cycle that includes entity contexts
- `SyncLoop.watch()` reads the previous manifest before render and calls `RenderEngine.cleanup()` after render when `WatchOptions.cleanup` is set
- `Lattice.reconcile()` reads previous manifest, renders (writing new manifest), then compares old vs new manifest to detect orphans

---

## [0.4.0] — 2026-03-22

### Added

**YAML schema config (`lattice.config.yml`)**

- New `LatticeConfig` / `LatticeEntityDef` / `LatticeFieldDef` types for the YAML config schema
- `parseConfigFile(configPath)` — reads and validates a `lattice.config.yml` file, returns `ParsedConfig`
- `parseConfigString(yaml, configDir)` — parses a raw YAML string (useful in tests and dynamic config)
- Field types: `uuid`, `text`, `integer`, `int`, `real`, `float`, `boolean`, `bool`, `datetime`, `date`, `blob`
- Automatic `belongsTo` relation creation from `ref: <entity>` on a field — `_id` suffix stripped from relation name
- Entity-level `primaryKey` override for composite or custom primary keys
- `render` spec in YAML: accepts a built-in template name string or `{ template, formatRow }` object
- `outputFile` paths resolved relative to the config file directory at parse time

**`lattice generate` CLI**

- New `lattice` binary bundled with the package (`bin.lattice = ./dist/cli.js`)
- `lattice generate` command — reads config, writes `generated/types.ts` and `generated/migration.sql`
- `--config / -c` flag — path to config file (default: `./lattice.config.yml`)
- `--out / -o` flag — output directory (default: `./generated`)
- `--scaffold` flag — also create empty scaffold context files at each entity's `outputFile` path
- `--version / -v` — print installed version
- `--help / -h` — print usage

**`generateTypes(config)`** — TypeScript interface generator

- One `export interface` per entity, PascalCase entity names
- Fields marked `primaryKey: true` or `required: true` are non-optional; all others have `?`
- Inline comment `// → <target>` on `ref` fields
- Type mapping: uuid/text/datetime/date → `string`; integer/int/real/float → `number`; boolean/bool → `boolean`; blob → `Buffer`

**`generateMigration(config)`** — SQL migration generator

- `CREATE TABLE IF NOT EXISTS` per entity
- Full column spec generation: `PRIMARY KEY`, `NOT NULL`, `DEFAULT` (string-quoted or numeric)

**`Lattice({ config })` constructor form**

- New `LatticeConfigInput` type: `{ config: string; options?: LatticeOptions }`
- Constructor overload: `new Lattice({ config: './lattice.config.yml' })` reads the YAML file, resolves `dbPath`, and calls `define()` for each entity automatically

**Exports added to `latticesql`:**

- `parseConfigFile`, `parseConfigString`, `ParsedConfig`
- `LatticeConfigInput`
- `LatticeFieldType`, `LatticeFieldDef`, `LatticeEntityDef`, `LatticeEntityRenderSpec`, `LatticeConfig`

**Documentation**

- `docs/api-reference.md` — complete per-method API reference
- `docs/configuration.md` — full YAML config format guide
- `docs/templates.md` — built-in templates and render hooks
- `docs/migrations.md` — schema migration workflow
- `docs/cli.md` — CLI reference
- `docs/architecture.md` — internals walkthrough
- `docs/examples/agent-system.md` — complete agent system example
- `docs/examples/ticket-tracker.md` — complete ticket tracker example
- `docs/examples/cms.md` — complete CMS example
- `CONTRIBUTING.md` — dev setup and contribution guide

### Changed

- `package.json` version → `0.4.0`
- `better-sqlite3` → `^12.8.0` (Node 25 compatibility; Node 25 requires the updated C++ bindings)
- `tsup.config.ts` refactored to array form: separate library and CLI build entries; CLI entry adds `#!/usr/bin/env node` shebang via `banner`
- `yaml` `^2.8.3` added to runtime dependencies

### Fixed

- TypeScript `exactOptionalPropertyTypes` error in `src/render/templates.ts` — `_NormalizedSpec.hooks` typed as `hooks?: RenderHooks | undefined`
- CLI `ParsedArgs.command` typed as `command?: string | undefined` to satisfy strict optional property checks

---

## [0.3.0] — 2026-03-18

### Added

**Built-in render templates**

- `BuiltinTemplateName` type: `'default-list' | 'default-table' | 'default-detail' | 'default-json'`
- `RenderHooks` interface: `{ beforeRender?, formatRow? }`
- `TemplateRenderSpec` interface: `{ template: BuiltinTemplateName; hooks?: RenderHooks }`
- `RenderSpec` union type: function | `BuiltinTemplateName` | `TemplateRenderSpec`
- `compileRender()` — converts any `RenderSpec` to `(rows: Row[]) => string` at `define()` time (zero per-cycle overhead)
- `interpolate(template, row, relations)` — `{{field}}` and `{{relationName.field}}` substitution engine

**Built-in template implementations**

- `default-list` — bulleted Markdown list, supports `formatRow` hook
- `default-table` — GitHub-flavoured Markdown table, headers from first row keys
- `default-detail` — one Markdown section per row, supports `formatRow` hook
- `default-json` — `JSON.stringify(rows, null, 2)` in a fenced code block

**`beforeRender` hook** — transform or filter rows before rendering; called before `formatRow`

**`formatRow` hook** — accepts a `(row: Row) => string` function or a `{{field}}` template string

**Relation resolution in templates** — `belongsTo` relations declared in `TableDefinition.relations` are joined in-process when `{{rel.field}}` tokens are found in `formatRow` strings

### Changed

- `TableDefinition.render` now accepts `RenderSpec` (function | string | object) instead of only `(rows: Row[]) => string`
- All existing function-form render definitions are fully backward compatible — no changes needed

---

## [0.2.0] — 2026-03-14

### Added

**Configurable primary key**

- `TableDefinition.primaryKey?: PrimaryKey` — single column name (`string`) or composite (`string[]`)
- Default remains `'id'` (UUID auto-generated on insert when absent)
- Custom PK: caller must supply value on every insert; no UUID generated
- Composite PK: `PkLookup` accepts `Record<string, unknown>` in addition to `string`

**Expanded query filters**

- `FilterOp` type: `'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'isNull' | 'isNotNull'`
- `Filter` interface: `{ col: string; op: FilterOp; val?: unknown }`
- `QueryOptions.filters?: Filter[]` — advanced filter clauses combined with `where` using AND
- `CountOptions` — same `where` + `filters` as `QueryOptions`

**Relationship declarations**

- `BelongsToRelation` — `{ type: 'belongsTo', table, foreignKey, references? }`
- `HasManyRelation` — `{ type: 'hasMany', table, foreignKey, references? }`
- `TableDefinition.relations?: Record<string, Relation>` — metadata used by template rendering in v0.3+

**`tableConstraints`**

- `TableDefinition.tableConstraints?: string[]` — SQL table-level constraints appended to `CREATE TABLE`
- Required for composite PKs and multi-column unique constraints

**`upsertBy(table, col, val, row)`** — insert-or-update by an arbitrary column (not the PK)

**`count(table, opts?)`** — count rows with optional where/filters

### Changed

- `SchemaManager.define()` validates that the primary key column is non-empty
- `_pkWhere()` now dispatches on `PkLookup` type to build correct WHERE clause

---

## [0.1.0] — 2026-03-10

### Added

Initial release.

**Core API**

- `Lattice(path, options?)` constructor
- `define(table, def)` — register a table schema
- `defineMulti(name, def)` — register a multi-table view
- `defineWriteback(def)` — register a writeback pipeline
- `init(options?)` — open database, apply schema, run migrations
- `close()` — close database connection
- `insert(table, row)` — insert a row; auto-generate UUID for default `id` PK
- `upsert(table, row)` — `INSERT OR REPLACE` semantics
- `update(table, id, row)` — update one row by PK
- `delete(table, id)` — delete one row by PK
- `get(table, id)` — fetch one row by PK
- `query(table, opts?)` — query rows with `where`, `orderBy`, `orderDir`, `limit`, `offset`
- `render(outputDir)` — render all tables to context files once
- `sync(outputDir)` — render + process writeback entries
- `watch(outputDir, opts?)` — start polling sync loop; returns `StopFn`
- `on(event, handler)` — subscribe to `'audit'`, `'render'`, `'writeback'`, `'error'` events
- `db` escape hatch — direct `better-sqlite3` database access

**Schema**

- `TableDefinition` — `columns`, `render` (function only), `outputFile`, `filter`, `primaryKey` (default `'id'`)
- Migration system — `_lattice_migrations` tracking table, version-based deduplication

**Security**

- `Sanitizer` — null-byte stripping, field length limits, audit event emission
- `SecurityOptions` — `sanitize`, `auditTables`, `fieldLimits`

**Infrastructure**

- `SQLiteAdapter` — `better-sqlite3` wrapper with WAL mode + busy timeout support
- `SchemaManager` — schema registry, `applySchema()`, `applyMigrations()`
- `RenderEngine` — file-write deduplication (skip unchanged content)
- `SyncLoop` — `setInterval`-based polling
- `WritebackPipeline` — offset-based file reading with dedup key support

**Exports**

- All public types exported from `latticesql`
- ESM + CJS dual build via tsup

## [0.18.2] — 2026-04-03

### Added

- **`fixSchemaConflicts(db, checks)`** — Pre-init utility to resolve legacy schema conflicts. Renames tables with incompatible columns to `_legacy_{name}` so `init()` can create fresh tables. Also handles `__lattice_migrations` INTEGER→TEXT PK migration.
