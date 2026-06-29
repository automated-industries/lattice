// Auto-composed section of the GUI stylesheet (see styles/index.ts). The Outputs
// column (right side of the Inputs/Model/Outputs layout): Artifacts, Markdown,
// Tables, Server Docs, API Docs, MCP. Reuses the collapsible .section-* idiom from
// the left sidebar for each out-group.
export const outputsCss = `    /* ── Outputs column ────────────────────────────────── */
    .outputs {
      position: relative;
      background:
        radial-gradient(120% 60% at 100% 0%, rgba(59, 130, 246, 0.08), rgba(59, 130, 246, 0) 60%),
        var(--sheen),
        rgba(255, 255, 255, 0.66);
      -webkit-backdrop-filter: var(--blur-lg); backdrop-filter: var(--blur-lg);
      border-left: 1px solid rgba(59, 130, 246, 0.10);
      box-shadow: inset 1px 0 0 rgba(15, 23, 42, 0.035), -16px 0 40px -24px rgba(15, 23, 42, 0.12);
      display: flex; flex-direction: column; min-width: 0; overflow: hidden;
    }
    .outputs-resize {
      position: absolute; left: 0; top: 0; bottom: 0; width: 5px;
      cursor: col-resize; background: transparent; z-index: 5;
      transition: background-color 120ms;
    }
    .outputs-resize:hover, .outputs-resize.dragging { background: var(--accent-soft); }
    .outputs-head {
      flex: 0 0 auto; padding: 12px 14px;
      border-bottom: 1px solid rgba(59, 130, 246, 0.14);
    }
    .outputs-title {
      font-size: 11px; font-weight: 600; color: var(--accent);
      text-transform: uppercase; letter-spacing: 0.06em;
    }
    .outputs-body { flex: 1 1 auto; overflow-y: auto; padding: 14px 10px; }
    .out-group + .out-group { margin-top: 6px; }
    .out-link { display: inline-block; padding: 6px 12px; color: var(--accent); font-size: 13px; text-decoration: none; }
    .out-link:hover { text-decoration: underline; }
    .out-placeholder { color: var(--text-muted); font-size: 12.5px; padding: 6px 12px; }

    /* Outputs > Tables mirror — tiers stacked compactly in the narrow column. */
    .out-tier + .out-tier { margin-top: 10px; }
    .out-tier-head {
      font-size: 10px; font-weight: 700; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.06em; margin: 0 0 4px 2px;
    }
    .out-tier-row {
      display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px;
      color: var(--text); font-size: 13px; text-decoration: none;
    }
    .out-tier-row:hover { background: var(--row-hover); }
    .out-tier-row .src-ic { flex: none; }
    .out-tier-row .src-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Outputs detail slide-over — the rendered .md when a Markdown entry is opened. */
    .outputs-detail {
      position: fixed; top: 56px; right: 0; bottom: 0; width: min(520px, 92vw);
      z-index: 1150; display: flex; flex-direction: column;
      background: var(--surface); border-left: 1px solid var(--border);
      box-shadow: -16px 0 40px -24px rgba(15, 23, 42, 0.25);
      animation: outputsDetailIn 0.16s ease-out;
    }
    .outputs-detail[hidden] { display: none; }
    @keyframes outputsDetailIn { from { transform: translateX(16px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    .outputs-detail-head {
      flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
      padding: 12px 14px; border-bottom: 1px solid var(--border);
    }
    .outputs-detail-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 14px; }
    .outputs-detail-close { flex: none; width: 26px; height: 26px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2); color: var(--text-muted); cursor: pointer; }
    .outputs-detail-close:hover { background: var(--row-hover); color: var(--text); }
    .outputs-detail-body { flex: 1 1 auto; overflow: auto; padding: 16px 18px; }

`;
