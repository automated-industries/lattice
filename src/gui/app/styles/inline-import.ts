// Auto-composed section of the GUI stylesheet. Styles the inline structured-source
// import confirm card that renders into the assistant rail when a dropped file is
// recognized as a structured source. See styles/index.ts for composition.
export const inlineImportCss = `
    /* ── Inline import confirm card (assistant rail) ── */
    .cd-sub { margin: 10px 0 6px; font-size: 12px; color: var(--text-muted, #64748b); }
    .cd-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
    .cd-path {
      flex: 1 1 220px; min-width: 0; box-sizing: border-box; height: 34px; padding: 0 10px;
      border-radius: 6px; border: 1px solid #e6eaf0;
      background: var(--panel, #ffffff); color: var(--text, #0f172a); font-size: 13px;
    }
    .cd-status { margin-top: 12px; font-size: 13px; line-height: 1.5; }
    .cd-status.ok { color: #3b82f6; }
    .cd-status.err { color: #f87171; }
    .cd-status a { color: var(--accent, #3b82f6); }
    .cd-btn {
      height: 34px; padding: 0 14px; border-radius: 6px; border: 1px solid #e6eaf0;
      background: transparent; color: var(--text, #0f172a); font-size: 13px;
      font-weight: 600; cursor: pointer;
    }
    .cd-btn:hover { background: rgba(15, 23, 42, 0.04); }
    .cd-btn.cd-primary { background: #3b82f6; color: var(--btn-text); border-color: #3b82f6; }
    .cd-btn.cd-primary:hover { filter: brightness(1.06); }
    .cd-import-list { margin: 10px 0 0; padding-left: 18px; font-size: 13px; line-height: 1.6; }
    .cd-import-list li { margin: 2px 0; }
    .imp-sub { margin: 16px 0 6px; font-size: 13px; color: var(--text, #0f172a); }
    .imp-modes { display: flex; flex-direction: column; gap: 8px; margin: 0 0 6px; }
    .imp-modes label {
      display: flex; gap: 8px; align-items: flex-start; font-size: 13px; line-height: 1.4;
      padding: 8px 10px; border: 1px solid #e6eaf0; border-radius: 6px; cursor: pointer;
    }
    .imp-modes label:hover { background: rgba(15, 23, 42, 0.03); }
    .imp-modes input { margin-top: 2px; }
    .imp-modes b { color: var(--text, #0f172a); }
    .imp-percol {
      display: flex; gap: 8px; align-items: flex-start; font-size: 13px; line-height: 1.4;
      margin: 8px 0 0; cursor: pointer; color: var(--text-dim, #64748b);
    }
    .imp-percol input { margin-top: 2px; }
    .imp-computed {
      display: flex; gap: 8px; align-items: flex-start; font-size: 13px; line-height: 1.4;
      margin: 6px 0 0; cursor: pointer; color: var(--text-dim, #64748b);
    }
    .imp-computed input { margin-top: 2px; }
    .imp-computed b { color: var(--text, #0f172a); }
    .imp-match { border-left: 3px solid var(--accent, #7dd3fc); font-weight: 500; }
    .feed-item.import-confirm .imp-confirm-body { margin-top: 4px; }

    /* ── Live import progress in the card's log ── */
    .feed-item.import-confirm .imp-card-log,
    .feed-item.import-live .imp-card-log {
      margin-top: 4px;
      font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      max-height: 200px; overflow-y: auto; color: var(--text-muted, #64748b);
    }
    .imp-card-line { white-space: pre-wrap; word-break: break-word; }
    .imp-card-line.imp-done { color: var(--accent, #3b82f6); }
    .imp-card-line.imp-err { color: #f87171; }
    .imp-card-line.imp-spin::after {
      content: ''; display: inline-block; width: 10px; height: 10px; margin-left: 7px;
      border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%;
      vertical-align: -1px; animation: imp-spin-kf 0.7s linear infinite;
    }
    @keyframes imp-spin-kf { to { transform: rotate(360deg); } }
`;
