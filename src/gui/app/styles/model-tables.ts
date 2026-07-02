// Auto-composed section of the GUI stylesheet (see styles/index.ts). The Model
// "Tables" explorer: the four tier columns, the entity/field cards, the field
// tints, and the detail panel. (Graph vs Tables is now a top-level tab/route,
// not an in-pane toggle — so the old toggle styles are gone.)
export const modelTablesCss = `    /* ── Model "Tables" route container ────────────────────── */
    .model-tables-view { height: 100%; min-height: 0; }

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
    /* "+ Wire" — toggles wiring mode (click a source table, then a target). */
    .mt-wire {
      margin-left: auto; padding: 4px 12px; font: inherit; font-size: 12.5px; font-weight: 600;
      border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2);
      color: var(--accent); text-decoration: none; cursor: pointer;
    }
    .mt-wire:hover { background: var(--accent-soft); border-color: rgba(59, 130, 246, 0.35); }
    .mt-wire.on { background: var(--accent); color: var(--btn-text); border-color: var(--accent); }
    .mt-wire-hint { margin-left: auto; margin-right: 10px; font-size: 12px; color: var(--accent); }
    .mt-wire-hint + .mt-wire { margin-left: 0; }
    /* "Merge" — toggles merge mode (move one table's rows into another, then
       remove the emptied source). Sits next to "+ Wire"; a warm accent signals a
       structural (but reversible) change. */
    .mt-merge {
      margin-left: 6px; padding: 4px 12px; font: inherit; font-size: 12.5px; font-weight: 600;
      border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2);
      color: #b45309; cursor: pointer;
    }
    .mt-merge:hover { background: rgba(245, 158, 11, 0.12); border-color: rgba(245, 158, 11, 0.4); }
    .mt-merge.on { background: #d97706; color: var(--btn-text); border-color: #d97706; }

    .mt-main { flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden; }
    .mt-tiers {
      position: relative; /* positioning context for the edge SVG overlay */
      flex: 1 1 auto; min-width: 0; overflow: auto;
      display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px; padding: 16px; align-content: start;
    }
    /* Relationship connectors sit ABOVE the cards (z-index 2 > the .mt-tier cards'
       z-index 1) so a link is never hidden behind a table; pointer-events:none
       keeps the cards clickable. Solid strokes (no dashes). */
    svg.mt-edges { position: absolute; top: 0; left: 0; pointer-events: none; z-index: 2; overflow: visible; }
    .mt-edge { fill: none; stroke-width: 1.75; }
    .mt-edge-fk { stroke: var(--accent); opacity: 0.6; }
    .mt-edge-m2m { stroke: #7c3aed; opacity: 0.6; }
    .mt-tier { min-width: 0; position: relative; z-index: 1; }
    /* Wiring / merging affordances. */
    .mt.mt-wiring .mt-card { cursor: crosshair; }
    .mt-card.mt-wire-from { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft), var(--shadow-2); }
    /* Invalid targets while a source is held: dimmed + unclickable/undroppable. */
    .mt-card.mt-card-disabled { opacity: 0.4; pointer-events: none; cursor: not-allowed; }
    /* The card currently being dragged onto a target. */
    .mt-card.mt-drag-active { opacity: 0.6; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
    /* In merge mode, tint the held source amber to match the Merge action. */
    .mt.mt-mode-merge .mt-card.mt-wire-from { border-color: #d97706; box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.18), var(--shadow-2); }
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
      /* Drag-to-wire/merge uses pointer events; suppress the browser's touch pan/
         zoom AND native text-selection so a drag can't hand the pointer stream to
         the OS mid-gesture (that freezes the ghost in webviews — same fix as
         .fs-tile). Pairs with setPointerCapture in wiremerge.ts. */
      touch-action: none; -webkit-user-select: none; user-select: none;
      transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
    }
    .mt-card:hover { border-color: rgba(59, 130, 246, 0.4); box-shadow: var(--shadow-2); transform: translateY(-1px); }
    .mt-card-ic { flex: none; font-size: 15px; }
    .mt-card-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: 13.5px; font-weight: 500; }
    .mt-card-meta { flex: none; font-size: 11px; color: var(--text-muted); }
    .mt-fields { list-style: none; margin: 4px 0 2px; padding: 0 0 0 6px; display: flex; flex-direction: column; gap: 2px; }
    .mt-field {
      display: flex; align-items: baseline; gap: 8px; font-size: 12px;
      padding: 1px 0 1px 8px; border-left: 2px solid var(--border-strong); cursor: pointer;
    }
    .mt-field:hover { background: var(--row-hover); }
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
    .mt-detail-open { display: inline-block; margin-top: 14px; font-size: 13px; color: var(--accent); text-decoration: none; }
    .mt-detail-open:hover { text-decoration: underline; }
    .mt-detail-field.mt-field-focus { background: var(--accent-soft); border-radius: 4px; }

    /* ── Lineage: selection highlight on the tier cards + the detail chips ── */
    /* Selecting a table rings it (accent) and tints its directly-connected cards:
       upstream sources (violet) and downstream consumers (teal). */
    .mt-card.mt-sel { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft), var(--shadow-2); }
    .mt-card.mt-up { border-color: #7c3aed; box-shadow: 0 0 0 1px rgba(124, 58, 237, 0.35); }
    .mt-card.mt-down { border-color: #0d9488; box-shadow: 0 0 0 1px rgba(13, 148, 136, 0.35); }
    .mt-lin { display: flex; flex-direction: column; gap: 4px; }
    .mt-lin-chip {
      display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
      padding: 5px 8px; border: 1px solid var(--border); border-radius: 7px;
      background: var(--surface-2); color: var(--text); font: inherit; font-size: 12.5px; cursor: pointer;
    }
    .mt-lin-chip:hover { border-color: rgba(59, 130, 246, 0.4); background: var(--row-hover); }
    .mt-lin-via {
      margin-left: auto; font-family: ui-monospace, monospace; font-size: 11px; color: var(--text-muted);
      /* The via can be a long junction name; truncate it so it never pushes the
         removal ✕ off the (fixed-width) detail panel. */
      min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* A consumer chip pairs the (clickable) chip with a ✕ that removes the link.
       min-width:0 + overflow:hidden let the chip shrink inside the flex row so the
       fixed-width ✕ stays visible within the panel. */
    .mt-lin-chip-wrap { display: flex; align-items: stretch; gap: 4px; min-width: 0; }
    .mt-lin-chip-wrap .mt-lin-chip { flex: 1 1 auto; width: auto; min-width: 0; overflow: hidden; }
    .mt-lin-x {
      flex: none; display: inline-flex; align-items: center; justify-content: center;
      width: 24px; border: 1px solid var(--border); border-radius: 7px;
      background: var(--surface-2); color: var(--text-muted); cursor: pointer;
      font-size: 11px; line-height: 1; user-select: none;
    }
    .mt-lin-x:hover { color: #ef4444; border-color: rgba(239, 68, 68, 0.5); background: color-mix(in srgb, #ef4444 12%, transparent); }
    .mt-lin-x-busy { opacity: 0.5; pointer-events: none; }
    .mt-fl { font-size: 12px; color: var(--text-muted); padding: 3px 0; font-family: ui-monospace, monospace; }
    .mt-fl-f { color: var(--accent); }
    .mt-fl-t { color: var(--text); }
    .mt-fl-none { font-family: inherit; }

`;
