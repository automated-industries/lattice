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
    /* The Outputs column header reuses the shared .col-header chrome (tabs.ts);
       only its sizing within the column track is set here. */
    .outputs-head { flex: 0 0 auto; padding: 0 12px; }
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

    /* ── Markdown context tree (lazy, nested) ──────────────────────────────── */
    /* One consistent row style at every depth; the per-level indent is applied
       inline (padding-left) on .mdt-row so a deep tree never overlaps. */
    .mdt-children { list-style: none; margin: 0; padding: 0; }
    .mdt-node { list-style: none; }
    .mdt-row {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 8px; border-radius: 6px; cursor: pointer;
      color: var(--text); font-size: 13px; line-height: 1.4;
    }
    .mdt-row:hover { background: var(--row-hover); }
    .mdt-caret { width: 12px; flex: none; font-size: 9px; color: var(--text-muted); text-align: center; }
    .mdt-row .src-ic { width: 16px; flex: none; text-align: center; font-size: 13px; }
    .mdt-row .src-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

`;
