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
    /* Rows-table pager: "A–B of T" + Prev/Next, pushed to the right of the header. */
    .rows-pager { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; flex: none; }
    .rows-pager-info { color: var(--text-muted); font-size: 13px; white-space: nowrap; }
    .rows-pager .btn { padding: 4px 10px; font-size: 13px; }
    .rows-pager .btn[disabled] { opacity: 0.45; cursor: default; pointer-events: none; }

    /* ── SQL runner (the table page) ─────────────────────── */
    .sql-runner { display: flex; flex-direction: column; gap: 10px; }
    .sql-editor-row { display: flex; align-items: stretch; gap: 8px; }
    .sql-editor {
      flex: 1 1 auto; min-width: 0; resize: vertical;
      font-family: var(--font-mono);
      font-size: 13px; line-height: 1.5; padding: 8px 10px;
      border: 1px solid var(--border); border-radius: var(--r-md);
      background: var(--surface); color: var(--text);
    }
    .sql-run { flex: 0 0 auto; align-self: flex-start; }
    .sql-error {
      padding: 8px 12px; border-radius: var(--r-md); font-size: 13px;
      background: var(--danger-soft);
      color: var(--danger); border: 1px solid var(--danger);
    }
    .sql-error[hidden] { display: none; }
    .sql-note { color: var(--text-muted); font-size: 13px; padding: 2px 2px 0; }
    .sql-results-head { display: flex; align-items: center; justify-content: flex-end; margin-bottom: 8px; }
    .sql-results-head .rows-pager { margin-left: 0; }

    table {
      width: 100%; border-collapse: separate; border-spacing: 0;
      background: var(--surface);
      border: 1px solid var(--border); border-radius: var(--r-md); overflow: hidden;
      box-shadow: var(--shadow-2);
    }
    thead th {
      text-align: left; font-weight: 600; font-size: 13px;
      color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;
      padding: 12px 14px; background: var(--surface-2);
      border-bottom: 1px solid var(--border);
    }
    tbody td {
      padding: 12px 14px; border-bottom: 1px solid var(--border);
      vertical-align: top; font-size: 14px;
    }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr { cursor: pointer; }
    tbody tr:hover td { background: var(--row-hover); }
    td.muted { color: var(--text-muted); }
    .chip {
      display: inline-block; padding: 2px 8px; margin: 2px 4px 2px 0;
      background: var(--accent-soft); color: var(--accent);
      border-radius: var(--r-lg); font-size: 12px;
    }
    a.chip-link { cursor: pointer; }
    a.chip-link:hover { background: var(--accent); color: var(--btn-text); }
    /* Inline object-reference pills the assistant emits — render flush in prose. */
    a.lattice-ref { text-decoration: none; vertical-align: baseline; }

`;
