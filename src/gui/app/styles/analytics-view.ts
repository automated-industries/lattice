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
      grid-template-columns: var(--nav-width) minmax(0, 1fr) minmax(300px, 24vw);
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

    /* ── Tab strip + canvas ─────────────────────────────── */
    .analytics-content-wrap { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    .antabstrip {
      flex: 0 0 auto; display: flex; align-items: center; min-height: 34px;
      padding: 0 8px; border-bottom: 1px solid var(--border); background: var(--surface);
    }
    .antabstrip-tabs { display: flex; align-items: center; flex: 1; min-width: 0; }
    #analytics-content { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }

    /* ── Analytics home (empty states) ──────────────────── */
    .analytics-home {
      flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 10px; padding: 40px 24px; text-align: center;
    }
    .analytics-home-mark { font-size: 44px; line-height: 1; opacity: 0.9; }
    .analytics-home h1 { margin: 0; font-size: 22px; font-weight: 700; color: var(--text); }
    .analytics-home p { margin: 0; max-width: 46ch; }

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
