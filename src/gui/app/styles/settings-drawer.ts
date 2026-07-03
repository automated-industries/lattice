// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const settingsDrawerCss = `    /* ── Settings / Version-history TAKEOVER panel ─────────────
       One full-workspace panel below the header (Settings and Version history
       share it): only the topbar stays visible; the trigger button highlights
       while open and clicking it again collapses. */
    .drawer-backdrop {
      position: fixed; inset: 0; background: rgba(15, 23, 42, 0.15);
      /* BELOW the topbar (z 100): the takeover replaces the workspace, but the
         header and its triggers must stay clickable — the clock/gear COLLAPSE
         the open panel. */
      z-index: 90; opacity: 0; transition: opacity 0.2s ease;
    }
    .drawer-backdrop.open { opacity: 1; }
    .settings-drawer {
      position: fixed; left: 0; right: 0; bottom: 0; top: 49px; /* refined by JS to the real header height */
      background: var(--surface, #fff);
      border-top: 1px solid rgba(15, 23, 42, 0.06);
      z-index: 95; display: flex; flex-direction: column;
      opacity: 0; transform: translateY(-6px);
      transition: transform 0.18s ease, opacity 0.18s ease;
    }
    .settings-drawer.open { transform: translateY(0); opacity: 1; }
    /* display:flex above would override the hidden attribute's display:none —
       and an invisible full-workspace panel would swallow every click. */
    .settings-drawer[hidden] { display: none; }
    .settings-drawer:not(.open) { pointer-events: none; }
    .settings-drawer .drawer-body { max-width: 980px; width: 100%; margin: 0 auto; }
    /* Highlight the header trigger whose takeover is open. */
    .history-btn.on, #settings-gear.on { background: var(--accent-soft, rgba(79,70,229,0.12)); color: var(--accent, #4f46e5); }
    .drawer-head {
      flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
      padding: 14px 18px; border-bottom: 1px solid var(--border);
    }
    .drawer-title { font-size: 16px; font-weight: 600; }
    .drawer-close {
      margin-left: auto; width: 30px; height: 30px; border: 1px solid var(--border);
      border-radius: 6px; background: transparent; color: var(--text-muted);
      cursor: pointer; font-size: 16px; line-height: 1;
    }
    .drawer-close:hover { background: var(--row-hover); color: var(--text); }
    .drawer-tabs {
      flex: 0 0 auto; display: flex; gap: 4px; padding: 10px 14px 0;
    }
    .drawer-tab {
      padding: 7px 14px; border: 1px solid var(--border); border-bottom: none;
      border-radius: 6px 6px 0 0; background: var(--surface-2); color: var(--text-muted);
      font-size: 13px; cursor: pointer;
    }
    .drawer-tab.active { background: var(--surface); color: var(--text); font-weight: 600; border-color: var(--border-strong); }
    .drawer-body { flex: 1 1 auto; overflow-y: auto; padding: 4px 4px 20px; }
    .drawer-body .teams-page { padding: 16px 18px; }
    /* Lattice version, pinned to the bottom of the Settings drawer (moved here
       from the header, whose spot the status pill now occupies). */
    .drawer-version {
      flex: 0 0 auto; padding: 10px 18px; border-top: 1px solid var(--border);
      color: var(--text-muted); font-size: 12px;
    }
    .drawer-version .app-version { color: var(--text); }

    /* Toggle switch (advanced mode) */
    .toggle { display: flex; align-items: center; gap: 10px; cursor: pointer; }
    .toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
    .toggle-track {
      position: relative; flex: 0 0 auto; width: 38px; height: 22px;
      background: var(--border-strong); border-radius: 999px; transition: background 0.15s ease;
    }
    .toggle-thumb {
      position: absolute; top: 2px; left: 2px; width: 18px; height: 18px;
      background: #fff; border-radius: 50%; transition: transform 0.15s ease;
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.25);
    }
    .toggle input:checked + .toggle-track { background: var(--accent); }
    .toggle input:checked + .toggle-track .toggle-thumb { transform: translateX(16px); }
    .toggle-label { font-size: 13.5px; color: var(--text); }
    .toggle-label small { display: block; font-size: 11px; color: var(--text-muted); }

    /* ── Connectors dialog (slides in from the LEFT) ────── */
    .connectors-backdrop {
      position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45);
      -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
      z-index: 120; opacity: 0; transition: opacity 0.2s ease;
    }
    .connectors-backdrop.open { opacity: 1; }
    .connectors-dialog {
      position: fixed; top: 0; left: 0; height: 100vh;
      width: min(460px, 92vw); background: rgba(255, 255, 255, 0.86);
      -webkit-backdrop-filter: var(--blur-lg); backdrop-filter: var(--blur-lg);
      border-right: 1px solid rgba(15, 23, 42, 0.04);
      box-shadow: 12px 0 32px rgba(15, 23, 42, 0.08), var(--shadow-4);
      z-index: 95; display: flex; flex-direction: column;
      transform: translateX(-100%); transition: transform 0.22s ease;
    }
    .connectors-dialog.open { transform: translateX(0); }
    /* Standardized connector logo — uniform box regardless of source aspect ratio. */
    .connector-icon { width: 16px; height: 16px; object-fit: contain; flex: none; vertical-align: middle; }
    .conn-card-head .connector-icon { width: 22px; height: 22px; }
    .conn-lead { margin: 4px 12px 10px; font-size: 12px; color: var(--text-muted); line-height: 1.5; }
    .conn-msg { margin: 0 12px 8px; font-size: 12px; color: var(--text-muted); min-height: 14px; }
    .conn-card {
      margin: 0 12px 12px; padding: 12px; border: 1px solid var(--border);
      border-radius: 10px; background: var(--surface);
    }
    .conn-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .conn-card-title { font-size: 14px; font-weight: 600; }
    .conn-form { display: flex; flex-direction: column; gap: 10px; }
    /* Fields + buttons match the Ask Lattice composer (surface-2 fill, strong
       border, 8px radius, accent focus glow) — not default browser controls. */
    .conn-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
    .conn-field input,
    .conn-field select {
      width: 100%; box-sizing: border-box;
      background: var(--surface-2); color: var(--text);
      border: 1px solid var(--border-strong); border-radius: 8px;
      padding: 8px 10px; font: inherit; font-size: 13.5px; line-height: 1.4;
    }
    .conn-field input:focus,
    .conn-field select:focus { outline: none; border-color: var(--accent); box-shadow: var(--glow-focus); }
    .conn-or { text-align: center; color: var(--text-muted); font-size: 12px; margin: 2px 0; }
    .conn-form-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 6px; }
    .conn-form-actions .btn { height: 36px; padding: 0 16px; border-radius: 8px; font-weight: 600; }
    .conn-form-actions .btn.primary { background: var(--accent); color: var(--btn-text); border: none; }
    .conn-help { font-size: 12px; color: var(--text-muted); }
    .conn-connected { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .conn-status { font-size: 12px; text-transform: capitalize; }
    .conn-sub { font-size: 12px; color: var(--text-muted); }
    .conn-err { margin-top: 6px; font-size: 12px; color: var(--danger, #c0392b); }
    /* Sidebar connector row: logo with a small status dot overlay. */
    .src-conn-ic { position: relative; display: inline-flex; flex: none; }
    .src-conn-dot {
      position: absolute; right: -2px; bottom: -2px; width: 7px; height: 7px;
      border-radius: 50%; border: 1px solid var(--bg);
    }


`;
