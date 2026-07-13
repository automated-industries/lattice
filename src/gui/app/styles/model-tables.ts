// Auto-composed section of the GUI stylesheet (see styles/index.ts). The Model
// "Tables" explorer: the tier columns (Inputs / Derived Tables / Computed
// Tables), the entity/field cards, the field tints, and the detail panel.
// (Graph vs Tables is now a top-level tab/route, not an in-pane toggle — so the
// old toggle styles are gone.)
export const modelTablesCss = `    /* ── Model "Tables" route container ────────────────────── */
    .model-tables-view { height: 100%; min-height: 0; }

    /* ── Tables explorer ───────────────────────────────────── */
    .mt { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .mt-bar {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      padding: 12px 14px; border-bottom: 1px solid var(--border); flex: 0 0 auto;
    }
    .mt-seg { display: inline-flex; }
    .mt-seg-btn {
      padding: 4px 12px; font: inherit; font-size: 13px; cursor: pointer;
      border: 1px solid var(--border); background: var(--surface-2); color: var(--text-muted);
    }
    .mt-seg-btn:first-child { border-radius: var(--r-sm) 0 0 var(--r-sm); }
    .mt-seg-btn:last-child { border-radius: 0 var(--r-sm) var(--r-sm) 0; border-left: 0; }
    .mt-seg-btn.on { background: var(--accent-soft); color: var(--accent); border-color: rgba(59, 130, 246, 0.35); }
    /* "+ Wire" — toggles wiring mode (click a source table, then a target). */
    .mt-wire {
      margin-left: auto; padding: 4px 12px; font: inherit; font-size: 13px; font-weight: 600;
      border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2);
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
      margin-left: 6px; padding: 4px 12px; font: inherit; font-size: 13px; font-weight: 600;
      border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2);
      color: var(--hue-amber-ink); cursor: pointer;
    }
    .mt-merge:hover { background: var(--warn-soft); border-color: var(--warn-border); }
    .mt-merge.on { background: var(--hue-amber-deep); color: var(--btn-text); border-color: var(--hue-amber-deep); }

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
    .mt-edge-m2m { stroke: var(--hue-violet-deep); opacity: 0.6; }
    .mt-tier { min-width: 0; position: relative; z-index: 1; }
    /* Wiring / merging affordances. */
    .mt.mt-wiring .mt-card { cursor: crosshair; }
    .mt-card.mt-wire-from { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft), var(--shadow-2); }
    /* Invalid targets while a source is held: dimmed + unclickable/undroppable. */
    .mt-card.mt-card-disabled { opacity: 0.4; pointer-events: none; cursor: not-allowed; }
    /* The card currently being dragged onto a target. */
    .mt-card.mt-drag-active { opacity: 0.6; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
    /* In merge mode, tint the held source amber to match the Merge action. */
    .mt.mt-mode-merge .mt-card.mt-wire-from { border-color: var(--hue-amber-deep); box-shadow: 0 0 0 2px color-mix(in srgb, var(--warn) 18%, transparent), var(--shadow-2); }
    .mt-tier-head {
      font-size: 11px; font-weight: 700; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px;
    }
    .mt-tier-count {
      display: inline-block; margin-left: 4px; padding: 0 6px;
      background: var(--surface-2); color: var(--text-muted); font-weight: 600;
    }
    /* A belongsTo-nested table indents under its parent (line = m2m only). */
    .mt-nest { border-left: 2px solid var(--border); padding-left: 8px; }
    .mt-tier-body { display: flex; flex-direction: column; gap: 8px; }
    .mt-tier-empty { font-size: 12px; padding: 4px 2px; }

    .mt-card {
      display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
      padding: 10px 12px; border-radius: var(--r-md); cursor: pointer;
      background: var(--sheen), var(--surface-2); border: 1px solid var(--edge-faint);
      box-shadow: var(--shadow-1); font: inherit;
      /* Drag-to-wire/merge uses pointer events; suppress the browser's touch pan/
         zoom AND native text-selection so a drag can't hand the pointer stream to
         the OS mid-gesture (that freezes the ghost in webviews — same fix as
         .fs-tile). Pairs with setPointerCapture in wiremerge.ts. */
      touch-action: none; -webkit-user-select: none; user-select: none;
      transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
    }
    .mt-card:hover { border-color: var(--accent-border); box-shadow: var(--shadow-2); transform: translateY(-1px); }
    .mt-card-ic { flex: none; font-size: 15px; }
    .mt-card-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: 14px; font-weight: 500; }
    /* Computed-table flag (a live read-only projection) on a card. */
    .mt-card-flag { flex: none; font-size: 11px; font-weight: 700; font-family: ui-monospace, monospace; color: var(--accent); }
    .mt-card-meta { flex: none; font-size: 11px; color: var(--text-muted); }
    .mt-fields { list-style: none; margin: 4px 0 2px; padding: 0 0 0 6px; display: flex; flex-direction: column; gap: 2px; }
    .mt-field {
      display: flex; align-items: baseline; gap: 8px; font-size: 12px;
      padding: 2px 0 2px 8px; border-left: 2px solid var(--border-strong); cursor: pointer;
    }
    .mt-field:hover { background: var(--row-hover); }
    .mt-field-name { color: var(--text); }
    .mt-field-type { margin-left: auto; color: var(--text-muted); font-family: ui-monospace, monospace; font-size: 11px; }

    /* Field-tint concept colours (border accent) */
    .mt-c-key { border-left-color: var(--hue-slate); }
    .mt-c-identity { border-left-color: var(--accent-glow); }
    .mt-c-contact { border-left-color: var(--hue-cyan); }
    .mt-c-content { border-left-color: var(--hue-violet); }
    .mt-c-measure { border-left-color: var(--hue-emerald); }
    .mt-c-state { border-left-color: var(--hue-amber); }
    .mt-c-time { border-left-color: var(--hue-orange); }
    .mt-c-secret { border-left-color: var(--hue-red); }

    /* Detail panel (slides in on the right of the tiers area) */
    .mt-detail {
      flex: 0 0 320px; max-width: 360px; overflow: auto;
      border-left: 1px solid var(--border); background: var(--surface); padding: 16px;
    }
    .mt-detail[hidden] { display: none; }
    .mt-detail-head { display: flex; align-items: center; gap: 8px; }
    .mt-detail-title { font-size: 15px; font-weight: 600; color: var(--text); flex: 1 1 auto; min-width: 0; }
    .mt-detail-close { flex: none; width: 24px; height: 24px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); color: var(--text-muted); cursor: pointer; }
    .mt-detail-sub { font-size: 12px; color: var(--text-muted); margin: 4px 0 14px; }
    .mt-detail-sec h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin: 12px 0 6px; }
    .mt-detail-field {
      display: flex; align-items: baseline; gap: 8px; font-size: 13px;
      padding: 4px 0 4px 8px; border-left: 2px solid var(--border-strong);
    }
    .mt-detail-open { display: inline-block; margin-top: 14px; font-size: 13px; color: var(--accent); text-decoration: none; }
    .mt-detail-open:hover { text-decoration: underline; }
    .mt-detail-field.mt-field-focus { background: var(--accent-soft); border-radius: var(--r-xs); }

    /* ── Lineage: selection highlight on the tier cards + the detail chips ── */
    /* Selecting a table rings it (accent) and tints its directly-connected cards:
       upstream sources (violet) and downstream consumers (teal). */
    .mt-card.mt-sel { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft), var(--shadow-2); }
    .mt-card.mt-up { border-color: var(--hue-violet-deep); box-shadow: 0 0 0 1px color-mix(in srgb, var(--hue-violet-deep) 35%, transparent); }
    .mt-card.mt-down { border-color: var(--hue-teal-deep); box-shadow: 0 0 0 1px color-mix(in srgb, var(--hue-teal-deep) 35%, transparent); }
    .mt-lin { display: flex; flex-direction: column; gap: 4px; }
    .mt-lin-chip {
      display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
      padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--r-sm);
      background: var(--surface-2); color: var(--text); font: inherit; font-size: 13px; cursor: pointer;
    }
    .mt-lin-chip:hover { border-color: var(--accent-border); background: var(--row-hover); }
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
      width: 24px; border: 1px solid var(--border); border-radius: var(--r-sm);
      background: var(--surface-2); color: var(--text-muted); cursor: pointer;
      font-size: 11px; line-height: 1; user-select: none;
    }
    .mt-lin-x:hover { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 50%, transparent); background: color-mix(in srgb, var(--danger) 12%, transparent); }
    .mt-lin-x-busy { opacity: 0.5; pointer-events: none; }
    .mt-fl { font-size: 12px; color: var(--text-muted); padding: 4px 0; font-family: ui-monospace, monospace; }
    .mt-fl-f { color: var(--accent); }
    .mt-fl-t { color: var(--text); }
    .mt-fl-none { font-family: inherit; }

    /* ── Data lineage map (shown above a table's rows) ─────────
       Upstream sources (left) · this table + its fields (centre) · downstream consumers
       (right), reusing the Data Model explorer's chip look. Click a node → open it in the
       Data Model tab. */
    .table-lineage { margin: 4px 0 14px; }
    .table-lineage:empty { display: none; }
    .lineage-wrap { border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); }
    .lineage-sum {
      cursor: pointer; padding: 10px 14px; font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); list-style: none;
    }
    .lineage-sum::-webkit-details-marker { display: none; }
    .lineage-grid {
      display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr) minmax(0, 1fr);
      gap: 16px; align-items: start; padding: 0 14px 14px;
    }
    .lin-col { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .lin-col-h {
      font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
      color: var(--text-muted); margin-bottom: 2px;
    }
    .lin-col-none { font-size: 12px; color: var(--text-muted); }
    .lin-node {
      display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; min-width: 0;
      padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--r-sm);
      background: var(--surface-2); color: var(--text); font: inherit; font-size: 13px; cursor: pointer;
    }
    .lin-node:hover { border-color: var(--accent-border); background: var(--row-hover); }
    .lin-node-ic { flex: none; font-size: 15px; }
    .lin-node-lab { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lin-node-via {
      margin-left: auto; font-family: ui-monospace, monospace; font-size: 11px; color: var(--text-muted);
      min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .lin-center { display: flex; flex-direction: column; gap: 8px; }
    .lin-center-node {
      display: flex; align-items: center; gap: 8px; justify-content: center; padding: 10px;
      border: 1px solid var(--accent-border); border-radius: var(--r-md); background: var(--accent-wash); font-weight: 700;
    }
    .lin-center-lab { font-size: 14px; }
    .lin-fields { display: flex; flex-wrap: wrap; gap: 4px; justify-content: center; }
    .lin-field {
      font-size: 11px; padding: 4px 8px; border: 1px solid var(--border); border-radius: var(--r-pill);
      background: var(--surface-2); color: var(--text-muted);
    }
    @media (max-width: 760px) { .lineage-grid { grid-template-columns: 1fr; } }

`;
