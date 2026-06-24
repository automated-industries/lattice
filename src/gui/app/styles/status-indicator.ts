// Auto-composed section of the GUI stylesheet (see styles/index.ts). The single
// top-right status indicator that lives in the tab strip's status slot.
export const statusIndicatorCss = `    /* ── Top-right status indicator ────────────────────────── */
    .app-status {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 10px; border-radius: 999px;
      background: var(--surface-2); border: 1px solid var(--border);
      color: var(--text-muted); font-size: 12px; white-space: nowrap;
    }
    .app-status .spinner { width: 11px; height: 11px; }
    .app-status-accent { color: var(--accent); border-color: var(--accent-soft); }
    .app-status-warn { color: var(--warn, #d97706); }
    .app-status-error { color: var(--danger, #c0392b); }

`;
