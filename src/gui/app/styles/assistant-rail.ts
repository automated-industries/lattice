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
      background: var(--surface); border: 1px solid rgba(190, 242, 100, 0.22);
      box-shadow: var(--shadow-1), var(--glow-accent-soft);
    }
    .ingest-progress-label { font-size: 12px; font-weight: 500; color: var(--text); }
    .ingest-progress-track {
      height: 6px; border-radius: 999px; overflow: hidden; background: var(--border-strong);
    }
    .ingest-progress-fill {
      height: 100%; width: 0%; border-radius: 999px;
      background: linear-gradient(90deg, var(--accent-deep), var(--accent));
      box-shadow: 0 0 8px rgba(190, 242, 100, 0.5);
      transition: width 0.3s ease;
    }
    .assistant-rail {
      position: relative;
      background:
        radial-gradient(120% 60% at 100% 0%, rgba(190, 242, 100, 0.10), rgba(190, 242, 100, 0) 60%),
        var(--sheen),
        rgba(17, 21, 26, 0.66);
      -webkit-backdrop-filter: var(--blur-lg); backdrop-filter: var(--blur-lg);
      border-left: 1px solid rgba(190, 242, 100, 0.10);
      box-shadow: inset 1px 0 0 rgba(255, 255, 255, 0.05), -16px 0 40px -24px rgba(0, 0, 0, 0.7);
      display: flex; flex-direction: column;
      min-width: 0; overflow: hidden;
    }
    .rail-resize {
      position: absolute; left: 0; top: 0; bottom: 0; width: 5px;
      cursor: col-resize; background: transparent; z-index: 5;
      transition: background-color 120ms;
    }
    .rail-resize:hover, .rail-resize.dragging { background: var(--accent-soft); }
    .rail-header {
      flex: 0 0 auto; padding: 12px 14px;
      background: linear-gradient(180deg, rgba(190, 242, 100, 0.10), rgba(190, 242, 100, 0) 100%);
      border-bottom: 1px solid rgba(190, 242, 100, 0.14);
      display: flex; align-items: center; gap: 8px;
    }
    .rail-title {
      font-size: 11px; font-weight: 600; color: var(--accent);
      text-transform: uppercase; letter-spacing: 0.06em; flex: 0 0 auto;
      text-shadow: 0 0 10px rgba(190, 242, 100, 0.35);
    }
    /* Title glows while the assistant is working (pending feed / typing) */
    @keyframes railPulse {
      0%, 100% { text-shadow: 0 0 10px rgba(190, 242, 100, 0.3); }
      50% { text-shadow: 0 0 18px rgba(190, 242, 100, 0.7); }
    }
    .assistant-rail:has(.feed-pending) .rail-title,
    .assistant-rail:has(.chat-typing) .rail-title { animation: railPulse 1.6s ease-in-out infinite; }
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
      background: var(--sheen), var(--surface-2); border: 1px solid rgba(255, 255, 255, 0.05);
      box-shadow: var(--shadow-1);
      animation: feedIn 0.18s ease-out;
    }
    .feed-item.feed-clickable { cursor: pointer; transition: border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease; }
    .feed-item.feed-clickable:hover { border-color: rgba(190, 242, 100, 0.4); background: var(--surface-2); box-shadow: var(--shadow-2), var(--glow-accent-soft); transform: translateY(-1px); }
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
      box-shadow: var(--glow-accent-soft);
    }
    .feed-time { font-size: 11px; color: var(--text-muted); white-space: nowrap; }

`;
