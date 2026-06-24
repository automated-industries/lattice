// Auto-composed section of the GUI stylesheet (see styles/index.ts). The center
// tab strip, the tabbed content pane, the brain-graph view, and the Settings →
// Data Model entity list.
export const tabsCss = `    /* ── Center tab strip + tabbed content ─────────────────── */
    #content { flex: 1; overflow: auto; padding: 24px; min-height: 0; }
    .tabstrip {
      display: flex; align-items: stretch;
      border-bottom: 1px solid var(--border); background: var(--surface);
      min-height: 38px; padding: 0 6px;
    }
    .tabstrip-tabs { display: flex; align-items: stretch; gap: 2px; overflow-x: auto; flex: 1; min-width: 0; }
    .tabstrip-status { display: flex; align-items: center; margin-left: auto; padding: 0 6px; }
    .tab {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 10px; margin: 4px 0; border: 1px solid transparent; border-radius: 6px;
      background: transparent; color: var(--text-muted); font-size: 13px; cursor: pointer;
      max-width: 220px; white-space: nowrap;
    }
    .tab:hover { background: var(--row-hover); color: var(--text); }
    .tab.active { background: var(--accent-soft); color: var(--accent); font-weight: 500; box-shadow: var(--glow-accent-soft); }
    .tab-icon { font-size: 13px; }
    .tab-title { overflow: hidden; text-overflow: ellipsis; }
    .tab-close {
      display: inline-flex; align-items: center; justify-content: center;
      width: 16px; height: 16px; border-radius: 4px; font-size: 11px; color: var(--text-muted);
    }
    .tab-close:hover { background: var(--row-hover); color: var(--text); }

    /* The brain graph fills the whole content pane. */
    .brain-graph { height: 100%; }
    .brain-graph #graph-mount { height: 100%; }

    /* ── Settings → Data Model entity list ─────────────────── */
    .dm-entity-list { list-style: none; margin: 0; padding: 0; }
    .dm-entity-item {
      display: flex; align-items: center; gap: 8px; width: 100%;
      padding: 7px 10px; border: 0; border-radius: 6px; background: transparent;
      color: var(--text); font-size: 13.5px; text-align: left; cursor: pointer;
    }
    .dm-entity-item:hover { background: var(--row-hover); }
    .dm-entity-item.active { background: var(--accent-soft); color: var(--accent); }
    .dm-entity-icon { width: 18px; text-align: center; }

`;
