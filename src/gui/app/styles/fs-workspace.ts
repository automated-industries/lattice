// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const fsWorkspaceCss = `    /* ── File-system workspace (default view) ───────────── */
    .fs-crumbs {
      display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
      font-size: 13px; margin-bottom: 16px; color: var(--text-muted);
    }
    .fs-crumbs a { color: var(--accent); }
    .fs-crumbs a:hover { text-decoration: underline; }
    .fs-crumbs a:last-child { color: var(--text); }
    .fs-sep { color: var(--text-muted); font-size: 11px; }
    .fs-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 14px; max-width: 1100px;
    }
    .fs-tile {
      position: relative;
      display: flex; flex-direction: column; align-items: center; gap: 8px;
      padding: 18px 12px 14px; text-align: center;
      background: var(--sheen), var(--surface); border: 1px solid var(--border);
      border-radius: 12px; box-shadow: var(--shadow-2), var(--hl-top); cursor: pointer;
      transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
    }
    /* Per-row privacy indicator in a card-tile corner (lock = private, eye =
       shared). Reuses the shared .vis-indicator component. */
    .fs-tile-vis { position: absolute; top: 8px; right: 8px; opacity: 0.55; }
    .fs-tile-vis svg { width: 13px; height: 13px; }
    .fs-tile:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: var(--shadow-3); }
    .fs-tile-icon { font-size: 40px; line-height: 1; }
    .fs-tile-label {
      font-size: 13px; font-weight: 500; color: var(--text);
      word-break: break-word; overflow: hidden; display: -webkit-box;
      -webkit-line-clamp: 2; -webkit-box-orient: vertical; max-height: 2.6em; line-height: 1.3;
    }
    .fs-folder-count { font-size: 11px; color: var(--text-muted); }
    .fs-empty { color: var(--text-muted); font-style: italic; padding: 28px 4px; }

    /* Document preview (item view, built from columns) */
    .fs-doc {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; padding: 8px 20px; box-shadow: var(--shadow);
      max-width: 900px;
    }
    /* Simple-mode rendered context: formatted markdown documents. */
    .fs-context { max-width: 900px; }
    .fs-context-doc {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; padding: 6px 20px; box-shadow: var(--shadow); margin-top: 16px;
    }
    .fs-context-doc .md-body { font-size: 14px; line-height: 1.6; color: var(--text); }
    .fs-context-doc .md-body h1 { font-size: 18px; margin: 14px 0 6px; }
    .fs-context-doc .md-body h2 { font-size: 15px; margin: 14px 0 6px; }
    .fs-context-doc .md-body h3, .fs-context-doc .md-body h4 { font-size: 13px; margin: 12px 0 4px; color: var(--text-muted); }
    .fs-context-doc .md-body ul { margin: 6px 0; padding-left: 20px; }
    .fs-context-doc .md-body li { margin: 2px 0; }
    .fs-context-doc .md-body p { margin: 6px 0; }
    .fs-context-doc .md-body code { background: var(--surface-2); padding: 1px 4px; border-radius: 4px; font-size: 12.5px; }
    .fs-context-doc .md-body a { color: var(--accent); }
    .fs-field { padding: 12px 0; border-bottom: 1px solid var(--border); }
    .fs-field:last-child { border-bottom: none; }
    /* Inline create-view action row (Save / Cancel). */
    .fs-create-actions { display: flex; gap: 8px; justify-content: flex-end; max-width: 900px; margin-top: 16px; }
    .fs-field-label {
      font-size: 11px; color: var(--text-muted); text-transform: uppercase;
      letter-spacing: 0.04em; margin-bottom: 4px;
    }
    .fs-field-val { font-size: 14px; line-height: 1.5; }
    .fs-field-val.ce { cursor: text; border-radius: 6px; margin: -3px -6px; padding: 3px 6px; }
    .fs-field-val.ce:hover { background: var(--surface-2); outline: 1px dashed var(--border-strong); }
    .fs-field-val.editing { outline: none; background: transparent; }
    .fs-field-val.editing input, .fs-field-val.editing textarea, .fs-field-val.editing select {
      width: 100%; padding: 6px 9px; font: inherit; font-size: 14px;
      border: 1px solid var(--accent); border-radius: 6px; background: var(--surface);
    }
    .fs-field-val.editing textarea { min-height: 80px; resize: vertical; }
    .fs-field-val .md-body { font-size: 14px; line-height: 1.55; }
    .fs-field-val .md-body h1, .fs-field-val .md-body h2, .fs-field-val .md-body h3 { margin: 10px 0 6px; line-height: 1.3; }
    .fs-field-val .md-body ul { margin: 6px 0; padding-left: 20px; }
    .fs-field-val .md-body code { background: var(--surface-2); padding: 1px 4px; border-radius: 4px; font-size: 12.5px; }
    .fs-empty-val { color: var(--text-muted); }
    .fs-link { color: var(--accent); }
    .fs-link:hover { text-decoration: underline; }
    .fs-rel-title { font-size: 13px; color: var(--text-muted); text-transform: uppercase;
      letter-spacing: 0.04em; margin: 24px 0 12px; }

`;
