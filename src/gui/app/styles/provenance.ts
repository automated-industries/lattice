// Styles for the data-provenance views — the object page's source table and the
// single-row detail panel. (The graph mode + its legend/node coloring were
// removed: the object page is a table-only view.)
export const provenanceCss = `
    .prov-mount {
      position: relative; background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; height: auto; overflow: visible;
    }

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
    /* Files object page / folder drill-in rendered as a table (reuses .pv-table). */
    .fs-files-table .fs-files-path {
      color: var(--text-muted); font-family: ui-monospace, monospace; font-size: 11.5px;
      max-width: 460px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    /* Single-row detail provenance panel. */
    details.prov-panel { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 8px; }
    details.prov-panel > summary {
      cursor: pointer; font-weight: 600; color: var(--text-muted); list-style: none; padding: 4px 0;
    }
    details.prov-panel > summary::-webkit-details-marker { display: none; }
    details.prov-panel > summary::before { content: '▸ '; color: var(--text-muted); }
    details.prov-panel[open] > summary::before { content: '▾ '; }
    details.prov-panel[open] > summary:hover { color: var(--text); }
    .prov-panel-body { padding-top: 6px; }
`;
