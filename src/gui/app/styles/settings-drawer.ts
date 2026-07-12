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

    /* ── Connectors dialog (slides in from the LEFT) ────── */
    .connectors-backdrop {
      -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
      z-index: var(--z-drawer-scrim); opacity: 0; transition: opacity 0.2s ease;
    }
    .connectors-backdrop.open { opacity: 1; }
    .connectors-dialog {
      position: fixed; top: 0; left: 0; height: 100vh;
      width: min(460px, 92vw); background: rgba(255, 255, 255, 0.86);
      -webkit-backdrop-filter: var(--blur-lg); backdrop-filter: var(--blur-lg);
      border-right: 1px solid rgba(15, 23, 42, 0.04);
      box-shadow: 12px 0 32px rgba(15, 23, 42, 0.08), var(--shadow-4);
      /* A true MODAL side-drawer: its backdrop (z 120) dims the whole app, the
         header included, so the dialog MUST sit ABOVE the backdrop. (The
         takeover-panel z-fix wrongly dropped this to 95 — below the backdrop —
         which dimmed the dialog itself and faded the whole screen.) */
      z-index: var(--z-drawer); display: flex; flex-direction: column;
      transform: translateX(-100%); transition: transform 0.22s ease;
    }
    .connectors-dialog.open { transform: translateX(0); }
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

    /* ── Configure drawer: Data Model + Inputs tabs ── */
    .dm-subtabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid var(--border); }
    .dm-subtabs .tab { border: 0; background: none; padding: 8px 12px; cursor: pointer;
      color: var(--text-muted); font-size: 13px; font-weight: 600; border-bottom: 2px solid transparent; }
    .dm-subtabs .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .dm-tables-merge { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 16px; align-items: start; }
    .dm-panel { min-width: 0; }
    /* The Graph subtab shares this grid. .brain-graph is height:100%, but a grid cell
       in an align-items:start, auto-height grid is an indefinite containing block, so
       that percentage would collapse the graph canvas to 0. Pin it to the same 64vh the
       standalone #graph-mount uses so the force-graph canvas has a real height. */
    .dm-tables-merge .brain-graph { height: 64vh; }
    @media (max-width: 900px) { .dm-tables-merge { grid-template-columns: 1fr; } }
    .inputs-group { margin-bottom: 20px; }
    .inputs-files-toggle { display: inline-flex; gap: 2px; }
    .ift-btn { border: 1px solid var(--border); background: var(--surface-2); color: var(--text-muted);
      width: 24px; height: 22px; border-radius: 5px; cursor: pointer; font-size: 12px; line-height: 1; }
    .ift-btn.on { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
    /* "Edit columns & relationships" affordance in the Data Model detail panel. */
    .mt-detail-edit { display: inline-block; margin-top: 10px; margin-left: 10px; padding: 6px 12px;
      border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2);
      color: var(--text); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
    .mt-detail-edit:hover { background: var(--row-hover); }
`;
