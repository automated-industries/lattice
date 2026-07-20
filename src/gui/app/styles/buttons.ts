// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const buttonsCss = `    /* ── Buttons ──────────────────────────────────────── */
    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      height: 30px; padding: 0 12px;
      background: var(--surface); color: var(--text);
      border: 1px solid var(--border-strong); border-radius: var(--r-sm);
      font-size: 13px;
    }
    .btn:hover { background: var(--row-hover); }
    .btn.primary { background: var(--accent); color: var(--btn-text); border-color: var(--accent-deep); font-weight: 600; box-shadow: none; }
    .btn.primary:hover { background: var(--accent-deep); border-color: var(--accent-glow); box-shadow: var(--shadow-2); }
    .btn.danger { color: var(--warn); border-color: color-mix(in srgb, var(--hue-orange) 40%, transparent); }
    .btn.danger:hover { background: color-mix(in srgb, var(--hue-orange) 12%, transparent); }
    /* Solid red for genuinely destructive, irreversible actions (delete database). */
    .btn.destructive { background: var(--danger); color: var(--btn-text); border-color: var(--danger); font-weight: 600; }
    .btn.destructive:hover { background: var(--danger-deep); border-color: var(--danger-deep); }
    .btn.destructive:disabled { opacity: 0.45; cursor: not-allowed; }
    .danger-zone { margin-top: 18px; padding: 14px; border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent); border-radius: var(--r-md); background: color-mix(in srgb, var(--danger) 5%, transparent); }
    .danger-zone h3 { margin: 0 0 6px; color: var(--danger); }
    .btn.ghost { background: transparent; border-color: transparent; color: var(--text-muted); }
    .btn.ghost:hover { background: var(--row-hover); color: var(--text); }
    .view-header .actions { margin-left: auto; display: flex; gap: 8px; }

    /* Per-row visibility indicator (2.2). Reuses the team share colour
       language — amber (var(--warn)) = visible to everyone, red (var(--danger)) =
       private — matching the .sw-shared / .sw-private swatches. Owner =
       interactive toggle; non-owner = faded + inert (status only). */
    .row-vis {
      background: transparent; border: none; padding: 4px 6px; border-radius: var(--r-xs);
      font-size: 14px; line-height: 1; cursor: pointer; text-decoration: none;
      color: var(--warn);
    }
    .row-vis:hover { filter: brightness(1.18); }
    .row-vis-private { color: var(--danger); }
    .row-vis-disabled { cursor: default; pointer-events: none; opacity: 0.45; }
    /* Grants checklist (detail view, owner-only): who can see a
       shared-with-specific-people row. Checkboxes post straight to the
       row-grant endpoints. */
    .grants-panel {
      margin: 4px 0 10px; padding: 10px 12px; max-width: 420px;
      border-radius: var(--r-sm); background: var(--surface-2);
      font-size: 13px;
    }
    .grants-panel .grants-title { font-weight: 600; margin-bottom: 6px; }
    .grants-panel .grants-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; }
    .grants-panel .grants-row input { accent-color: var(--accent); }
    .grants-panel .grants-actions { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); }
    .grants-panel .grants-dirty { font-size: 12px; }

    /* Inline create-row at the bottom of every table */
    tr.create-row td { background: var(--surface-2); }
    tr.create-row input, tr.create-row textarea, tr.create-row select {
      width: 100%; padding: 6px 8px; font: inherit;
      border: 1px solid var(--border); border-radius: var(--r-xs); background: var(--surface);
    }
    tr.create-row textarea { min-height: 32px; resize: vertical; }
    tr.create-row #inline-create {
      height: 30px; width: 30px; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 18px;
    }

    /* Detail inputs (inline editing) */
    .detail dl.editing input,
    .detail dl.editing textarea {
      width: 100%; padding: 6px 10px; font: inherit;
      border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--surface);
    }
    .detail dl.editing textarea { min-height: 60px; resize: vertical; }

`;
