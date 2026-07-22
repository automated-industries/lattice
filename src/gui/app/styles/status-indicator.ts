// Auto-composed section of the GUI stylesheet (see styles/index.ts). The single
// top-right status indicator that lives in the tab strip's status slot.
export const statusIndicatorCss = `    /* ── Top-right status indicator ────────────────────────── */
    /* The header slot the status pill homes into — where the version used to sit
       (the version moved into the Settings drawer footer). */
    /* Shrinkable (min-width:0) so a long ingestion status yields space instead of
       pushing the "Ask Lattice"/Configure toggle onto a second line. */
    .header-status-slot { display: inline-flex; align-items: center; flex: 0 1 auto; min-width: 0; }
    .app-status {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px;
      background: var(--surface-2); border: 1px solid var(--border);
      color: var(--text-muted); font-size: 12px; white-space: nowrap;
      /* Cap the width and truncate long notifications with an ellipsis. */
      max-width: min(34vw, 340px); min-width: 0;
    }
    .app-status .app-status-text {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
    }
    /* When idle the status is hidden via the [hidden] attribute — but the
       display:inline-flex above would otherwise win over the UA [hidden] rule and
       leave an empty bubble. Force it gone. */
    .app-status[hidden] { display: none; }
    .app-status .spinner { width: 11px; height: 11px; }
    /* Determinate progress bar (e.g. an update download) — shown in place of the
       spinner so a long operation gives real feedback, never an endless spin. */
    .app-status-bar {
      flex: 0 0 auto; width: 56px; height: 5px; border-radius: var(--r-pill);
      overflow: hidden; background: var(--border-strong);
    }
    .app-status-bar-fill {
      display: block; height: 100%; border-radius: var(--r-pill);
      background: var(--accent); transition: width 0.25s ease;
    }
    .app-status-accent { color: var(--accent); border-color: var(--accent-soft); }
    .app-status-warn { color: var(--warn); }
    .app-status-error { color: var(--danger); }

`;
