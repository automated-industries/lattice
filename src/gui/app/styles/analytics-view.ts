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
      padding: 5px 12px; border-radius: 999px; cursor: pointer;
      border: 1px solid var(--border); background: var(--surface-2);
      color: var(--text); font-size: 12.5px; font-weight: 600; line-height: 1;
    }
    .configure-trigger:hover { background: var(--row-hover); }
    .configure-trigger svg { width: 13px; height: 13px; }

    /* ── Dashboards sidebar ─────────────────────────────── */
    .dash-sidebar {
      display: flex; flex-direction: column; min-height: 0;
      height: 100%; overflow-y: auto;
      background: var(--surface); border-right: 1px solid var(--border);
    }
    #dash-list { flex: 0 0 auto; padding: 8px; display: flex; flex-direction: column; gap: 2px; }
    .dash-item {
      display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; align-items: center;
      column-gap: 8px; width: 100%; text-align: left;
      padding: 7px 9px; border: 0; border-radius: 8px; background: none;
      color: var(--text); font-size: 13px; cursor: pointer;
    }
    .dash-item:hover { background: var(--surface-2); }
    .dash-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
    .dash-item-icon { text-align: center; font-size: 13px; }
    .dash-item-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dash-item-desc {
      grid-column: 2 / -1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 11.5px; color: var(--text-muted); font-weight: 400;
    }
    .dash-item .vis-indicator { justify-self: end; }
    .dash-list-empty { color: var(--text-muted); font-size: 12.5px; padding: 14px 10px; text-align: center; }

    /* ── Left-sidebar nav sections (Tables / Files / Markdown) ── */
    .nav-section { border-top: 1px solid var(--border); }
    /* Match the DASHBOARDS header (.col-header-text): blue, 11px, 0.08em, uppercase,
       no emoji. Sticky so each head pins while the single sidebar scroll runs under it. */
    .nav-section-head {
      width: 100%; display: flex; align-items: center; gap: 6px;
      position: sticky; top: 0; z-index: 2; background: var(--surface);
      padding: 8px 10px; border: 0; cursor: pointer;
      color: #2563eb; font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.08em;
    }
    .nav-section-head:hover { color: #1d4ed8; }
    .nav-tier-head {
      padding: 4px 12px; font-size: 10.5px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.05em; color: var(--text-muted); opacity: 0.75;
    }
    .nav-table-item {
      width: 100%; display: flex; align-items: center; gap: 8px; text-align: left;
      padding: 5px 10px 5px 14px; border: 0; border-radius: 6px; background: none;
      color: var(--text); font-size: 12.5px; cursor: pointer;
    }
    .nav-table-item:hover { background: var(--surface-2); }
    .nav-table-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
    .nav-item-ic { flex: 0 0 auto; }
    .nav-item-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nav-empty { color: var(--text-muted); font-size: 12px; padding: 8px 12px; }
    #nav-tables-list, #nav-files-tree, #nav-md-tree { padding-bottom: 6px; }

    /* ── Column headers (identical style to the Configure view) ── */
    /* All three carry the shared .col-header chrome. Accents mirror Configure:
       Dashboards=blue (inputs), Workspace=purple (model), Ask Gladys=teal
       (outputs). The Dashboards header holds a compact "+" on the right. */
    .col-dashboards { --col-accent: #2563eb; justify-content: space-between; }
    .dash-new-btn {
      flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
      width: 24px; height: 24px; border: 1px solid var(--border); background: var(--surface-2);
      color: var(--text-muted); font-size: 15px; line-height: 1; border-radius: 6px; cursor: pointer;
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
    .antabstrip .tab {
      border: 1px solid transparent; border-radius: 8px 8px 0 0;
      padding: 7px 12px; margin: 0; background: transparent;
      color: var(--text-muted); font-weight: 500;
    }
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
      border: 1px solid var(--border-strong); border-radius: 10px;
      padding: 11px 12px; font: inherit; font-size: 14px; line-height: 1.4;
    }
    .analytics-home-prompt textarea:focus { outline: none; border-color: var(--accent); box-shadow: var(--glow-focus); }
    .analytics-home-prompt .btn { flex: 0 0 auto; height: 42px; padding: 0 16px; border-radius: 10px; font-weight: 600; }
    .analytics-home-prompt .btn.primary { background: var(--accent); color: var(--btn-text); border: none; }

    /* ── Ask Gladys dock: aligned header + adjustable width ── */
    .ask-dock { position: relative; }
    /* The head reuses the shared .col-header chrome (accent bar + 38px height)
       so it lines up with Dashboards + Workspace. Teal accent (outputs), plain
       surface — no gradient — matching the Configure column headers. */
    .ask-dock-head.col-header {
      --col-accent: #0d9488;
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
    .dash-title { margin: 0; font-size: 19px; font-weight: 700; flex: 0 1 auto; min-width: 0; }
    .dash-vis-slot { display: inline-flex; align-items: center; min-width: 0; }
    .dash-menu-wrap { margin-left: auto; position: relative; }
    .dash-desc { font-size: 12.5px; }
    .dash-history { flex: 0 0 auto; max-height: 40%; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; padding: 4px 8px; background: var(--surface); }
    .dash-frame { flex: 1 1 auto; min-height: 0; width: 100%; border: 1px solid var(--border); border-radius: 10px; background: #fff; }

    /* ── Assistant working status (dock) ────────────────── */
    .ask-status {
      flex: 0 0 auto; padding: 4px 14px; font-size: 12px; color: var(--text-muted);
      font-style: italic; animation: askStatusIn 0.15s ease-out;
    }
    @keyframes askStatusIn { from { opacity: 0; } to { opacity: 1; } }
`;
