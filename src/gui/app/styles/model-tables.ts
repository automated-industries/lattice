// Auto-composed section of the GUI stylesheet (see styles/index.ts). The Model
// "Tables" explorer: the Graph|Tables toggle, the four tier columns, the
// entity/field cards, the field tints, and the detail panel.
export const modelTablesCss = `    /* ── Model view: Graph | Tables toggle ─────────────────── */
    .model-view { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .model-toggle { display: inline-flex; gap: 2px; padding: 10px 14px 0; flex: 0 0 auto; }
    .model-tab {
      padding: 6px 16px; font: inherit; font-size: 13px; font-weight: 600;
      border: 1px solid var(--border); background: var(--surface-2); color: var(--text-muted);
      cursor: pointer;
    }
    .model-tab:first-child { border-radius: 8px 0 0 8px; }
    .model-tab:last-child { border-radius: 0 8px 8px 0; border-left: 0; }
    .model-tab.on { background: var(--accent-soft); color: var(--accent); border-color: rgba(59, 130, 246, 0.35); }
    .model-body { flex: 1 1 auto; min-height: 0; overflow: auto; }
    .model-body .brain-graph { height: 100%; }

    /* ── Tables explorer ───────────────────────────────────── */
    .mt { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .mt-bar {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      padding: 12px 14px; border-bottom: 1px solid var(--border); flex: 0 0 auto;
    }
    .mt-bar-label { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .mt-seg { display: inline-flex; }
    .mt-seg-btn {
      padding: 4px 12px; font: inherit; font-size: 12.5px; cursor: pointer;
      border: 1px solid var(--border); background: var(--surface-2); color: var(--text-muted);
    }
    .mt-seg-btn:first-child { border-radius: 6px 0 0 6px; }
    .mt-seg-btn:last-child { border-radius: 0 6px 6px 0; border-left: 0; }
    .mt-seg-btn.on { background: var(--accent-soft); color: var(--accent); border-color: rgba(59, 130, 246, 0.35); }
    .mt-chips { display: inline-flex; gap: 6px; flex-wrap: wrap; }
    .mt-chip {
      padding: 3px 10px; font: inherit; font-size: 12px; cursor: pointer;
      border: 1px solid var(--border); border-radius: 999px;
      background: var(--surface-2); color: var(--text-muted); opacity: 0.55;
    }
    .mt-chip.on { opacity: 1; background: var(--accent-soft); color: var(--accent); border-color: rgba(59, 130, 246, 0.35); }

    .mt-main { flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden; }
    .mt-tiers {
      flex: 1 1 auto; min-width: 0; overflow: auto;
      display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px; padding: 16px; align-content: start;
    }
    .mt-tier { min-width: 0; }
    .mt-tier-head {
      font-size: 11px; font-weight: 700; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px;
    }
    .mt-tier-count {
      display: inline-block; margin-left: 4px; padding: 0 6px; border-radius: 999px;
      background: var(--surface-2); color: var(--text-muted); font-weight: 600;
    }
    .mt-tier-body { display: flex; flex-direction: column; gap: 8px; }
    .mt-tier-empty { color: var(--text-muted); font-size: 12px; padding: 4px 2px; }

    .mt-card {
      display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
      padding: 9px 11px; border-radius: 9px; cursor: pointer;
      background: var(--sheen), var(--surface-2); border: 1px solid rgba(15, 23, 42, 0.05);
      box-shadow: var(--shadow-1); font: inherit;
      transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
    }
    .mt-card:hover { border-color: rgba(59, 130, 246, 0.4); box-shadow: var(--shadow-2); transform: translateY(-1px); }
    .mt-card-ic { flex: none; font-size: 15px; }
    .mt-card-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: 13.5px; font-weight: 500; }
    .mt-card-meta { flex: none; font-size: 11px; color: var(--text-muted); }
    .mt-fields { list-style: none; margin: 4px 0 2px; padding: 0 0 0 6px; display: flex; flex-direction: column; gap: 2px; }
    .mt-field {
      display: flex; align-items: baseline; gap: 8px; font-size: 12px;
      padding: 1px 0 1px 8px; border-left: 2px solid var(--border-strong);
    }
    .mt-field-name { color: var(--text); }
    .mt-field-type { margin-left: auto; color: var(--text-muted); font-family: ui-monospace, monospace; font-size: 11px; }

    /* Field-tint concept colours (border accent) */
    .mt-c-key { border-left-color: #94a3b8; }
    .mt-c-identity { border-left-color: #60a5fa; }
    .mt-c-contact { border-left-color: #22d3ee; }
    .mt-c-content { border-left-color: #a78bfa; }
    .mt-c-measure { border-left-color: #34d399; }
    .mt-c-state { border-left-color: #fbbf24; }
    .mt-c-time { border-left-color: #fb923c; }
    .mt-c-secret { border-left-color: #f87171; }

    /* Detail panel (slides in on the right of the tiers area) */
    .mt-detail {
      flex: 0 0 320px; max-width: 360px; overflow: auto;
      border-left: 1px solid var(--border); background: var(--surface); padding: 16px;
    }
    .mt-detail[hidden] { display: none; }
    .mt-detail-head { display: flex; align-items: center; gap: 8px; }
    .mt-detail-title { font-size: 15px; font-weight: 600; color: var(--text); flex: 1 1 auto; min-width: 0; }
    .mt-detail-close { flex: none; width: 24px; height: 24px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2); color: var(--text-muted); cursor: pointer; }
    .mt-detail-sub { font-size: 12px; color: var(--text-muted); margin: 4px 0 14px; }
    .mt-detail-sec h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin: 12px 0 6px; }
    .mt-detail-field {
      display: flex; align-items: baseline; gap: 8px; font-size: 12.5px;
      padding: 3px 0 3px 8px; border-left: 2px solid var(--border-strong);
    }
    .mt-caveats .mt-caveat { padding: 8px 10px; border-radius: 8px; background: var(--surface-2); margin-bottom: 6px; }
    .mt-caveat-label { font-size: 12.5px; font-weight: 600; color: var(--text); }
    .mt-caveat-detail { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
    .mt-detail-open { display: inline-block; margin-top: 14px; font-size: 13px; color: var(--accent); text-decoration: none; }
    .mt-detail-open:hover { text-decoration: underline; }

`;
