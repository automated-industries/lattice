// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const settingsDrawerCss = `    /* ── Settings / Version-history TAKEOVER panel ─────────────
       One full-workspace panel below the header (Settings and Version history
       share it): only the topbar stays visible; the trigger button highlights
       while open and clicking it again collapses. */
    .drawer-backdrop {
      /* Box geometry comes from the shared backdrop group; the scrim here is
         deliberately LIGHTER than the default so the header stays legible. */
      background: var(--overlay-dim-soft);
      /* BELOW the topbar (z 100): the takeover replaces the workspace, but the
         header and its triggers must stay clickable — the clock/gear COLLAPSE
         the open panel. */
      z-index: var(--z-takeover-scrim); opacity: 0; transition: opacity 0.2s ease;
    }
    .drawer-backdrop.open { opacity: 1; }
    .settings-drawer {
      position: fixed; left: 0; right: 0; bottom: 0; top: 49px; /* refined by JS to the real header height */
      background: var(--surface);
      border-top: 1px solid rgba(15, 23, 42, 0.06);
      z-index: var(--z-takeover); display: flex; flex-direction: column;
      /* Slide in from the top (down from behind the header) on open, back up on close.
         Kept under the 220ms hide-timeout in closeSettingsDrawer so the panel isn't
         display:none'd mid-slide. */
      transform: translateY(-100%);
      transition: transform 0.2s ease;
    }
    .settings-drawer.open { transform: translateY(0); }
    /* display:flex above would override the hidden attribute's display:none —
       and an invisible full-workspace panel would swallow every click. */
    .settings-drawer[hidden] { display: none; }
    .settings-drawer:not(.open) { pointer-events: none; }
    /* While the drawer takeover is open, freeze the document scroll so the columns
       beneath it can't scroll (toggled by open/closeSettingsDrawer). The drawer's own
       body (#drawer-body) keeps its overflow-y:auto below. */
    body.drawer-open { overflow: hidden; }
    .settings-drawer .drawer-body { max-width: 980px; width: 100%; margin: 0 auto; }
    /* Highlight the header trigger whose takeover is open. */
    .history-btn.on, #configure-trigger.on { background: var(--accent-soft); color: var(--accent); }
    .drawer-head {
      flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
      padding: 14px 18px; border-bottom: 1px solid var(--border);
    }
    .drawer-title { font-size: 16px; font-weight: 600; }
    .drawer-close {
      margin-left: auto; width: 30px; height: 30px; border: 1px solid var(--border);
      border-radius: var(--r-sm); background: transparent; color: var(--text-muted);
      cursor: pointer; font-size: 16px; line-height: 1;
    }
    .drawer-close:hover { background: var(--row-hover); color: var(--text); }
    .drawer-tabs {
      flex: 0 0 auto; display: flex; gap: 4px; padding: 10px 14px 0;
    }
    /* Version history is its OWN takeover (opened via the header clock), not a
       Settings sub-tab — so the tab row is hidden while history is showing. The
       class rule above out-specifies bare [hidden], hence this explicit rule. */
    .drawer-tabs[hidden] { display: none; }
    .drawer-tab {
      padding: 8px 14px; border: 1px solid var(--border); border-bottom: none;
      border-radius: var(--r-sm) var(--r-sm) 0 0; background: var(--surface-2); color: var(--text-muted);
      font-size: 13px; cursor: pointer;
    }
    .drawer-tab.active { background: var(--surface); color: var(--text); font-weight: 600; border-color: var(--border-strong); }
    .drawer-body { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; padding: 4px 4px 20px; }
    .drawer-body .teams-page { padding: 16px 18px; }
    /* Lattice version, pinned to the bottom of the Settings drawer (moved here
       from the header, whose spot the status pill now occupies). */
    .drawer-version {
      flex: 0 0 auto; padding: 10px 18px; border-top: 1px solid var(--border);
      color: var(--text-muted); font-size: 12px;
    }
    .drawer-version .app-version { color: var(--text); }

    /* ── Connector / database panel cards + forms (MCP Connectors + Databases
          Configure tabs both render inline; there are no side-drawers) ────── */
    /* Standardized connector logo — uniform box regardless of source aspect ratio. */
    .connector-icon { width: 16px; height: 16px; object-fit: contain; flex: none; vertical-align: middle; }
    .conn-card-head .connector-icon { width: 22px; height: 22px; }
    .conn-lead { margin: 4px 12px 10px; font-size: 12px; color: var(--text-muted); line-height: 1.5; }
    .conn-msg { margin: 0 12px 8px; font-size: 12px; color: var(--text-muted); min-height: 14px; }
    .conn-card {
      margin: 0 12px 12px; padding: 12px;
    }
    .conn-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .conn-card-title { font-size: 14px; font-weight: 600; }
    .conn-form { display: flex; flex-direction: column; gap: 10px; }
    /* Fields use the global bubble field base (same as the onboarding screen) so
       every form across the app looks the same; the label wrapper is styled here. */
    .conn-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
    /* Box (background / border / radius / padding) comes from the global bubble
       field base so these match the onboarding fields exactly; only layout is set
       here. */
    .conn-field input,
    .conn-field select {
      width: 100%; box-sizing: border-box; line-height: 1.4;
    }
    .conn-or { text-align: center; color: var(--text-muted); font-size: 12px; margin: 2px 0; }
    .conn-form-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 6px; }
    .conn-form-actions .btn { height: 36px; padding: 0 16px; border-radius: var(--r-md); font-weight: 600; }
    .conn-form-actions .btn.primary { background: var(--accent); color: var(--btn-text); border: none; }
    .conn-help { font-size: 12px; color: var(--text-muted); }
    /* Prefab connector catalog grid (#mcp-catalog). */
    .conn-cat-sec { margin: 0 0 16px; }
    .conn-cat-head { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-muted); margin: 0 0 8px; }
    .conn-cat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
    .conn-cat-card { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); cursor: pointer; text-align: left; transition: border-color 0.12s, background 0.12s; }
    .conn-cat-card:hover:not(:disabled) { border-color: var(--accent); }
    .conn-cat-card:disabled { opacity: 0.5; cursor: not-allowed; }
    .conn-cat-icon { width: 24px; height: 24px; border-radius: var(--r-sm); }
    .conn-cat-label { font-size: 13px; font-weight: 600; }
    .conn-cat-hint { font-size: 11px; color: var(--text-muted); }
    .conn-cat-more { margin: 0 0 16px; }
    .conn-cat-more > summary { cursor: pointer; font-size: 12px; color: var(--text-muted); margin: 0 0 8px; }
    .conn-cat-note { font-size: 12px; color: var(--text-muted); margin: 4px 0 0; }
    .conn-connected { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .conn-status { font-size: 12px; text-transform: capitalize; }
    .conn-sub { font-size: 12px; color: var(--text-muted); }
    .conn-err { margin-top: 6px; font-size: 12px; color: var(--danger); }
    /* Sidebar connector row: logo with a small status dot overlay. */
    .src-conn-ic { position: relative; display: inline-flex; flex: none; }
    .src-conn-dot {
      position: absolute; right: -2px; bottom: -2px; width: 7px; height: 7px;
      border-radius: 50%; border: 1px solid var(--bg);
    }

    /* ── Databases tab: a full-width, multi-column table of connected databases
          plus the inline add/edit form. ────── */
    .db-panel { padding: 4px 8px 8px; }
    .db-lead { margin: 4px 0 16px; font-size: 13px; color: var(--text-muted); line-height: 1.5; max-width: 720px; }
    .db-empty { padding: 20px; text-align: center; color: var(--text-muted); font-size: 13px;
      border: 1px dashed var(--border); border-radius: var(--r-md); margin-bottom: 20px; }
    .db-table-wrap { width: 100%; overflow-x: auto; margin-bottom: 24px;
      border: 1px solid var(--border); border-radius: var(--r-md); }
    .db-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .db-table thead th {
      text-align: left; font-weight: 600; color: var(--text-muted); font-size: 11px;
      text-transform: uppercase; letter-spacing: 0.04em; padding: 12px 16px;
      border-bottom: 1px solid var(--border); background: var(--surface-2); white-space: nowrap;
    }
    .db-table tbody td { padding: 14px 16px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    .db-table tbody tr:last-child td { border-bottom: none; }
    .db-table .db-row:hover td { background: var(--surface-2); }
    .db-name { font-weight: 600; color: var(--text); }
    .db-mono { font-family: var(--font-mono, ui-monospace, monospace); color: var(--text-muted); font-size: 12px; }
    .db-num { color: var(--text); white-space: nowrap; }
    .db-muted { color: var(--text-muted); white-space: nowrap; }
    .db-status { display: inline-flex; align-items: center; gap: 6px; text-transform: capitalize; white-space: nowrap; }
    .db-status-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .db-actions { text-align: right; white-space: nowrap; }
    .db-actions .btn { margin-left: 8px; }
    .db-err-row td { padding-top: 0; border-bottom: 1px solid var(--border); }
    /* The add/edit form: a card with a responsive multi-column field grid. */
    .db-form-host { max-width: 720px; }
    .db-form-card { margin: 0; padding: 18px; border: 1px solid var(--border); border-radius: var(--r-md); }
    .db-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
    @media (max-width: 640px) { .db-form-grid { grid-template-columns: 1fr; } }

    /* ── Configure drawer: Data Model + Inputs tabs ── */
    /* Data Model + Graph are their own Configure tabs and run EDGE-TO-EDGE — the drawer's
       980px reading cap is lifted for them so the explorer / graph canvas span the pane. */
    .settings-drawer .drawer-body.dm-wide { max-width: none; }
    .dm-panel { min-width: 0; }
    .dm-panel[hidden] { display: none; }
    /* Data-model planner panel: applied fixes + reviewable suggestions. */
    .dm-plan-note { color: var(--text-muted); font-size: 12px; padding: 8px 2px; }
    .dm-plan-head { font-weight: 600; font-size: 12px; margin: 8px 2px 6px; }
    .dm-plan-applied { font-size: 12px; padding: 4px 2px; color: var(--text-muted); }
    .dm-plan-card {
      border: 1px solid var(--border); border-radius: var(--r-sm); padding: 8px; margin: 6px 0;
    }
    .dm-plan-why { font-size: 12px; margin-bottom: 6px; }
    /* Data Model tab: the tiered Tables explorer full width. The optional
       column/relationship editor drops in BELOW it (full width), never a fixed side
       column, so selecting an object keeps the explorer spanning the whole pane. */
    .dm-fullwidth { display: block; }
    .dm-fullwidth #model-tables-host { width: 100%; }
    .dm-fullwidth .dm-panel { margin-top: 12px; }
    .dm-fullwidth .dm-panel:empty { margin-top: 0; }
    /* Graph tab: a Link/Merge (+ drill Back) toolbar over a full-height graph canvas. */
    .graph-tab { display: flex; flex-direction: column; height: 76vh; }
    .graph-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .graph-tools-spacer { flex: 1 1 auto; }
    .graph-drill-label { font-weight: 600; font-size: 14px; }
    .graph-tab .brain-graph { flex: 1 1 auto; height: auto; min-height: 0; }
    .inputs-group { margin-bottom: 20px; }
    /* "Edit columns & relationships" affordance in the Data Model detail panel. */
    .mt-detail-edit { display: inline-block; margin-top: 10px; margin-left: 10px; padding: 6px 12px;
      border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2);
      color: var(--text); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
    .mt-detail-edit:hover { background: var(--row-hover); }

    /* ── Markdown context chips and provenance card ────────────────────── */
    .chip-trace {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px 8px; margin: 0 2px; border-radius: var(--r-sm);
      background: var(--accent-soft); color: var(--accent);
      font-size: 13px; font-weight: 500; white-space: nowrap;
      cursor: pointer; user-select: none; transition: background 0.15s ease, box-shadow 0.15s ease;
      border: 1px solid var(--accent);
    }
    .chip-trace:hover { background: var(--accent); color: var(--btn-text); }
    .chip-trace:focus { outline: 2px solid var(--accent); outline-offset: 2px; }
    .source-chips-row {
      display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; padding: 8px;
      border-radius: var(--r-sm); background: var(--surface-2);
    }
    .source-chip {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px 8px; border-radius: var(--r-sm);
      background: var(--surface); border: 1px solid var(--border);
      color: var(--text); font-size: 12px; font-weight: 500; white-space: nowrap;
      cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease;
    }
    .source-chip:hover { background: var(--row-hover); border-color: var(--border-strong); }
    /* Trace-link arrival: the source data line a chat answer drew from flashes
       so the eye lands on it, then settles back to normal. */
    .trace-hl {
      background: color-mix(in srgb, var(--accent) 18%, transparent);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent);
      border-radius: var(--r-xs);
      transition: background 1.2s ease, box-shadow 1.2s ease;
    }
    .provenance-card {
      display: flex; flex-direction: column;
      background: var(--surface); border: 1px solid var(--border-strong);
      border-radius: var(--r-md); box-shadow: var(--shadow-lg);
      z-index: var(--z-popover); pointer-events: auto;
    }
    .provenance-card-body {
      padding: 12px; display: flex; flex-direction: column; gap: 8px;
    }
    .provenance-card-header {
      font-weight: 500; word-break: break-word; color: var(--text);
    }
    .provenance-card-meta {
      font-size: 0.85em; color: var(--text-muted);
    }
    .provenance-card-meta code {
      background: var(--surface-2); padding: 2px 4px; border-radius: 3px;
      font-family: var(--font-mono, ui-monospace, monospace);
    }
    .provenance-card-content {
      font-size: 0.85em; border-top: 1px solid var(--border); padding-top: 8px; margin-top: 4px;
    }
    .provenance-fields {
      display: flex; flex-direction: column; gap: 8px;
    }
    .provenance-field {
      margin-bottom: 6px; color: var(--text);
    }
    .provenance-field strong {
      color: var(--text); font-weight: 600;
    }
    .provenance-tier {
      font-size: 0.85em; color: var(--text-muted); margin-bottom: 8px;
      padding-bottom: 8px; border-bottom: 1px solid var(--border);
    }
`;
