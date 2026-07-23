// Auto-composed section of the GUI stylesheet (see styles/index.ts). The column
// headers, the Workspace content pane, the brain-graph view, and the Settings →
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

    /* ── The Workspace content pane ────────────────────────── */
    #content { flex: 1; overflow: auto; padding: 24px; min-height: 0; }

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
