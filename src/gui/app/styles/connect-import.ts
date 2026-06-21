// Auto-composed section of the GUI stylesheet. Styles the connect-dashboard +
// import-data top-bar buttons, their modal panels, and the live import card in
// the assistant rail. See styles/index.ts for composition.
export const connectImportCss = `
    /* ── Connect / Import top-bar buttons ── */
    .import-data-btn {
      display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
      height: 32px; padding: 0 12px; margin-left: 8px;
      background: transparent; color: #e6e8eb; border: 1px solid #2a2f36;
      border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600;
    }
    .import-data-btn:hover { background: rgba(255, 255, 255, 0.06); }
    .import-data-btn svg { width: 16px; height: 16px; display: block; }
    .connect-dash-btn {
      display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
      height: 32px; padding: 0 12px; margin-left: 8px;
      background: #bef264; color: #0b0d10; border: 0; border-radius: 6px;
      cursor: pointer; font-size: 13px; font-weight: 600;
    }
    .connect-dash-btn:hover { filter: brightness(1.06); }
    .connect-dash-btn svg { width: 16px; height: 16px; display: block; }
    .connect-dash-btn + #settings-gear { margin-left: 8px; }
    @media (max-width: 720px) {
      .connect-dash-btn .connect-dash-label,
      .import-data-btn .import-data-label { display: none; }
      .connect-dash-btn,
      .import-data-btn { padding: 0 8px; }
    }

    /* ── Connect / Import modal ── */
    .ci-modal-backdrop {
      position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.55);
      display: flex; align-items: flex-start; justify-content: center; overflow: auto; padding: 6vh 16px;
    }
    .ci-modal {
      width: 100%; max-width: 640px; box-sizing: border-box;
      background: var(--panel, #0e1116); border: 1px solid #2a2f36; border-radius: 10px;
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5);
    }
    .ci-modal-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 16px; border-bottom: 1px solid #2a2f36;
    }
    .ci-modal-title { font-size: 14px; font-weight: 700; color: var(--text, #e6e8eb); }
    .ci-modal-close {
      background: transparent; border: 0; color: var(--text-muted, #9aa3ad);
      font-size: 16px; cursor: pointer; line-height: 1; padding: 4px 6px; border-radius: 6px;
    }
    .ci-modal-close:hover { background: rgba(255, 255, 255, 0.06); color: var(--text, #e6e8eb); }
    .ci-modal-body { padding: 16px; }

    /* ── Connect / Import panel content ── */
    .cd-step { margin: 0 0 18px; }
    .cd-step h4 { margin: 0 0 6px; font-size: 13px; color: var(--text, #e6e8eb); }
    .cd-step p { margin: 0 0 8px; font-size: 13px; color: var(--text-muted, #9aa3ad); line-height: 1.5; }
    .cd-prompt {
      width: 100%; box-sizing: border-box; min-height: 132px; resize: vertical;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      padding: 8px; border-radius: 6px; border: 1px solid #2a2f36;
      background: var(--panel, #0e1116); color: var(--text, #e6e8eb);
    }
    .cd-desc {
      width: 100%; box-sizing: border-box; min-height: 64px; resize: vertical;
      font: 13px/1.5 inherit; padding: 8px; border-radius: 6px; border: 1px solid #2a2f36;
      background: var(--panel, #0e1116); color: var(--text, #e6e8eb);
    }
    .cd-sub { margin: 10px 0 6px; font-size: 12px; color: var(--text-muted, #9aa3ad); }
    .cd-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
    .cd-path {
      flex: 1 1 220px; min-width: 0; box-sizing: border-box; height: 34px; padding: 0 10px;
      border-radius: 6px; border: 1px solid #2a2f36;
      background: var(--panel, #0e1116); color: var(--text, #e6e8eb); font-size: 13px;
    }
    .cd-status { margin-top: 12px; font-size: 13px; line-height: 1.5; }
    .cd-status.ok { color: #bef264; }
    .cd-status.err { color: #f87171; }
    .cd-status a { color: var(--accent, #bef264); }
    .cd-btn {
      height: 34px; padding: 0 14px; border-radius: 6px; border: 1px solid #2a2f36;
      background: transparent; color: var(--text, #e6e8eb); font-size: 13px;
      font-weight: 600; cursor: pointer;
    }
    .cd-btn:hover { background: rgba(255, 255, 255, 0.06); }
    .cd-btn.cd-primary { background: #bef264; color: #0b0d10; border-color: #bef264; }
    .cd-btn.cd-primary:hover { filter: brightness(1.06); }
    .cd-import-list { margin: 10px 0 0; padding-left: 18px; font-size: 13px; line-height: 1.6; }
    .cd-import-list li { margin: 2px 0; }
    .imp-sub { margin: 16px 0 6px; font-size: 13px; color: var(--text, #e6e8eb); }
    .imp-modes { display: flex; flex-direction: column; gap: 8px; margin: 0 0 6px; }
    .imp-modes label {
      display: flex; gap: 8px; align-items: flex-start; font-size: 13px; line-height: 1.4;
      padding: 8px 10px; border: 1px solid #2a2f36; border-radius: 6px; cursor: pointer;
    }
    .imp-modes label:hover { background: rgba(255, 255, 255, 0.04); }
    .imp-modes input { margin-top: 2px; }
    .imp-modes b { color: var(--text, #e6e8eb); }
    .imp-percol {
      display: flex; gap: 8px; align-items: flex-start; font-size: 13px; line-height: 1.4;
      margin: 8px 0 0; cursor: pointer; color: var(--text-dim, #aeb6c2);
    }
    .imp-percol input { margin-top: 2px; }
    .imp-match { border-left: 3px solid var(--accent, #7dd3fc); font-weight: 500; }
    .cd-or { margin: 8px 0; font-size: 12px; color: var(--text-muted, #9aa3ad); text-align: center; }
    .imp-browse { display: inline-flex; align-items: center; cursor: pointer; }

    /* ── Live import card in the assistant rail ── */
    .feed-item.import-live .imp-card-log {
      margin-top: 4px;
      font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      max-height: 200px; overflow-y: auto; color: var(--text-muted, #9aa3ad);
    }
    .imp-card-line { white-space: pre-wrap; word-break: break-word; }
    .imp-card-line.imp-done { color: var(--accent, #bef264); }
    .imp-card-line.imp-err { color: #f87171; }
    .imp-card-line.imp-spin::after {
      content: ''; display: inline-block; width: 10px; height: 10px; margin-left: 7px;
      border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%;
      vertical-align: -1px; animation: imp-spin-kf 0.7s linear infinite;
    }
    @keyframes imp-spin-kf { to { transform: rotate(360deg); } }
`;
