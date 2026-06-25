// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const searchCss = `    /* ── Full-text search (top bar) ────────────────────── */
    .topsearch { position: relative; flex: 1 1 auto; max-width: 440px; display: flex; align-items: center; }
    .topsearch-icon {
      position: absolute; left: 10px; font-size: 12px; opacity: 0.6; pointer-events: none;
    }
    #search-input {
      width: 100%; height: 32px; padding: 0 10px 0 30px;
      background: var(--surface-2); color: var(--text);
      border: 1px solid var(--border); border-radius: 6px; font-size: 13px;
    }
    #search-input:focus { outline: none; border-color: var(--border-strong); }
    .search-results {
      position: absolute; top: 38px; left: 0; right: 0;
      max-height: 60vh; overflow-y: auto;
      background: var(--glass-strong);
      -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
      border: 1px solid rgba(15, 23, 42, 0.04); border-radius: 8px;
      box-shadow: var(--shadow-3), var(--hl-top); z-index: 70; padding: 6px;
    }
    .search-empty { padding: 12px 10px; color: var(--text-muted); font-size: 13px; text-align: center; }
    .search-group { margin-bottom: 4px; }
    .search-group-head {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; color: var(--text-muted); text-transform: uppercase;
      letter-spacing: 0.05em; padding: 6px 8px 3px;
    }
    .search-group-icon { font-size: 12px; }
    .search-more {
      margin-left: auto; background: var(--accent-soft); color: var(--accent);
      border-radius: 999px; padding: 0 6px; font-size: 10px; letter-spacing: 0;
    }
    .search-hit {
      width: 100%; display: block; text-align: left;
      padding: 6px 10px; border: none; background: transparent; color: var(--text);
      border-radius: 6px; cursor: pointer; font-size: 13px;
    }
    .search-hit:hover { background: var(--row-hover); }
    .search-snippet {
      display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    @media (max-width: 720px) { .topsearch { order: 9; flex-basis: 100%; max-width: none; } }
    .last-edited { margin: -4px 0 12px; font-size: 12px; color: var(--text-muted); }
    .last-edited:empty { display: none; }

`;
