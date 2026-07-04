// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const tableViewCss = `    /* ── Table view ───────────────────────────────────── */
    .view-header {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 18px;
    }
    .view-header .entity-icon { font-size: 22px; line-height: 1; padding: 2px 0; }
    .view-header h1 { font-size: 22px; font-weight: 600; margin: 0; }
    .view-header .count { color: var(--text-muted); font-size: 13px; margin-left: 4px; }
    /* Record Formatted | Markdown toggle (segmented control, pushed to the right). */
    .fs-view-toggle { margin-left: auto; display: inline-flex; flex: none; }
    .fs-view-toggle button {
      padding: 4px 12px; font: inherit; font-size: 12.5px; cursor: pointer;
      border: 1px solid var(--border); background: var(--surface-2); color: var(--text-muted);
    }
    .fs-view-toggle button:first-child { border-radius: 6px 0 0 6px; }
    .fs-view-toggle button:last-child { border-radius: 0 6px 6px 0; border-left: 0; }
    .fs-view-toggle button.on { background: var(--accent-soft); color: var(--accent); border-color: rgba(59, 130, 246, 0.35); }
    /* Rows-table pager: "A–B of T" + Prev/Next, pushed to the right of the header. */
    .rows-pager { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; flex: none; }
    .rows-pager-info { color: var(--text-muted); font-size: 12.5px; white-space: nowrap; }
    .rows-pager .btn { padding: 3px 10px; font-size: 12.5px; }
    .rows-pager .btn[disabled] { opacity: 0.45; cursor: default; pointer-events: none; }

    table {
      width: 100%; border-collapse: separate; border-spacing: 0;
      background: var(--surface);
      border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
      box-shadow: var(--shadow-2);
    }
    thead th {
      text-align: left; font-weight: 600; font-size: 12.5px;
      color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em;
      padding: 12px 14px; background: var(--surface-2);
      border-bottom: 1px solid var(--border);
    }
    tbody td {
      padding: 12px 14px; border-bottom: 1px solid var(--border);
      vertical-align: top; font-size: 13.5px;
    }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr { cursor: pointer; }
    tbody tr:hover td { background: var(--row-hover); }
    td.muted { color: var(--text-muted); }
    .chip {
      display: inline-block; padding: 2px 8px; margin: 1px 3px 1px 0;
      background: var(--accent-soft); color: var(--accent);
      border-radius: 10px; font-size: 12px;
    }
    a.chip-link { cursor: pointer; }
    a.chip-link:hover { background: var(--accent); color: white; }
    /* Inline object-reference pills the assistant emits — render flush in prose. */
    a.lattice-ref { text-decoration: none; vertical-align: baseline; }

`;
