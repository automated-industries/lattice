// Auto-composed section of the GUI stylesheet (see styles/index.ts). The center
// tab strip, the tabbed content pane, the brain-graph view, and the Settings →
// Data Model entity list.
export const tabsCss = `    /* ── Column headers (Inputs · Model · Outputs) ─────────── */
    /* One shared font/size/weight/position across all three columns; the columns
       are differentiated only by a per-column accent (header text color + a 2px
       top accent bar). Pinned to the top of each column. */
    .col-header {
      position: sticky; top: 0; z-index: 5;
      flex: 0 0 auto; display: flex; align-items: center;
      min-height: 38px; padding: 0 12px;
      background: var(--surface); border-bottom: 1px solid var(--border);
      border-top: 2px solid var(--col-accent, var(--border));
    }
    .col-header-text {
      font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--col-accent, var(--text-muted)); white-space: nowrap;
    }
    .col-inputs  { --col-accent: var(--accent-deep); }
    .col-model   { --col-accent: var(--hue-violet-deep); }
    .col-outputs { --col-accent: var(--hue-teal-deep); }

    /* ── Center "Model" header: label + seamless Graph|Tables tabs ── */
    #content { flex: 1; overflow: auto; padding: 24px; min-height: 0; }
    .tabstrip { align-items: stretch; padding: 0 12px; }
    .tabstrip .col-header-text { align-self: center; margin-right: 18px; flex: 0 0 auto; }
    .tabstrip-tabs { display: flex; align-items: stretch; gap: 6px; overflow: visible; flex: 1; min-width: 0; }
    .tabstrip-status { display: flex; align-items: center; margin-left: auto; padding: 0 6px; }
    /* Underline tabs that sit ON the header's bottom border — seamless, no box. */
    .tab {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 0 10px; margin: 0; border: 0; border-radius: 0;
      border-bottom: 2px solid transparent; margin-bottom: -1px;
      background: transparent; color: var(--text-muted); font-size: 13px; font-weight: 500;
      cursor: pointer; flex: 0 0 auto; max-width: 220px; white-space: nowrap; overflow: hidden;
    }
    .tab:hover { color: var(--text); background: transparent; }
    .tab.active { color: var(--col-accent, var(--accent)); border-bottom-color: var(--col-accent, var(--accent)); font-weight: 700; }
    .tab-icon { font-size: 13px; flex: none; }
    .tab-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .tab-close {
      display: inline-flex; align-items: center; justify-content: center; flex: none;
      width: 16px; height: 16px; border-radius: var(--r-xs); font-size: 11px; color: var(--text-muted);
    }
    .tab-close:hover { background: var(--row-hover); color: var(--text); }
    /* Unread-count badge on the Data Questions tab. */
    .tab-badge {
      display: inline-flex; align-items: center; justify-content: center; flex: none;
      min-width: 16px; height: 16px; padding: 0 4px; border-radius: var(--r-md);
      font-size: 11px; font-weight: 700; line-height: 1;
      background: var(--danger); color: var(--btn-text);
    }
    /* Tab overflow: the "⋯ N" button + a dropdown listing the collapsed tabs. */
    .tab-overflow-wrap { position: relative; display: inline-flex; align-items: stretch; }
    .tab-overflow-btn { flex: none; min-width: 40px; font-weight: 500; }
    .tab-overflow-menu {
      position: absolute; right: 0; top: calc(100% + 2px); z-index: 50;
      min-width: 220px; max-height: 60vh; overflow-y: auto;
      display: flex; flex-direction: column; padding: 6px;
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg);
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.07);
    }
    .tab-overflow-menu[hidden] { display: none; }
    .tab-ov-item {
      display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: var(--r-sm);
      font-size: 13px; color: var(--text-muted); cursor: pointer;
    }
    .tab-ov-item:hover { background: var(--row-hover); color: var(--text); }
    .tab-ov-item.active { color: var(--accent); }
    .tab-ov-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* The brain graph fills the whole content pane. */
    .brain-graph { height: 100%; }
    .brain-graph #graph-mount { height: 100%; position: relative; }
    /* Drilled-in entity graph (Graph section, Object Page): a breadcrumb bar on top
       and the graph canvas filling the rest. */
    .brain-graph.entity-graph { display: flex; flex-direction: column; }
    .brain-graph.entity-graph #graph-mount { flex: 1 1 auto; height: auto; min-height: 0; }
    .graph-crumbs { flex: 0 0 auto; padding: 10px 16px; border-bottom: 1px solid var(--border); }
    /* Loading spinner shown until the graph has settled + centred (no off-centre
       flash / jump). Covers the mount; removed the moment the graph is revealed. */
    .graph-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 2; }
    .graph-spinner {
      width: 28px; height: 28px; border-radius: 50%;
      border: 3px solid var(--border); border-top-color: var(--accent);
      animation: graphSpin 0.8s linear infinite;
    }
    @keyframes graphSpin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .graph-spinner { animation: none; } }

    /* ── Settings → Data Model entity list ─────────────────── */
    .dm-entity-list { list-style: none; margin: 0; padding: 0; }
    .dm-entity-item {
      display: flex; align-items: center; gap: 8px; width: 100%;
      padding: 8px 10px; border: 0; border-radius: var(--r-sm); background: transparent;
      color: var(--text); font-size: 14px; text-align: left; cursor: pointer;
    }
    .dm-entity-item:hover { background: var(--row-hover); }
    .dm-entity-item.active { background: var(--accent-soft); color: var(--accent); }
    .dm-entity-icon { width: 18px; text-align: center; }

`;
