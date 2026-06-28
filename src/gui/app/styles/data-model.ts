// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const dataModelCss = `    /* ── Placeholder / data-model stub ─────────────────── */
    .placeholder {
      background: var(--surface); border: 1px dashed var(--border-strong);
      border-radius: 10px; padding: 40px;
      max-width: 600px; text-align: center;
      color: var(--text-muted);
    }
    .placeholder h2 { margin: 0 0 8px; color: var(--text); }

    /* Frame-first navigation: a route paints this loading frame synchronously on
       every click, then streams its content in. The view is never frozen. */
    .route-loading {
      display: flex; align-items: center; justify-content: center;
      min-height: 240px; padding: 48px;
    }
    .route-loading .spinner { width: 22px; height: 22px; margin: 0; }

    /* Data Model: a force-directed schema graph on top, edit panel below. */
    .dm-layout {
      display: flex; flex-direction: column; gap: 20px;
    }
    #graph-mount {
      position: relative; background: var(--bg);
      border: 1px solid var(--border); border-radius: 10px; height: 64vh; overflow: hidden;
    }
    svg.dm-graph { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
    svg.dm-graph:active { cursor: grabbing; }
    .dm-graph .gnode { cursor: pointer; }
    .dm-graph .gnode-glow { fill: var(--accent); opacity: 0; transition: opacity 0.1s ease; }
    .dm-graph .gnode-dot { fill: var(--surface-2); stroke: var(--border-strong); stroke-width: 1.5; transition: stroke 0.1s ease; }
    .dm-graph .gnode-label { fill: var(--text); font-size: var(--gnode-label-size, 13px); font-weight: 400; }
    .dm-graph .gnode-icon { dominant-baseline: middle; }
    .dm-graph .gnode:hover .gnode-dot { stroke: var(--text-muted); }
    /* Share-status stroke (cloud workspaces only): yellow = shared, red = private. */
    .dm-graph .gnode-shared .gnode-dot { stroke: #eab308; stroke-width: 2; }
    .dm-graph .gnode-private .gnode-dot { stroke: #ef4444; stroke-width: 2; }
    /* Selected (green) wins over share status — higher specificity (.gnode.active). */
    .dm-graph .gnode.active .gnode-dot { stroke: var(--accent); stroke-width: 2; }
    .dm-graph .gnode.active .gnode-glow { opacity: 0.18; }
    .dm-graph .gnode.active .gnode-label { fill: var(--accent); }
    .dm-edge { transition: opacity 0.1s ease; }
    /* Live force-graph renderer: edges + arrowheads take their color from CSS now
       (the renderer no longer inlines a stroke). A warm accent marks the search-
       highlight pulse — the hybrid touch: warm focus moments over the cool
       structural palette. */
    svg.dm-graph { --graph-warm: #d98a3d; }
    .dm-graph .dm-edge { stroke: var(--accent); }
    .dm-graph .dm-arrow-fk, .dm-graph .dm-arrow-m2m { fill: var(--accent); }
    .dm-graph .gnode-dot.gnode-hot { stroke: var(--graph-warm); stroke-width: 3; }
    /* Object page = a focused graph (entity rows + related objects). Reuses the
       .dm-graph node primitives; #fsg-mount mirrors #graph-mount's sizing. */
    #fsg-mount {
      position: relative; background: var(--bg);
      border: 1px solid var(--border); border-radius: 10px; height: 64vh; overflow: hidden;
    }
    /* Center object node: accented; related objects: dashed ring; entities: plain. */
    .dm-graph .ognode-object .gnode-dot { fill: var(--accent-deep, #2563eb); stroke: var(--accent); stroke-width: 2; }
    .dm-graph .ognode-object .gnode-label { fill: var(--accent); font-weight: 600; }
    .dm-graph .ognode-related .gnode-dot { stroke: var(--text-muted); stroke-dasharray: 3 2; }
    .dm-graph .ognode-related .gnode-label { fill: var(--text-muted); }
    .dm-graph .ognode-entity .gnode-dot { fill: var(--surface); }
    .fsg-more { position: absolute; left: 12px; bottom: 12px; z-index: 4; }
    .dm-legend {
      position: absolute; top: 10px; left: 12px; display: flex; gap: 14px;
      font-size: 11px; color: var(--text-muted);
      background: var(--glass-strong); border: 1px solid var(--border);
      border-radius: 8px; padding: 6px 10px; backdrop-filter: blur(2px);
    }
    .dm-legend span { display: inline-flex; align-items: center; gap: 6px; }
    .dm-legend i { width: 16px; height: 0; border-top: 2px solid currentColor; display: inline-block; }
    .dm-legend i.dash { border-top-style: dashed; }
    /* Share-status swatches: filled dots rather than the relationship line. */
    .dm-legend i.sw { width: 10px; height: 10px; border-top: 0; border-radius: 50%; }
    .dm-legend i.sw-shared { background: #eab308; }
    .dm-legend i.sw-private { background: #ef4444; }
    .dm-legend i.sw-selected { background: var(--accent); }
    #dm-panel {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; padding: 20px;
    }
    #dm-panel h3 { margin: 0 0 12px; font-size: 16px; }
    #dm-panel h4 { margin: 12px 0 6px; font-size: 12.5px;
      color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
    #dm-panel .breadcrumb { cursor: pointer; }
    ul.dm-rows { list-style: none; padding: 0; margin: 0; }
    ul.dm-rows li {
      padding: 8px 10px; border-radius: 6px; cursor: pointer;
      font-size: 13.5px; border: 1px solid transparent;
    }
    ul.dm-rows li:hover { background: var(--row-hover); border-color: var(--border); }
    .dm-junction { margin-bottom: 14px; }
    .dm-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
    .chip-removable {
      display: inline-flex; align-items: center; gap: 4px;
      background: var(--accent-soft); color: var(--accent);
      border-radius: 10px; padding: 2px 4px 2px 8px; font-size: 12px;
    }
    .chip-removable button {
      background: transparent; border: none; color: var(--accent);
      cursor: pointer; padding: 0 4px; font-size: 14px; line-height: 1;
      border-radius: 50%;
    }
    .chip-removable button:hover { background: var(--accent-soft); }
    select.dm-add { width: 100%; padding: 6px 10px; font: inherit;
      border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface); }

    /* Data Model entity-edit panel */
    .dm-section { margin: 10px 0; }
    .dm-section summary { cursor: pointer; font-size: 13px; padding: 6px 0;
      color: var(--text); list-style: none; }
    .dm-section summary::before {
      content: '▸'; display: inline-block; margin-right: 6px; color: var(--text-muted);
      transition: transform 0.1s;
    }
    .dm-section[open] summary::before { transform: rotate(90deg); }
    .dm-edit-grid {
      display: grid; grid-template-columns: 110px minmax(0, 1fr);
      gap: 10px 14px; align-items: center; font-size: 13px;
    }
    .dm-edit-grid > label {
      color: var(--text-muted); text-transform: uppercase;
      letter-spacing: 0.04em; font-size: 11px;
      align-self: start; padding-top: 9px;
    }
    .dm-edit-grid input, .dm-edit-grid select {
      padding: 7px 10px; font: inherit; border: 1px solid var(--border-strong);
      border-radius: 6px; background: var(--surface); font-size: 13.5px;
      min-width: 0;
    }
    .dm-row-inline { display: flex; gap: 8px; align-items: center; min-width: 0; }
    .dm-row-inline input { flex: 1 1 auto; min-width: 0; }
    .dm-row-inline select { flex: 0 0 110px; }
    .dm-row-inline .btn { height: 32px; font-size: 12.5px; padding: 0 12px; flex-shrink: 0; }
    .dm-cols { display: flex; flex-direction: column; gap: 6px; }
    /* Columns: name | type | secret. Links live in their own section. */
    .dm-col-row {
      display: grid; grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 8px; align-items: center;
    }
    .dm-col-type {
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11px;
      color: var(--text-muted); white-space: nowrap;
    }
    .dm-col-row input {
      padding: 7px 10px; font: inherit; border: 1px solid var(--border);
      border-radius: 6px; background: var(--surface); font-size: 13.5px; min-width: 0;
    }
    .dm-col-row .dm-locked {
      padding: 7px 10px; font: inherit; font-size: 13.5px;
      color: var(--text-muted); background: var(--surface-2);
      border: 1px dashed var(--border); border-radius: 6px;
      display: flex; align-items: center; gap: 8px;
    }
    .dm-col-row .dm-locked-label { font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.04em; color: var(--text-muted); margin-left: auto; }
    /* Links: read-only foreign-key columns (name → target) + Destroy. */
    .dm-links { display: flex; flex-direction: column; gap: 6px; }
    .dm-link-row {
      display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto;
      gap: 8px; align-items: center;
    }
    .dm-link-name {
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12.5px;
      color: var(--text); white-space: nowrap;
    }
    .dm-link-arrow { font-size: 12px; color: var(--signal); white-space: nowrap; }
    .dm-link-row .dm-link-destroy { height: 28px; padding: 0 10px; font-size: 12px; }
    /* Danger zone — whole-table deletion (typed confirmation). */
    .dm-danger {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 10px; border: 1px solid var(--danger, #ef4444); border-radius: 8px;
      background: color-mix(in srgb, var(--danger, #ef4444) 6%, transparent);
    }
    .dm-secret-toggle {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 11px; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.04em;
      white-space: nowrap; cursor: pointer;
    }
    .dm-secret-toggle input[type="checkbox"] { margin: 0; }

    /* Emoji picker (collapsed by default; click to drop down) */
    .emoji-picker { position: relative; display: inline-block; }
    .emoji-trigger {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 4px 8px 4px 10px; background: var(--surface);
      border: 1px solid var(--border-strong); border-radius: 6px;
      cursor: pointer; min-width: 70px;
    }
    .emoji-trigger:hover { background: var(--row-hover); }
    .emoji-trigger .emoji-preview { font-size: 22px; line-height: 1; }
    .emoji-trigger .emoji-caret { color: var(--text-muted); font-size: 10px; }
    .emoji-grid {
      position: absolute; top: 42px; left: 0; z-index: 70;
      display: grid; grid-template-columns: repeat(8, 36px); gap: 4px;
      background: var(--glass-strong);
      -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
      padding: 8px; border-radius: 8px;
      border: 1px solid rgba(15, 23, 42, 0.04);
      box-shadow: var(--shadow-3), var(--hl-top);
    }
    .emoji-grid[hidden] { display: none; }
    .emoji-tile {
      width: 36px; height: 36px;
      background: transparent; border: 1px solid transparent;
      border-radius: 6px; cursor: pointer;
      font-size: 18px; line-height: 1; padding: 0;
      display: flex; align-items: center; justify-content: center;
    }
    .emoji-tile:hover { background: var(--row-hover); border-color: var(--border); }
    .emoji-tile.active { background: var(--accent-soft); border-color: var(--accent); }

`;
