// Auto-composed section of the GUI stylesheet (see styles/index.ts). The
// Analytics view: the app-level view toggle, the Dashboards sidebar, the
// dashboard tab strip + canvas, the assistant dock's status line, and the
// header trigger visibility. The tab buttons themselves reuse the .tab /
// .tab-close / .tab-overflow-* classes from tabs.ts (styles) — only the
// container differs.
export const analyticsViewCss = `    /* ── Analytics view ─────────────────────────────────── */
    /* Two sibling layouts, one visible: the body class picks the view. Both
       stay mounted so a flip never destroys the hidden side's state. */
    .analytics-layout {
      display: grid;
      /* The Ask Gladys dock width is user-adjustable (drag the divider) and
         defaults ~30px wider than before so "Ask or instruct…" fits one line. */
      grid-template-columns: var(--nav-width) minmax(0, 1fr) var(--ask-dock-width, 360px);
      height: calc(100vh - 56px);
    }
    body:not(.view-analytics) .analytics-layout { display: none; }
    body.view-analytics .layout { display: none; }
    /* Exactly one header trigger shows: Ask in Configure, Configure in Analytics. */
    body.view-analytics .ask-lattice-trigger { display: none; }
    body:not(.view-analytics) .configure-trigger { display: none; }
    .configure-trigger {
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
      background: var(--surface); border-right: 1px solid var(--border);
    }
    #dash-list { flex: 1 1 auto; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 2px; }
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

    /* ── Header bar (aligned with the Configure view) ───── */
    /* The Dashboards header carries a "+ New Dashboard" button on the right. */
    .col-dashboards { justify-content: space-between; }
    .dash-new-btn {
      flex: 0 0 auto; border: 1px solid var(--border); background: var(--surface-2);
      color: var(--text); font-size: 11.5px; font-weight: 600; line-height: 1;
      padding: 5px 9px; border-radius: 7px; cursor: pointer;
    }
    .dash-new-btn:hover { background: var(--row-hover); }

    /* ── Tab strip (the "Workspace" col-header) + canvas ── */
    .analytics-content-wrap { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    /* antabstrip now uses .col-header .col-model (see markup) so it sits at the
       same 38px height + accent as the Configure "Model" header. Mirror the
       Configure .tabstrip layout: the label, then the tabs stretching after it. */
    .antabstrip { align-items: stretch; padding: 0 12px; }
    .antabstrip .col-header-text { align-self: center; margin-right: 18px; flex: 0 0 auto; }
    .antabstrip-tabs { display: flex; align-items: stretch; flex: 1; min-width: 0; }
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
       so it lines up with Dashboards + Workspace; keep its subtle gradient. */
    .ask-dock-head.col-header {
      justify-content: flex-start;
      background: linear-gradient(180deg, rgba(59, 130, 246, 0.10), rgba(59, 130, 246, 0) 100%);
    }
    /* Drag handle on the dock's LEFT edge (the dock is the rightmost column). */
    .ask-dock-resize {
      position: absolute; top: 0; left: -3px; width: 6px; height: 100%;
      cursor: col-resize; z-index: 6;
    }
    .ask-dock-resize:hover, .ask-dock-resize.dragging { background: var(--accent-soft); }

    /* ── Dashboard page ─────────────────────────────────── */
    .dash-page { flex: 1; display: flex; flex-direction: column; min-height: 0; padding: 12px 16px 16px; gap: 8px; }
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
