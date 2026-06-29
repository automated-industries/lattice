// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const assistantRailCss = `    /* ============ AI assistant rail (2.0) ============ */
    .feed-item.feed-pending { opacity: 0.85; }
    .feed-spinner {
      display: inline-block; width: 12px; height: 12px; border-radius: 50%;
      border: 2px solid var(--border-strong); border-top-color: var(--accent);
      animation: feedSpin 0.7s linear infinite; vertical-align: middle;
    }
    @keyframes feedSpin { to { transform: rotate(360deg); } }
    /* Batch-upload progress bar — pinned to the top of the feed while a
       multi-file drop drains through the bounded-concurrency queue. */
    .ingest-progress {
      position: sticky; top: 0; z-index: 3;
      display: flex; flex-direction: column; gap: 6px;
      padding: 8px 10px; border-radius: 8px;
      background: var(--surface); border: 1px solid rgba(59, 130, 246, 0.22);
      box-shadow: var(--shadow-1);
    }
    .ingest-progress-label { font-size: 12px; font-weight: 500; color: var(--text); }
    .ingest-progress-track {
      height: 6px; border-radius: 999px; overflow: hidden; background: var(--border-strong);
    }
    .ingest-progress-fill {
      height: 100%; width: 0%; border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 8px rgba(59, 130, 246, 0.5);
      transition: width 0.3s ease;
    }
    /* Staging tray — dropped/picked files awaiting review before ingest. */
    .staging-tray {
      display: flex; flex-direction: column; gap: 8px;
      padding: 10px; margin: 4px 0; border-radius: 10px;
      background: var(--surface); border: 1px solid rgba(59, 130, 246, 0.28);
      box-shadow: var(--shadow-1);
    }
    .staging-head { font-size: 12px; font-weight: 600; color: var(--text); }
    .staging-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .staging-file { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .staging-file-ic { flex: none; }
    .staging-file-name {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text);
    }
    .staging-file-x {
      flex: none; background: none; border: 0; color: var(--text-muted);
      cursor: pointer; font-size: 13px; line-height: 1; padding: 2px 4px; border-radius: 4px;
    }
    .staging-file-x:hover { background: var(--surface-2); color: var(--danger, #c0392b); }
    .staging-actions { display: flex; gap: 8px; margin-top: 2px; }
    .staging-send { flex: 1; }
    /* ── Floating "Ask Lattice" assistant panel ────────────────────── */
    /* A detached, 3-dimensional card floating off the top-right corner. Shown by
       toggling the .open class (not [hidden]) so it can animate IN and OUT from
       the corner. Closed state stays in the DOM but inert + invisible. */
    .ask-lattice-panel {
      position: fixed; top: 68px; right: 24px; z-index: 1200;
      width: min(400px, calc(100vw - 48px));
      height: min(620px, calc(100vh - 104px));
      display: flex; flex-direction: column;
      background:
        radial-gradient(120% 50% at 100% 0%, rgba(59, 130, 246, 0.10), rgba(59, 130, 246, 0) 60%),
        var(--sheen),
        var(--glass-strong);
      -webkit-backdrop-filter: var(--blur-lg); backdrop-filter: var(--blur-lg);
      border: 1px solid rgba(59, 130, 246, 0.18); border-radius: 16px;
      /* Layered shadow for real depth (a card lifted off the surface). */
      box-shadow:
        0 1px 2px rgba(15, 23, 42, 0.08),
        0 8px 24px -6px rgba(15, 23, 42, 0.22),
        0 24px 60px -12px rgba(15, 23, 42, 0.30),
        var(--hl-top);
      overflow: hidden;
      transform-origin: top right;
      opacity: 0;
      transform: translate(12px, -12px) scale(0.96);
      visibility: hidden;
      pointer-events: none;
      transition:
        opacity 0.18s ease,
        transform 0.2s cubic-bezier(0.16, 1, 0.3, 1),
        visibility 0s linear 0.2s;
    }
    .ask-lattice-panel.open {
      opacity: 1;
      transform: translate(0, 0) scale(1);
      visibility: visible;
      pointer-events: auto;
      transition:
        opacity 0.18s ease,
        transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .ask-lattice-panel.dragging-file { outline: 2px dashed var(--accent); outline-offset: -6px; }
    .ask-lattice-panel-head {
      flex: 0 0 auto; padding: 10px 12px;
      display: flex; align-items: center; gap: 8px;
      background: linear-gradient(180deg, rgba(59, 130, 246, 0.10), rgba(59, 130, 246, 0) 100%);
      border-bottom: 1px solid rgba(59, 130, 246, 0.14);
    }
    .ask-lattice-panel-title {
      font-size: 12px; font-weight: 600; color: var(--accent);
      display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto;
      text-shadow: 0 0 10px rgba(59, 130, 246, 0.35);
    }
    .ask-lattice-panel .ask-lattice-mark { color: var(--accent); }
    .ask-lattice-close {
      flex: 0 0 auto; width: 24px; height: 24px; border: 1px solid var(--border);
      border-radius: 6px; background: var(--surface-2); color: var(--text-muted);
      cursor: pointer; font-size: 13px; line-height: 1;
    }
    .ask-lattice-close:hover { background: var(--row-hover); color: var(--text); }
    /* Title glows while the assistant is working (pending feed / typing) */
    @keyframes askPulse {
      0%, 100% { text-shadow: 0 0 8px rgba(59, 130, 246, 0.25); }
      50% { text-shadow: 0 0 16px rgba(59, 130, 246, 0.6); }
    }
    .ask-lattice-panel:has(.feed-pending) .ask-lattice-panel-title,
    .ask-lattice-panel:has(.chat-typing) .ask-lattice-panel-title { animation: askPulse 1.6s ease-in-out infinite; }
    .rail-threads {
      flex: 1; min-width: 0; background: var(--surface-2); color: var(--text);
      border: 1px solid var(--border); border-radius: 6px; font-size: 12px; padding: 3px 6px;
    }
    .rail-newchat {
      flex: 0 0 auto; width: 26px; height: 26px; border: 1px solid var(--border);
      border-radius: 6px; background: var(--surface-2); color: var(--text-muted);
      cursor: pointer; font-size: 14px; line-height: 1;
    }
    .rail-feed {
      flex: 1 1 auto; overflow-y: auto; padding: 10px 12px;
      display: flex; flex-direction: column; gap: 8px;
    }
    .rail-empty { color: var(--text-muted); font-size: 12.5px; text-align: center; padding: 18px 8px; }
    .feed-item {
      display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; gap: 8px;
      align-items: baseline; padding: 7px 9px; border-radius: 8px;
      background: var(--sheen), var(--surface-2); border: 1px solid rgba(15, 23, 42, 0.035);
      box-shadow: var(--shadow-1);
      animation: feedIn 0.18s ease-out;
    }
    .feed-item.feed-clickable { cursor: pointer; transition: border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease; }
    .feed-item.feed-clickable:hover { border-color: rgba(59, 130, 246, 0.4); background: var(--surface-2); box-shadow: var(--shadow-2); transform: translateY(-1px); }
    .feed-item.feed-clickable:focus-visible { outline: none; box-shadow: var(--glow-focus); }
    @keyframes feedIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    .feed-icon { text-align: center; font-size: 13px; }
    .feed-body { min-width: 0; }
    .feed-summary { font-size: 13px; color: var(--text); word-break: break-word; }
    .feed-meta { margin-top: 2px; display: flex; align-items: center; gap: 6px; }
    .feed-source {
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
      padding: 1px 6px; border-radius: 999px;
      background: var(--accent-soft); color: var(--accent);
      box-shadow: none;
    }
    .feed-time { font-size: 11px; color: var(--text-muted); white-space: nowrap; }

`;
