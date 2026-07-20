// Auto-composed section of the GUI stylesheet (see styles/index.ts). Utility
// vocabulary (design pass M3): single-purpose helper classes appended LAST in
// the composition so they win ties against component rules. No markup uses
// them yet — a later pass adopts them module by module.
export const utilitiesCss = `    /* ── Utilities (last in the cascade) ─────────────────── */
    .muted { color: var(--text-muted); }
    .hint { font-size: 12px; color: var(--text-muted); }
    .hint-xs { font-size: 11px; color: var(--text-muted); }
    .mono { font-family: var(--font-mono); }
    .u-row { display: flex; align-items: center; gap: 8px; }
    .u-row-wrap { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .u-spread { display: flex; align-items: center; justify-content: space-between; }
    .u-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .u-w-100 { width: 100%; }
    .u-m-0 { margin: 0; }
    .u-mt-1 { margin-top: 4px; }
    .u-mt-2 { margin-top: 8px; }
    .u-mt-3 { margin-top: 12px; }
    .u-mb-2 { margin-bottom: 8px; }
    .u-mb-3 { margin-bottom: 12px; }
    .dialog-lead { font-size: 13px; color: var(--text-muted); margin: 0 0 12px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .sr-only {
      position: absolute; width: 1px; height: 1px; opacity: 0;
      overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; padding: 0; margin: -1px;
    }
`;
