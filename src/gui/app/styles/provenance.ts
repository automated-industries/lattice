// Styles for the data-provenance views. Reuses the brain-graph primitives
// (svg.dm-graph / .gnode / .gnode-dot / .dm-legend from data-model.ts) and adds
// only the per-tier node coloring, the legend swatches, the source table, and
// the collapsed detail-view panel.
export const provenanceCss = `
    .prov-mount {
      position: relative; background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; height: 64vh; overflow: hidden;
    }
    .prov-mount.prov-mount-table { height: auto; overflow: visible; }
    .pv-legend { position: absolute; top: 12px; left: 12px; z-index: 2; }
    .pv-legend .pv-sw {
      display: inline-block; width: 10px; height: 10px; border-radius: 10px;
      margin: 0 4px 0 12px; vertical-align: middle; border: 1.5px solid var(--border-strong);
    }
    .pv-legend .pv-sw:first-child { margin-left: 0; }
    /* Per-tier node coloring (createForceGraph emits class="gnode pvnode-<type>"). */
    .pv-sw.pvnode-raw, .dm-graph .pvnode-raw .gnode-dot { background: var(--signal); fill: var(--signal); stroke: var(--signal); }
    .pv-sw.pvnode-computed, .dm-graph .pvnode-computed .gnode-dot { background: var(--warn); fill: var(--warn); stroke: var(--warn); }
    .pv-sw.pvnode-observation, .dm-graph .pvnode-observation .gnode-dot { background: var(--surface-2); fill: var(--surface-2); stroke: var(--text-muted); stroke-dasharray: 3 2; }
    .pv-sw.pvnode-object, .dm-graph .pvnode-object .gnode-dot { background: var(--accent); fill: var(--accent-deep); stroke: var(--accent); stroke-width: 2; }
    .dm-graph .pvnode-object .gnode-label { fill: var(--accent); font-weight: 600; }
    .btn.pv-active { background: var(--accent-soft); border-color: var(--accent); color: var(--text); }

    /* Source provenance table. */
    .pv-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .pv-table thead th {
      text-align: left; padding: 8px 10px; color: var(--text-muted); font-weight: 600;
      border-bottom: 1px solid var(--border-strong); white-space: nowrap;
    }
    .pv-table thead th.num, .pv-table td.num { text-align: right; }
    .pv-table tbody td { padding: 7px 10px; border-bottom: 1px solid var(--border); }
    .pv-table tr.pv-tier-row th {
      text-align: left; padding: 10px 10px 4px; font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.06em; color: var(--text-muted); border-bottom: none;
    }
    .pvchip {
      display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px;
      border: 1px solid var(--border-strong);
    }
    .pvchip-raw { color: var(--signal); border-color: var(--signal); }
    .pvchip-computed { color: var(--warn); border-color: var(--warn); }
    .pvchip-observation { color: var(--text-muted); }
    .prov-fallback { padding: 10px 0; }

    /* Single-row detail provenance panel. */
    details.prov-panel { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 8px; }
    details.prov-panel > summary {
      cursor: pointer; font-weight: 600; color: var(--text-muted); list-style: none; padding: 4px 0;
    }
    details.prov-panel > summary::-webkit-details-marker { display: none; }
    details.prov-panel > summary::before { content: '\\u25B8 '; color: var(--text-muted); }
    details.prov-panel[open] > summary::before { content: '\\u25BE '; }
    details.prov-panel[open] > summary:hover { color: var(--text); }
    .prov-panel-body { padding-top: 6px; }
`;
