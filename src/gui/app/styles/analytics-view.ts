// Auto-composed section of the GUI stylesheet (see styles/index.ts). The
// Analytics view: the app-level view toggle, the Dashboards sidebar, the
// dashboard tab strip + canvas, the assistant dock's status line, and the
// header trigger visibility. The tab buttons themselves reuse the .tab /
// .tab-close / .tab-overflow-* classes from tabs.ts (styles) — only the
// container differs.
export const analyticsViewCss = `    /* ── Single workspace layout ────────────────────────── */
    /* One 3-column layout (no view flip): left sidebar │ Workspace tabs │ the
       persistent Ask Gladys dock (its width is user-adjustable via the divider). */
    .layout {
      display: grid;
      grid-template-columns: var(--nav-width) minmax(0, 1fr) var(--ask-dock-width, 360px);
      height: calc(100vh - 56px);
    }
    /* The Configure button (top-right) pushes to the far right of the header. */
    .configure-trigger {
      margin-left: auto;
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 12px; cursor: pointer;
      border: 1px solid var(--border); background: var(--surface-2);
      color: var(--text); font-size: 13px; font-weight: 600; line-height: 1;
    }
    .configure-trigger:hover { background: var(--row-hover); }
    .configure-trigger svg { width: 13px; height: 13px; }

    /* ── Dashboards sidebar ─────────────────────────────── */
    .dash-sidebar {
      display: flex; flex-direction: column; min-height: 0;
      /* The RAIL itself never scrolls — the one open accordion section scrolls
         internally (below), so the three section headers are always on screen. */
      height: 100%; overflow: hidden;
      background: var(--surface); border-right: 1px solid var(--border);
    }
    /* Fixed-header accordion: each section is a flex column whose header stays put and
       whose body scrolls. The OPEN section (body not [hidden]) grows to fill the rail;
       collapsed sections shrink to just their header. One is open at a time (JS
       enforces single-open), so the headers of the other two stay visible above/below. */
    .dash-section { display: flex; flex-direction: column; min-height: 0; }
    .dash-section:has(> .section-body:not([hidden])) { flex: 1 1 auto; min-height: 0; }
    .dash-section:has(> .section-body[hidden]) { flex: 0 0 auto; }
    .dash-section > .nav-section-head, .dash-section > .nav-head-row { flex: 0 0 auto; }
    .dash-section > .section-body:not([hidden]) { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
    /* Dashboards header row: the collapse toggle fills the row, the "+" sits at the end. */
    .nav-head-row { display: flex; align-items: center; gap: 4px; padding-right: 8px; }
    .nav-head-row .nav-section-head { flex: 1 1 auto; }
    /* The Dashboards body holds #dash-list (its own padding) — no tree indent. */
    .section-body[data-group-body="nav-dashboards"] { padding-left: 0; }
    #dash-list { flex: 0 0 auto; padding: 8px; display: flex; flex-direction: column; gap: 2px; }
    .dash-item {
      display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; align-items: center;
      column-gap: 8px; width: 100%; text-align: left;
      padding: 8px 10px; border: 0; border-radius: var(--r-md); background: none;
      color: var(--text); font-size: 13px; cursor: pointer;
    }
    .dash-item:hover { background: var(--surface-2); }
    .dash-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
    .dash-item-icon { text-align: center; font-size: 13px; }
    .dash-item-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dash-item-desc {
      grid-column: 2 / -1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 12px; color: var(--text-muted); font-weight: 400;
    }
    .dash-item .vis-indicator { justify-self: end; }
    .dash-list-empty { font-size: 13px; padding: 14px 10px; }

    /* ── Left-sidebar nav sections (Tables / Files) ── */
    .nav-section { border-top: 1px solid var(--border); }
    .nav-section-head {
      width: 100%; display: flex; align-items: center; gap: 6px;
      background: var(--surface);
      padding: 8px 10px; border: 0; cursor: pointer;
      text-transform: uppercase;
    }
    /* Match the DASHBOARDS header (.col-header-text) EXACTLY: blue, 11px, 700, 0.08em.
       Target the label SPAN — the button itself carries button.section-label.section-toggle
       { font:inherit; color:var(--text-muted) } at higher specificity, so declaring these on
       .nav-section-head loses; the child span (no competing specificity) wins. */
    .nav-section-head .section-label-text {
      font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: var(--accent-deep);
    }
    /* Stay blue on hover too — a generic .section-toggle:hover .section-label-text
       (layout.ts, 0,3,0) would otherwise flip it to var(--text). DASHBOARDS never
       recolors on hover, so match that. This (0,4,0) beats it. */
    .section-toggle.nav-section-head:hover .section-label-text { color: var(--accent-deep); }
    .nav-tier-head {
      padding: 4px 12px; font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.05em; color: var(--text-muted); opacity: 0.75;
    }
    /* Schema group header within TABLES — a clickable collapse toggle (caret + label). */
    .nav-schema-head {
      width: 100%; display: flex; align-items: center; gap: 6px;
      padding: 4px 12px; border: 0; background: none; cursor: pointer; text-align: left;
    }
    .nav-schema-head .section-caret {
      font-size: 10px; line-height: 1; color: var(--text-muted); width: 10px; flex: none;
    }
    .nav-schema-label {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.05em; color: var(--text-muted); opacity: 0.85;
      min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .nav-schema-head:hover .nav-schema-label { opacity: 1; color: var(--text); }
    /* The schema body's table items already carry their own indent; don't double it. */
    .nav-schema > .section-body { padding-left: 0; }
    .nav-table-item {
      width: 100%; display: flex; align-items: center; gap: 8px; text-align: left;
      padding: 6px 10px 6px 14px; border: 0; border-radius: var(--r-sm); background: none;
      color: var(--text); font-size: 13px; cursor: pointer;
    }
    .nav-table-item:hover { background: var(--surface-2); }
    .nav-table-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
    .nav-item-ic { flex: 0 0 auto; }
    .nav-item-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nav-empty { font-size: 12px; padding: 8px 12px; }
    #nav-tables-list { padding-bottom: 6px; }

    /* ── Column headers (identical style to the Configure view) ── */
    /* All three carry the shared .col-header chrome. Accents mirror Configure:
       Dashboards=blue (inputs), Workspace=purple (model), Ask Gladys=teal
       (outputs). The Dashboards header holds a compact "+" on the right. */
    .col-dashboards { --col-accent: var(--accent-deep); justify-content: space-between; }
    .dash-new-btn {
      flex: 0 0 auto; justify-content: center;
      width: 24px; height: 24px; background: var(--surface-2);
      color: var(--text-muted); font-size: 15px; line-height: 1;
    }
    .dash-new-btn:hover { background: var(--row-hover); color: var(--text); }

    /* ── Workspace header + tab strip BELOW it + canvas ─── */
    .content-wrap { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    .an-workspace-head { flex: 0 0 auto; }
    /* The tab strip is its OWN row beneath the Workspace header (not inside it).
       Folder-style tabs so even a single tab reads unmistakably as a TAB rather
       than an underlined heading: a tinted strip with raised, rounded, bordered
       tabs whose ACTIVE one is filled to the canvas surface and merges into the
       content below. */
    .antabstrip {
      flex: 0 0 auto; display: flex; align-items: flex-end; min-height: 40px;
      padding: 6px 10px 0; border-bottom: 1px solid var(--border); background: var(--surface-2);
    }
    .antabstrip-tabs { display: flex; align-items: flex-end; gap: 4px; flex: 1; min-width: 0; }
    /* Every tab is FORCED to one width (flex:1 1 0 → equal share). With a few tabs each
       caps at the natural ~180px ("Certificate Holders" width); as more open they shrink
       uniformly down to 38px — icon-only (title/× clip under overflow:hidden). 38px is
       AN_TAB_MIN_W in analytics-tabs.ts; once even that won't fit, the trailing tabs
       collapse into the "⋯ N" overflow menu (JS), so no horizontal scrollbar appears. */
    .antabstrip .tab {
      border: 1px solid transparent; border-radius: var(--r-md) var(--r-md) 0 0;
      padding: 8px 12px; margin: 0; background: transparent;
      color: var(--text-muted); font-weight: 500;
      flex: 1 1 0; min-width: 38px; max-width: 180px;
    }
    /* The overflow "⋯ N" button is NOT a uniform tab — keep it natural width so it
       always shows its full count and never shrinks to an icon. */
    .antabstrip .tab.tab-overflow-btn { flex: 0 0 auto; min-width: 40px; max-width: none; }
    .antabstrip .tab:hover { background: var(--row-hover); color: var(--text); }
    .antabstrip .tab.active {
      background: var(--surface); border-color: var(--border);
      border-bottom: 1px solid var(--surface); margin-bottom: -1px;
      color: var(--text); font-weight: 600;
    }
    #analytics-content { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }

    /* ── Analytics home (empty states) ──────────────────── */
    .analytics-home {
      flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 10px; padding: 40px 24px; text-align: center;
    }
    .analytics-home-mark { font-size: 44px; line-height: 1; opacity: 0.9; }
    .analytics-home h1 { margin: 0; font-size: 22px; font-weight: 700; color: var(--text); }
    .analytics-home p { margin: 0; max-width: 46ch; }
    /* The empty-state prompt box — describe a dashboard / ask a question; it
       hands the turn to Gladys (streams into the dock). */
    .analytics-home-prompt {
      display: flex; align-items: flex-end; gap: 8px; width: 100%; max-width: 640px; margin-top: 6px;
    }
    .analytics-home-prompt textarea {
      flex: 1 1 auto; resize: none; min-height: 42px; max-height: 200px;
      background: var(--surface-2); color: var(--text);
      border: 1px solid var(--border-strong); border-radius: var(--r-lg);
      padding: 12px 12px; font: inherit; font-size: 14px; line-height: 1.4;
    }
    .analytics-home-prompt .btn { flex: 0 0 auto; height: 42px; padding: 0 16px; border-radius: var(--r-lg); font-weight: 600; }
    .analytics-home-prompt .btn.primary { background: var(--accent); color: var(--btn-text); border: none; }

    /* ── Ask Gladys dock: aligned header + adjustable width ── */
    .ask-dock { position: relative; }
    /* The head reuses the shared .col-header chrome (accent bar + 38px height)
       so it lines up with Dashboards + Workspace. Teal accent (outputs), plain
       surface — no gradient — matching the Configure column headers. */
    .ask-dock-head.col-header {
      --col-accent: var(--hue-teal-deep);
      justify-content: flex-start; gap: 8px;
      background: var(--surface);
    }
    /* Force the WORKSPACE/DASHBOARDS uppercase-accent treatment on the title,
       overriding .ask-lattice-panel-title's larger glowy style. */
    .ask-dock-head .ask-lattice-panel-title.col-header-text {
      font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--col-accent); text-shadow: none;
    }
    .ask-dock-head .ask-lattice-mark { font-size: 13px; }
    /* Keep the thread picker from swallowing the whole header. */
    .ask-dock-head .rail-threads { flex: 0 1 auto; max-width: 150px; margin-left: auto; }
    /* Drag handle on the dock's LEFT edge (the dock is the rightmost column). */
    .ask-dock-resize {
      position: absolute; top: 0; left: -3px; width: 6px; height: 100%;
      cursor: col-resize; z-index: 6;
    }
    .ask-dock-resize:hover, .ask-dock-resize.dragging { background: var(--accent-soft); }

    /* ── Dashboard page ─────────────────────────────────── */
    /* height:100% (not flex:1) because #content is display:block, so a flex-grow on a
       block child is inert and the page would collapse to content height. #content has
       a definite height (flex:1 in the .content-wrap column), so 100% fills the pane
       and gives .dash-frame a definite height to stretch into. */
    .dash-page { height: 100%; display: flex; flex-direction: column; min-height: 0; padding: 12px 16px 16px; gap: 8px; }
    .dash-header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .dash-title { margin: 0; font-size: 20px; font-weight: 700; flex: 0 1 auto; min-width: 0; }
    .dash-vis-slot { display: inline-flex; align-items: center; min-width: 0; }
    .dash-menu-wrap { margin-left: auto; position: relative; }
    .dash-desc { font-size: 13px; }
    .dash-history { flex: 0 0 auto; max-height: 40%; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-md); padding: 4px 8px; background: var(--surface); }
    .dash-frame { flex: 1 1 auto; min-height: 0; width: 100%; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface); }

    /* ── Assistant working status (dock) ────────────────── */
    .ask-status {
      flex: 0 0 auto; padding: 4px 14px; font-size: 12px; color: var(--text-muted);
      font-style: italic; animation: askStatusIn 0.15s ease-out;
    }
    @keyframes askStatusIn { from { opacity: 0; } to { opacity: 1; } }
`;
