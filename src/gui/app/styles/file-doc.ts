// Auto-composed section of the GUI stylesheet (see styles/index.ts). The file /
// artifact document view: the editable/raw Source view and the Version History
// panel that sit alongside the formatted preview.
export const fileDocCss = `    /* ── File / artifact document view ─────────────────────── */
    .file-source { display: flex; flex-direction: column; gap: 8px; }
    .file-source-text {
      width: 100%; min-height: 360px; resize: vertical;
      font-family: var(--font-mono); font-size: 13px;
      background: var(--surface-2); color: var(--text);
      border: 1px solid var(--border); border-radius: var(--r-md); padding: 12px;
    }
    .file-source-actions { display: flex; align-items: center; gap: 10px; }
    .file-source-pre {
      white-space: pre-wrap; word-break: break-word;
      font-family: var(--font-mono); font-size: 13px;
      background: var(--surface-2); color: var(--text);
      border: 1px solid var(--border); border-radius: var(--r-md); padding: 12px; overflow: auto;
    }
    /* Full-page version-history view (replaces the body, not an overlay). */
    .file-history-view { padding: 4px 2px; }
    .file-history-list { list-style: none; margin: 0; padding: 0; }
    .file-history-item {
      display: flex; align-items: center; gap: 10px; padding: 6px 0;
      font-size: 13px; border-top: 1px solid var(--border);
    }
    .file-history-item:first-child { border-top: 0; }
    .fh-op { font-weight: 500; text-transform: capitalize; }
    .fh-ts { color: var(--text-muted); }
    .fh-undone { color: var(--text-muted); font-style: italic; }
    .fh-revert { margin-left: auto; }
    /* ── File actions dropdown (next to the title) ─────────── */
    .file-menu-wrap { position: relative; }
    .file-menu-btn { font-size: 18px; line-height: 1; padding: 2px 10px; }
    .file-menu {
      position: absolute; right: 0; top: calc(100% + 4px); z-index: 30;
      min-width: 172px; padding: 6px; display: flex; flex-direction: column;
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg);
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
    }
    /* display:flex above would otherwise beat the UA [hidden] rule and leave the
       menu stuck open — force it gone when hidden. */
    .file-menu[hidden] { display: none; }
    .file-menu-item {
      text-align: left; background: none; border: 0; color: var(--text);
      font-size: 13px; padding: 8px 10px; border-radius: var(--r-sm); cursor: pointer;
    }
    .file-menu-item:hover { background: var(--surface-2); }
    .file-menu-item.danger { color: var(--danger); }

`;
