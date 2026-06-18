// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const buttonsCss = `    /* ── Buttons ──────────────────────────────────────── */
    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      height: 30px; padding: 0 12px;
      background: var(--surface); color: var(--text);
      border: 1px solid var(--border-strong); border-radius: 6px;
      font-size: 13px;
    }
    .btn:hover { background: var(--row-hover); }
    .btn.primary { background: linear-gradient(135deg, var(--accent-glow), var(--accent-deep)); color: #0b0d10; border-color: var(--accent-deep); font-weight: 600; box-shadow: var(--glow-accent-soft); }
    .btn.primary:hover { background: linear-gradient(135deg, var(--accent-glow), var(--accent)); border-color: var(--accent-glow); box-shadow: var(--glow-accent); }
    .btn.danger { color: var(--warn); border-color: rgba(251, 146, 60, 0.4); }
    .btn.danger:hover { background: rgba(251, 146, 60, 0.12); }
    /* Solid red for genuinely destructive, irreversible actions (delete database). */
    .btn.destructive { background: var(--danger); color: #fff; border-color: var(--danger); font-weight: 600; }
    .btn.destructive:hover { background: var(--danger-deep); border-color: var(--danger-deep); }
    .btn.destructive:disabled { opacity: 0.45; cursor: not-allowed; }
    .danger-zone { margin-top: 18px; padding: 14px; border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 8px; background: rgba(239, 68, 68, 0.05); }
    .danger-zone h3 { margin: 0 0 6px; color: var(--danger); }
    .btn.ghost { background: transparent; border-color: transparent; color: var(--text-muted); }
    .btn.ghost:hover { background: var(--row-hover); color: var(--text); }
    .view-header .actions { margin-left: auto; display: flex; gap: 8px; }

    /* Row delete / restore controls */
    .row-actions { width: 88px; text-align: center; white-space: nowrap; }
    .row-delete, .row-restore {
      background: transparent; border: none; color: var(--text-muted);
      font-size: 16px; cursor: pointer; padding: 4px 6px;
      border-radius: 4px;
    }
    tr:hover .row-delete { color: var(--warn); }
    .row-delete:hover { background: rgba(251, 146, 60, 0.12); }
    .row-restore:hover { background: var(--accent-soft); color: var(--accent); }
    tr.row-deleted td { background: rgba(251, 146, 60, 0.08); color: var(--text-muted); }
    tr.row-deleted:hover td { background: #fcf5e3; }
    /* Per-row visibility indicator (2.2). Reuses the team share colour
       language — yellow (#eab308) = visible to everyone, red (#ef4444) =
       private — matching the .sw-shared / .sw-private swatches. Owner =
       interactive toggle; non-owner = faded + inert (status only). */
    .row-vis {
      background: transparent; border: none; padding: 4px 6px; border-radius: 4px;
      font-size: 14px; line-height: 1; cursor: pointer; text-decoration: none;
      color: #eab308;
    }
    .row-vis:hover { filter: brightness(1.18); }
    .row-vis-private { color: #ef4444; }
    .row-vis-disabled { cursor: default; pointer-events: none; opacity: 0.45; }
    /* Grants checklist (detail view, owner-only): who can see a
       shared-with-specific-people row. Checkboxes post straight to the
       row-grant endpoints. */
    .grants-panel {
      margin: 4px 0 10px; padding: 10px 12px; max-width: 420px;
      border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2);
      font-size: 13px;
    }
    .grants-panel .grants-title { font-weight: 600; margin-bottom: 6px; }
    .grants-panel .grants-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; cursor: pointer; }
    .grants-panel .grants-row input { accent-color: var(--accent); }

    /* Inline create-row at the bottom of every table */
    tr.create-row td { background: var(--surface-2); }
    tr.create-row input, tr.create-row textarea, tr.create-row select {
      width: 100%; padding: 6px 8px; font: inherit;
      border: 1px solid var(--border); border-radius: 4px; background: var(--surface);
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
      width: 100%; padding: 6px 9px; font: inherit;
      border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface);
    }
    .detail dl.editing textarea { min-height: 60px; resize: vertical; }

`;
