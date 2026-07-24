// Auto-composed section of the GUI stylesheet (see styles/index.ts). The Sources
// sidebar: Files tree / Artifacts / Connectors sections + the lazy file tree.
export const sourcesCss = `    /* ── Sources sidebar ───────────────────────────────────── */
    .src-group { margin-bottom: 16px; }
    .src-note { font-size: 11px; color: var(--text-muted); padding: 8px 12px 4px; display: flex; align-items: center; gap: 6px; }
    .src-note-ic { font-size: 10px; flex: none; line-height: 1; }
    .src-empty { font-size: 12px; padding: 4px 12px; }
    .src-add-row { display: flex; gap: 6px; padding: 4px 8px 0; }
    .src-add {
      flex: 1; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--r-sm);
      background: var(--surface-2); color: var(--text); font-size: 12px; cursor: pointer;
    }
    .src-add:hover { background: var(--row-hover); }
    /* "＋ File(s)" button + its file/folder popover menu. */
    .src-add-files-wrap { position: relative; }
    .src-add-menu {
      position: absolute; left: 8px; right: 8px; top: calc(100% + 2px); z-index: var(--z-menu);
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md);
      box-shadow: var(--shadow-2); padding: 4px; overflow: hidden;
    }
    .src-add-menu[hidden] { display: none; }
    .src-add-menu-item {
      display: block; width: 100%; text-align: left; padding: 6px 8px; border: 0; border-radius: var(--r-sm);
      background: none; color: var(--text); font-size: 13px; cursor: pointer;
    }
    .src-add-menu-item:hover { background: var(--row-hover); }
    .src-tree { list-style: none; margin: 0; padding: 0; }
    .src-tree .src-tree { margin: 0; } /* nested children */
    .src-node { list-style: none; }
    .src-row {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 12px; border-radius: var(--r-sm); cursor: pointer;
      color: var(--text); font-size: 13px;
    }
    .src-row:hover { background: var(--row-hover); }
    .src-caret { width: 10px; font-size: 10px; color: var(--text-muted); flex: none; }
    .src-ic { width: 16px; text-align: center; flex: none; }
    .src-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .src-del {
      flex: none; margin-left: auto; border: none; background: none; cursor: pointer;
      color: var(--text-muted); font-size: 13px; line-height: 1; padding: 2px 4px;
      border-radius: var(--r-sm); opacity: 0; transition: opacity .1s;
    }
    .src-row:hover .src-del { opacity: 1; }
    .src-del:hover { background: var(--row-hover); color: var(--danger, #d03b3b); }
    .src-children { list-style: none; margin: 0; padding: 0; }

    /* ── Configure → Files GRID (grid-only, nested folders) ─────────────── */
    /* More padding is scoped to this container, not the shared .fs-tile (which
       also serves the record page's Connected-objects grid). */
    .inputs-files-grid-host { padding: 8px 4px 4px; }
    .inputs-files-grid {
      /* Roomier than the shared default: wider min tile + larger gap. */
      grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
      gap: 18px; margin: 10px 0;
    }
    /* A folder root renders as a full-width expandable group (folder tile, then a
       nested tile grid) so nesting reads clearly without fighting the tile grid. */
    .ifg-group { margin: 6px 0; }
    .ifg-tile-wrap { position: relative; }
    .ifg-folder { max-width: 200px; }
    /* The ✕ overlays the tile's top-right corner, hover-revealed. */
    .ifg-tile-wrap .src-del {
      position: absolute; top: 6px; right: 6px; margin: 0; z-index: 1;
      background: var(--surface);
    }
    .ifg-tile-wrap:hover .src-del { opacity: 1; }
    /* Nested children: indented, and a real grid only when shown. */
    .ifg-children { margin: 8px 0 8px 20px; padding-left: 10px; border-left: 1px solid var(--border); }
    .ifg-children[hidden] { display: none; }
    .ifg-open > .fs-tile { border-color: var(--accent); }

`;
