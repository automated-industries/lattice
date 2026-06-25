// Auto-composed section of the GUI stylesheet (see styles/index.ts). The Sources
// sidebar: Files tree / Artifacts / Connectors sections + the lazy file tree.
export const sourcesCss = `    /* ── Sources sidebar ───────────────────────────────────── */
    .src-group { margin-bottom: 16px; }
    .src-note { font-size: 11px; color: var(--text-muted); padding: 8px 12px 4px; display: flex; align-items: center; gap: 5px; }
    .src-note-ic { font-size: 10px; flex: none; line-height: 1; }
    .src-empty { font-size: 12px; color: var(--text-muted); padding: 4px 12px; }
    .src-add-row { display: flex; gap: 6px; padding: 4px 8px 0; }
    .src-add {
      flex: 1; padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px;
      background: var(--surface-2); color: var(--text); font-size: 12px; cursor: pointer;
    }
    .src-add:hover { background: var(--row-hover); }
    .src-tree { list-style: none; margin: 0; padding: 0; }
    .src-tree .src-tree { margin: 0; } /* nested children */
    .src-node { list-style: none; }
    .src-row {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 12px; border-radius: 6px; cursor: pointer;
      color: var(--text); font-size: 13px;
    }
    .src-row:hover { background: var(--row-hover); }
    .src-caret { width: 10px; font-size: 9px; color: var(--text-muted); flex: none; }
    .src-ic { width: 16px; text-align: center; flex: none; }
    .src-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .src-children { list-style: none; margin: 0; padding: 0; }
    .src-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .src-conn .src-row { gap: 8px; }

`;
