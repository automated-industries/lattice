// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const topbarCss = `    /* ── Top bar ───────────────────────────────────────── */
    header.topbar {
      display: flex; align-items: center; gap: 12px;
      /* The topbar's backdrop-filter creates a stacking context; without an
         explicit z-index it (and its dropdowns like .db-menu) get painted under
         the main content. 100 keeps dropdowns above the dashboard cards while
         staying below drawers (120/130), modals (1000), and toasts (2000). */
      position: relative; z-index: 100;
      min-height: 56px; padding: 8px 20px;
      background: var(--glass);
      -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
      border-bottom: 1px solid rgba(15, 23, 42, 0.04);
      box-shadow: var(--shadow-1), var(--hl-top);
      color: var(--text);
      flex-wrap: wrap;
    }
    .brand {
      display: inline-flex; align-items: center;
      flex-shrink: 0; border-radius: 6px;
      padding: 2px; cursor: pointer;
    }
    .brand:hover { background: rgba(15, 23, 42, 0.04); }
    .brand-logo {
      width: 32px; height: 32px; display: block;
      /* object-fit keeps an owner's custom <img> logo from distorting when it
         isn't a perfect 32px square (the default inline SVG ignores this). */
      object-fit: contain; border-radius: 4px;
      filter: none;
      transition: filter 0.18s ease;
    }
    .brand:hover .brand-logo { filter: none; }

    /* History controls — dark variant */
    .history-controls { display: inline-flex; gap: 4px; }
    .history-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 32px; height: 32px;
      background: transparent; border: 1px solid #e6eaf0;
      border-radius: 6px; cursor: pointer;
      color: #0f172a; font-size: 16px; text-decoration: none;
    }
    .history-btn:hover:not([disabled]) { background: rgba(15, 23, 42, 0.04); }
    .history-btn[disabled] { opacity: 0.35; cursor: not-allowed; }
    .history-btn svg { width: 16px; height: 16px; display: block; }

    /* History page */
    .history-list {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; overflow: hidden; max-width: 980px;
    }
    .history-entry { display: flex; gap: 16px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
    .history-entry:last-child { border-bottom: none; }
    .history-entry.is-undone { background: var(--surface-2); }
    .history-entry.is-undone .history-summary { color: var(--text-muted); text-decoration: line-through; }
    .history-meta { min-width: 200px; font-size: 12px; color: var(--text-muted); }
    .history-meta .history-op {
      display: inline-block; padding: 1px 8px;
      background: var(--accent-soft); color: var(--accent);
      border-radius: 8px; font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.04em; font-weight: 600;
    }
    .history-op.op-delete { background: rgba(251, 146, 60, 0.12); color: var(--warn); }
    .history-op.op-link, .history-op.op-unlink { background: rgba(34, 211, 238, 0.15); color: var(--signal); }
    .history-op.op-schema { background: rgba(168, 85, 247, 0.15); color: #c084fc; }
    .history-summary { flex: 1; font-size: 13.5px; }
    .history-summary .history-table { font-weight: 600; }
    .history-diff {
      margin-top: 8px; font-family: ui-monospace, monospace; font-size: 12px;
      background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px;
      padding: 8px 10px; white-space: pre-wrap;
    }
    .history-diff .diff-add { color: var(--accent); }
    .history-diff .diff-rem { color: var(--warn); }
    .history-actions { display: flex; flex-direction: column; gap: 4px; }
    .history-actions .btn { font-size: 12px; height: 26px; padding: 0 10px; }
    #history-filter {
      height: 30px; padding: 0 10px; font: inherit; font-size: 13px;
      border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface);
    }

    /* DB switcher in the top bar */
    .db-switcher { position: relative; }
    .db-button {
      display: inline-flex; align-items: center; gap: 6px;
      height: 32px; padding: 0 10px;
      background: #f1f5f9; color: #0f172a;
      border: 1px solid #e6eaf0; border-radius: 6px;
      font-size: 13px; cursor: pointer;
    }
    /* Realtime connection status indicator inside .db-button.
       yellow=local SQLite, green=cloud+SSE connected, red=cloud+disconnected. */
    .db-button .db-status {
      display: inline-block; width: 8px; height: 8px;
      border-radius: 50%; background: var(--warn);
      flex-shrink: 0;
    }
    .db-button .db-status.is-cloud-connected { background: var(--accent); }
    .db-button .db-status.is-cloud-disconnected { background: #ef4444; }
    .db-button .db-status.is-cloud-connecting { background: var(--warn); }
    .db-button:hover { background: rgba(15, 23, 42, 0.05); }
    .db-button .db-caret { color: #64748b; font-size: 10px; }
    /* While a workspace switch is in flight, the stable header button shows a
       spinner (swapped for the 📂 icon) so the switch is visible for its whole
       duration — POST + reloadEverything — not just while the dropdown is open. */
    .db-button.is-switching { opacity: 0.85; cursor: progress; }
    .db-button.is-switching .db-icon .spinner { margin-right: 0; }
    .db-button.is-switching.is-switch-error .db-name { color: #ef4444; }
    .db-menu {
      position: absolute; top: 38px; left: 0;
      min-width: 260px; background: var(--glass-strong);
      -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
      border: 1px solid rgba(15, 23, 42, 0.04); border-radius: 8px;
      box-shadow: var(--shadow-3), var(--hl-top);
      z-index: 60; padding: 6px;
    }
    .db-menu .db-section { font-size: 11px; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.06em;
      padding: 8px 10px 4px; }
    .db-menu button.db-item {
      width: 100%; display: flex; align-items: center; gap: 8px;
      padding: 7px 10px; border: none; background: transparent; text-align: left;
      cursor: pointer; border-radius: 6px; font-size: 13.5px; color: var(--text);
    }
    .db-menu button.db-item:hover { background: var(--row-hover); }
    .db-menu button.db-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 500; }
    .db-menu button.db-item .db-item-file { color: var(--text-muted); font-size: 12px; margin-left: auto; }
    .db-menu .db-create { padding: 6px 10px; border-top: 1px solid var(--border); margin-top: 4px; }
    .db-menu .db-create input {
      width: 100%; height: 30px; padding: 0 10px; font: inherit;
      border: 1px solid var(--border-strong); border-radius: 6px;
      background: var(--surface); margin-bottom: 6px;
    }

    /* Live activity feed popover (next to the version-history clock) */
    .activity { position: relative; display: inline-flex; }
    .activity-pill { position: relative; }
    .activity-count {
      position: absolute; top: -4px; right: -4px; min-width: 15px; height: 15px;
      padding: 0 3px; border-radius: 999px; background: var(--accent); color: #fff;
      font-size: 9px; font-weight: 700; line-height: 15px; text-align: center;
    }
    .activity-popover {
      position: absolute; top: 38px; right: 0; width: 320px; max-height: 60vh;
      overflow: hidden; display: flex; flex-direction: column;
      background: var(--glass-strong);
      -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
      border: 1px solid rgba(15, 23, 42, 0.06); border-radius: 10px;
      box-shadow: var(--shadow-3), var(--hl-top); z-index: 110; padding: 8px;
    }
    .activity-popover[hidden] { display: none; }
    .activity-popover-head {
      font-size: 11px; font-weight: 600; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 6px 8px;
    }
    .activity-feed { overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
    .activity-empty { color: var(--text-muted); font-size: 12.5px; text-align: center; padding: 14px 8px; }

    /* Floating "Ask Lattice" trigger in the top bar */
    .ask-lattice { display: inline-flex; flex: 0 0 auto; }
    .ask-lattice-trigger {
      display: inline-flex; align-items: center; gap: 6px;
      height: 32px; padding: 0 12px; cursor: pointer;
      border: 1px solid rgba(59, 130, 246, 0.35); border-radius: 999px;
      background: var(--accent-soft); color: var(--accent);
      font: inherit; font-size: 13px; font-weight: 600;
      box-shadow: var(--glow-accent-soft);
    }
    .ask-lattice-trigger:hover { background: rgba(59, 130, 246, 0.18); }
    .ask-lattice-trigger .ask-lattice-mark { font-size: 14px; line-height: 1; }

`;
