// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const topbarCss = `    /* ── Top bar ───────────────────────────────────────── */
    header.topbar {
      display: flex; align-items: center; gap: 12px;
      /* The topbar's backdrop-filter creates a stacking context; without an
         explicit z-index it (and its dropdowns like .db-menu) get painted under
         the main content. 100 keeps dropdowns above the dashboard cards while
         staying below drawers (120/130), modals (1000), and toasts (2000). */
      position: relative; z-index: var(--z-topbar);
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
      flex-shrink: 0; border-radius: var(--r-sm);
      padding: 2px; cursor: pointer;
    }
    .brand:hover { background: rgba(15, 23, 42, 0.04); }
    .brand-logo {
      width: 32px; height: 32px; display: block;
      /* object-fit keeps an owner's custom <img> logo from distorting when it
         isn't a perfect 32px square (the default inline SVG ignores this). */
      object-fit: contain; border-radius: var(--r-xs);
      filter: none;
      transition: filter var(--dur-2) ease;
    }
    .brand:hover .brand-logo { filter: none; }

    /* History controls — dark variant */
    .history-controls { display: inline-flex; gap: 4px; align-items: center; }
    /* Divides page-nav (Back/Forward) from data-edit (Undo/Redo) in the one group. */
    .history-sep { width: 1px; height: 18px; background: var(--border); margin: 0 4px; }
    .history-btn {
      justify-content: center;
      width: 32px; height: 32px;
      background: transparent;
      color: var(--text); font-size: 16px; text-decoration: none;
    }
    .history-btn:hover:not([disabled]) { background: rgba(15, 23, 42, 0.04); }
    .history-btn[disabled] { opacity: 0.35; cursor: not-allowed; }
    .history-btn svg { width: 16px; height: 16px; display: block; }

    /* History page */
    /* Compact subheader over the history list — holds just the entity filter
       (the takeover's own header already titles the panel "Version history"). */
    .history-subhead {
      display: flex; align-items: center; gap: 8px;
      max-width: 980px; margin: 0 0 12px; padding: 2px;
    }
    .history-filter-label { font-size: 12px; font-weight: 600; color: var(--text-muted); }
    .history-list {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--r-lg); overflow: hidden; max-width: 980px;
    }
    .history-entry { display: flex; gap: 16px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
    .history-entry:last-child { border-bottom: none; }
    .history-entry.is-undone { background: var(--surface-2); }
    .history-entry.is-undone .history-summary { color: var(--text-muted); text-decoration: line-through; }
    .history-meta { min-width: 200px; font-size: 12px; color: var(--text-muted); }
    .history-meta .history-op {
      display: inline-block; padding: 2px 8px;
      background: var(--accent-soft); color: var(--accent);
      border-radius: var(--r-md); font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.05em; font-weight: 600;
    }
    .history-op.op-delete { background: color-mix(in srgb, var(--hue-orange) 12%, transparent); color: var(--warn); }
    .history-op.op-link, .history-op.op-unlink { background: color-mix(in srgb, var(--hue-cyan) 15%, transparent); color: var(--signal); }
    .history-op.op-schema { background: color-mix(in srgb, var(--hue-violet) 15%, transparent); color: var(--hue-violet-deep); }
    .history-summary { flex: 1; font-size: 14px; }
    .history-summary .history-table { font-weight: 600; }
    .history-diff {
      margin-top: 8px; font-family: ui-monospace, monospace; font-size: 12px;
      background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm);
      padding: 8px 10px; white-space: pre-wrap;
    }
    .history-diff .diff-add { color: var(--accent); }
    .history-diff .diff-rem { color: var(--warn); }
    .history-actions { display: flex; flex-direction: column; gap: 4px; }
    .history-actions .btn { font-size: 12px; height: 26px; padding: 0 10px; }
    #history-filter {
      height: 30px; padding: 0 10px; font: inherit; font-size: 13px;
      border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--surface);
    }

    /* DB switcher in the top bar */
    .db-switcher { position: relative; }
    .db-button {
      gap: 6px;
      height: 32px; padding: 0 10px;
      background: var(--surface-2); color: var(--text);
      font-size: 13px;
    }
    /* Realtime connection status indicator inside .db-button.
       yellow=local SQLite, green=cloud+SSE connected, red=cloud+disconnected. */
    .db-button .db-status {
      display: inline-block; width: 8px; height: 8px;
      border-radius: 50%; background: var(--warn);
      flex-shrink: 0;
    }
    .db-button .db-status.is-cloud-connected { background: var(--accent); }
    .db-button .db-status.is-cloud-disconnected { background: var(--danger); }
    .db-button .db-status.is-cloud-connecting { background: var(--warn); }
    .db-button:hover { background: var(--hover-veil); }
    .db-button .db-caret { color: var(--text-muted); font-size: 10px; }
    /* While a workspace switch is in flight, the stable header button shows a
       spinner (swapped for the 📂 icon) so the switch is visible for its whole
       duration — POST + reloadEverything — not just while the dropdown is open. */
    .db-button.is-switching { opacity: 0.85; cursor: progress; }
    .db-button.is-switching .db-icon .spinner { margin-right: 0; }
    .db-button.is-switching.is-switch-error .db-name { color: var(--danger); }
    .db-menu {
      position: absolute; top: 38px; left: 0;
      min-width: 260px; background: var(--glass-strong);
      -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
      border: 1px solid rgba(15, 23, 42, 0.04); border-radius: var(--r-md);
      box-shadow: var(--shadow-3), var(--hl-top);
      z-index: var(--z-menu); padding: 6px;
    }
    .db-menu .db-section { font-size: 11px; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.05em;
      padding: 8px 10px 4px; }
    .db-menu button.db-item {
      width: 100%; display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; border: none; background: transparent; text-align: left;
      cursor: pointer; border-radius: var(--r-sm); font-size: 14px; color: var(--text);
    }
    .db-menu button.db-item:hover { background: var(--row-hover); }
    .db-menu button.db-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 500; }
    .db-menu button.db-item .db-item-file { color: var(--text-muted); font-size: 12px; margin-left: auto; }
    .db-menu .db-create { padding: 6px 10px; border-top: 1px solid var(--border); margin-top: 4px; }
    .db-menu .db-create input {
      width: 100%; height: 30px; padding: 0 10px; font: inherit;
      border: 1px solid var(--border-strong); border-radius: var(--r-sm);
      background: var(--surface); margin-bottom: 6px;
    }

    /* Header account menu (disconnect Claude) */
    .account { position: relative; display: inline-flex; }
    .account-menu {
      position: absolute; top: 38px; right: 0;
      min-width: 200px; background: var(--glass-strong);
      -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
      border: 1px solid rgba(15, 23, 42, 0.04); border-radius: var(--r-md);
      box-shadow: var(--shadow-3), var(--hl-top);
      z-index: var(--z-menu); padding: 6px;
    }
    .account-menu-head {
      font-size: 11px; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.05em; padding: 8px 10px 4px;
    }
    .account-menu-item {
      width: 100%; display: block; text-align: left;
      padding: 8px 10px; border: none; background: transparent;
      cursor: pointer; border-radius: var(--r-sm); font-size: 14px; color: var(--text);
    }
    .account-menu-item:hover { background: var(--row-hover); }
    .account-menu-item.danger { color: var(--danger); }
    .account-menu-item.danger:hover { background: color-mix(in srgb, var(--danger) 10%, transparent); }

    /* Live activity feed popover (next to the version-history clock) */
    .activity { position: relative; display: inline-flex; }
    .activity-pill { position: relative; }
    .activity-count {
      position: absolute; top: -4px; right: -4px; min-width: 15px; height: 15px;
      padding: 0 4px; background: var(--accent); color: var(--btn-text);
      font-size: 10px; font-weight: 700; line-height: 15px; text-align: center;
    }
    .activity-popover {
      position: absolute; top: 38px; right: 0; width: 320px; max-height: 60vh;
      overflow: hidden; display: flex; flex-direction: column;
      background: var(--glass-strong);
      -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
      border: 1px solid rgba(15, 23, 42, 0.06); border-radius: var(--r-lg);
      box-shadow: var(--shadow-3), var(--hl-top); z-index: var(--z-popover); padding: 8px;
    }
    .activity-popover[hidden] { display: none; }
    .activity-popover-head { padding: 2px 6px 8px; }
    .activity-feed { overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
    .activity-empty { font-size: 13px; padding: 14px 8px; }

    /* Floating "Ask Lattice" trigger in the top bar */
    .ask-lattice { display: inline-flex; flex: 0 0 auto; }
    .ask-lattice-trigger {
      display: inline-flex; align-items: center; gap: 6px;
      height: 32px; padding: 0 12px; cursor: pointer;
      border: 1px solid rgba(59, 130, 246, 0.35);
      background: var(--accent-soft); color: var(--accent);
      font: inherit; font-size: 13px; font-weight: 600;
      box-shadow: var(--glow-accent-soft);
    }
    .ask-lattice-trigger:hover { background: var(--accent-tint); }
    .ask-lattice-trigger .ask-lattice-mark { font-size: 14px; line-height: 1; }

`;
