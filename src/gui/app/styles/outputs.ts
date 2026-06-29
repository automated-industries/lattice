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

`;
