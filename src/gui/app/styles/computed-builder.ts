// Auto-composed section of the GUI stylesheet (see styles/index.ts). The
// computed-table builder page (#/computed/*), the "Computed" badge + read-only
// note on record/collection pages, the Tables explorer's computed-tier
// additions ("+ New" header button, detail-panel actions), and the dashed
// projection connector.
export const computedBuilderCss = `    /* ── Computed-table builder (#/computed/*) ─────────────── */
    .computed-builder { max-width: 980px; padding-bottom: 40px; }
    .cb-name-input {
      font-size: 20px; font-weight: 600; padding: 6px 10px; min-width: 280px;
      font-family: var(--font-mono);
    }
    .cb-name-input.cb-invalid { border-color: var(--danger); box-shadow: 0 0 0 2px color-mix(in srgb, var(--danger) 15%, transparent); }
    .cb-status { margin-left: auto; font-size: 13px; color: var(--text-muted); white-space: nowrap; }
    .cb-error {
      margin: 10px 0; padding: 10px 12px; border: 1px solid var(--danger-border);
      border-radius: var(--r-md); background: color-mix(in srgb, var(--danger) 6%, transparent); color: var(--danger-deep); font-size: 13px;
    }
    .cb-card {
      border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface);
      padding: 14px; margin: 12px 0; box-shadow: var(--shadow-1);
    }
    .cb-label { display: block; font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
    .cb-hint { font-size: 12px; color: var(--text-muted); margin-top: 6px; }
    .cb-fields-head { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px; }
    .cb-field { border: 1px solid var(--border); border-radius: var(--r-md); padding: 10px 12px; margin-bottom: 10px; background: var(--surface); }
    .cb-field-main { display: flex; align-items: center; gap: 8px; }
    .cb-field-name { flex: 1 1 auto; min-width: 0; font-family: var(--font-mono); padding: 6px 8px; }
    .cb-field-kind { flex: 0 0 auto; padding: 6px 8px; }
    .cb-field-del {
      flex: 0 0 auto; border: 0; background: none; color: var(--text-muted);
      cursor: pointer; font: inherit; font-size: 13px; padding: 4px 6px; border-radius: var(--r-sm);
    }
    .cb-field-del:hover { color: var(--danger); background: var(--danger-wash); }
    .cb-mark { flex: 0 0 14px; text-align: center; font-size: 13px; color: var(--border-strong); }
    .cb-mark-ok { color: var(--hue-emerald-deep); }
    .cb-mark-err { color: var(--danger); }
    .cb-field-body { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
    .cb-field-body select, .cb-field-body input { padding: 6px 8px; max-width: 420px; }
    .cb-inline { display: flex; gap: 8px; flex-wrap: wrap; }
    .cb-expr, .cb-prompt { width: 100%; min-height: 54px; padding: 8px 10px; resize: vertical; font-size: 13px; }
    .cb-expr { font-family: var(--font-mono); }
    .cb-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .cb-chip {
      display: inline-flex; align-items: center; gap: 6px; padding: 2px 6px 2px 8px;
      border: 1px solid var(--border); border-radius: var(--r-pill); background: var(--surface-2); font-size: 13px;
    }
    .cb-chip-n {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 15px; height: 15px; border-radius: var(--r-pill); background: var(--accent-soft);
      color: var(--accent); font-size: 11px; font-weight: 600;
    }
    .cb-chip-x { border: 0; background: none; cursor: pointer; color: var(--text-muted); font-size: 11px; padding: 0 2px; }
    .cb-chip-x:hover { color: var(--danger); }
    .cb-chip-input { border: 0 !important; background: none !important; min-width: 160px; padding: 4px 2px; font-size: 13px; }
    .cb-chip-input:focus { outline: none; }
    .cb-actions { display: flex; align-items: center; gap: 8px; margin: 14px 0; }
    .cb-refresh-log {
      margin: 10px 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r-md);
      background: var(--surface-2); font-size: 12px; max-height: 160px; overflow: auto; white-space: pre-wrap;
    }
    .cb-preview-head { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin: 14px 0 6px; }
    .cb-preview-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--r-md); }
    .cb-preview-table { margin: 0; }
    .cb-sql { margin: 12px 0; }
    .cb-sql summary { cursor: pointer; font-size: 13px; color: var(--text-muted); }
    .cb-sql pre {
      margin: 8px 0 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r-md);
      background: var(--surface-2); font-size: 12px; overflow: auto; white-space: pre-wrap;
    }

    /* "Computed" badge + read-only note (record + collection pages). */
    .fs-computed-badge {
      display: inline-flex; align-items: center; padding: 2px 8px; border-radius: var(--r-pill);
      border: 1px solid rgba(59, 130, 246, 0.35); background: var(--accent-soft); color: var(--accent);
      font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap;
    }
    .fs-computed-note { margin: 4px 0 10px; font-size: 13px; color: var(--text-muted); }
    .fs-computed-fields { display: grid; grid-template-columns: minmax(120px, 200px) 1fr; gap: 6px 14px; padding: 14px; margin: 0; }
    .fs-computed-fields dt { color: var(--text-muted); font-size: 13px; padding-top: 2px; }
    .fs-computed-fields dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }

    /* Tables explorer: computed-tier additions. */
    .mt-tier-new {
      margin-left: auto; padding: 2px 8px; font: inherit; font-size: 12px; font-weight: 600;
      border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface);
      color: var(--accent); cursor: pointer;
    }
    .mt-tier-new:hover { background: var(--accent-soft); border-color: rgba(59, 130, 246, 0.35); }
    /* A projection connector (base → computed view) draws dashed, distinct from
       the solid many-to-many links. */
    .mt-edge-computes { stroke: var(--hue-cyan-deep); opacity: 0.55; stroke-dasharray: 5 4; }
    .mt-computed-sec { display: flex; flex-direction: column; gap: 8px; }
    .mt-computed-refresh-row { display: flex; align-items: center; gap: 8px; }
    .mt-computed-refresh-status { font-size: 12px; color: var(--text-muted); min-width: 0; overflow-wrap: anywhere; }
    .mt-computed-sqlpre {
      margin: 6px 0 0; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--r-sm);
      background: var(--surface-2); font-size: 12px; overflow: auto; white-space: pre-wrap; max-height: 220px;
    }
`;
