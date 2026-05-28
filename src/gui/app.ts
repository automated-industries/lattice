export const guiAppHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lattice Browser</title>
  <style>
    /* Design tokens copied from lattice-website's tailwind.config.ts
       (tailwind.config theme.extend.colors). The local GUI ships these
       inline so it doesn't need a build step or a network fetch — keep
       in sync manually when the website's palette changes. Last sync:
       tailwind.config.ts as of feat/teams branch. */
    :root {
      --bg: #0b0d10;
      --surface: #13171b;
      --surface-2: #1a1f25;
      --border: #262d36;
      --border-strong: #2f3742;
      --text: #e7ecf0;
      --text-muted: #8b96a3;
      --accent: #bef264;
      --accent-deep: #84cc16;
      --accent-glow: #d9f99d;
      --accent-soft: rgba(190, 242, 100, 0.12);
      --row-hover: #1a1f25;
      --signal: #22d3ee;
      --warn: #fb923c;
      --danger: #ef4444;
      --danger-deep: #dc2626;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
      --sidebar-width: 380px;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: var(--text);
      background: var(--bg);
      font-size: 14px;
    }
    code, kbd, samp, pre {
      font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    /* Form controls inherit the body text color so they're readable
       on the dark surface. Browsers default inputs to the OS color
       (typically black), which disappears on var(--surface)=#13171b.
       Placeholders default ~black too — bump them to --text-muted.
       Affects every input/select/textarea across the GUI (Data Model
       editor, Database wizard, User Config Identity, all modals). */
    input, select, textarea {
      color: var(--text);
      /* Without an explicit background, bare inputs (Database Settings
         name field, Lattice Settings, invite token box) render the
         browser-default white background while the global color above
         is the light dark-theme text — i.e. light-on-white, unreadable.
         Default to the dark surface; contexts that want a different
         background (modals, wizard) override via more specific rules. */
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    input::placeholder, textarea::placeholder {
      color: var(--text-muted);
      opacity: 1;
    }
    a { color: inherit; text-decoration: none; }
    button { font: inherit; cursor: pointer; }

    /* ── Top bar ───────────────────────────────────────── */
    header.topbar {
      display: flex; align-items: center; gap: 12px;
      min-height: 56px; padding: 8px 20px;
      background: var(--surface); border-bottom: 1px solid var(--border);
      color: var(--text);
      flex-wrap: wrap;
    }
    .brand {
      display: inline-flex; align-items: center;
      flex-shrink: 0; border-radius: 6px;
      padding: 2px; cursor: pointer;
    }
    .brand:hover { background: rgba(255, 255, 255, 0.06); }
    .brand-logo { width: 32px; height: 32px; display: block; }

    /* History controls — dark variant */
    .history-controls { display: inline-flex; gap: 4px; }
    .history-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 32px; height: 32px;
      background: transparent; border: 1px solid #2a2f36;
      border-radius: 6px; cursor: pointer;
      color: #e6e8eb; font-size: 16px; text-decoration: none;
    }
    .history-btn:hover:not([disabled]) { background: rgba(255, 255, 255, 0.06); }
    .history-btn[disabled] { opacity: 0.35; cursor: not-allowed; }

    /* History page */
    .history-list {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; overflow: hidden; max-width: 980px;
    }
    .history-entry { display: flex; gap: 16px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
    .history-entry:last-child { border-bottom: none; }
    .history-entry.is-undone { background: var(--surface-2); }
    .history-entry.is-undone .history-summary { color: var(--text-muted); text-decoration: line-through; }
    .history-meta { min-width: 200px; font-size: 12px; color: var(--text-muted); }
    .history-meta .history-op {
      display: inline-block; padding: 1px 8px;
      background: var(--accent-soft); color: var(--accent);
      border-radius: 8px; font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.04em; font-weight: 600;
    }
    .history-op.op-delete { background: rgba(251, 146, 60, 0.12); color: var(--warn); }
    .history-op.op-link, .history-op.op-unlink { background: rgba(34, 211, 238, 0.15); color: var(--signal); }
    .history-summary { flex: 1; font-size: 13.5px; }
    .history-summary .history-table { font-weight: 600; }
    .history-diff {
      margin-top: 8px; font-family: ui-monospace, monospace; font-size: 12px;
      background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px;
      padding: 8px 10px; white-space: pre-wrap;
    }
    .history-diff .diff-add { color: var(--accent); }
    .history-diff .diff-rem { color: var(--warn); }
    .history-actions { display: flex; flex-direction: column; gap: 4px; }
    .history-actions .btn { font-size: 12px; height: 26px; padding: 0 10px; }
    #history-filter {
      height: 30px; padding: 0 10px; font: inherit; font-size: 13px;
      border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface);
    }

    /* DB switcher in the top bar */
    .db-switcher { position: relative; }
    .db-button {
      display: inline-flex; align-items: center; gap: 6px;
      height: 32px; padding: 0 10px;
      background: #1a1d22; color: #e6e8eb;
      border: 1px solid #2a2f36; border-radius: 6px;
      font-size: 13px; cursor: pointer;
    }
    /* Realtime connection status indicator inside .db-button.
       yellow=local SQLite, green=cloud+SSE connected, red=cloud+disconnected. */
    .db-button .db-status {
      display: inline-block; width: 8px; height: 8px;
      border-radius: 50%; background: var(--warn);
      flex-shrink: 0;
    }
    .db-button .db-status.is-cloud-connected { background: var(--accent); }
    .db-button .db-status.is-cloud-disconnected { background: #ef4444; }
    .db-button .db-status.is-cloud-connecting { background: var(--warn); }
    .db-button:hover { background: rgba(255, 255, 255, 0.08); }
    .db-button .db-caret { color: #9aa1ad; font-size: 10px; }
    .db-menu {
      position: absolute; top: 38px; left: 0;
      min-width: 260px; background: var(--surface);
      border: 1px solid var(--border); border-radius: 8px;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
      z-index: 60; padding: 6px;
    }
    .db-menu .db-section { font-size: 11px; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.06em;
      padding: 8px 10px 4px; }
    .db-menu button.db-item {
      width: 100%; display: flex; align-items: center; gap: 8px;
      padding: 7px 10px; border: none; background: transparent; text-align: left;
      cursor: pointer; border-radius: 6px; font-size: 13.5px; color: var(--text);
    }
    .db-menu button.db-item:hover { background: var(--row-hover); }
    .db-menu button.db-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 500; }
    .db-menu button.db-item .db-item-file { color: var(--text-muted); font-size: 12px; margin-left: auto; }
    .db-menu .db-create { padding: 6px 10px; border-top: 1px solid var(--border); margin-top: 4px; }
    .db-menu .db-create input {
      width: 100%; height: 30px; padding: 0 10px; font: inherit;
      border: 1px solid var(--border-strong); border-radius: 6px;
      background: var(--surface); margin-bottom: 6px;
    }

    /* ── Layout ────────────────────────────────────────── */
    /* minmax(0, 1fr) on the content track lets a wide child (a table with
       chip-heavy cells) shrink instead of forcing the page wider than the
       viewport. Without the explicit 0 lower bound, the implicit auto
       minimum keeps the track at content-width and the whole page scrolls
       horizontally. */
    .layout {
      display: grid; grid-template-columns: 220px minmax(0, 1fr) var(--sidebar-width);
      height: calc(100vh - 56px);
    }
    @media (max-width: 720px) {
      /* Collapse the assistant rail off the grid on narrow viewports. */
      .layout { grid-template-columns: 220px minmax(0, 1fr); }
      .assistant-rail { display: none; }
    }
    nav.sidebar {
      background: var(--surface); border-right: 1px solid var(--border);
      padding: 18px 10px; overflow-y: auto;
    }
    .section-label {
      font-size: 11px; font-weight: 600; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.06em;
      padding: 0 12px; margin: 12px 0 6px;
    }
    .section-label:first-child { margin-top: 0; }
    nav ul { list-style: none; padding: 0; margin: 0; }
    nav li a {
      display: flex; align-items: center; gap: 10px;
      padding: 7px 12px; border-radius: 6px;
      color: var(--text); font-size: 13.5px;
    }
    nav li a .nav-icon { width: 18px; text-align: center; font-size: 14px; }
    nav li a:hover { background: var(--row-hover); }
    nav li a.active { background: var(--accent-soft); color: var(--accent); font-weight: 500; }

    main#content { padding: 24px; overflow: auto; }

    /* ── Assistant rail (activity feed) ────────────────── */
    .assistant-rail {
      position: relative;
      background: var(--surface);
      border-left: 1px solid var(--border);
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
      flex: 0 0 auto; padding: 12px 14px; border-bottom: 1px solid var(--border);
      display: flex; align-items: center; gap: 8px;
    }
    .rail-title {
      font-size: 11px; font-weight: 600; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.06em;
    }
    .rail-feed {
      flex: 1 1 auto; overflow-y: auto; padding: 10px 12px;
      display: flex; flex-direction: column; gap: 8px;
    }
    .rail-empty { color: var(--text-muted); font-size: 12.5px; text-align: center; padding: 18px 8px; }
    .feed-item {
      display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; gap: 8px;
      align-items: baseline; padding: 7px 9px; border-radius: 8px;
      background: var(--surface-2); border: 1px solid var(--border);
      animation: feedIn 0.18s ease-out;
    }
    @keyframes feedIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    .feed-icon { text-align: center; font-size: 13px; }
    .feed-body { min-width: 0; }
    .feed-summary { font-size: 13px; color: var(--text); word-break: break-word; }
    .feed-meta { margin-top: 2px; display: flex; align-items: center; gap: 6px; }
    .feed-source {
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
      padding: 1px 6px; border-radius: 999px;
      background: var(--accent-soft); color: var(--accent);
    }
    .feed-time { font-size: 11px; color: var(--text-muted); white-space: nowrap; }

    /* ── Chat bubbles + tool pills ─────────────────────── */
    .chat-msg { display: flex; animation: feedIn 0.18s ease-out; }
    .chat-msg.user { justify-content: flex-end; }
    .chat-msg.assistant { justify-content: flex-start; }
    .chat-bubble {
      max-width: 85%; padding: 8px 12px; font-size: 13.5px; line-height: 1.45;
      white-space: pre-wrap; word-break: break-word;
    }
    .chat-bubble.user {
      background: var(--accent); color: #0b0d10;
      border-radius: 14px 14px 4px 14px;
    }
    .chat-bubble.assistant {
      background: var(--surface-2); color: var(--text); border: 1px solid var(--border);
      border-radius: 14px 14px 14px 4px;
    }
    .chat-tools { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
    .tool-pill {
      display: inline-flex; align-items: center; gap: 5px;
      border-radius: 999px; padding: 2px 9px; font-size: 11px; font-weight: 500;
      background: var(--accent-soft); color: var(--accent);
    }
    .tool-pill.done { background: var(--surface-2); color: var(--text-muted); }
    .tool-pill.error { background: rgba(251,146,60,0.14); color: var(--warn); }
    .tool-pill .spin { display: inline-block; width: 9px; height: 9px;
      border: 1.5px solid currentColor; border-top-color: transparent; border-radius: 50%;
      animation: pillspin 0.7s linear infinite; }
    @keyframes pillspin { to { transform: rotate(360deg); } }
    .rail-composer { flex: 0 0 auto; border-top: 1px solid var(--border); padding: 10px 12px; }
    .rail-composer textarea {
      width: 100%; resize: none; min-height: 38px; max-height: 120px;
      background: var(--surface-2); color: var(--text);
      border: 1px solid var(--border-strong); border-radius: 8px;
      padding: 8px 10px; font: inherit; font-size: 13.5px;
    }
    .rail-composer .composer-row { display: flex; gap: 8px; align-items: flex-end; }
    .rail-composer .composer-send {
      flex: 0 0 auto; height: 38px; padding: 0 14px; border: none; border-radius: 8px;
      background: var(--accent); color: #0b0d10; font-weight: 600; cursor: pointer;
    }
    .rail-composer .composer-send:disabled { opacity: 0.4; cursor: default; }
    .rail-composer .composer-setup { font-size: 12.5px; color: var(--text-muted); text-align: center; }
    .rail-composer .composer-setup a { color: var(--accent); }
    .rail-composer .composer-mic {
      flex: 0 0 auto; height: 38px; width: 38px; font-size: 15px;
      border: 1px solid var(--border-strong); border-radius: 8px;
      background: var(--surface-2); color: var(--text-muted); cursor: pointer;
    }
    .rail-composer .composer-mic.recording { background: var(--warn); color: #0b0d10; border-color: var(--warn); }
    .rail-composer .composer-mic.transcribing { color: var(--accent); }
    .rail-composer .composer-clip {
      flex: 0 0 auto; height: 38px; width: 38px; font-size: 15px;
      border: 1px solid var(--border-strong); border-radius: 8px;
      background: var(--surface-2); color: var(--text-muted); cursor: pointer;
    }
    .assistant-rail.dragging-file::after {
      content: 'Drop to ingest'; position: absolute; inset: 0; z-index: 10;
      display: flex; align-items: center; justify-content: center;
      background: var(--accent-soft); border: 2px dashed var(--accent);
      color: var(--accent); font-weight: 600; pointer-events: none;
    }

    /* ── File preview (files detail page) ──────────────── */
    .file-preview { margin: 4px 0 16px; }
    .file-preview .file-desc {
      margin: 0 0 10px; padding: 10px 12px; font-size: 13.5px; color: var(--text);
      background: var(--accent-soft); border-radius: 8px; border: 1px solid var(--border);
    }
    .file-preview img { max-width: 100%; max-height: 60vh; border: 1px solid var(--border); border-radius: 8px; display: block; }
    .file-preview iframe { width: 100%; height: 60vh; border: 1px solid var(--border); border-radius: 8px; background: #fff; }
    .file-preview pre {
      max-height: 50vh; overflow: auto; background: var(--surface-2); border: 1px solid var(--border);
      border-radius: 8px; padding: 12px; font-size: 12.5px; white-space: pre-wrap; word-break: break-word;
    }
    .file-preview .file-unsupported { color: var(--text-muted); font-size: 13px; padding: 10px 0; }
    .file-preview .file-actions { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }

    /* ── Dashboard ────────────────────────────────────── */
    .dashboard {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;
      max-width: 1100px;
    }
    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; padding: 22px;
      min-height: 160px;
      display: flex; flex-direction: column; gap: 8px;
      box-shadow: var(--shadow);
      transition: transform 0.05s ease, box-shadow 0.15s ease, border-color 0.15s ease;
    }
    .card:hover { border-color: var(--accent); box-shadow: 0 2px 6px rgba(47, 111, 235, 0.12); }
    .card-icon { font-size: 22px; }
    .card-label { font-size: 15px; font-weight: 600; }
    .card-count { font-size: 28px; font-weight: 700; color: var(--text-muted); margin-top: auto; }

    /* ── Table view ───────────────────────────────────── */
    .view-header {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 18px;
    }
    .view-header .entity-icon { font-size: 22px; line-height: 1; padding: 2px 0; }
    .view-header h1 { font-size: 22px; font-weight: 600; margin: 0; }
    .view-header .count { color: var(--text-muted); font-size: 13px; margin-left: 4px; }

    table {
      width: 100%; border-collapse: separate; border-spacing: 0;
      background: var(--surface);
      border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
      box-shadow: var(--shadow);
    }
    thead th {
      text-align: left; font-weight: 600; font-size: 12.5px;
      color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em;
      padding: 12px 14px; background: var(--surface-2);
      border-bottom: 1px solid var(--border);
    }
    tbody td {
      padding: 12px 14px; border-bottom: 1px solid var(--border);
      vertical-align: top; font-size: 13.5px;
    }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr { cursor: pointer; }
    tbody tr:hover td { background: var(--row-hover); }
    td.muted { color: var(--text-muted); }
    /* Row cells truncate at 3 lines so a row with many chips or a long text
       blob stays one consistent visual height instead of wrapping into a
       paragraph. The wrapping <div class="cell-clip"> is necessary because
       -webkit-line-clamp doesn't apply to <td> directly in all engines. */
    td .cell-clip {
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
      line-height: 1.45;
      max-height: calc(1.45em * 3);
      word-break: break-word;
    }
    .chip {
      display: inline-block; padding: 2px 8px; margin: 1px 3px 1px 0;
      background: var(--accent-soft); color: var(--accent);
      border-radius: 10px; font-size: 12px;
    }
    a.chip-link { cursor: pointer; }
    a.chip-link:hover { background: var(--accent); color: white; }
    .empty-row td {
      color: var(--text-muted); font-style: italic; text-align: center;
      padding: 24px;
    }

    /* ── Detail view ──────────────────────────────────── */
    .breadcrumb {
      font-size: 13px; color: var(--accent);
      margin-bottom: 14px; display: inline-block;
    }
    .breadcrumb:hover { text-decoration: underline; }
    .detail dl {
      display: grid; grid-template-columns: 180px 1fr;
      gap: 10px 24px;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; padding: 20px; box-shadow: var(--shadow);
      max-width: 900px;
    }
    .detail dt {
      font-size: 12.5px; color: var(--text-muted); text-transform: uppercase;
      letter-spacing: 0.04em; padding-top: 2px;
    }
    .detail dd { margin: 0; font-size: 14px; }

    /* ── Placeholder / data-model stub ─────────────────── */
    .placeholder {
      background: var(--surface); border: 1px dashed var(--border-strong);
      border-radius: 10px; padding: 40px;
      max-width: 600px; text-align: center;
      color: var(--text-muted);
    }
    .placeholder h2 { margin: 0 0 8px; color: var(--text); }

    /* Data Model: graph on top, edit panel below when an entity is selected. */
    .dm-layout {
      display: flex; flex-direction: column; gap: 20px;
    }
    #graph-mount { background: var(--surface);
      border: 1px solid var(--border); border-radius: 10px; padding: 16px;
      min-height: 60vh; overflow: hidden;
    }
    #graph-mount svg { width: 100%; height: 60vh; display: block; }
    #graph-mount g.gnode { cursor: pointer; }
    #graph-mount g.gnode circle { transition: fill 0.1s ease, stroke 0.1s ease; }
    #graph-mount g.gnode.active circle { fill: var(--accent); stroke: var(--accent); }
    #graph-mount g.gnode.active text { fill: var(--accent); font-weight: 600; }
    #dm-panel {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; padding: 20px;
    }
    #dm-panel h3 { margin: 0 0 12px; font-size: 16px; }
    #dm-panel h4 { margin: 12px 0 6px; font-size: 12.5px;
      color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
    #dm-panel .breadcrumb { cursor: pointer; }
    ul.dm-rows { list-style: none; padding: 0; margin: 0; }
    ul.dm-rows li {
      padding: 8px 10px; border-radius: 6px; cursor: pointer;
      font-size: 13.5px; border: 1px solid transparent;
    }
    ul.dm-rows li:hover { background: var(--row-hover); border-color: var(--border); }
    .dm-junction { margin-bottom: 14px; }
    .dm-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
    .chip-removable {
      display: inline-flex; align-items: center; gap: 4px;
      background: var(--accent-soft); color: var(--accent);
      border-radius: 10px; padding: 2px 4px 2px 8px; font-size: 12px;
    }
    .chip-removable button {
      background: transparent; border: none; color: var(--accent);
      cursor: pointer; padding: 0 4px; font-size: 14px; line-height: 1;
      border-radius: 50%;
    }
    .chip-removable button:hover { background: rgba(47, 111, 235, 0.15); }
    select.dm-add { width: 100%; padding: 6px 10px; font: inherit;
      border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface); }

    /* Data Model entity-edit panel */
    .dm-section { margin: 10px 0; }
    .dm-section summary { cursor: pointer; font-size: 13px; padding: 6px 0;
      color: var(--text); list-style: none; }
    .dm-section summary::before {
      content: '▸'; display: inline-block; margin-right: 6px; color: var(--text-muted);
      transition: transform 0.1s;
    }
    .dm-section[open] summary::before { transform: rotate(90deg); }
    .dm-edit-grid {
      display: grid; grid-template-columns: 110px minmax(0, 1fr);
      gap: 10px 14px; align-items: center; font-size: 13px;
    }
    .dm-edit-grid > label {
      color: var(--text-muted); text-transform: uppercase;
      letter-spacing: 0.04em; font-size: 11px;
      align-self: start; padding-top: 9px;
    }
    .dm-edit-grid input, .dm-edit-grid select {
      padding: 7px 10px; font: inherit; border: 1px solid var(--border-strong);
      border-radius: 6px; background: var(--surface); font-size: 13.5px;
      min-width: 0;
    }
    .dm-row-inline { display: flex; gap: 8px; align-items: center; min-width: 0; }
    .dm-row-inline input { flex: 1 1 auto; min-width: 0; }
    .dm-row-inline select { flex: 0 0 110px; }
    .dm-row-inline .btn { height: 32px; font-size: 12.5px; padding: 0 12px; flex-shrink: 0; }
    .dm-cols { display: flex; flex-direction: column; gap: 6px; }
    .dm-col-row {
      display: grid; grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 8px; align-items: center;
    }
    .dm-col-row input {
      padding: 7px 10px; font: inherit; border: 1px solid var(--border);
      border-radius: 6px; background: var(--surface); font-size: 13.5px; min-width: 0;
    }
    .dm-col-row .dm-locked {
      padding: 7px 10px; font: inherit; font-size: 13.5px;
      color: var(--text-muted); background: var(--surface-2);
      border: 1px dashed var(--border); border-radius: 6px;
      display: flex; align-items: center; gap: 8px;
    }
    .dm-col-row .dm-locked-label { font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.04em; color: var(--text-muted); margin-left: auto; }
    .dm-col-rename { height: 32px; padding: 0 12px; font-size: 12.5px; }
    .dm-secret-toggle {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 11px; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.04em;
      white-space: nowrap; cursor: pointer;
    }
    .dm-secret-toggle input[type="checkbox"] { margin: 0; }

    /* Emoji picker (collapsed by default; click to drop down) */
    .emoji-picker { position: relative; display: inline-block; }
    .emoji-trigger {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 4px 8px 4px 10px; background: var(--surface);
      border: 1px solid var(--border-strong); border-radius: 6px;
      cursor: pointer; min-width: 70px;
    }
    .emoji-trigger:hover { background: var(--row-hover); }
    .emoji-trigger .emoji-preview { font-size: 22px; line-height: 1; }
    .emoji-trigger .emoji-caret { color: var(--text-muted); font-size: 10px; }
    .emoji-grid {
      position: absolute; top: 42px; left: 0; z-index: 70;
      display: grid; grid-template-columns: repeat(8, 36px); gap: 4px;
      background: var(--surface); padding: 8px; border-radius: 8px;
      border: 1px solid var(--border-strong);
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
    }
    .emoji-grid[hidden] { display: none; }
    .emoji-tile {
      width: 36px; height: 36px;
      background: transparent; border: 1px solid transparent;
      border-radius: 6px; cursor: pointer;
      font-size: 18px; line-height: 1; padding: 0;
      display: flex; align-items: center; justify-content: center;
    }
    .emoji-tile:hover { background: var(--row-hover); border-color: var(--border); }
    .emoji-tile.active { background: var(--accent-soft); border-color: var(--accent); }

    /* ── Toast / undo banner ──────────────────────────── */
    .toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: #1f2328; color: white;
      padding: 10px 18px; border-radius: 999px;
      display: flex; align-items: center; gap: 14px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
      z-index: 200; font-size: 13.5px;
      animation: toast-in 0.18s ease;
    }
    @keyframes toast-in {
      from { transform: translate(-50%, 8px); opacity: 0; }
      to   { transform: translate(-50%, 0);   opacity: 1; }
    }
    /* Inline button spinner — shown by withBusy() while an action runs. */
    @keyframes lattice-spin { to { transform: rotate(360deg); } }
    .spinner {
      display: inline-block; width: 12px; height: 12px; margin-right: 6px;
      vertical-align: -1px; border: 2px solid currentColor; border-right-color: transparent;
      border-radius: 50%; animation: lattice-spin 0.6s linear infinite;
    }
    button.is-busy { opacity: 0.75; cursor: progress; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .toast .undo-link {
      color: #87b3ff; cursor: pointer; font-weight: 600;
      background: transparent; border: none; padding: 0; font: inherit;
    }
    .toast .undo-link:hover { color: white; }
    .toast .toast-dismiss {
      background: transparent; border: none; color: #9aa1ad;
      cursor: pointer; padding: 0 4px; font-size: 16px; line-height: 1;
    }
    .toast .toast-dismiss:hover { color: white; }

    /* ── Buttons ──────────────────────────────────────── */
    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      height: 30px; padding: 0 12px;
      background: var(--surface); color: var(--text);
      border: 1px solid var(--border-strong); border-radius: 6px;
      font-size: 13px;
    }
    .btn:hover { background: var(--row-hover); }
    .btn.primary { background: var(--accent); color: #0b0d10; border-color: var(--accent); font-weight: 600; }
    .btn.primary:hover { background: var(--accent-glow); border-color: var(--accent-glow); }
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
    .row-actions { width: 64px; text-align: center; white-space: nowrap; }
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

    /* ── Rendered context (per-row .md from Lattice) ──── */
    .context-block {
      margin-top: 24px; background: var(--surface);
      border: 1px solid var(--border); border-radius: 8px;
      max-width: 900px; box-shadow: var(--shadow);
    }
    .context-file { padding: 12px 18px; border-bottom: 1px solid var(--border); }
    .context-file:last-child { border-bottom: none; }
    .context-file-head {
      display: flex; align-items: baseline; gap: 8px;
      font-size: 12.5px; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.04em;
      margin-bottom: 6px;
    }
    .context-file-head .context-file-name { color: var(--text); font-weight: 600; text-transform: none; letter-spacing: 0; }
    .context-file pre {
      margin: 0; padding: 12px; background: var(--surface-2);
      border: 1px solid var(--border); border-radius: 6px;
      font-family: ui-monospace, 'SF Mono', 'Menlo', Consolas, monospace;
      font-size: 12.5px; line-height: 1.55;
      white-space: pre-wrap; word-break: break-word;
    }
    .context-empty { padding: 16px 18px; color: var(--text-muted); font-style: italic; }

    /* ── Teams (Project Config + User Config) ───────────── */
    .teams-page { padding: 24px 28px; max-width: 1000px; }
    .teams-page h2 { margin: 0 0 4px 0; font-size: 22px; }
    .teams-page .lead { color: var(--text-muted); margin-bottom: 24px; font-size: 13.5px; }
    .teams-actions { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
    .team-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; padding: 16px 18px; margin-bottom: 14px;
      box-shadow: var(--shadow);
    }
    .team-card h3 {
      margin: 0 0 4px 0; font-size: 16px;
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
    }
    .team-card .team-meta { color: var(--text-muted); font-size: 12.5px; margin-bottom: 12px; }
    .team-card .team-meta code { font-family: ui-monospace, monospace; font-size: 12px; }
    .team-card .role-tag {
      display: inline-block; padding: 2px 8px; border-radius: 4px;
      font-size: 11px; font-weight: 600; text-transform: uppercase;
      background: var(--accent-soft); color: var(--accent);
    }
    .team-card .role-tag.role-member { background: #eef0f3; color: var(--text-muted); }
    .team-stats {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;
      margin: 10px 0 14px 0;
    }
    .team-stat {
      background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px;
      padding: 8px 10px; text-align: center;
    }
    .team-stat .stat-label {
      font-size: 11px; text-transform: uppercase; color: var(--text-muted);
      letter-spacing: 0.04em; margin-bottom: 2px;
    }
    .team-stat .stat-value { font-size: 18px; font-weight: 600; }
    .team-card .team-actions { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
    .team-card .shared-list, .team-card .members-list {
      margin: 12px 0; border-top: 1px solid var(--border); padding-top: 12px;
    }
    .team-card .shared-list h4, .team-card .members-list h4 {
      margin: 0 0 8px 0; font-size: 13px; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600;
    }
    .shared-row, .member-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 8px; border-radius: 4px; font-size: 13px;
    }
    .shared-row:hover, .member-row:hover { background: var(--row-hover); }
    .shared-row .table-name { font-family: ui-monospace, monospace; }
    .teams-empty {
      padding: 32px; text-align: center; color: var(--text-muted);
      border: 1px dashed var(--border-strong); border-radius: 8px;
    }
    .danger-btn { background: rgba(251, 146, 60, 0.12); color: var(--warn); border-color: rgba(251, 146, 60, 0.4); }
    .danger-btn:hover { background: rgba(251, 146, 60, 0.2); }

    /* Modal — used by the teams flows. Self-contained so it doesn't
       collide with any modal styles the GUI agent may add later. */
    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(15, 23, 42, 0.32);
      display: flex; align-items: center; justify-content: center;
      z-index: 1000;
    }
    .modal {
      background: var(--surface); border-radius: 10px;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.18);
      min-width: 420px; max-width: 560px; max-height: 80vh;
      display: flex; flex-direction: column; overflow: hidden;
    }
    .modal-head {
      padding: 14px 18px; border-bottom: 1px solid var(--border);
      font-size: 15px; font-weight: 600;
    }
    .modal-body {
      padding: 16px 18px; overflow-y: auto; flex: 1;
    }
    .modal-foot {
      padding: 12px 18px; border-top: 1px solid var(--border);
      display: flex; gap: 8px; justify-content: flex-end;
    }
    .modal-foot .btn {
      padding: 6px 14px; border: 1px solid var(--border-strong);
      border-radius: 6px; background: var(--surface); color: var(--text);
    }
    .modal-foot .btn:hover { background: var(--row-hover); }
    .modal-foot .btn.primary {
      background: var(--accent); color: #0b0d10; border-color: var(--accent); font-weight: 600;
    }
    .modal-foot .btn.primary:hover { background: var(--accent-glow); border-color: var(--accent-glow); }
    .modal .field { margin-bottom: 12px; }
    .modal .field label {
      display: block; margin-bottom: 4px; font-size: 12px;
      color: var(--text); font-weight: 500;
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .modal .field input, .modal .field textarea {
      width: 100%; padding: 6px 8px;
      background: var(--surface); color: var(--text);
      border: 1px solid var(--border-strong);
      border-radius: 4px; font: inherit;
    }
    .modal .field input::placeholder, .modal .field textarea::placeholder {
      color: var(--text-muted);
    }
    .modal .field textarea { min-height: 60px; font-family: ui-monospace, monospace; font-size: 12px; }
    .modal .copy-token {
      padding: 8px 10px; background: var(--surface-2); border: 1px solid var(--border);
      border-radius: 4px; font-family: ui-monospace, monospace; font-size: 12px;
      word-break: break-all; cursor: pointer;
    }
    .modal .copy-token:hover { background: var(--row-hover); }
  </style>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="#/" title="Go to dashboard" aria-label="Lattice — dashboard">
      <svg class="brand-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect width="24" height="24" rx="4" fill="#0b0d10"/>
        <line x1="6" y1="6" x2="18" y2="6" stroke="#bef264" stroke-width="0.5" opacity="0.4"/>
        <line x1="6" y1="12" x2="18" y2="12" stroke="#bef264" stroke-width="0.5" opacity="0.4"/>
        <line x1="6" y1="18" x2="18" y2="18" stroke="#bef264" stroke-width="0.5" opacity="0.4"/>
        <line x1="6" y1="6" x2="6" y2="18" stroke="#bef264" stroke-width="0.5" opacity="0.4"/>
        <line x1="12" y1="6" x2="12" y2="18" stroke="#bef264" stroke-width="0.5" opacity="0.4"/>
        <line x1="18" y1="6" x2="18" y2="18" stroke="#bef264" stroke-width="0.5" opacity="0.4"/>
        <circle cx="6" cy="6" r="1.5" fill="#bef264"/>
        <circle cx="12" cy="6" r="1.5" fill="#bef264"/>
        <circle cx="18" cy="6" r="1.5" fill="#bef264"/>
        <circle cx="6" cy="12" r="1.5" fill="#bef264"/>
        <circle cx="12" cy="12" r="2" fill="#bef264"/>
        <circle cx="18" cy="12" r="1.5" fill="#bef264"/>
        <circle cx="6" cy="18" r="1.5" fill="#bef264"/>
        <circle cx="12" cy="18" r="1.5" fill="#bef264"/>
        <circle cx="18" cy="18" r="1.5" fill="#bef264"/>
      </svg>
    </a>
    <div class="history-controls">
      <button class="history-btn" id="undo-btn" title="Undo" disabled>↶</button>
      <button class="history-btn" id="redo-btn" title="Redo" disabled>↷</button>
      <a class="history-btn" id="history-link" href="#/settings/history" title="Version history">📜</a>
    </div>
    <div class="db-switcher">
      <button class="db-button" id="db-button" title="Switch database">
        <span class="db-status" id="db-status" title="Local"></span>
        <span class="db-icon">💾</span>
        <span class="db-name" id="db-name">loading…</span>
        <span class="db-caret">▾</span>
      </button>
      <div class="db-menu" id="db-menu" hidden></div>
    </div>
  </header>
  <div class="layout">
    <nav class="sidebar">
      <div class="section-label">Objects</div>
      <ul id="object-nav"></ul>
      <div id="system-section" hidden>
        <div class="section-label">System</div>
        <ul id="system-nav"></ul>
      </div>
      <div class="section-label">Settings</div>
      <ul id="settings-nav">
        <li><a href="#/settings/lattice"><span class="nav-icon">🗂</span> Lattice Settings</a></li>
        <li><a href="#/settings/database"><span class="nav-icon">⚙</span> Database Settings</a></li>
        <li><a href="#/settings/user-config"><span class="nav-icon">👤</span> User Settings</a></li>
      </ul>
    </nav>
    <main id="content"></main>
    <aside class="assistant-rail" id="assistant-rail">
      <div class="rail-resize" id="rail-resize" role="separator" aria-orientation="vertical" title="Drag to resize"></div>
      <div class="rail-header">
        <span class="rail-title">Activity</span>
      </div>
      <div class="rail-feed" id="rail-feed">
        <div class="rail-empty" id="rail-empty">No activity yet. Changes you make will appear here.</div>
      </div>
      <div class="rail-composer" id="rail-composer"></div>
    </aside>
  </div>

  <script>
  (function () {
    // ────────────────────────────────────────────────────────────
    // Display config — labels + icons. Anything missing falls back
    // to title-case of the table name and a generic dot.
    // ────────────────────────────────────────────────────────────
    var DISPLAY = {
      meetings:     { label: 'Meetings',     icon: '📅' },
      people:       { label: 'People',       icon: '👥' },
      messages:     { label: 'Messages',     icon: '✉️' },
      projects:     { label: 'Projects',     icon: '📦' },
      repositories: { label: 'Repositories', icon: '💿' },
      files:        { label: 'Files',        icon: '📄' },
      secrets:      { label: 'Secrets',      icon: '🔐' },
    };
    // Cards shown on the dashboard (Secrets is sidebar-only by design).
    var DASHBOARD_ORDER = ['meetings', 'people', 'messages', 'projects', 'repositories', 'files'];

    var FIELD_DISPLAY = {
      starts_at: 'Date+Time',
      sent_at:   'Sent',
      role:      'Role',
      url:       'URL',
      path:      'Path',
      kind:      'Kind',
    };

    // Generic fallback icon when the user hasn't set one and the entity
    // name isn't in the built-in DISPLAY map.
    var DEFAULT_ICON = '📋';

    var state = {
      entities: null,
      rowCache: {},
      iconOverrides: {},
      columnMeta: {},
      systemTables: [],
      preferences: { show_system_tables: false },
    };

    function isSecretColumn(tableName, colName) {
      var t = state.columnMeta[tableName];
      return !!(t && t[colName] && t[colName].secret);
    }
    var SECRET_MASK = '••••••••'; // ••••••••

    function displayFor(name) {
      var override = state.iconOverrides[name];
      var base = DISPLAY[name];
      var icon = (override && override.icon) || (base && base.icon) || DEFAULT_ICON;
      var label = (base && base.label) || titleCase(name);
      return { label: label, icon: icon };
    }
    function titleCase(s) {
      return s.replace(/_/g, ' ').replace(/\\b\\w/g, function (c) { return c.toUpperCase(); });
    }
    function fieldLabel(col) {
      return FIELD_DISPLAY[col] || titleCase(col);
    }

    function escapeHtml(v) {
      if (v == null) return '';
      return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Redact the userinfo portion of a connection URL so the password
    // never reaches the rendered DOM. Used for every place the GUI
    // displays a cloud_url field (team cards, connection list, etc).
    // Defensive fallback returns the input as-is when it doesn't parse
    // as a URL — better to render a non-credential string verbatim than
    // to silently swallow the value.
    function redactUrlCredentials(url) {
      if (url == null) return '';
      var s = String(url);
      try {
        var u = new URL(s);
        if (u.password) {
          // Preserve the username (often useful for identification —
          // e.g. tenant prefixes like postgres.<ref>) but mask the
          // password portion. ASCII mask avoids URL.toString()
          // percent-encoding non-ASCII characters in userinfo.
          u.password = '****';
          return u.toString();
        }
        return s;
      } catch (_) {
        return s;
      }
    }

    function truncate(s, n) {
      if (s == null) return '';
      s = String(s);
      return s.length > n ? s.slice(0, n) + '…' : s;
    }

    function isJunction(table) {
      var rels = Object.values(table.relations || {});
      return rels.length === 2 && rels.every(function (r) { return r.type === 'belongsTo'; });
    }

    function tableByName(name) {
      return state.entities.tables.find(function (t) { return t.name === name; });
    }

    function fetchJson(url, opts) {
      return fetch(url, opts).then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || r.statusText); });
        return r.json();
      });
    }

    // Disable a button + show an inline spinner for the duration of an
    // async action so a slow server round-trip can't be double-clicked.
    // The fn arg should return a Promise; the button is restored on settle.
    function withBusy(btn, fn) {
      if (!btn || btn.disabled) return undefined;
      var original = btn.innerHTML;
      btn.disabled = true;
      btn.classList.add('is-busy');
      btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + original;
      var restore = function () {
        btn.disabled = false;
        btn.classList.remove('is-busy');
        btn.innerHTML = original;
      };
      var result;
      try {
        result = fn();
      } catch (e) {
        restore();
        throw e;
      }
      if (result && typeof result.then === 'function') {
        return result.then(
          function (v) { restore(); return v; },
          function (e) { restore(); throw e; },
        );
      }
      restore();
      return result;
    }

    // ────────────────────────────────────────────────────────────
    // Boot
    // ────────────────────────────────────────────────────────────
    function init() {
      Promise.all([
        fetchJson('/api/entities'),
        fetchJson('/api/gui-meta').catch(function () { return {}; }),
        fetchJson('/api/databases').catch(function () { return null; }),
        fetchJson('/api/gui-meta/columns').catch(function () { return {}; }),
        fetchJson('/api/system-tables').catch(function () { return { tables: [] }; }),
        fetchJson('/api/userconfig/preferences').catch(function () { return { show_system_tables: false }; }),
      ]).then(function (results) {
        state.entities = results[0];
        state.iconOverrides = results[1] || {};
        state.columnMeta = results[3] || {};
        state.systemTables = (results[4] && results[4].tables) || [];
        state.preferences = results[5] || { show_system_tables: false };
        renderDbSwitcher(results[2]);
        renderSidebar();
        wireHistoryControls();
        refreshHistoryState();
        renderRoute();
        startRealtime();
        initRailResize();
        initRailDragDrop();
        startFeed();
        renderComposer();
      }).catch(function (err) {
        document.getElementById('content').innerHTML =
          '<div class="placeholder"><h2>Failed to load</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // ────────────────────────────────────────────────────────────
    // Realtime — Server-Sent Events from /api/realtime/stream.
    // One EventSource per session; on 'change' events we mark the
    // current view dirty and refetch via afterMutation() (debounced
    // to coalesce bursts). On 'state' events we drive the topbar pill.
    // ────────────────────────────────────────────────────────────
    var realtimeSource = null;
    var realtimePending = null;
    function setStatusPill(mode, state) {
      var el = document.getElementById('db-status');
      if (!el) return;
      el.classList.remove(
        'is-cloud-connected',
        'is-cloud-disconnected',
        'is-cloud-connecting',
      );
      if (mode !== 'cloud') {
        el.title = 'Local database — no realtime channel';
        return;
      }
      if (state === 'connected') {
        el.classList.add('is-cloud-connected');
        el.title = 'Cloud database — live';
      } else if (state === 'connecting') {
        el.classList.add('is-cloud-connecting');
        el.title = 'Cloud database — connecting…';
      } else {
        el.classList.add('is-cloud-disconnected');
        el.title = 'Cloud database — disconnected';
      }
    }
    function scheduleRealtimeRefresh() {
      if (realtimePending) return;
      realtimePending = setTimeout(function () {
        realtimePending = null;
        // afterMutation refreshes entities + the current view. Fire-and-
        // forget: any error just falls through to next manual action.
        afterMutation().catch(function () { /* swallow */ });
      }, 200);
    }
    function startRealtime() {
      if (realtimeSource) {
        try { realtimeSource.close(); } catch (_) { /* ignore */ }
        realtimeSource = null;
      }
      if (typeof EventSource === 'undefined') return;
      realtimeSource = new EventSource('/api/realtime/stream');
      realtimeSource.addEventListener('state', function (ev) {
        try {
          var data = JSON.parse(ev.data);
          setStatusPill(data.mode || 'local', data.state || 'local');
        } catch (_) { /* ignore malformed */ }
      });
      realtimeSource.addEventListener('change', function () {
        scheduleRealtimeRefresh();
      });
      realtimeSource.onerror = function () {
        // EventSource auto-reconnects; surface the disconnect on the pill
        // until the server's 'state' event reports recovery.
        setStatusPill('cloud', 'disconnected');
      };
    }

    // ────────────────────────────────────────────────────────────
    // Activity feed — SSE from /api/feed/stream. Renders every audited
    // mutation as a bubble in the assistant rail. Unlike the realtime
    // channel (Postgres-only), this works for SQLite databases too.
    // ────────────────────────────────────────────────────────────
    var feedSource = null;
    var FEED_ICONS = {
      insert: '➕', update: '✏️', delete: '🗑',
      link: '🔗', unlink: '⛓', undo: '↶', redo: '↷', schema: '🛠',
    };
    function relTime(iso) {
      try {
        var diff = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
        if (diff < 60) return diff + 's ago';
        var m = Math.round(diff / 60);
        if (m < 60) return m + 'm ago';
        var h = Math.round(m / 60);
        if (h < 24) return h + 'h ago';
        return new Date(iso).toLocaleDateString();
      } catch (_) { return ''; }
    }
    function renderFeedItem(ev) {
      var feedEl = document.getElementById('rail-feed');
      if (!feedEl) return;
      var empty = document.getElementById('rail-empty');
      if (empty) empty.remove();
      var item = document.createElement('div');
      item.className = 'feed-item';
      var icon = document.createElement('div');
      icon.className = 'feed-icon';
      icon.textContent = FEED_ICONS[ev.op] || '•';
      var body = document.createElement('div');
      body.className = 'feed-body';
      var summary = document.createElement('div');
      summary.className = 'feed-summary';
      summary.textContent = ev.summary || (String(ev.op || '') + ' ' + String(ev.table || ''));
      var meta = document.createElement('div');
      meta.className = 'feed-meta';
      var src = document.createElement('span');
      src.className = 'feed-source';
      src.textContent = ev.source === 'gui' ? 'you' : String(ev.source || '');
      meta.appendChild(src);
      body.appendChild(summary);
      body.appendChild(meta);
      var time = document.createElement('div');
      time.className = 'feed-time';
      time.textContent = relTime(ev.ts);
      item.appendChild(icon);
      item.appendChild(body);
      item.appendChild(time);
      feedEl.appendChild(item);
      feedEl.scrollTop = feedEl.scrollHeight;
    }
    function startFeed() {
      if (feedSource) {
        try { feedSource.close(); } catch (_) { /* ignore */ }
        feedSource = null;
      }
      if (typeof EventSource === 'undefined') return;
      feedSource = new EventSource('/api/feed/stream');
      feedSource.addEventListener('feed', function (ev) {
        try { renderFeedItem(JSON.parse(ev.data)); } catch (_) { /* ignore malformed */ }
      });
      // EventSource auto-reconnects on error; no extra handling needed.
    }

    // ────────────────────────────────────────────────────────────
    // Assistant rail resize — drag the left edge, clamp, persist.
    // ────────────────────────────────────────────────────────────
    var RAIL_MIN = 320, RAIL_MAX = 640, RAIL_KEY = 'lattice-rail-width';
    function applyRailWidth(px) {
      var w = Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(px)));
      document.documentElement.style.setProperty('--sidebar-width', w + 'px');
      return w;
    }
    function initRailResize() {
      var saved = parseInt(window.localStorage.getItem(RAIL_KEY) || '', 10);
      if (!isNaN(saved)) applyRailWidth(saved);
      var handle = document.getElementById('rail-resize');
      if (!handle) return;
      handle.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        var startX = e.clientX;
        var rail = document.getElementById('assistant-rail');
        var startW = rail ? rail.getBoundingClientRect().width : 380;
        handle.classList.add('dragging');
        function move(ev) {
          // Rail sits on the right; dragging left (smaller clientX) widens it.
          applyRailWidth(startW - (ev.clientX - startX));
        }
        function up() {
          handle.classList.remove('dragging');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          var cur = parseInt(
            getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'),
            10,
          );
          if (!isNaN(cur)) window.localStorage.setItem(RAIL_KEY, String(cur));
        }
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    }

    // ────────────────────────────────────────────────────────────
    // Assistant chat composer — POST /api/chat, parse SSE, render
    // bubbles + tool pills into the same rail feed (interleaved with
    // activity events). Gated on a configured Claude token.
    // ────────────────────────────────────────────────────────────
    var chatHistory = [];
    var chatBusy = false;
    function railFeedEl() { return document.getElementById('rail-feed'); }
    function railEmptyGone() { var e = document.getElementById('rail-empty'); if (e) e.remove(); }
    function appendUserBubble(text) {
      railEmptyGone();
      var feedEl = railFeedEl(); if (!feedEl) return;
      var msg = document.createElement('div'); msg.className = 'chat-msg user';
      var b = document.createElement('div'); b.className = 'chat-bubble user'; b.textContent = text;
      msg.appendChild(b); feedEl.appendChild(msg); feedEl.scrollTop = feedEl.scrollHeight;
    }
    function newAssistantBubble() {
      railEmptyGone();
      var feedEl = railFeedEl();
      var msg = document.createElement('div'); msg.className = 'chat-msg assistant';
      var wrap = document.createElement('div');
      var tools = document.createElement('div'); tools.className = 'chat-tools';
      var b = document.createElement('div'); b.className = 'chat-bubble assistant'; b.textContent = '';
      wrap.appendChild(tools); wrap.appendChild(b);
      msg.appendChild(wrap); feedEl.appendChild(msg); feedEl.scrollTop = feedEl.scrollHeight;
      return { bubble: b, tools: tools, pills: {} };
    }
    var TOOL_VERBS = {
      create_row: ['Creating row', 'Row created', 'Could not create row'],
      update_row: ['Updating row', 'Row updated', 'Could not update row'],
      delete_row: ['Deleting row', 'Row deleted', 'Could not delete row'],
      list_rows: ['Listing rows', 'Listed rows', 'Could not list rows'],
      get_row: ['Fetching row', 'Fetched row', 'Could not fetch row'],
      list_entities: ['Listing tables', 'Listed tables', 'Could not list tables']
    };
    function toolLabel(name, state) {
      var v = TOOL_VERBS[name] || [name, name, name];
      return state === 'pending' ? v[0] + '…' : (state === 'error' ? v[2] : v[1]);
    }
    function addToolPill(ctx, id, name) {
      var pill = document.createElement('span'); pill.className = 'tool-pill';
      pill.innerHTML = '<span class="spin"></span>' + escapeHtml(toolLabel(name, 'pending'));
      pill.setAttribute('data-name', name);
      ctx.tools.appendChild(pill); ctx.pills[id] = pill;
    }
    function resolveToolPill(ctx, id, isError) {
      var pill = ctx.pills[id]; if (!pill) return;
      var name = pill.getAttribute('data-name');
      pill.className = 'tool-pill ' + (isError ? 'error' : 'done');
      pill.textContent = (isError ? '⚠ ' : '✓ ') + toolLabel(name, isError ? 'error' : 'done');
    }
    function parseSse(buffer, onEvent) {
      var sep;
      while ((sep = buffer.indexOf('\\n\\n')) >= 0) {
        var frame = buffer.slice(0, sep); buffer = buffer.slice(sep + 2);
        var line = frame.split('\\n').find(function (l) { return l.indexOf('data:') === 0; });
        if (!line) continue;
        var json = line.slice(5).trim(); if (!json) continue;
        try { onEvent(JSON.parse(json)); } catch (_) { /* drop malformed */ }
      }
      return buffer;
    }
    function sendChat(text) {
      if (chatBusy || !text) return;
      chatBusy = true;
      appendUserBubble(text);
      var historyToSend = chatHistory.slice();
      chatHistory.push({ role: 'user', text: text });
      var input = document.getElementById('chat-input');
      var sendBtn = document.getElementById('chat-send');
      if (input) { input.value = ''; input.style.height = 'auto'; }
      if (sendBtn) sendBtn.disabled = true;
      var actx = null; var assembled = '';
      fetch('/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, history: historyToSend })
      }).then(function (r) {
        if (!r.ok || !r.body) {
          return r.json().then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); });
        }
        var reader = r.body.getReader(); var dec = new TextDecoder(); var buf = '';
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) return;
            buf += dec.decode(res.value, { stream: true });
            buf = parseSse(buf, function (ev) {
              if (ev.type === 'assistant_message_start') { actx = newAssistantBubble(); assembled = ''; }
              else if (ev.type === 'text_delta' && actx) { assembled += ev.delta; actx.bubble.textContent = assembled; railFeedEl().scrollTop = railFeedEl().scrollHeight; }
              else if (ev.type === 'tool_use' && actx) { addToolPill(actx, ev.id, ev.name); }
              else if (ev.type === 'tool_result' && actx) { resolveToolPill(actx, ev.toolUseId, ev.isError); }
              else if (ev.type === 'error') { if (!actx) actx = newAssistantBubble(); actx.bubble.textContent = (assembled ? assembled + '\\n' : '') + '⚠ ' + ev.message; }
            });
            return pump();
          });
        }
        return pump();
      }).then(function () {
        if (assembled) chatHistory.push({ role: 'assistant', text: assembled });
      }).catch(function (e) {
        var c = newAssistantBubble(); c.bubble.textContent = '⚠ ' + e.message;
      }).finally(function () {
        chatBusy = false;
        var sb = document.getElementById('chat-send'); if (sb) sb.disabled = false;
        var inp = document.getElementById('chat-input'); if (inp) inp.focus();
      });
    }
    var recState = 'idle';
    var mediaRecorder = null;
    var audioChunks = [];
    function setMicState(btn, state) {
      recState = state;
      if (!btn) return;
      btn.classList.remove('recording', 'transcribing');
      if (state === 'recording') { btn.classList.add('recording'); btn.textContent = '⏹'; btn.title = 'Stop recording'; btn.disabled = false; }
      else if (state === 'transcribing') { btn.classList.add('transcribing'); btn.textContent = '…'; btn.title = 'Transcribing…'; btn.disabled = true; }
      else { btn.textContent = '🎙'; btn.title = 'Record voice'; btn.disabled = false; }
    }
    function startRecording(btn, input) {
      if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
        alert('Voice recording is not supported in this browser.'); return;
      }
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        var rec = new MediaRecorder(stream);
        audioChunks = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size) audioChunks.push(e.data); };
        rec.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          var blob = new Blob(audioChunks, { type: rec.mimeType || 'audio/webm' });
          setMicState(btn, 'transcribing');
          fetch('/api/assistant/transcribe', { method: 'POST', headers: { 'content-type': blob.type }, body: blob })
            .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
            .then(function (j) {
              if (input && j.text) {
                input.value = (input.value ? input.value + ' ' : '') + j.text;
                input.dispatchEvent(new Event('input'));
                input.focus();
              }
            })
            .catch(function (e) { alert('Transcription failed: ' + e.message); })
            .finally(function () { setMicState(btn, 'idle'); });
        };
        rec.start();
        mediaRecorder = rec;
        setMicState(btn, 'recording');
      }).catch(function (e) { alert('Microphone unavailable: ' + e.message); });
    }
    function toggleRecording(btn, input) {
      if (recState === 'recording' && mediaRecorder) { mediaRecorder.stop(); mediaRecorder = null; }
      else if (recState === 'idle') { startRecording(btn, input); }
    }

    // ────────────────────────────────────────────────────────────
    // File ingest — drag a file onto the rail or use the paperclip.
    // Browsers can't expose the local path, so we POST the bytes; the
    // server extracts + summarizes, then discards them (path stays null).
    // ────────────────────────────────────────────────────────────
    function uploadFile(file) {
      railEmptyGone();
      return fetch('/api/ingest/upload', {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': file.name },
        body: file,
      })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
        .catch(function (e) { showToast('Ingest failed: ' + e.message, {}); });
    }
    function uploadFiles(files) {
      if (!files) return;
      for (var i = 0; i < files.length; i++) uploadFile(files[i]);
    }
    function initRailDragDrop() {
      var rail = document.getElementById('assistant-rail'); if (!rail) return;
      rail.addEventListener('dragover', function (e) { e.preventDefault(); rail.classList.add('dragging-file'); });
      rail.addEventListener('dragleave', function (e) { if (e.target === rail) rail.classList.remove('dragging-file'); });
      rail.addEventListener('drop', function (e) {
        e.preventDefault();
        rail.classList.remove('dragging-file');
        if (e.dataTransfer && e.dataTransfer.files) uploadFiles(e.dataTransfer.files);
      });
    }

    function renderComposer() {
      var host = document.getElementById('rail-composer'); if (!host) return;
      fetchJson('/api/assistant/config').then(function (cfg) {
        if (cfg && cfg.hasAnthropicKey) {
          var micHtml = cfg.hasVoiceKey
            ? '<button class="composer-mic" id="chat-mic" title="Record voice">🎙</button>'
            : '';
          host.innerHTML =
            '<div class="composer-row">' +
              '<button class="composer-clip" id="chat-clip" title="Attach a file">📎</button>' +
              micHtml +
              '<textarea id="chat-input" rows="1" placeholder="Ask or instruct… (Enter to send)"></textarea>' +
              '<button class="composer-send" id="chat-send">Send</button>' +
            '</div>' +
            '<input type="file" id="chat-file" multiple style="display:none">';
          var input = document.getElementById('chat-input');
          var sendBtn = document.getElementById('chat-send');
          var clipBtn = document.getElementById('chat-clip');
          var fileInput = document.getElementById('chat-file');
          if (clipBtn && fileInput) {
            clipBtn.addEventListener('click', function () { fileInput.click(); });
            fileInput.addEventListener('change', function () { uploadFiles(fileInput.files); fileInput.value = ''; });
          }
          input.addEventListener('input', function () {
            input.style.height = 'auto';
            input.style.height = Math.min(120, input.scrollHeight) + 'px';
          });
          input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(input.value.trim()); }
          });
          sendBtn.addEventListener('click', function () { sendChat(input.value.trim()); });
          var micBtn = document.getElementById('chat-mic');
          if (micBtn) micBtn.addEventListener('click', function () { toggleRecording(micBtn, input); });
        } else {
          host.innerHTML = '<div class="composer-setup">Set a Claude API token in ' +
            '<a href="#/settings/user-config">User Settings → Assistant</a> to chat.</div>';
        }
      }).catch(function () {
        host.innerHTML = '<div class="composer-setup">Assistant unavailable.</div>';
      });
    }

    /** Reload column meta after a secret-flag change. */
    function refreshColumnMeta() {
      return fetchJson('/api/gui-meta/columns').then(function (d) {
        state.columnMeta = d || {};
      });
    }

    // ────────────────────────────────────────────────────────────
    // Toast banner (with optional one-click undo)
    // ────────────────────────────────────────────────────────────
    var activeToast = null;
    var toastDismissTimer = null;
    function showToast(message, opts) {
      opts = opts || {};
      if (activeToast) activeToast.remove();
      if (toastDismissTimer) clearTimeout(toastDismissTimer);
      var toast = document.createElement('div');
      toast.className = 'toast';
      var undoBtn = opts.undo ? '<button class="undo-link" type="button">Undo</button>' : '';
      toast.innerHTML =
        '<span>' + escapeHtml(message) + '</span>' +
        undoBtn +
        '<button class="toast-dismiss" type="button" title="Dismiss">×</button>';
      document.body.appendChild(toast);
      activeToast = toast;

      function close() {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
        if (activeToast === toast) activeToast = null;
      }
      toast.querySelector('.toast-dismiss').addEventListener('click', close);
      if (opts.undo) {
        toast.querySelector('.undo-link').addEventListener('click', function () {
          close();
          if (toastDismissTimer) clearTimeout(toastDismissTimer);
          opts.undo();
        });
      }
      toastDismissTimer = setTimeout(close, opts.duration || 6000);
    }

    /** Standard undo: hit /api/history/undo and refresh views. */
    function undoLast() {
      return fetchJson('/api/history/undo', { method: 'POST' })
        .then(afterMutation)
        .catch(function (err) { showToast('Undo failed: ' + err.message, {}); });
    }

    // ────────────────────────────────────────────────────────────
    // Version history (undo / redo / log)
    // ────────────────────────────────────────────────────────────
    function wireHistoryControls() {
      document.getElementById('undo-btn').addEventListener('click', function () {
        fetchJson('/api/history/undo', { method: 'POST' })
          .then(function () { return afterMutation(); })
          .then(function () { showToast('Last change undone', {}); })
          .catch(function (err) { showToast('Undo failed: ' + err.message, {}); });
      });
      document.getElementById('redo-btn').addEventListener('click', function () {
        fetchJson('/api/history/redo', { method: 'POST' })
          .then(function () { return afterMutation(); })
          .then(function () { showToast('Redone', {}); })
          .catch(function (err) { showToast('Redo failed: ' + err.message, {}); });
      });
    }

    /**
     * Re-fetch everything that might have changed and re-render. Used after
     * any mutation that goes through the audit log: row CRUD, link/unlink,
     * undo, redo, revert.
     */
    function afterMutation() {
      loadedTables = {};
      return Promise.all([
        fetchJson('/api/entities'),
        refreshHistoryState(),
      ]).then(function (r) {
        state.entities = r[0];
        renderSidebar();
        renderRoute();
      });
    }

    function refreshHistoryState() {
      return fetchJson('/api/history?limit=1').then(function (h) {
        document.getElementById('undo-btn').disabled = !h.canUndo;
        document.getElementById('redo-btn').disabled = !h.canRedo;
        return h;
      }).catch(function () { /* swallow */ });
    }

    /** Refetch everything after a DB switch and rerender. */
    function reloadEverything() {
      return Promise.all([
        fetchJson('/api/entities'),
        fetchJson('/api/gui-meta').catch(function () { return {}; }),
        fetchJson('/api/databases').catch(function () { return null; }),
        fetchJson('/api/gui-meta/columns').catch(function () { return {}; }),
        fetchJson('/api/system-tables').catch(function () { return { tables: [] }; }),
      ]).then(function (results) {
        state.entities = results[0];
        state.iconOverrides = results[1] || {};
        state.columnMeta = results[3] || {};
        state.systemTables = (results[4] && results[4].tables) || [];
        renderDbSwitcher(results[2]);
        renderSidebar();
        if (location.hash !== '#/') location.hash = '#/';
        else renderRoute();
        loadedTables = {};
        startRealtime();
        startFeed();
      });
    }

    function renderDbSwitcher(data) {
      var btn = document.getElementById('db-button');
      var menu = document.getElementById('db-menu');
      var nameEl = document.getElementById('db-name');
      if (!data) {
        nameEl.textContent = '(no databases endpoint)';
        return;
      }
      // Friendly DB name: prefer current.label (cloud team_name or YAML name:),
      // fall back to the db file basename.
      nameEl.textContent = (data.current && data.current.label) || data.current.dbFile || '';
      // Initial status pill — overridden when the realtime SSE 'state'
      // event arrives, but avoids a yellow flash before SSE connects.
      var initialKind = (data.current && data.current.kind) || 'local';
      setStatusPill(initialKind, initialKind === 'cloud' ? 'connecting' : 'local');

      function buildMenu() {
        var currentPath = data.current && data.current.path;
        var currentKind = (data.current && data.current.kind) || 'local';
        var items = data.configs.map(function (c) {
          // Per-row kind comes from the server now (each config resolves
          // its db: line to postgres → cloud, else local), so inactive
          // cloud rows tag Cloud/green just like the selected one — no
          // more defaulting every non-active row to Local/yellow.
          var kind = c.kind || (c.path === currentPath ? currentKind : 'local');
          var isCloud = kind === 'cloud';
          var dotClass = isCloud ? 'is-cloud-connected' : '';
          var chipText = isCloud ? 'Cloud' : 'Local';
          var chipBg = isCloud ? 'var(--accent-soft)' : 'rgba(255,255,255,0.06)';
          var chipColor = isCloud ? 'var(--accent)' : 'var(--text-muted)';
          return '<button class="db-item' + (c.active ? ' active' : '') +
            '" data-path="' + escapeHtml(c.path) + '">' +
            '<span class="db-item-status db-status ' + dotClass + '" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' +
              (isCloud ? 'var(--accent)' : 'var(--warn)') +
            ';flex-shrink:0"></span>' +
            '<span style="flex:1;text-align:left">' + escapeHtml(c.label || c.name) + '</span>' +
            '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:' + chipBg + ';color:' + chipColor + ';text-transform:uppercase;letter-spacing:0.04em">' + chipText + '</span>' +
            '</button>';
        }).join('');
        menu.innerHTML =
          '<div class="db-section">Available databases</div>' +
          items +
          '<div class="db-section">New database</div>' +
          '<div class="db-create">' +
            '<button class="btn primary" id="db-create-btn" style="width:100%;">+ New database…</button>' +
          '</div>';
        menu.querySelectorAll('button.db-item').forEach(function (b) {
          b.addEventListener('click', function () {
            var path = b.getAttribute('data-path');
            if (path === currentPath) { menu.hidden = true; return; }
            withBusy(b, function () {
              return fetchJson('/api/databases/switch', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ path: path }),
              }).then(function () {
                menu.hidden = true;
                return reloadEverything();
              }).then(function () {
                showToast('Switched database', {});
              }).catch(function (err) { showToast('Switch failed: ' + err.message, {}); });
            });
          });
        });
        document.getElementById('db-create-btn').addEventListener('click', function () {
          menu.hidden = true;
          showCreateDatabaseWizard();
        });
      }

      btn.onclick = function (e) {
        e.stopPropagation();
        if (menu.hidden) buildMenu();
        menu.hidden = !menu.hidden;
      };
      document.addEventListener('click', function (e) {
        if (menu.hidden) return;
        if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
          menu.hidden = true;
        }
      });
    }

    /** Reload icon overrides after a save, then re-render the current view. */
    function refreshIcons() {
      return fetchJson('/api/gui-meta').then(function (data) {
        state.iconOverrides = data || {};
        renderSidebar();
        renderRoute();
      });
    }

    window.addEventListener('hashchange', renderRoute);

    // ────────────────────────────────────────────────────────────
    // Sidebar
    // ────────────────────────────────────────────────────────────
    function renderSidebar() {
      var ul = document.getElementById('object-nav');
      var firstClass = state.entities.tables.filter(function (t) { return !isJunction(t); });
      ul.innerHTML = firstClass.map(function (t) {
        var d = displayFor(t.name);
        return '<li><a data-route="#/objects/' + t.name + '" href="#/objects/' + t.name +
          '"><span class="nav-icon">' + d.icon + '</span> ' + escapeHtml(d.label) + '</a></li>';
      }).join('');

      var section = document.getElementById('system-section');
      var show = !!(state.preferences && state.preferences.show_system_tables);
      if (section) section.hidden = !show;
      var sys = document.getElementById('system-nav');
      if (sys) {
        sys.innerHTML = show
          ? (state.systemTables || []).map(function (t) {
              return '<li><a data-route="#/system/' + t.name + '" href="#/system/' + t.name +
                '"><span class="nav-icon">⚙</span> ' + escapeHtml(t.name) + '</a></li>';
            }).join('')
          : '';
      }

      highlightActive();
    }

    function highlightActive() {
      var hash = location.hash || '#/';
      document.querySelectorAll('nav a').forEach(function (a) {
        var route = a.getAttribute('data-route') || a.getAttribute('href');
        a.classList.toggle('active', route && hash.indexOf(route) === 0);
      });
    }

    // ────────────────────────────────────────────────────────────
    // Routing
    // ────────────────────────────────────────────────────────────
    function renderRoute() {
      if (!state.entities) return;
      highlightActive();
      var content = document.getElementById('content');
      var hash = location.hash || '#/';

      if (hash === '#/' || hash === '') { renderDashboard(content); return; }

      var m = /^#\\/objects\\/([^/]+)(?:\\/(.+))?$/.exec(hash);
      if (m) {
        if (m[2]) renderDetail(content, m[1], m[2]);
        else      renderTable(content, m[1]);
        return;
      }

      var sm = /^#\\/system\\/([^/]+)$/.exec(hash);
      if (sm) { renderSystemTable(content, sm[1]); return; }

      // Data Model now lives inside Database Settings. Keep the legacy
      // hash working (deep links, internal re-renders) by rendering the
      // settings page, which contains the Data Model section.
      if (hash === '#/settings/data-model') { renderDatabaseSettings(content); return; }
      if (hash === '#/settings/history') { renderHistory(content); return; }
      if (hash === '#/settings/lattice') { renderLatticeSettings(content); return; }
      // Database Settings — new v1.13.8 page. The legacy /settings/project-config
      // route stays wired for back-compat (deep-link tests, existing bookmarks).
      if (hash === '#/settings/database' || hash === '#/settings/project-config') {
        renderDatabaseSettings(content);
        return;
      }
      if (hash === '#/settings/user-config') { renderUserConfig(content); return; }
      content.innerHTML = '<div class="placeholder"><h2>Unknown route</h2></div>';
    }

    // ────────────────────────────────────────────────────────────
    // Dashboard
    // ────────────────────────────────────────────────────────────
    function renderDashboard(content) {
      // Show every first-class (non-junction, non-system) entity. The
      // previous implementation used DASHBOARD_ORDER as the filter — meaning
      // installs whose YAML declared tables outside the hardcoded list
      // (e.g. clients / students / vendors) saw a blank dashboard with no
      // hint why. DASHBOARD_ORDER is now a preference for ordering only;
      // tables not in it appear after, in declaration order.
      var preferenceRank = function (name) {
        var idx = DASHBOARD_ORDER.indexOf(name);
        return idx === -1 ? DASHBOARD_ORDER.length : idx;
      };
      var firstClass = (state.entities.tables || [])
        .filter(function (t) {
          // Junctions belong on the Data Model page, not as dashboard cards.
          if (isJunction(t)) return false;
          // System tables (_lattice_gui_*, __lattice_*) are hidden.
          if (t.name.charAt(0) === '_') return false;
          return true;
        })
        .slice()
        .sort(function (a, b) {
          var ra = preferenceRank(a.name);
          var rb = preferenceRank(b.name);
          if (ra !== rb) return ra - rb;
          // Same preference rank — keep declaration order from the API.
          return 0;
        });

      if (firstClass.length === 0) {
        content.innerHTML =
          '<div class="placeholder">' +
            '<h2>No entities yet</h2>' +
            '<p>Define entities in your <code>lattice.config.yml</code> or register them via <code>db.define()</code>, then reload.</p>' +
          '</div>';
        return;
      }

      var cards = firstClass.map(function (t) {
        var d = displayFor(t.name);
        var count = (t.rowCount != null) ? t.rowCount : 0;
        return '<a class="card" href="#/objects/' + t.name + '">' +
          '<div class="card-icon">' + d.icon + '</div>' +
          '<div class="card-label">' + escapeHtml(d.label) + '</div>' +
          '<div class="card-count">' + count + '</div>' +
          '</a>';
      }).join('');
      content.innerHTML = '<div class="dashboard">' + cards + '</div>';
    }

    // ────────────────────────────────────────────────────────────
    // Table view
    // ────────────────────────────────────────────────────────────
    function intrinsicColumns(table) {
      // Drop id + foreign-key columns (rendered as belongsTo relations instead).
      var fkCols = new Set();
      Object.values(table.relations || {}).forEach(function (r) {
        if (r.type === 'belongsTo') fkCols.add(r.foreignKey);
      });
      return table.columns.filter(function (c) { return c !== 'id' && !fkCols.has(c); });
    }

    function belongsToColumns(table) {
      return Object.entries(table.relations || {})
        .filter(function (kv) { return kv[1].type === 'belongsTo'; })
        .map(function (kv) { return { relName: kv[0], rel: kv[1] }; });
    }

    function junctionsFor(tableName) {
      // Junctions where the LEFT side is this table.
      var out = [];
      state.entities.tables.forEach(function (t) {
        if (!isJunction(t)) return;
        var rels = Object.values(t.relations);
        var here = rels.find(function (r) { return r.table === tableName; });
        var other = rels.find(function (r) { return r.table !== tableName; });
        if (here && other) out.push({ junction: t.name, localFk: here.foreignKey, remoteRel: other });
      });
      return out;
    }

    function displayNameFor(row) {
      if (!row) return '';
      return row.name || row.title || row.url || row.path || row.id || '';
    }

    /**
     * Render a clickable chip linking to the detail page of a row in another
     * table. Used for belongsTo cells and junction-derived cells so the user
     * can navigate to the related object with one click.
     */
    function chipLink(table, row) {
      if (!row) return '<span class="muted">—</span>';
      return '<a class="chip chip-link" href="#/objects/' + encodeURIComponent(table) +
        '/' + encodeURIComponent(row.id) + '">' + escapeHtml(displayNameFor(row)) + '</a>';
    }

    var loadedTables = {};
    function loadAllRows(tableName) {
      if (loadedTables[tableName]) return Promise.resolve(loadedTables[tableName]);
      return fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows').then(function (d) {
        loadedTables[tableName] = d.rows;
        return d.rows;
      });
    }

    /** Force a fresh fetch — used for views that need to opt in/out of soft-delete filtering. */
    function fetchRows(tableName, deletedMode) {
      var url = '/api/tables/' + encodeURIComponent(tableName) + '/rows';
      if (deletedMode) url += '?deleted=' + encodeURIComponent(deletedMode);
      return fetchJson(url).then(function (d) { return d.rows; });
    }

    /**
     * Invalidate cached rows for one or more tables. Call after any mutation
     * so the next renderTable / renderDetail re-fetches from the server.
     */
    function invalidate(tableNames) {
      (Array.isArray(tableNames) ? tableNames : [tableNames]).forEach(function (n) {
        delete loadedTables[n];
      });
    }

    /**
     * Refresh /api/entities (dashboard row counts) AND the undo/redo button
     * state after a mutation. Called by every CRUD handler.
     */
    function refreshEntities() {
      return Promise.all([
        fetchJson('/api/entities').then(function (d) { state.entities = d; }),
        refreshHistoryState(),
      ]);
    }

    function fieldFor(col, value, table) {
      // Render an input element for a column. belongsTo FK columns become a
      // <select> over the referenced table's rows (must already be cached).
      var belongsTo = belongsToColumns(table).find(function (b) { return b.rel.foreignKey === col; });
      if (belongsTo) {
        var rows = loadedTables[belongsTo.rel.table] || [];
        var options = '<option value="">(none)</option>' + rows.map(function (r) {
          var sel = (r.id === value) ? ' selected' : '';
          return '<option value="' + escapeHtml(r.id) + '"' + sel + '>' + escapeHtml(displayNameFor(r)) + '</option>';
        }).join('');
        return '<select name="' + escapeHtml(col) + '">' + options + '</select>';
      }
      // Secret columns: use a password input so the value is masked while editing.
      if (isSecretColumn(table.name, col)) {
        return '<input type="password" name="' + escapeHtml(col) + '" value="' +
          escapeHtml(value || '') + '" autocomplete="off" />';
      }
      // Multiline for known long-form fields.
      if (col === 'transcript' || col === 'summary' || col === 'body') {
        return '<textarea name="' + escapeHtml(col) + '">' + escapeHtml(value || '') + '</textarea>';
      }
      return '<input type="text" name="' + escapeHtml(col) + '" value="' + escapeHtml(value || '') + '" />';
    }

    function collectFormValues(scope) {
      var out = {};
      scope.querySelectorAll('[name]').forEach(function (el) {
        var v = el.value;
        out[el.getAttribute('name')] = v === '' ? null : v;
      });
      return out;
    }

    // Per-table view state: 'live' (default) or 'trash' (soft-deleted rows).
    var tableViewMode = {};

    function renderTable(content, tableName) {
      var t = tableByName(tableName);
      if (!t) {
        content.innerHTML = '<div class="placeholder">Unknown entity: ' + escapeHtml(tableName) + '</div>';
        return;
      }
      var d = displayFor(tableName);
      var intrinsic = intrinsicColumns(t);
      var belongsTo = belongsToColumns(t);
      var junctions = junctionsFor(tableName);
      var supportsSoftDelete = (t.columns || []).indexOf('deleted_at') !== -1;
      var viewMode = tableViewMode[tableName] || 'live';
      // Fetch this entity's rows fresh (mode-aware), plus relation tables (live only) for chips.
      var fetches = [fetchRows(tableName, viewMode === 'trash' ? 'only' : '')];
      belongsTo.forEach(function (b) { fetches.push(loadAllRows(b.rel.table)); });
      junctions.forEach(function (j) {
        fetches.push(loadAllRows(j.junction));
        fetches.push(loadAllRows(j.remoteRel.table));
      });

      Promise.all(fetches).then(function (results) {
        var rows = results[0];
        var headers = intrinsic.map(fieldLabel)
          .concat(belongsTo.map(function (b) { return titleCase(b.relName); }))
          .concat(junctions.map(function (j) { return titleCase(j.remoteRel.table); }))
          .map(function (h) { return '<th>' + escapeHtml(h) + '</th>'; }).join('');
        headers += '<th class="row-actions"></th>';

        var bodyRows;
        if (rows.length === 0) {
          bodyRows = '';
        } else {
          bodyRows = rows.map(function (r) {
            var tds = intrinsic.map(function (c) {
              if (isSecretColumn(tableName, c) && r[c] != null && r[c] !== '') {
                return '<td class="muted">' + SECRET_MASK + '</td>';
              }
              return '<td><div class="cell-clip">' + escapeHtml(truncate(r[c], 120)) + '</div></td>';
            });
            belongsTo.forEach(function (b) {
              var ref = (loadedTables[b.rel.table] || []).find(function (x) { return x.id === r[b.rel.foreignKey]; });
              tds.push('<td><div class="cell-clip">' + chipLink(b.rel.table, ref) + '</div></td>');
            });
            junctions.forEach(function (j) {
              var matches = (loadedTables[j.junction] || []).filter(function (jr) { return jr[j.localFk] === r.id; });
              var remoteFkCol = j.remoteRel.foreignKey;
              var chips = matches.map(function (jr) {
                var ref = (loadedTables[j.remoteRel.table] || []).find(function (x) { return x.id === jr[remoteFkCol]; });
                return ref ? chipLink(j.remoteRel.table, ref) : '';
              }).join('');
              tds.push('<td><div class="cell-clip">' + (chips || '<span class="muted">—</span>') + '</div></td>');
            });
            if (viewMode === 'trash') {
              tds.push('<td class="row-actions">' +
                '<button class="row-restore" title="Restore" data-restore="' + escapeHtml(r.id) + '">↺</button>' +
                '<button class="row-delete" title="Delete permanently" data-hard-del="' + escapeHtml(r.id) + '">✕</button>' +
                '</td>');
            } else {
              tds.push('<td class="row-actions"><button class="row-delete" title="Delete" data-del="' + escapeHtml(r.id) + '">✕</button></td>');
            }
            return '<tr data-id="' + escapeHtml(r.id) + '"' + (viewMode === 'trash' ? ' class="row-deleted"' : '') + '>' + tds.join('') + '</tr>';
          }).join('');
        }

        // Inline "+ new" row at the bottom of the table. Intrinsic + belongsTo
        // columns become inputs; junctions show a dim placeholder (links happen
        // via the Data Model page); the last cell is the create control.
        var createCells = intrinsic.map(function (c) {
          return '<td>' + fieldFor(c, '', t) + '</td>';
        });
        belongsTo.forEach(function (b) {
          createCells.push('<td>' + fieldFor(b.rel.foreignKey, '', t) + '</td>');
        });
        junctions.forEach(function () {
          createCells.push('<td><span class="muted">add after create</span></td>');
        });
        createCells.push('<td class="row-actions"><button class="btn primary" id="inline-create" title="Create">+</button></td>');
        var createRow = '<tr class="create-row">' + createCells.join('') + '</tr>';

        var trashToggle = supportsSoftDelete
          ? '<div class="actions"><button class="btn ghost" id="toggle-trash">' +
              (viewMode === 'trash' ? '← Back to live' : 'Show trash') +
            '</button></div>'
          : '';

        content.innerHTML =
          '<div class="view-header">' +
            '<span class="entity-icon">' + d.icon + '</span>' +
            '<h1>' + escapeHtml(d.label) + (viewMode === 'trash' ? ' · Trash' : '') + '</h1>' +
            '<span class="count">' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + '</span>' +
            trashToggle +
          '</div>' +
          '<table>' +
            '<thead><tr>' + headers + '</tr></thead>' +
            '<tbody>' + bodyRows + (viewMode === 'trash' ? '' : createRow) + '</tbody>' +
          '</table>';

        if (supportsSoftDelete) {
          document.getElementById('toggle-trash').addEventListener('click', function () {
            tableViewMode[tableName] = viewMode === 'trash' ? 'live' : 'trash';
            renderTable(content, tableName);
          });
        }

        if (viewMode === 'live') document.getElementById('inline-create').addEventListener('click', function () {
          var values = collectFormValues(content.querySelector('tr.create-row'));
          // Strip empty optional fields so they're left to DB defaults.
          Object.keys(values).forEach(function (k) {
            if (values[k] === null || values[k] === '') delete values[k];
          });
          fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(values),
          }).then(function () {
            invalidate(tableName);
            return refreshEntities();
          }).then(function () {
            renderTable(content, tableName);
            showToast(d.label.replace(/s$/, '') + ' created', { undo: undoLast });
          }).catch(function (err) {
            showToast('Create failed: ' + err.message, {});
          });
        });

        content.querySelectorAll('button.row-delete').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var softId = btn.getAttribute('data-del');
            var hardId = btn.getAttribute('data-hard-del');
            var id = softId || hardId;
            var hard = !!hardId;
            var url = '/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id);
            if (hard) url += '?hard=true';
            fetchJson(url, { method: 'DELETE' }).then(function () {
              invalidate(tableName);
              return refreshEntities();
            }).then(function () {
              renderTable(content, tableName);
              var msg = hard
                ? d.label.replace(/s$/, '') + ' permanently deleted'
                : d.label.replace(/s$/, '') + ' deleted';
              showToast(msg, { undo: undoLast });
            }).catch(function (err) {
              showToast('Delete failed: ' + err.message, {});
            });
          });
        });

        content.querySelectorAll('button.row-restore').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var id = btn.getAttribute('data-restore');
            fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id), {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ deleted_at: null }),
            }).then(function () {
              invalidate(tableName);
              return refreshEntities();
            }).then(function () {
              renderTable(content, tableName);
              showToast(d.label.replace(/s$/, '') + ' restored', { undo: undoLast });
            }).catch(function (err) {
              showToast('Restore failed: ' + err.message, {});
            });
          });
        });

        content.querySelectorAll('tr[data-id]').forEach(function (tr) {
          tr.addEventListener('click', function (e) {
            // Let chip-link anchors and the delete button handle their own click.
            if (e.target && e.target.closest('a, button')) return;
            location.hash = '#/objects/' + tableName + '/' + tr.getAttribute('data-id');
          });
        });
      }).catch(function (err) {
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // ────────────────────────────────────────────────────────────
    // Detail view (with edit / delete)
    // ────────────────────────────────────────────────────────────
    function renderFilePreview(row) {
      var host = document.getElementById('file-preview'); if (!host || !row) return;
      var id = row.id;
      var mime = row.mime || '';
      var blobUrl = '/api/files/' + encodeURIComponent(id) + '/blob';
      var html = '';
      if (row.description) html += '<div class="file-desc">' + escapeHtml(row.description) + '</div>';
      if (mime.indexOf('image/') === 0 && row.path) {
        html += '<img src="' + blobUrl + '" alt="' + escapeHtml(row.original_name || 'image') + '">';
      } else if (mime === 'application/pdf' && row.path) {
        html += '<iframe src="' + blobUrl + '" title="PDF preview"></iframe>';
      } else if (row.extracted_text) {
        html += '<pre>' + escapeHtml(String(row.extracted_text).slice(0, 20000)) + '</pre>';
      } else {
        html += '<div class="file-unsupported">No inline preview for this file type' +
          (mime ? ' (' + escapeHtml(mime) + ')' : '') + '.</div>';
      }
      if (row.path) {
        html += '<div class="file-actions">' +
          '<button class="btn" id="file-open">Open in Finder</button>' +
          '<a class="btn" href="' + blobUrl + '" download="' + escapeHtml(row.original_name || 'file') + '">Download</a>' +
        '</div>';
      }
      host.innerHTML = html;
      var openBtn = document.getElementById('file-open');
      if (openBtn) openBtn.addEventListener('click', function () {
        fetch('/api/files/' + encodeURIComponent(id) + '/open-in-finder', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j && j.enabled === false) {
              if (row.path && navigator.clipboard) {
                navigator.clipboard.writeText(row.path).then(function () {
                  showToast('Path copied — set LATTICE_LOCAL_OPEN=1 to open directly', {});
                });
              } else {
                showToast('Set LATTICE_LOCAL_OPEN=1 to open files locally', {});
              }
            } else if (j && j.opened === false) {
              showToast('Could not open: ' + (j.error || 'unknown'), {});
            }
          })
          .catch(function (e) { showToast('Open failed: ' + e.message, {}); });
      });
    }

    function renderDetail(content, tableName, id) {
      var t = tableByName(tableName);
      if (!t) {
        content.innerHTML = '<div class="placeholder">Unknown entity: ' + escapeHtml(tableName) + '</div>';
        return;
      }
      var d = displayFor(tableName);
      var intrinsic = intrinsicColumns(t);
      var belongsTo = belongsToColumns(t);
      var junctions = junctionsFor(tableName);

      var fetches = [
        fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id)),
      ];
      belongsTo.forEach(function (b) { fetches.push(loadAllRows(b.rel.table)); });
      junctions.forEach(function (j) {
        fetches.push(loadAllRows(j.junction));
        fetches.push(loadAllRows(j.remoteRel.table));
      });

      Promise.all(fetches).then(function (results) {
        var row = results[0];

        function paint(editing) {
          var rows = [];
          intrinsic.forEach(function (c) {
            var secret = isSecretColumn(tableName, c);
            var dd;
            if (editing) {
              dd = fieldFor(c, row[c], t);
            } else if (row[c] == null || row[c] === '') {
              dd = '<span class="muted">—</span>';
            } else if (secret) {
              dd = '<span class="muted">' + SECRET_MASK + '</span>';
            } else {
              dd = escapeHtml(row[c]);
            }
            rows.push('<dt>' + escapeHtml(fieldLabel(c)) + '</dt><dd>' + dd + '</dd>');
          });
          belongsTo.forEach(function (b) {
            var dd;
            if (editing) {
              dd = fieldFor(b.rel.foreignKey, row[b.rel.foreignKey], t);
            } else {
              var ref = (loadedTables[b.rel.table] || []).find(function (x) { return x.id === row[b.rel.foreignKey]; });
              dd = chipLink(b.rel.table, ref);
            }
            rows.push('<dt>' + escapeHtml(titleCase(b.relName)) + '</dt><dd>' + dd + '</dd>');
          });
          // Junctions: always editable inline. Click × on a chip to unlink,
          // pick from the dropdown to link. Mutations are atomic — no Save.
          junctions.forEach(function (j) {
            var matches = (loadedTables[j.junction] || []).filter(function (jr) { return jr[j.localFk] === row.id; });
            var linkedIds = new Set(matches.map(function (m) { return m[j.remoteRel.foreignKey]; }));
            var available = (loadedTables[j.remoteRel.table] || []).filter(function (o) { return !linkedIds.has(o.id); });
            var chips = matches.map(function (jr) {
              var remoteId = jr[j.remoteRel.foreignKey];
              var ref = (loadedTables[j.remoteRel.table] || []).find(function (x) { return x.id === remoteId; });
              if (!ref) return '';
              return '<span class="chip-removable"' +
                ' data-junction="' + escapeHtml(j.junction) + '"' +
                ' data-localfk="' + escapeHtml(j.localFk) + '"' +
                ' data-remotefk="' + escapeHtml(j.remoteRel.foreignKey) + '"' +
                ' data-local="' + escapeHtml(row.id) + '"' +
                ' data-remote="' + escapeHtml(remoteId) + '">' +
                '<a class="chip-link" href="#/objects/' + encodeURIComponent(j.remoteRel.table) +
                  '/' + encodeURIComponent(remoteId) + '">' + escapeHtml(displayNameFor(ref)) + '</a>' +
                ' <button class="remove-link" title="Unlink">×</button></span>';
            }).join(' ');
            var picker = available.length
              ? '<select class="dm-add"' +
                  ' data-junction="' + escapeHtml(j.junction) + '"' +
                  ' data-localfk="' + escapeHtml(j.localFk) + '"' +
                  ' data-remotefk="' + escapeHtml(j.remoteRel.foreignKey) + '"' +
                  ' data-local="' + escapeHtml(row.id) + '">' +
                '<option value="">+ Add link…</option>' +
                available.map(function (o) {
                  return '<option value="' + escapeHtml(o.id) + '">' + escapeHtml(displayNameFor(o)) + '</option>';
                }).join('') +
                '</select>'
              : '';
            rows.push('<dt>' + escapeHtml(titleCase(j.remoteRel.table)) + '</dt>' +
                      '<dd>' + (chips || '<span class="muted">None yet</span>') + ' ' + picker + '</dd>');
          });

          var actions = editing
            ? '<button class="btn primary" id="save-row">Save</button>' +
              '<button class="btn" id="cancel-edit">Cancel</button>'
            : '<button class="btn" id="edit-row">Edit</button>' +
              '<button class="btn danger" id="del-row">Delete</button>';

          content.innerHTML =
            '<a class="breadcrumb" href="#/objects/' + tableName + '">← ' + escapeHtml(d.label) + '</a>' +
            '<div class="view-header">' +
              '<span class="entity-icon">' + d.icon + '</span>' +
              '<h1>' + escapeHtml(displayNameFor(row) || d.label) + '</h1>' +
              '<div class="actions">' + actions + '</div>' +
            '</div>' +
            (tableName === 'files' ? '<div class="file-preview" id="file-preview"></div>' : '') +
            '<div class="detail"><dl class="' + (editing ? 'editing' : '') + '">' + rows.join('') + '</dl></div>' +
            '<div id="row-context"></div>';

          // Skip the context fetch while editing — the just-PATCHed row may
          // not have re-rendered yet, so we'd flash stale content.
          if (!editing) loadRowContext(tableName, id);
          if (!editing && tableName === 'files') renderFilePreview(row);

          // Junction link/unlink handlers (active in both read and edit modes).
          content.querySelectorAll('.remove-link').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
              e.preventDefault();
              e.stopPropagation();
              var chip = btn.closest('[data-junction]');
              var body = {};
              body[chip.getAttribute('data-localfk')] = chip.getAttribute('data-local');
              body[chip.getAttribute('data-remotefk')] = chip.getAttribute('data-remote');
              fetchJson('/api/tables/' + encodeURIComponent(chip.getAttribute('data-junction')) + '/unlink', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              }).then(function () {
                invalidate(chip.getAttribute('data-junction'));
                return refreshEntities();
              }).then(function () {
                renderDetail(content, tableName, id);
                showToast('Link removed', { undo: undoLast });
              }).catch(function (err) { showToast('Unlink failed: ' + err.message, {}); });
            });
          });
          content.querySelectorAll('select.dm-add').forEach(function (sel) {
            sel.addEventListener('change', function () {
              if (!sel.value) return;
              var body = {};
              body[sel.getAttribute('data-localfk')] = sel.getAttribute('data-local');
              body[sel.getAttribute('data-remotefk')] = sel.value;
              fetchJson('/api/tables/' + encodeURIComponent(sel.getAttribute('data-junction')) + '/link', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              }).then(function () {
                invalidate(sel.getAttribute('data-junction'));
                return refreshEntities();
              }).then(function () {
                renderDetail(content, tableName, id);
                showToast('Linked', { undo: undoLast });
              }).catch(function (err) { showToast('Link failed: ' + err.message, {}); });
            });
          });

          if (editing) {
            document.getElementById('cancel-edit').addEventListener('click', function () { paint(false); });
            document.getElementById('save-row').addEventListener('click', function () {
              var values = collectFormValues(content.querySelector('.detail dl'));
              fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id), {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(values),
              }).then(function () {
                invalidate(tableName);
                return refreshEntities();
              }).then(function () {
                renderDetail(content, tableName, id);
                showToast(d.label.replace(/s$/, '') + ' modified', { undo: undoLast });
              }).catch(function (err) {
                showToast('Save failed: ' + err.message, {});
              });
            });
          } else {
            document.getElementById('edit-row').addEventListener('click', function () { paint(true); });
            document.getElementById('del-row').addEventListener('click', function () {
              fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id), {
                method: 'DELETE',
              }).then(function () {
                invalidate(tableName);
                return refreshEntities();
              }).then(function () {
                location.hash = '#/objects/' + tableName;
                showToast(d.label.replace(/s$/, '') + ' deleted', { undo: undoLast });
              }).catch(function (err) {
                showToast('Delete failed: ' + err.message, {});
              });
            });
          }
        }

        paint(false);
      }).catch(function (err) {
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // ────────────────────────────────────────────────────────────
    // System tables (Lattice-internal — read-only browse view)
    // ────────────────────────────────────────────────────────────
    function renderSystemTable(content, tableName) {
      var entry = (state.systemTables || []).find(function (t) { return t.name === tableName; });
      if (!entry) {
        content.innerHTML = '<div class="placeholder">Unknown system table: ' + escapeHtml(tableName) + '</div>';
        return;
      }
      content.innerHTML =
        '<div class="view-header">' +
          '<span class="entity-icon">⚙</span>' +
          '<h1>' + escapeHtml(tableName) + '</h1>' +
          '<span class="count">' + entry.rowCount + ' row' + (entry.rowCount === 1 ? '' : 's') +
            ' · read-only</span>' +
        '</div>' +
        '<div class="muted" style="margin-bottom:12px;font-size:13px;">' +
          'Lattice-internal table — shown here for inspection only. The GUI does not allow editing.' +
        '</div>' +
        '<table id="system-table"><thead><tr></tr></thead><tbody></tbody></table>';

      fetchJson('/api/system-tables/' + encodeURIComponent(tableName) + '/rows').then(function (data) {
        var rows = data.rows || [];
        var cols = entry.columns;
        var thead = content.querySelector('#system-table thead tr');
        thead.innerHTML = cols.map(function (c) { return '<th>' + escapeHtml(c) + '</th>'; }).join('');
        var tbody = content.querySelector('#system-table tbody');
        if (rows.length === 0) {
          tbody.innerHTML = '<tr><td colspan="' + cols.length + '" class="muted" style="padding:24px;text-align:center;">Empty</td></tr>';
          return;
        }
        tbody.innerHTML = rows.map(function (r) {
          var tds = cols.map(function (c) {
            var v = r[c];
            if (v == null) return '<td class="muted">—</td>';
            var s = String(v);
            return '<td>' + escapeHtml(s.length > 200 ? s.slice(0, 200) + '…' : s) + '</td>';
          }).join('');
          return '<tr>' + tds + '</tr>';
        }).join('');
      }).catch(function (err) {
        content.querySelector('#system-table tbody').innerHTML =
          '<tr><td colspan="' + entry.columns.length + '" class="muted" style="padding:24px;">' +
          'Failed to load: ' + escapeHtml(err.message) + '</td></tr>';
      });
    }

    // ────────────────────────────────────────────────────────────
    // Version history page (#/settings/history)
    // ────────────────────────────────────────────────────────────
    var historyFilterTable = '';

    function renderHistory(content) {
      var firstClass = state.entities.tables
        .filter(function (t) { return !isJunction(t); })
        .map(function (t) { return t.name; });
      var options = '<option value="">All entities</option>' +
        firstClass.map(function (n) {
          var sel = n === historyFilterTable ? ' selected' : '';
          return '<option value="' + escapeHtml(n) + '"' + sel + '>' + escapeHtml(displayFor(n).label) + '</option>';
        }).join('');

      content.innerHTML =
        '<div class="view-header">' +
          '<span class="entity-icon">📜</span>' +
          '<h1>Version history</h1>' +
          '<div class="actions">' +
            '<select id="history-filter">' + options + '</select>' +
            '<button class="btn danger" id="history-revert-all" disabled>Revert all (filtered)</button>' +
          '</div>' +
        '</div>' +
        '<div class="history-list" id="history-list"><div class="muted" style="padding:20px;">Loading…</div></div>';

      var filterEl = document.getElementById('history-filter');
      filterEl.addEventListener('change', function () {
        historyFilterTable = filterEl.value;
        renderHistory(content);
      });

      var url = '/api/history?limit=500' +
        (historyFilterTable ? '&table=' + encodeURIComponent(historyFilterTable) : '');
      fetchJson(url).then(function (data) {
        var mount = document.getElementById('history-list');
        if (!data.entries || data.entries.length === 0) {
          mount.innerHTML = '<div class="muted" style="padding:24px;">' +
            (historyFilterTable
              ? 'No history yet for ' + escapeHtml(displayFor(historyFilterTable).label) + '.'
              : 'No history yet — make a change to see it here.') +
            '</div>';
          return;
        }
        mount.innerHTML = data.entries.map(historyEntryHtml).join('');

        // 'Revert all (filtered)' — only when a filter is active and at least
        // one live entry is showing.
        var liveFiltered = data.entries.filter(function (e) { return e.undone === 0; });
        var revertAllBtn = document.getElementById('history-revert-all');
        revertAllBtn.disabled = !(historyFilterTable && liveFiltered.length > 0);
        revertAllBtn.addEventListener('click', function () {
          // Walk newest → oldest so each revert undoes against the most-recent
          // version of the row.
          var queue = liveFiltered.slice();
          function next() {
            var e = queue.shift();
            if (!e) {
              afterMutation().then(function () {
                renderHistory(document.getElementById('content'));
                showToast('Reverted ' + liveFiltered.length + ' change' +
                  (liveFiltered.length === 1 ? '' : 's'), {});
              });
              return;
            }
            fetchJson('/api/history/revert/' + encodeURIComponent(e.id), { method: 'POST' })
              .then(next)
              .catch(function (err) { showToast('Bulk revert failed: ' + err.message, {}); });
          }
          next();
        });

        mount.querySelectorAll('button.history-revert').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-id');
            fetchJson('/api/history/revert/' + encodeURIComponent(id), { method: 'POST' })
              .then(afterMutation)
              .then(function () {
                renderHistory(document.getElementById('content'));
                showToast('Change reverted', {});
              })
              .catch(function (err) { showToast('Revert failed: ' + err.message, {}); });
          });
        });
      }).catch(function (err) {
        document.getElementById('history-list').innerHTML =
          '<div class="muted" style="padding:24px;">Failed to load: ' + escapeHtml(err.message) + '</div>';
      });
    }

    function historyEntryHtml(e) {
      var before = e.before_json ? safeParse(e.before_json) : null;
      var after = e.after_json ? safeParse(e.after_json) : null;
      var summary;
      var iconName = displayFor(e.table_name).label;
      switch (e.operation) {
        case 'insert': summary = 'Created in <span class="history-table">' + escapeHtml(iconName) + '</span>'; break;
        case 'update': summary = 'Updated <span class="history-table">' + escapeHtml(iconName) + '</span> row'; break;
        case 'delete': summary = 'Deleted from <span class="history-table">' + escapeHtml(iconName) + '</span>'; break;
        case 'link':   summary = 'Linked via <span class="history-table">' + escapeHtml(e.table_name) + '</span>'; break;
        case 'unlink': summary = 'Unlinked from <span class="history-table">' + escapeHtml(e.table_name) + '</span>'; break;
        default:       summary = escapeHtml(e.operation) + ' on ' + escapeHtml(e.table_name);
      }
      var diff = renderDiff(before, after);
      var actions = e.undone
        ? '<span class="muted" style="font-size:11px;">undone</span>'
        : '<button class="btn danger history-revert" data-id="' + escapeHtml(e.id) + '">Revert</button>';
      return '<div class="history-entry' + (e.undone ? ' is-undone' : '') + '">' +
        '<div class="history-meta">' +
          '<div><span class="history-op op-' + escapeHtml(e.operation) + '">' + escapeHtml(e.operation) + '</span></div>' +
          '<div style="margin-top:6px;">' + escapeHtml(formatTs(e.ts)) + '</div>' +
        '</div>' +
        '<div class="history-summary">' +
          summary +
          (diff ? '<div class="history-diff">' + diff + '</div>' : '') +
        '</div>' +
        '<div class="history-actions">' + actions + '</div>' +
      '</div>';
    }

    function safeParse(s) {
      try { return JSON.parse(s); } catch (_e) { return null; }
    }

    function formatTs(s) {
      if (!s) return '';
      try {
        var d = new Date(s);
        return d.toLocaleString();
      } catch (_e) { return s; }
    }

    /** Side-by-side-ish text diff. Shows changed columns only for updates. */
    function renderDiff(before, after) {
      if (!before && !after) return '';
      if (!before && after) {
        return Object.keys(after).map(function (k) {
          if (k === 'deleted_at' || after[k] == null) return '';
          return '<div class="diff-add">+ ' + escapeHtml(k) + ': ' + escapeHtml(String(after[k])) + '</div>';
        }).filter(Boolean).join('');
      }
      if (before && !after) {
        return Object.keys(before).map(function (k) {
          if (before[k] == null) return '';
          return '<div class="diff-rem">- ' + escapeHtml(k) + ': ' + escapeHtml(String(before[k])) + '</div>';
        }).filter(Boolean).join('');
      }
      var keys = new Set([].concat(Object.keys(before), Object.keys(after)));
      var lines = [];
      keys.forEach(function (k) {
        var b = before[k];
        var a = after[k];
        if (b === a || (b == null && a == null)) return;
        if (b == null) lines.push('<div class="diff-add">+ ' + escapeHtml(k) + ': ' + escapeHtml(String(a)) + '</div>');
        else if (a == null) lines.push('<div class="diff-rem">- ' + escapeHtml(k) + ': ' + escapeHtml(String(b)) + '</div>');
        else {
          lines.push('<div class="diff-rem">- ' + escapeHtml(k) + ': ' + escapeHtml(String(b)) + '</div>');
          lines.push('<div class="diff-add">+ ' + escapeHtml(k) + ': ' + escapeHtml(String(a)) + '</div>');
        }
      });
      return lines.join('');
    }

    // ────────────────────────────────────────────────────────────
    // Row context (Lattice-rendered markdown files)
    // ────────────────────────────────────────────────────────────
    function loadRowContext(tableName, id) {
      var mount = document.getElementById('row-context');
      if (!mount) return;
      fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows/' +
                encodeURIComponent(id) + '/context').then(function (data) {
        if (!data.files || data.files.length === 0) {
          mount.innerHTML = '<div class="context-block"><div class="context-empty">' +
            'No rendered context for this row — define an entityContext for "' +
            escapeHtml(tableName) + '" in lattice.config.yml or run \`lattice render\`.' +
            '</div></div>';
          return;
        }
        var blocks = data.files.map(function (f) {
          var body = f.content
            ? '<pre>' + escapeHtml(f.content) + '</pre>'
            : '<div class="context-empty">File not rendered yet (run \`lattice render\`).</div>';
          return '<div class="context-file">' +
            '<div class="context-file-head">' +
              '<span class="context-file-name">' + escapeHtml(f.name) + '</span>' +
              '<span>· ' + escapeHtml(f.path) + '</span>' +
            '</div>' + body + '</div>';
        }).join('');
        mount.innerHTML = '<div class="context-block">' + blocks + '</div>';
      }).catch(function (err) {
        mount.innerHTML = '<div class="context-block"><div class="context-empty">' +
          'Failed to load rendered context: ' + escapeHtml(err.message) + '</div></div>';
      });
    }

    // ────────────────────────────────────────────────────────────
    // Data Model — entity graph + entity editor
    // (row-level link/unlink lives on the row detail page now)
    // ────────────────────────────────────────────────────────────
    var dmActiveTable = null;

    /** Columns that are structurally part of every entity and shouldn't be
     * renamed or removed from the GUI. id is the primary key; deleted_at is
     * the soft-delete column whose semantics undo/redo depends on. */
    var LOCKED_COLUMNS = ['id', 'deleted_at'];

    /** Curated emoji set for entity icons. Click one to select. */
    var EMOJI_PALETTE = [
      '📋', '📅', '👥', '✉️', '📦', '💿', '📄', '🔐',
      '🗂️', '📁', '📓', '📕', '📗', '📘', '📙', '📒',
      '📊', '📈', '📌', '📍', '🧾', '🧰', '🧪', '🧬',
      '🛒', '💼', '💳', '💰', '🏢', '🏬', '🏛️', '🚀',
      '🎯', '🎨', '🛠️', '🔧', '⚙️', '⚡', '🌟', '🔔',
      '🔖', '🔍', '❤️', '🌐', '🌎', '🐙', '🦄', '👤',
    ];

    function renderDataModelInto(host) {
      host.innerHTML =
        '<div class="dbconfig-panel" style="margin-top:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
            '<h3 style="margin:0">Data Model</h3>' +
            '<button class="btn primary" id="new-entity-btn">+ New entity</button>' +
          '</div>' +
          '<div class="dm-layout">' +
            '<div id="graph-mount"><div class="muted">Loading graph…</div></div>' +
            '<aside id="dm-panel" hidden></aside>' +
          '</div>' +
        '</div>';

      document.getElementById('new-entity-btn').addEventListener('click', function () {
        dmShowEntityEditor(null);
      });

      fetchJson('/api/graph').then(function (graph) {
        document.getElementById('graph-mount').innerHTML = renderGraphSvg(graph);
        document.querySelectorAll('#graph-mount g.gnode').forEach(function (g) {
          g.addEventListener('click', function () {
            var name = g.getAttribute('data-table');
            dmShowEntityEditor(name);
            highlightGraphNode(name);
          });
        });
        if (dmActiveTable) {
          dmShowEntityEditor(dmActiveTable);
          highlightGraphNode(dmActiveTable);
        }
      }).catch(function (err) {
        document.getElementById('graph-mount').innerHTML =
          '<div class="muted">Failed to load graph: ' + escapeHtml(err.message) + '</div>';
      });
    }

    function highlightGraphNode(tableName) {
      document.querySelectorAll('#graph-mount g.gnode').forEach(function (g) {
        g.classList.toggle('active', g.getAttribute('data-table') === tableName);
      });
    }

    /**
     * Show the editor for a selected entity. Pass null to render the
     * 'create new entity' form (same controls, different submit endpoint).
     * Until the user clicks a graph node or '+ New entity', the side panel
     * stays hidden.
     */
    function dmShowEntityEditor(tableName) {
      dmActiveTable = tableName;
      var panel = document.getElementById('dm-panel');
      panel.hidden = false;
      var creating = !tableName;
      if (creating) {
        // New entities are PRIVATE by default — on a team cloud you own
        // a table you create, and sharing it with the team is a separate,
        // explicit toggle on the entity below (no auto-share-on-create).
        panel.innerHTML =
          '<h3>+ New entity</h3>' +
          '<div class="dm-edit-grid">' +
            '<label>Name</label>' +
            '<div class="dm-row-inline">' +
              '<input id="dm-create-name" placeholder="e.g. invoices" autofocus />' +
            '</div>' +
            '<label>Icon</label>' +
            '<div>' +
              emojiPickerHtml('dm-create-icon', '📋') +
            '</div>' +
            '<label></label>' +
            '<div class="dm-row-inline">' +
              '<button class="btn primary" id="dm-create-btn">Create entity</button>' +
            '</div>' +
          '</div>' +
          '<div class="muted" style="margin-top:14px;font-size:12px;">' +
            'New entities get id (uuid PK), name, and deleted_at columns. ' +
            'Add more columns once the entity exists. On a team cloud the ' +
            'entity is private to you until you share it.' +
          '</div>';
        wireEmojiPicker(panel, 'dm-create-icon');
        var createBtn = panel.querySelector('#dm-create-btn');
        createBtn.addEventListener('click', function () {
          var name = panel.querySelector('#dm-create-name').value.trim();
          var icon = panel.querySelector('#dm-create-icon').value.trim();
          if (!name) { panel.querySelector('#dm-create-name').focus(); return; }
          withBusy(createBtn, function () {
            return fetchJson('/api/schema/entities', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: name, icon: icon || undefined }),
            }).then(function () {
              return reloadEverything();
            }).then(function () {
              location.hash = '#/settings/database';
              dmActiveTable = name;
              renderRoute();
              showToast('Entity "' + name + '" created', {});
            }).catch(function (err) { showToast('Create failed: ' + err.message, {}); });
          });
        });
        return;
      }

      var t = tableByName(tableName);
      if (!t) {
        panel.innerHTML = '<div class="muted">Unknown entity.</div>';
        return;
      }
      var d = displayFor(tableName);
      // Pre-fill the picker with the effective icon (override > built-in
      // default > generic fallback) so the dropdown reflects what's actually
      // rendered elsewhere in the GUI.
      var overrideIcon = d.icon;
      // Render every column, but render locked ones (id, deleted_at) as
      // read-only labels — they're structural and renaming would break
      // soft-delete / version-history semantics.
      var allCols = (t.columns || []);
      var columnsHtml = allCols.map(function (c) {
        var locked = LOCKED_COLUMNS.indexOf(c) !== -1;
        if (locked) {
          return '<div class="dm-col-row">' +
            '<div class="dm-locked">' + escapeHtml(c) +
              '<span class="dm-locked-label">system</span>' +
            '</div>' +
            '<span></span><span></span>' +
            '</div>';
        }
        var secret = isSecretColumn(tableName, c);
        return '<div class="dm-col-row">' +
          '<input class="dm-col-name" data-col="' + escapeHtml(c) + '" value="' + escapeHtml(c) + '" />' +
          '<label class="dm-secret-toggle" title="Mask values in the GUI">' +
            '<input type="checkbox" class="dm-col-secret" data-col="' + escapeHtml(c) + '"' +
              (secret ? ' checked' : '') + ' />' +
            ' secret' +
          '</label>' +
          '<button class="btn dm-col-rename" data-col="' + escapeHtml(c) + '" title="Rename">↻</button>' +
          '</div>';
      }).join('');
      // Team-cloud sharing row — only the owner of a table may toggle
      // its team visibility (t.ownedByMe is set by the server only for
      // team clouds). Tables shared to me by others, and all non-team
      // tables, show no sharing control.
      var canShare = !!(t && t.ownedByMe === true);
      var isShared = !!(t && t.shared);
      var shareRow = canShare
        ? '<label>Team sharing</label>' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
            '<button class="btn' + (isShared ? '' : ' primary') + '" id="dm-share-btn">' +
              (isShared ? 'Unshare from team' : 'Share with team') +
            '</button>' +
            '<span style="font-size:12px;color:var(--text-muted)">' +
              (isShared ? 'Visible to every team member.' : 'Private to you. Share to make it visible to the team.') +
            '</span>' +
          '</div>'
        : '';
      panel.innerHTML =
        '<h3>' + d.icon + ' ' + escapeHtml(d.label) + '</h3>' +
        '<div class="dm-edit-grid">' +
          '<label>Name</label>' +
          '<div class="dm-row-inline">' +
            '<input id="dm-rename-input" value="' + escapeHtml(tableName) + '" />' +
            '<button class="btn" id="dm-rename-btn">Save</button>' +
          '</div>' +
          '<label>Icon</label>' +
          '<div>' +
            emojiPickerHtml('dm-icon-input', overrideIcon) +
            '<button class="btn" id="dm-icon-btn" style="margin-top:6px;">Save</button>' +
          '</div>' +
          shareRow +
          '<label>Columns</label>' +
          '<div class="dm-cols">' + (columnsHtml || '<span class="muted">No columns</span>') + '</div>' +
          '<label>Add column</label>' +
          '<div class="dm-row-inline">' +
            '<input id="dm-newcol-name" placeholder="column_name" />' +
            '<select id="dm-newcol-type">' +
              '<option value="text">text</option>' +
              '<option value="integer">integer</option>' +
              '<option value="real">real</option>' +
              '<option value="boolean">boolean</option>' +
              '<option value="uuid">uuid</option>' +
            '</select>' +
            '<label class="dm-secret-toggle">' +
              '<input type="checkbox" id="dm-newcol-secret" /> secret' +
            '</label>' +
            '<button class="btn primary" id="dm-newcol-btn">Add</button>' +
          '</div>' +
        '</div>';
      wireEmojiPicker(panel, 'dm-icon-input');
      wireEntityEditPanel(panel, tableName);
      var shareBtn = panel.querySelector('#dm-share-btn');
      if (shareBtn) shareBtn.addEventListener('click', function () {
        withBusy(shareBtn, function () {
          return fetchJson('/api/schema/entities/' + encodeURIComponent(tableName) + '/share', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ share: !isShared }),
          }).then(function () {
            return reloadEverything();
          }).then(function () {
            location.hash = '#/settings/database';
            dmActiveTable = tableName;
            renderRoute();
            showToast(isShared ? 'Unshared "' + tableName + '" from team' : 'Shared "' + tableName + '" with team', {});
          }).catch(function (e) { showToast('Share update failed: ' + e.message, {}); });
        });
      });
    }

    /**
     * Render a collapsed emoji-picker: a button showing the currently selected
     * emoji (with a ▾ caret) and a hidden grid that drops down when clicked.
     * Selecting a tile updates the hidden input and the button, then closes
     * the dropdown.
     *
     * currentValue is the emoji to pre-fill (saved override OR the inherited
     * default — callers pass displayFor(table).icon so the dropdown reflects
     * what the user actually sees on the rest of the page).
     */
    function emojiPickerHtml(inputId, currentValue) {
      var current = currentValue || '📋';
      var tiles = EMOJI_PALETTE.map(function (e) {
        var active = e === current ? ' active' : '';
        return '<button type="button" class="emoji-tile' + active +
          '" data-emoji="' + escapeHtml(e) + '" aria-label="' + escapeHtml(e) + '">' + e + '</button>';
      }).join('');
      return '<div class="emoji-picker" data-input-id="' + escapeHtml(inputId) + '">' +
        '<button type="button" class="emoji-trigger" aria-haspopup="grid" aria-expanded="false">' +
          '<span class="emoji-preview">' + escapeHtml(current) + '</span>' +
          '<span class="emoji-caret">▾</span>' +
        '</button>' +
        '<div class="emoji-grid" hidden>' + tiles + '</div>' +
        '<input type="hidden" id="' + escapeHtml(inputId) + '" value="' + escapeHtml(current) + '" />' +
      '</div>';
    }

    function wireEmojiPicker(panel, inputId) {
      var picker = panel.querySelector('.emoji-picker[data-input-id="' + inputId + '"]');
      if (!picker) return;
      var input = picker.querySelector('input[type="hidden"]');
      var trigger = picker.querySelector('.emoji-trigger');
      var preview = picker.querySelector('.emoji-preview');
      var grid = picker.querySelector('.emoji-grid');

      function open() {
        grid.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
      }
      function close() {
        grid.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
      }

      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        if (grid.hidden) open(); else close();
      });

      // Click anywhere outside the picker closes it.
      document.addEventListener('click', function (e) {
        if (grid.hidden) return;
        if (!picker.contains(e.target)) close();
      });

      picker.querySelectorAll('.emoji-tile').forEach(function (tile) {
        tile.addEventListener('click', function () {
          var v = tile.getAttribute('data-emoji');
          input.value = v;
          preview.textContent = v;
          picker.querySelectorAll('.emoji-tile').forEach(function (t) {
            t.classList.toggle('active', t === tile);
          });
          close();
        });
      });
    }

    /** Wire up the edit-entity controls in the Data Model side panel. */
    function wireEntityEditPanel(panel, tableName) {
      // Rename entity — schema change, not in the audit log, so we keep
      // a confirm (the only kind of warning left in the app).
      panel.querySelector('#dm-rename-btn').addEventListener('click', function () {
        var to = panel.querySelector('#dm-rename-input').value.trim();
        if (!to || to === tableName) return;
        if (!confirm('Rename entity "' + tableName + '" to "' + to + '"? This is irreversible from the GUI.')) return;
        fetchJson('/api/schema/entities/' + encodeURIComponent(tableName) + '/rename', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ to: to }),
        }).then(function () {
          return reloadEverything();
        }).then(function () {
          location.hash = '#/settings/database';
          showToast('Entity renamed to "' + to + '"', {});
        }).catch(function (err) { showToast('Rename failed: ' + err.message, {}); });
      });
      // Edit icon
      panel.querySelector('#dm-icon-btn').addEventListener('click', function () {
        var icon = panel.querySelector('#dm-icon-input').value.trim();
        fetchJson('/api/gui-meta/' + encodeURIComponent(tableName), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ icon: icon }),
        }).then(refreshIcons).then(function () {
          dmShowTableRows(tableName);
          showToast('Icon saved', {});
        }).catch(function (err) { showToast('Icon save failed: ' + err.message, {}); });
      });
      // Add column — additive but not in the audit log, so no undo.
      panel.querySelector('#dm-newcol-btn').addEventListener('click', function () {
        var name = panel.querySelector('#dm-newcol-name').value.trim();
        var type = panel.querySelector('#dm-newcol-type').value;
        var secret = !!panel.querySelector('#dm-newcol-secret').checked;
        if (!name) return;
        fetchJson('/api/schema/entities/' + encodeURIComponent(tableName) + '/columns', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: name, type: type }),
        }).then(function () {
          if (!secret) return;
          // Persist the secret flag for the new column.
          return fetchJson(
            '/api/gui-meta/columns/' + encodeURIComponent(tableName) + '/' + encodeURIComponent(name),
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ secret: true }),
            },
          );
        }).then(function () {
          return reloadEverything();
        }).then(function () {
          location.hash = '#/settings/database';
          showToast('Column "' + name + '" added', {});
        }).catch(function (err) { showToast('Add column failed: ' + err.message, {}); });
      });
      // Toggle 'secret' on an existing column.
      panel.querySelectorAll('input.dm-col-secret').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var col = cb.getAttribute('data-col');
          fetchJson(
            '/api/gui-meta/columns/' + encodeURIComponent(tableName) + '/' + encodeURIComponent(col),
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ secret: !!cb.checked }),
            },
          ).then(refreshColumnMeta).then(function () {
            showToast(cb.checked ? 'Column "' + col + '" marked secret' : 'Column "' + col + '" no longer secret', {});
          }).catch(function (err) {
            cb.checked = !cb.checked; // revert
            showToast('Failed: ' + err.message, {});
          });
        });
      });
      // Rename column — schema change, irreversible.
      panel.querySelectorAll('.dm-col-rename').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var col = btn.getAttribute('data-col');
          var input = panel.querySelector('input.dm-col-name[data-col="' + col + '"]');
          var to = input.value.trim();
          if (!to || to === col) return;
          if (!confirm('Rename column "' + col + '" to "' + to + '"? This is irreversible from the GUI.')) return;
          fetchJson(
            '/api/schema/entities/' + encodeURIComponent(tableName) +
              '/columns/' + encodeURIComponent(col) + '/rename',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ to: to }),
            },
          ).then(function () {
            return reloadEverything();
          }).then(function () {
            location.hash = '#/settings/database';
            showToast('Column renamed to "' + to + '"', {});
          }).catch(function (err) { showToast('Rename column failed: ' + err.message, {}); });
        });
      });
    }

    function renderGraphSvg(graph) {
      // Circular layout. Junctions become edges (not nodes).
      var allTableNodes = graph.nodes.filter(function (n) { return n.type === 'table'; });
      var junctionNames = new Set(state.entities.tables.filter(isJunction).map(function (t) { return t.name; }));
      var tableNodes = allTableNodes.filter(function (n) { return !junctionNames.has(n.table || n.label); });

      // Build edges between first-class entities, each tagged with relationship type.
      var entityEdges = [];
      state.entities.tables.forEach(function (t) {
        if (!isJunction(t)) return;
        var rels = Object.values(t.relations);
        if (rels.length === 2) {
          entityEdges.push({
            source: 'table:' + rels[0].table,
            target: 'table:' + rels[1].table,
            type: 'many-to-many',
            via: t.name,
          });
        }
      });
      state.entities.tables.forEach(function (t) {
        if (isJunction(t)) return;
        Object.values(t.relations || {}).forEach(function (r) {
          if (r.type === 'belongsTo') {
            entityEdges.push({
              source: 'table:' + t.name,
              target: 'table:' + r.table,
              type: 'belongs-to',
              via: r.foreignKey,
            });
          }
        });
      });

      var cx = 500, cy = 360, r = 250;
      var nodeRadius = 30;
      var pos = {};
      tableNodes.forEach(function (n, i) {
        var a = (i / tableNodes.length) * Math.PI * 2 - Math.PI / 2;
        pos[n.id] = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
      });

      var BELONGS_COLOR = '#2f6feb';
      var M2M_COLOR = '#a16207';

      // Trim edge endpoints back from the node centre so the arrow heads
      // sit outside the circle. Markers are 7px tall; pad a little more.
      function trim(from, to, pad) {
        var dx = to.x - from.x, dy = to.y - from.y;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) return to;
        var k = (len - pad) / len;
        return { x: from.x + dx * k, y: from.y + dy * k };
      }

      var edgeSvg = entityEdges.map(function (e) {
        var a = pos[e.source], b = pos[e.target];
        if (!a || !b) return '';
        var color = e.type === 'belongs-to' ? BELONGS_COLOR : M2M_COLOR;
        var dash = e.type === 'belongs-to' ? '' : ' stroke-dasharray="6 4"';
        // One arrowhead at the target for belongs-to (child→parent);
        // arrowheads at both ends for many-to-many.
        var endTrimmed = trim(a, b, nodeRadius + 4);
        var startTrimmed = trim(b, a, nodeRadius + 4);
        var markerEnd = ' marker-end="url(#arrow-' + (e.type === 'belongs-to' ? 'b' : 'm') + ')"';
        var markerStart = e.type === 'many-to-many'
          ? ' marker-start="url(#arrow-m)"' : '';
        return '<line x1="' + startTrimmed.x + '" y1="' + startTrimmed.y +
          '" x2="' + endTrimmed.x + '" y2="' + endTrimmed.y +
          '" stroke="' + color + '" stroke-width="1.8"' + dash + markerEnd + markerStart +
          ' data-edge-type="' + e.type + '" data-via="' + escapeHtml(e.via || '') + '"></line>';
      }).join('');

      var nodeSvg = tableNodes.map(function (n) {
        var p = pos[n.id];
        var tableName = n.table || n.label;
        var d = displayFor(tableName);
        return '<g class="gnode" data-table="' + escapeHtml(tableName) + '">' +
          '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + nodeRadius +
            '" fill="#e7efff" stroke="' + BELONGS_COLOR + '" stroke-width="1.5" />' +
          '<text x="' + p.x + '" y="' + (p.y + 7) + '" text-anchor="middle" font-size="20">' + d.icon + '</text>' +
          '<text x="' + p.x + '" y="' + (p.y + nodeRadius + 18) + '" text-anchor="middle" font-size="12" fill="#e7ecf0">' +
          escapeHtml(d.label) + '</text></g>';
      }).join('');

      // Arrow-head markers: "b" = belongs-to (blue), "m" = many-to-many (amber).
      var defs =
        '<defs>' +
          '<marker id="arrow-b" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
            '<path d="M0,0 L10,5 L0,10 z" fill="' + BELONGS_COLOR + '" />' +
          '</marker>' +
          '<marker id="arrow-m" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
            '<path d="M0,0 L10,5 L0,10 z" fill="' + M2M_COLOR + '" />' +
          '</marker>' +
        '</defs>';

      // Legend in the corner.
      var legend =
        '<g class="dm-legend" transform="translate(20, 20)">' +
          '<line x1="0" y1="6" x2="36" y2="6" stroke="' + BELONGS_COLOR + '" stroke-width="1.8" marker-end="url(#arrow-b)" />' +
          '<text x="44" y="10" font-size="11" fill="#8b96a3">belongs-to (child → parent)</text>' +
          '<line x1="0" y1="28" x2="36" y2="28" stroke="' + M2M_COLOR + '" stroke-width="1.8" stroke-dasharray="6 4" marker-start="url(#arrow-m)" marker-end="url(#arrow-m)" />' +
          '<text x="44" y="32" font-size="11" fill="#8b96a3">many-to-many</text>' +
        '</g>';

      return '<svg viewBox="0 0 1000 720" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">' +
        defs + legend + edgeSvg + nodeSvg + '</svg>';
    }

    // ────────────────────────────────────────────────────────────
    // Lattice Teams (Project Config + User Config)
    // ────────────────────────────────────────────────────────────
    /**
     * Minimal modal helper for the teams flows. Returns { close } so
     * callers can dismiss imperatively (used by the invite-token modal
     * after copy). opts.onSubmit may return a Promise — the OK button
     * stays disabled until it resolves, then the modal closes.
     */
    function showModal(title, bodyHtml, opts) {
      opts = opts || {};
      var primaryLabel = opts.primaryLabel || 'Save';
      var primaryClass = opts.primaryClass || 'primary';
      var backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML =
        '<div class="modal">' +
          '<div class="modal-head">' + escapeHtml(title) + '</div>' +
          '<div class="modal-body">' + bodyHtml + '</div>' +
          '<div class="modal-foot">' +
            '<button class="btn" data-act="cancel">Cancel</button>' +
            '<button class="btn ' + primaryClass + '" data-act="ok">' + escapeHtml(primaryLabel) + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(backdrop);
      if (opts.onBody) opts.onBody(backdrop);
      function close() { if (backdrop.parentNode) document.body.removeChild(backdrop); }
      backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
      backdrop.querySelector('[data-act="cancel"]').addEventListener('click', close);
      backdrop.querySelector('[data-act="ok"]').addEventListener('click', function () {
        var btn = backdrop.querySelector('[data-act="ok"]');
        if (btn.disabled) return;
        var label = btn.innerHTML;
        var spin = function () {
          btn.disabled = true;
          btn.classList.add('is-busy');
          btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + label;
        };
        var unspin = function () {
          btn.disabled = false;
          btn.classList.remove('is-busy');
          btn.innerHTML = label;
        };
        try {
          var result = opts.onSubmit ? opts.onSubmit(backdrop) : null;
          if (result && typeof result.then === 'function') {
            spin();
            result.then(function () { close(); }).catch(function (err) {
              unspin();
              alert('Failed: ' + (err && err.message ? err.message : String(err)));
            });
          } else {
            close();
          }
        } catch (err) {
          alert('Failed: ' + (err && err.message ? err.message : String(err)));
        }
      });
      return { close: close };
    }

    function refreshSettingsRoute() {
      if (location.hash === '#/settings/project-config') renderProjectConfig(document.getElementById('content'));
      else if (location.hash === '#/settings/user-config') renderUserConfig(document.getElementById('content'));
    }

    // ────────────────────────────────────────────────────────────
    // Three-step Create Database wizard. Used from the header dropdown
    // "+ New database" button and from Lattice Settings → Add new DB.
    // Step 1: name + kind (+ cloud credentials if cloud)
    // Step 2: starter entities (with share-to-cloud checkbox when cloud)
    // Step 3: review + submit
    // ────────────────────────────────────────────────────────────
    function showCreateDatabaseWizard() {
      var wizState = {
        step: 1,
        name: '',
        kind: 'local',
        cloudUrl: '',
        email: '',
        displayName: '',
        entities: [], // { name: string, share: boolean }
      };
      // Prefill identity for the cloud path so the operator doesn't
      // re-type their email + display name on every wizard run.
      fetchJson('/api/userconfig/identity').then(function (id) {
        wizState.email = id.email || '';
        wizState.displayName = id.display_name || '';
        openWizard();
      }).catch(openWizard);

      function openWizard() {
        var backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        backdrop.innerHTML =
          '<div class="modal" style="min-width:560px;max-width:640px">' +
            '<div class="modal-head" id="wiz-head">New database — step 1 of 3</div>' +
            '<div class="modal-body" id="wiz-body"></div>' +
            '<div class="modal-foot">' +
              '<button class="btn" data-act="cancel">Cancel</button>' +
              '<button class="btn" data-act="back">Back</button>' +
              '<button class="btn primary" data-act="next">Next</button>' +
            '</div>' +
          '</div>';
        document.body.appendChild(backdrop);
        function close() { if (backdrop.parentNode) document.body.removeChild(backdrop); }
        backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
        backdrop.querySelector('[data-act="cancel"]').addEventListener('click', close);
        backdrop.querySelector('[data-act="back"]').addEventListener('click', goBack);
        backdrop.querySelector('[data-act="next"]').addEventListener('click', goNext);
        render();

        function render() {
          var head = backdrop.querySelector('#wiz-head');
          var body = backdrop.querySelector('#wiz-body');
          var nextBtn = backdrop.querySelector('[data-act="next"]');
          var backBtn = backdrop.querySelector('[data-act="back"]');
          head.textContent = 'New database — step ' + wizState.step + ' of 3';
          backBtn.style.display = wizState.step === 1 ? 'none' : '';
          nextBtn.textContent = wizState.step === 3 ? 'Create' : 'Next';
          if (wizState.step === 1) body.innerHTML = renderStep1();
          else if (wizState.step === 2) body.innerHTML = renderStep2();
          else body.innerHTML = renderStep3();
          wireStepHandlers(body);
        }

        function renderStep1() {
          var kind = wizState.kind;
          // Join uses the existing invite-redeem modal (opened on Next), so no
          // name/entities steps — the DB name comes from the team you join.
          var nameField = kind === 'join' ? '' :
            '<div class="field"><label>Database name</label>' +
              '<input id="wiz-name" type="text" value="' + escapeHtml(wizState.name) +
              '" placeholder="e.g. my-research, design-system" maxlength="200" />' +
            '</div>';
          var cloudBlock = '';
          if (kind === 'cloud') {
            cloudBlock =
              '<div class="field"><label>Cloud URL</label>' +
                '<input id="wiz-cloud-url" type="text" value="' + escapeHtml(wizState.cloudUrl) +
                '" placeholder="postgres://postgres.&lt;ref&gt;:password@aws-x-region.pooler.supabase.com:5432/postgres" autocapitalize="off" autocorrect="off" spellcheck="false" />' +
                '<p style="font-size:11px;color:var(--text-muted);margin:4px 0 0">Use a session-mode Postgres URL. Supabase users: see the pooler docs for the right host.</p>' +
              '</div>' +
              '<div class="field"><label>Your email</label>' +
                '<input id="wiz-email" type="email" value="' + escapeHtml(wizState.email) + '" autocapitalize="off" />' +
              '</div>' +
              '<div class="field"><label>Your display name</label>' +
                '<input id="wiz-display-name" type="text" value="' + escapeHtml(wizState.displayName) + '" />' +
              '</div>';
          } else if (kind === 'join') {
            cloudBlock = '<p style="font-size:12px;color:var(--text-muted);margin:4px 0 0">Click Next to paste your cloud URL and invite token.</p>';
          }
          return '' +
            nameField +
            '<div class="field"><label>Kind</label>' +
              '<div style="display:flex;gap:16px;margin-top:4px;flex-wrap:wrap">' +
                '<label style="display:flex;align-items:center;gap:6px;font-weight:400;text-transform:none;letter-spacing:0">' +
                  '<input type="radio" name="wiz-kind" value="local"' + (kind === 'local' ? ' checked' : '') + ' /> New local (SQLite)' +
                '</label>' +
                '<label style="display:flex;align-items:center;gap:6px;font-weight:400;text-transform:none;letter-spacing:0">' +
                  '<input type="radio" name="wiz-kind" value="cloud"' + (kind === 'cloud' ? ' checked' : '') + ' /> New cloud (Postgres)' +
                '</label>' +
                '<label style="display:flex;align-items:center;gap:6px;font-weight:400;text-transform:none;letter-spacing:0">' +
                  '<input type="radio" name="wiz-kind" value="join"' + (kind === 'join' ? ' checked' : '') + ' /> Join existing cloud (invite)' +
                '</label>' +
              '</div>' +
              '<p style="font-size:11px;color:var(--text-muted);margin:6px 0 0">' +
                'Local databases are single-user SQLite files on your machine. Cloud databases are Postgres, can be shared with invited team members, and stream realtime updates. Joining connects to a cloud DB you were invited to.' +
              '</p>' +
            '</div>' +
            cloudBlock;
        }

        function renderStep2() {
          var rows = wizState.entities.map(function (e, idx) {
            var shareCol = wizState.kind === 'cloud'
              ? '<td style="text-align:center"><input type="checkbox" data-wiz-share="' + idx + '"' + (e.share ? ' checked' : '') + ' /></td>'
              : '';
            return '<tr>' +
              '<td><input type="text" data-wiz-entity="' + idx + '" value="' + escapeHtml(e.name) + '" placeholder="entity_name" style="width:100%" /></td>' +
              shareCol +
              '<td style="text-align:right"><button class="btn" data-wiz-remove="' + idx + '" style="font-size:11px;padding:2px 8px">Remove</button></td>' +
            '</tr>';
          }).join('');
          var shareHeader = wizState.kind === 'cloud'
            ? '<th style="text-align:center;width:80px">Share with cloud</th>'
            : '';
          return '<p class="lead" style="margin:0 0 10px">Optionally add starter entities. You can skip and add them later.</p>' +
            '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
              '<thead><tr style="text-align:left"><th>Entity name</th>' + shareHeader + '<th style="width:90px"></th></tr></thead>' +
              '<tbody>' + (rows || '<tr><td colspan="3" style="padding:8px;color:var(--text-muted)">No entities yet.</td></tr>') + '</tbody>' +
            '</table>' +
            '<button class="btn" id="wiz-add-entity" style="margin-top:10px">+ Add entity</button>' +
            (wizState.kind === 'cloud'
              ? '<p style="font-size:11px;color:var(--text-muted);margin:10px 0 0">' +
                'Entities with “Share with cloud” checked are visible to every team member. Unchecked entities live on the cloud DB but stay scoped to your own row links.' +
                '</p>'
              : '');
        }

        function renderStep3() {
          var entityList = wizState.entities.length === 0
            ? '<em style="color:var(--text-muted)">(none — you can add entities after creating)</em>'
            : '<ul style="margin:4px 0 0 0;padding-left:18px">' +
                wizState.entities.map(function (e) {
                  var tag = wizState.kind === 'cloud'
                    ? (e.share ? ' <span style="font-size:10px;padding:1px 5px;border-radius:6px;background:var(--accent-soft);color:var(--accent)">shared</span>'
                              : ' <span style="font-size:10px;padding:1px 5px;border-radius:6px;background:rgba(255,255,255,0.06);color:var(--text-muted)">local only</span>')
                    : '';
                  return '<li>' + escapeHtml(e.name) + tag + '</li>';
                }).join('') +
              '</ul>';
          var cloudBlock = wizState.kind === 'cloud'
            ? '<div><strong>Cloud URL</strong>: <code>' + escapeHtml(redactUrlCredentials(wizState.cloudUrl)) + '</code></div>' +
              '<div><strong>Email</strong>: ' + escapeHtml(wizState.email) + '</div>'
            : '';
          return '<p class="lead" style="margin:0 0 10px">Review and create.</p>' +
            '<div style="display:grid;grid-template-columns:120px 1fr;gap:6px 12px;font-size:13.5px">' +
              '<div><strong>Name</strong>:</div><div>' + escapeHtml(wizState.name) + '</div>' +
              '<div><strong>Kind</strong>:</div><div>' + (wizState.kind === 'cloud' ? 'Cloud (Postgres)' : 'Local (SQLite)') + '</div>' +
            '</div>' +
            (cloudBlock ? '<div style="margin-top:10px;display:grid;grid-template-columns:120px 1fr;gap:6px 12px;font-size:13.5px">' + cloudBlock + '</div>' : '') +
            '<div style="margin-top:14px"><strong>Entities</strong>: ' + entityList + '</div>';
        }

        function wireStepHandlers(scope) {
          if (wizState.step === 1) {
            var nameInput = scope.querySelector('#wiz-name');
            if (nameInput) nameInput.addEventListener('input', function (e) { wizState.name = e.target.value; });
            scope.querySelectorAll('input[name="wiz-kind"]').forEach(function (radio) {
              radio.addEventListener('change', function () {
                wizState.name = (scope.querySelector('#wiz-name') || {}).value || wizState.name;
                wizState.kind = radio.value;
                render(); // re-render to show/hide cloud fields
              });
            });
            var cu = scope.querySelector('#wiz-cloud-url'); if (cu) cu.addEventListener('input', function (e) { wizState.cloudUrl = e.target.value; });
            var em = scope.querySelector('#wiz-email'); if (em) em.addEventListener('input', function (e) { wizState.email = e.target.value; });
            var dn = scope.querySelector('#wiz-display-name'); if (dn) dn.addEventListener('input', function (e) { wizState.displayName = e.target.value; });
          } else if (wizState.step === 2) {
            scope.querySelector('#wiz-add-entity').addEventListener('click', function () {
              wizState.entities.push({ name: '', share: wizState.kind === 'cloud' });
              render();
            });
            scope.querySelectorAll('input[data-wiz-entity]').forEach(function (input) {
              input.addEventListener('input', function () {
                var idx = parseInt(input.getAttribute('data-wiz-entity') || '0', 10);
                wizState.entities[idx].name = input.value;
              });
            });
            scope.querySelectorAll('input[data-wiz-share]').forEach(function (input) {
              input.addEventListener('change', function () {
                var idx = parseInt(input.getAttribute('data-wiz-share') || '0', 10);
                wizState.entities[idx].share = !!input.checked;
              });
            });
            scope.querySelectorAll('button[data-wiz-remove]').forEach(function (btn) {
              btn.addEventListener('click', function () {
                var idx = parseInt(btn.getAttribute('data-wiz-remove') || '0', 10);
                wizState.entities.splice(idx, 1);
                render();
              });
            });
          }
        }

        function goBack() {
          if (wizState.step > 1) { wizState.step -= 1; render(); }
        }

        function goNext() {
          if (wizState.step === 1) {
            // Join existing cloud: hand off to the invite-redeem modal, which
            // collects the cloud URL + invite token and connects.
            if (wizState.kind === 'join') { close(); showJoinTeamModal('project'); return; }
            if (!wizState.name.trim()) { alert('Database name is required'); return; }
            if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,199}$/.test(wizState.name.trim())) {
              alert('Database name must start with a letter or digit and contain only letters, digits, spaces, dots, underscores, or hyphens'); return;
            }
            if (wizState.kind === 'cloud') {
              if (!/^postgres(ql)?:\\/\\//i.test(wizState.cloudUrl.trim())) { alert('Cloud URL must start with postgres://'); return; }
              if (!wizState.email.trim()) { alert('Email is required for cloud databases'); return; }
              if (!wizState.displayName.trim()) { alert('Display name is required for cloud databases'); return; }
            }
            wizState.step = 2;
            render();
          } else if (wizState.step === 2) {
            // Validate entity names (if any)
            for (var i = 0; i < wizState.entities.length; i += 1) {
              var nm = wizState.entities[i].name.trim();
              if (!nm) { alert('Entity name on row ' + (i + 1) + ' is empty'); return; }
              if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(nm)) {
                alert('Entity name "' + nm + '" is invalid (use a valid identifier).'); return;
              }
            }
            wizState.step = 3;
            render();
          } else {
            submit();
          }
        }

        function submit() {
          var nextBtn = backdrop.querySelector('[data-act="next"]');
          nextBtn.setAttribute('disabled', 'disabled');
          nextBtn.textContent = 'Creating…';
          var promise = wizState.kind === 'local' ? submitLocal() : submitCloud();
          promise.then(function () {
            close();
            return reloadEverything();
          }).then(function () {
            showToast('Database "' + wizState.name + '" created', {});
          }).catch(function (err) {
            nextBtn.removeAttribute('disabled');
            nextBtn.textContent = 'Create';
            alert('Create failed: ' + (err && err.message ? err.message : String(err)));
          });
        }

        function submitLocal() {
          // Slug the name for the YAML filename; the friendly name goes
          // into the new config's name: key via /api/dbconfig/rename
          // after the create succeeds.
          var slug = wizState.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
          return fetchJson('/api/databases/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: slug }),
          }).then(function () {
            // After the create, the active DB is the new one. Set the
            // friendly name + add starter entities.
            return fetchJson('/api/dbconfig/rename', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: wizState.name.trim() }),
            });
          }).then(function () {
            return createStarterEntities(wizState.entities);
          });
        }

        function submitCloud() {
          var createdTeamId = null;
          return fetchJson('/api/teams-gui/connections/register-and-create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              cloud_url: wizState.cloudUrl.trim(),
              email: wizState.email.trim(),
              user_name: wizState.displayName.trim(),
              team_name: wizState.name.trim(),
            }),
          }).then(function (result) {
            createdTeamId = result && result.team && result.team.id;
            return createStarterEntities(wizState.entities, createdTeamId);
          });
        }

        function createStarterEntities(entities, teamId) {
          if (entities.length === 0) return Promise.resolve();
          // Sequential creates — order matters for any FK refs the user
          // adds later, and the volume is small (wizard cap is user-driven).
          return entities.reduce(function (chain, e) {
            return chain.then(function () {
              return fetchJson('/api/schema/entities', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: e.name.trim() }),
              }).then(function () {
                if (wizState.kind === 'cloud' && e.share && teamId) {
                  // Share the new entity with the cloud team. Best-effort:
                  // failure here doesn't roll back the create; the user
                  // can retry from Data Model → Share later.
                  return fetchJson('/api/teams-gui/teams/' + encodeURIComponent(teamId) + '/shared', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ table: e.name.trim() }),
                  }).catch(function () { /* swallow */ });
                }
                return null;
              });
            });
          }, Promise.resolve());
        }
      }
    }

    function showCreateTeamModal() {
      // Prefill identity from ~/.lattice/identity.json so the user only
      // enters per-DB things (cloud URL + DB name) in this modal.
      fetchJson('/api/userconfig/identity').then(function (id) {
        var bodyHtml =
          '<div class="field"><label>Cloud URL</label>' +
            '<input name="cloud_url" placeholder="postgres://postgres.&lt;ref&gt;:password@aws-x-region.pooler.supabase.com:5432/postgres" autocapitalize="off" autocorrect="off" spellcheck="false" />' +
          '</div>' +
          '<div class="field"><label>Your email</label><input name="email" value="' + escapeHtml(id.email || '') + '" autocapitalize="off" /></div>' +
          '<div class="field"><label>Your display name</label><input name="user_name" value="' + escapeHtml(id.display_name || '') + '" /></div>' +
          '<div class="field"><label>Database name</label><input name="team_name" /></div>' +
          '<p style="font-size:12px;color:var(--text-muted);margin:0">' +
          'Registers you on the cloud (bootstrap-only — must be a fresh cloud) and creates the cloud database in one step. ' +
          'Email + display name are pulled from your User Config identity; edit them below to override for this database only.' +
          '</p>';
        showModal('Create cloud database', bodyHtml, {
          primaryLabel: 'Create',
          onSubmit: function (scope) {
            var data = collectFormValues(scope);
            return fetchJson('/api/teams-gui/connections/register-and-create', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(data),
            }).then(function () { refreshSettingsRoute(); });
          },
        });
      });
    }

    function showJoinTeamModal(kind) {
      fetchJson('/api/userconfig/identity').then(function (id) {
        var bodyHtml =
          '<div class="field"><label>Cloud URL</label>' +
            '<input name="cloud_url" placeholder="postgres://postgres.&lt;ref&gt;:password@aws-x-region.pooler.supabase.com:5432/postgres" autocapitalize="off" autocorrect="off" spellcheck="false" />' +
          '</div>' +
          '<div class="field"><label>Invite token</label><textarea name="invite_token" placeholder="latinv_..." autocapitalize="off" autocorrect="off" spellcheck="false"></textarea></div>' +
          // Identity is fixed to the operator's User Settings — readonly so
          // you join as yourself (and the email matches the invite binding).
          '<div class="field"><label>Your email</label><input name="email" value="' + escapeHtml(id.email || '') + '" readonly tabindex="-1" style="opacity:0.7;cursor:not-allowed" /></div>' +
          '<div class="field"><label>Your display name</label><input name="name" value="' + escapeHtml(id.display_name || '') + '" readonly tabindex="-1" style="opacity:0.7;cursor:not-allowed" /></div>' +
          '<p style="font-size:12px;color:var(--text-muted);margin:0">' +
          'Use the same Postgres URL the inviter used (postgres://…). Your email + display name come from User Settings — change them there. The email must match the address the invitation was addressed to.' +
          '</p>';
        showModal('Join team', bodyHtml, {
          primaryLabel: 'Join',
          onSubmit: function (scope) {
            var data = collectFormValues(scope);
            return fetchJson('/api/teams-gui/connections/join', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(data),
            }).then(function (res) {
              // Auto-switch to the joined cloud DB so it shows in the
              // header dropdown and becomes active immediately — no
              // manual page refresh needed.
              var path = res && res.config_path;
              if (!path) { refreshSettingsRoute(kind); return; }
              return fetchJson('/api/databases/switch', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ path: path }),
              })
                .then(function () { return reloadEverything(); })
                .then(function () { showToast('Joined "' + (res.team && res.team.name || 'team') + '" — switched to it', {}); });
            });
          },
        });
      });
    }

    function renderUserConfig(content) {
      content.innerHTML =
        '<div class="teams-page">' +
          '<h2>User Settings</h2>' +
          '<div id="identity-host"><div class="placeholder" style="padding:18px">Loading identity…</div></div>' +
          '<div id="assistant-host"></div>' +
          '<div id="preferences-host"></div>' +
        '</div>';
      renderIdentityPanel(document.getElementById('identity-host'));
      renderAssistantPanel(document.getElementById('assistant-host'));
      renderPreferencesPanel(document.getElementById('preferences-host'));
      // Databases catalog lives on Lattice Settings; per-database cloud/team
      // config lives on Database Settings. User Settings is identity +
      // preferences only — every config option in exactly one place.
    }

    function renderAssistantPanel(host) {
      fetchJson('/api/assistant/config').then(function (cfg) {
        cfg = cfg || {};
        function rowHtml(idBase, label, has, placeholder) {
          return '<div style="margin-bottom:12px">' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
              '<strong style="font-size:13px">' + label + '</strong>' +
              '<span class="feed-source" style="background:' + (has ? 'var(--accent-soft)' : 'var(--surface-2)') +
                ';color:' + (has ? 'var(--accent)' : 'var(--text-muted)') + '">' + (has ? 'Set' : 'Not set') + '</span>' +
            '</div>' +
            '<div style="display:flex;gap:8px;align-items:center">' +
              '<input id="' + idBase + '-key" type="password" autocomplete="off" placeholder="' +
                (has ? '••••••••••••' : placeholder) + '" style="flex:1;background:var(--surface-2)">' +
              '<button id="' + idBase + '-save" class="btn">Save</button>' +
              (has ? '<button id="' + idBase + '-clear" class="btn">Clear</button>' : '') +
            '</div>' +
          '</div>';
        }
        host.innerHTML =
          '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<h3 style="margin:0 0 10px">Assistant</h3>' +
            '<p class="lead" style="margin:0 0 12px;font-size:12px;color:var(--text-muted)">' +
              'Keys are stored encrypted in the <code>secrets</code> table — never shown again once ' +
              'saved. Environment variables (<code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code>, ' +
              '<code>ELEVENLABS_API_KEY</code>) also work.' +
            '</p>' +
            rowHtml('asst-anthropic', 'Claude API token (chat)', !!cfg.hasAnthropicKey, 'sk-ant-…') +
            '<div style="margin:0 0 12px;font-size:12px;color:var(--text-muted)">' +
              (cfg.oauthEnabled
                ? 'Or <a href="/api/assistant/oauth/start" style="color:var(--accent)">connect your Claude subscription</a>.'
                : 'Subscription login: set the <code>ANTHROPIC_OAUTH_*</code> env vars to enable.') +
            '</div>' +
            '<div style="font-size:11px;color:var(--text-muted);margin:10px 0 8px;text-transform:uppercase;letter-spacing:0.05em">Voice — speech to text (set either)</div>' +
            rowHtml('asst-openai', 'OpenAI Whisper key', !!cfg.hasOpenaiKey, 'sk-…') +
            rowHtml('asst-elevenlabs', 'ElevenLabs key', !!cfg.hasElevenlabsKey, 'xi-…') +
            '<div id="assistant-msg" style="margin-top:4px;font-size:12px;color:var(--text-muted)"></div>' +
          '</div>';
        var msg = host.querySelector('#assistant-msg');
        function wire(idBase, kind) {
          var input = host.querySelector('#' + idBase + '-key');
          var saveBtn = host.querySelector('#' + idBase + '-save');
          if (saveBtn) saveBtn.addEventListener('click', function () {
            var key = (input.value || '').trim();
            if (!key) { msg.textContent = 'Enter a key first.'; return; }
            msg.textContent = 'Saving…';
            fetch('/api/assistant/key', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ kind: kind, key: key }),
            })
              .then(function (r) { if (!r.ok) throw new Error('save failed (' + r.status + ')'); return r.json(); })
              .then(function () { renderAssistantPanel(host); renderComposer(); })
              .catch(function (e) { msg.textContent = 'Failed: ' + e.message; });
          });
          var clearBtn = host.querySelector('#' + idBase + '-clear');
          if (clearBtn) clearBtn.addEventListener('click', function () {
            msg.textContent = 'Clearing…';
            fetch('/api/assistant/key?kind=' + encodeURIComponent(kind), { method: 'DELETE' })
              .then(function (r) { if (!r.ok) throw new Error('clear failed (' + r.status + ')'); return r.json(); })
              .then(function () { renderAssistantPanel(host); renderComposer(); })
              .catch(function (e) { msg.textContent = 'Failed: ' + e.message; });
          });
        }
        wire('asst-anthropic', 'anthropic');
        wire('asst-openai', 'openai');
        wire('asst-elevenlabs', 'elevenlabs');
      }).catch(function (e) {
        host.innerHTML = '<div class="dbconfig-panel" style="padding:14px;border:1px solid var(--border);border-radius:8px">' +
          '<h3 style="margin:0 0 10px">Assistant</h3><div style="font-size:12px;color:var(--warn)">Could not load: ' +
          escapeHtml(e.message) + '</div></div>';
      });
    }

    function renderPreferencesPanel(host) {
      var prefs = state.preferences || { show_system_tables: false };
      host.innerHTML =
        '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
          '<h3 style="margin:0 0 10px">Preferences</h3>' +
          '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
            '<input type="checkbox" id="pref-show-system-tables"' +
              (prefs.show_system_tables ? ' checked' : '') + '>' +
            '<span>Show system tables in sidebar</span>' +
          '</label>' +
          '<p class="lead" style="margin:8px 0 0;font-size:12px;color:var(--text-muted)">' +
            'Internal tables prefixed <code>__lattice_</code> are hidden by default. ' +
            'Enable to inspect them under a "System" section in the sidebar.' +
          '</p>' +
          '<div id="pref-msg" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div>' +
        '</div>';
      var checkbox = host.querySelector('#pref-show-system-tables');
      var msg = host.querySelector('#pref-msg');
      checkbox.addEventListener('change', function () {
        var body = { show_system_tables: !!checkbox.checked };
        msg.textContent = 'Saving…';
        fetch('/api/userconfig/preferences', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (r) { return r.json(); })
          .then(function (next) {
            state.preferences = next;
            renderSidebar();
            msg.textContent = 'Saved.';
          })
          .catch(function (e) { msg.textContent = 'Failed: ' + e.message; });
      });
    }

    function renderIdentityPanel(host) {
      fetchJson('/api/userconfig/identity').then(function (id) {
        host.innerHTML =
          '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<h3 style="margin:0 0 10px">Identity</h3>' +
            '<p class="lead" style="margin:0 0 10px">Display name + email used when creating or joining teams. Saved to ~/.lattice/identity.json and mirrored into the active Lattice.</p>' +
            '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px">' +
              '<div><label class="field-label">Display name</label><input id="id-display-name" type="text" value="' + escapeHtml(id.display_name || '') + '" style="width:100%"></div>' +
              '<div><label class="field-label">Email</label><input id="id-email" type="email" value="' + escapeHtml(id.email || '') + '" style="width:100%"></div>' +
            '</div>' +
            '<div class="team-actions" style="margin-top:10px">' +
              '<button class="btn primary" data-act="id-save">Save</button>' +
            '</div>' +
            '<div id="id-msg" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div>' +
          '</div>';
        host.querySelector('[data-act="id-save"]').addEventListener('click', function () {
          var body = {
            display_name: document.getElementById('id-display-name').value || '',
            email: document.getElementById('id-email').value || '',
          };
          var msg = document.getElementById('id-msg');
          msg.textContent = 'Saving…';
          fetch('/api/userconfig/identity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json(); })
            .then(function () { msg.textContent = 'Saved.'; })
            .catch(function (e) { msg.textContent = 'Failed: ' + e.message; });
        });
      }).catch(function (err) {
        host.innerHTML = '<div class="placeholder">Failed to load identity: ' + escapeHtml(err.message) + '</div>';
      });
    }

    function renderDatabasesPanel(host) {
      fetchJson('/api/userconfig/databases').then(function (cat) {
        var localRows = (cat.local || []).map(function (d) {
          var stateBadge = '<span style="font-family:JetBrains Mono,monospace;font-size:10px;color:var(--text-muted)">' + escapeHtml((d.state || 'local').toUpperCase()) + '</span>';
          return '<tr>' +
            '<td>' + escapeHtml(d.label) + (d.active ? ' <span class="role-tag">active</span>' : '') + '</td>' +
            '<td>SQLite</td>' +
            '<td>' + stateBadge + '</td>' +
            '<td><code>' + escapeHtml(d.dbFile) + '</code></td>' +
            '<td>' + (d.active ? '—' : '<button class="btn" data-switch="' + escapeHtml(d.configPath) + '">Switch</button>') + '</td>' +
          '</tr>';
        }).join('');
        var cloudRows = (cat.cloud || []).map(function (d) {
          var stateBadge = '<span style="font-family:JetBrains Mono,monospace;font-size:10px;color:var(--text-muted)">' + escapeHtml((d.state || 'unknown').toUpperCase()) + '</span>';
          return '<tr><td>' + escapeHtml(d.label) + '</td><td>Postgres</td><td>' + stateBadge + '</td><td>(encrypted)</td><td>—</td></tr>';
        }).join('');
        host.innerHTML =
          '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
              '<h3 style="margin:0">Databases</h3>' +
              '<button class="btn primary" id="action-add-cloud-db">Add a cloud DB →</button>' +
            '</div>' +
            '<table style="width:100%;border-collapse:collapse">' +
              '<thead><tr style="text-align:left"><th>Label</th><th>Type</th><th>State</th><th>File / source</th><th>Action</th></tr></thead>' +
              '<tbody>' + (localRows + cloudRows || '<tr><td colspan="5" style="padding:8px;color:var(--text-muted)">No databases configured.</td></tr>') + '</tbody>' +
            '</table>' +
          '</div>';
        host.querySelectorAll('[data-switch]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var configPath = btn.getAttribute('data-switch');
            fetch('/api/databases/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: configPath }) })
              .then(function (r) { return r.json(); })
              .then(function () { renderUserConfig(document.getElementById('content')); });
          });
        });
        var addCloudBtn = document.getElementById('action-add-cloud-db');
        if (addCloudBtn) addCloudBtn.addEventListener('click', function () {
          // Create a fresh project then immediately open the Connect-
          // existing wizard against it. The backend's /api/databases/create
          // makes a starter YAML + swaps the active Lattice to it; the
          // wizard then rewrites that project's db: line.
          var name = prompt('Project name for the new cloud-connected project:');
          if (!name) return;
          fetch('/api/databases/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name }) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (d.error) { alert('Failed: ' + d.error); return; }
              // Active swapped to the new project — open Connect-existing.
              showConnectExistingModal(function () {
                renderUserConfig(document.getElementById('content'));
              });
            })
            .catch(function (e) { alert('Failed: ' + e.message); });
        });
      }).catch(function (err) {
        host.innerHTML = '<div class="placeholder">Failed to load databases: ' + escapeHtml(err.message) + '</div>';
      });
    }

    function renderProjectConfig(content) {
      // Legacy entry — Track 4e renames this view to "Database Settings"
      // and adds an editable name header. The new alias is renderDatabaseSettings.
      renderDatabaseSettings(content);
    }

    function renderDatabaseSettings(content) {
      // Frame the page; the name header + Database + Teams panels each
      // populate asynchronously so a slow cloud probe doesn't block.
      // Active database only — name + connection/team config for THIS DB.
      // The all-databases list lives on Lattice Settings; adding/joining
      // databases lives in the add-database flow. Team management (invite
      // token + member list) for the active team cloud renders inline in the
      // Database panel below.
      content.innerHTML =
        '<div class="teams-page">' +
          '<h2>Database Settings</h2>' +
          '<div id="db-name-host"><div class="placeholder" style="padding:14px">Loading database name…</div></div>' +
          '<div id="dbconfig-host"><div class="placeholder" style="padding:18px">Loading database configuration…</div></div>' +
          '<div id="data-model-host"><div class="placeholder" style="padding:18px">Loading data model…</div></div>' +
          '<div id="db-danger-host"></div>' +
        '</div>';
      renderDatabaseNamePanel(document.getElementById('db-name-host'));
      renderDatabasePanel(document.getElementById('dbconfig-host'));
      renderDataModelInto(document.getElementById('data-model-host'));
      renderDatabaseDangerZone(document.getElementById('db-danger-host'));
    }

    // Confirmation modal for the irreversible delete. Gated on typing the exact
    // database name; the OK button is solid red (destructive) and disabled until
    // the name matches. onDone(result) runs after a successful delete.
    function confirmDeleteDatabase(path, label, onDone) {
      var safeLabel = (label || '').trim() || 'this database';
      var body =
        '<p style="margin:0 0 10px">Permanently delete <strong>' + escapeHtml(safeLabel) + '</strong>? ' +
        'This removes its configuration and, for a local database, deletes the underlying SQLite file. ' +
        'For a cloud database only the local connection is forgotten — the remote data is left untouched. ' +
        '<strong style="color:var(--danger)">This cannot be undone.</strong></p>' +
        '<p style="margin:0 0 6px;font-size:12px;color:var(--text-muted)">Type <strong>' + escapeHtml(safeLabel) + '</strong> to confirm:</p>' +
        '<input id="confirm-db-name" type="text" autocomplete="off" style="width:100%" />';
      showModal('Delete database', body, {
        primaryLabel: 'Delete database',
        primaryClass: 'destructive',
        onBody: function (backdrop) {
          var input = backdrop.querySelector('#confirm-db-name');
          var ok = backdrop.querySelector('[data-act="ok"]');
          ok.disabled = true;
          input.addEventListener('input', function () {
            ok.disabled = (input.value || '').trim() !== safeLabel;
          });
          setTimeout(function () { input.focus(); }, 0);
        },
        onSubmit: function (backdrop) {
          var v = (backdrop.querySelector('#confirm-db-name').value || '').trim();
          if (v !== safeLabel) return Promise.reject(new Error('Type the database name exactly to confirm.'));
          return fetch('/api/databases/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: path }),
          })
            .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
            .then(function (res) {
              if (!res.d || res.d.error) throw new Error((res.d && res.d.error) || ('HTTP ' + res.status));
              if (onDone) return onDone(res.d);
            });
        },
      });
    }

    function renderDatabaseDangerZone(host) {
      if (!host) return;
      fetchJson('/api/databases').then(function (data) {
        var current = (data && data.current) || {};
        var label = current.label || current.dbFile || '';
        var path = current.path || '';
        if (!path) { host.innerHTML = ''; return; }
        host.innerHTML =
          '<div class="danger-zone">' +
            '<h3>Danger zone</h3>' +
            '<p style="font-size:12px;color:var(--text-muted);margin:0 0 10px">' +
              'Permanently delete this database. The configuration is removed and, for a local database, the underlying SQLite file is deleted. This cannot be undone.' +
            '</p>' +
            '<button class="btn destructive" id="db-delete-btn">Delete database</button>' +
          '</div>';
        host.querySelector('#db-delete-btn').addEventListener('click', function () {
          confirmDeleteDatabase(path, label, function () {
            // We just deleted the active DB; the server switched to a fallback.
            return reloadEverything().then(function () {
              renderDatabaseSettings(document.getElementById('content'));
            });
          });
        });
      }).catch(function () { host.innerHTML = ''; });
    }

    function renderDatabaseNamePanel(host) {
      // Pull the friendly name from /api/databases and the team role from
      // /api/dbconfig (isCreator) so a non-owner member sees the name
      // read-only — renaming a team cloud broadcasts to every member, so
      // only the owner may do it.
      Promise.all([fetchJson('/api/databases'), fetchJson('/api/dbconfig').catch(function () { return {}; })])
        .then(function (results) {
        var data = results[0];
        var cfg = results[1] || {};
        var current = (data && data.current) || {};
        var name = current.label || current.dbFile || '';
        var isCloud = current.kind === 'cloud';
        var kind = isCloud ? 'Cloud' : 'Local';
        // Members (cloud, non-creator) can't rename. Locals + creators can.
        var canRename = !isCloud || cfg.isCreator === true;
        host.innerHTML =
          '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<h3 style="margin:0 0 10px">Name</h3>' +
            '<div style="display:flex;align-items:center;gap:8px">' +
              '<input id="db-name-input" type="text" value="' + escapeHtml(name) + '" maxlength="200" style="flex:1"' + (canRename ? '' : ' disabled') + ' />' +
              '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:' +
                (isCloud ? 'var(--accent-soft)' : 'rgba(255,255,255,0.06)') +
                ';color:' + (isCloud ? 'var(--accent)' : 'var(--text-muted)') +
                ';text-transform:uppercase;letter-spacing:0.04em">' + kind + '</span>' +
              (canRename ? '<button class="btn primary" id="db-name-save">Save</button>' : '') +
            '</div>' +
            '<p style="font-size:11px;color:var(--text-muted);margin:6px 0 0">' +
              (canRename
                ? ('Friendly database name shown in the topbar and the dropdown. ' +
                  (isCloud
                    ? 'For cloud databases, the rename is broadcast to every team member in realtime.'
                    : 'Saved to the YAML config\\'s name: key.'))
                : 'Only the team owner can rename this cloud database.') +
            '</p>' +
            '<div id="db-name-msg" style="margin-top:6px;font-size:12px;color:var(--text-muted)"></div>' +
          '</div>';
        var saveBtn = host.querySelector('#db-name-save');
        if (saveBtn) saveBtn.addEventListener('click', function () {
          var v = (host.querySelector('#db-name-input').value || '').trim();
          var msg = host.querySelector('#db-name-msg');
          if (!v) { msg.textContent = 'Name cannot be empty.'; return; }
          withBusy(saveBtn, function () {
            msg.textContent = 'Saving…';
            return fetch('/api/dbconfig/rename', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: v }),
            })
              .then(function (r) { return r.json(); })
              .then(function (d) {
                if (d.error) { msg.textContent = 'Failed: ' + d.error; return; }
                msg.textContent = 'Saved.';
                // Refresh the topbar dropdown so the new name shows.
                return fetchJson('/api/databases').then(renderDbSwitcher);
              })
              .catch(function (e) { msg.textContent = 'Failed: ' + e.message; });
          });
        });
      }).catch(function (err) {
        host.innerHTML = '<div class="placeholder">Failed to load database name: ' + escapeHtml(err.message) + '</div>';
      });
    }

    function renderLatticeSettings(content) {
      content.innerHTML =
        '<div class="teams-page">' +
          '<h2>Lattice Settings</h2>' +
          '<p class="lead">Every database this lattice can switch to. This is the same list as the header dropdown.</p>' +
          '<div id="lattice-dbs-host"><div class="placeholder" style="padding:18px">Loading databases…</div></div>' +
        '</div>';
      var host = document.getElementById('lattice-dbs-host');
      // Source the SAME list the header dropdown uses (/api/databases) so the
      // two are always 1:1, listed by readable label rather than the raw file.
      fetchJson('/api/databases').then(function (data) {
        var current = data.current || {};
        var rows = (data.configs || []).map(function (c) {
          var kind = c.active
            ? (current.kind === 'cloud' ? 'Cloud (Postgres)' : 'Local (SQLite)')
            : '—';
          var rowLabel = c.label || c.name;
          var del = '<button class="btn danger" data-delete-path="' + escapeHtml(c.path) + '" data-delete-label="' + escapeHtml(rowLabel) + '">Delete</button>';
          var actions = (c.active ? '' : '<button class="btn" data-switch="' + escapeHtml(c.path) + '">Switch</button> ') + del;
          return '<tr>' +
            '<td>' + escapeHtml(rowLabel) + (c.active ? ' <span class="role-tag">active</span>' : '') + '</td>' +
            '<td>' + kind + '</td>' +
            '<td><code>' + escapeHtml(c.dbFile || '') + '</code></td>' +
            '<td>' + actions + '</td>' +
          '</tr>';
        }).join('');
        host.innerHTML =
          '<div class="dbconfig-panel" style="padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
              '<h3 style="margin:0">Databases</h3>' +
              '<button class="btn primary" id="action-add-db">+ Add new database</button>' +
            '</div>' +
            '<table style="width:100%;border-collapse:collapse">' +
              '<thead><tr style="text-align:left"><th>Name</th><th>Kind</th><th>File / source</th><th>Action</th></tr></thead>' +
              '<tbody>' + (rows || '<tr><td colspan="4" style="padding:8px;color:var(--text-muted)">No databases configured.</td></tr>') + '</tbody>' +
            '</table>' +
          '</div>';
        host.querySelectorAll('[data-switch]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var configPath = btn.getAttribute('data-switch');
            fetch('/api/databases/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: configPath }) })
              .then(function (r) { return r.json(); })
              .then(function () { return reloadEverything(); })
              .then(function () { renderLatticeSettings(document.getElementById('content')); });
          });
        });
        host.querySelectorAll('[data-delete-path]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            confirmDeleteDatabase(
              btn.getAttribute('data-delete-path'),
              btn.getAttribute('data-delete-label'),
              function () {
                // Deleting any row may have switched the active DB (if it was
                // the active one); refetch everything, then re-render the list.
                return reloadEverything().then(function () {
                  renderLatticeSettings(document.getElementById('content'));
                });
              },
            );
          });
        });
        host.querySelector('#action-add-db').addEventListener('click', showCreateDatabaseWizard);
      }).catch(function (err) {
        host.innerHTML = '<div class="placeholder">Failed to load databases: ' + escapeHtml(err.message) + '</div>';
      });
    }

    // State-machine Database panel (v1.13+). Renders a different body
    // per info.state: local -> Migrate / Connect-existing wizards;
    // cloud-connected -> Upgrade-to-team; team-cloud-creator/member ->
    // team management UI; team-cloud-needs-invite -> join form.
    // Progression is one-way: local -> cloud -> team-cloud.
    function renderDatabasePanel(host) {
      fetchJson('/api/dbconfig').then(function (info) {
        var badge = renderStateBadge(info);
        var body = renderStateBody(info);
        host.innerHTML =
          '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">' +
              '<h3 style="margin:0">Database</h3>' +
              badge +
            '</div>' +
            body +
            '<div id="db-msg" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div>' +
          '</div>';
        wireStateActions(host, info);
      }).catch(function (err) {
        host.innerHTML = '<div class="placeholder">Failed to load database config: ' + escapeHtml(err.message) + '</div>';
      });
    }

    function renderStateBadge(info) {
      var label = '';
      var color = 'var(--text-muted)';
      switch (info.state) {
        case 'local':
          label = 'LOCAL';
          color = 'var(--text-muted)';
          break;
        case 'cloud-connected':
          label = 'CLOUD · CONNECTED';
          color = 'var(--accent)';
          break;
        case 'team-cloud-creator':
          label = '👑 TEAM CLOUD · CREATOR';
          color = 'var(--accent)';
          break;
        case 'team-cloud-member':
          label = 'TEAM CLOUD · MEMBER';
          color = 'var(--accent)';
          break;
        case 'team-cloud-needs-invite':
          label = 'TEAM CLOUD · NEEDS INVITE';
          color = 'var(--warn)';
          break;
        default:
          label = String(info.state || 'UNKNOWN').toUpperCase();
      }
      return '<span style="font-family:JetBrains Mono,monospace;font-size:11px;letter-spacing:0.04em;padding:4px 10px;border-radius:999px;border:1px solid ' + color + ';color:' + color + '">' + escapeHtml(label) + '</span>';
    }

    function renderStateBody(info) {
      if (info.state === 'local') {
        return (
          '<p style="margin:0 0 12px;color:var(--text-muted);font-size:13px">' +
            'SQLite DB: <code>' + escapeHtml(info.dbFile || '(unknown)') + '</code>. ' +
            'Move forward by either pushing this data to a new cloud Postgres or connecting to an existing one.' +
          '</p>' +
          '<div class="team-actions">' +
            '<button class="btn primary" data-act="open-migrate">Migrate to cloud →</button>' +
            '<button class="btn" data-act="open-connect-existing">Connect to existing cloud →</button>' +
          '</div>'
        );
      }
      if (info.state === 'cloud-connected') {
        return (
          renderConnectionSummary(info) +
          '<div class="team-actions" style="margin-top:10px">' +
            '<button class="btn primary" data-act="open-upgrade">Upgrade to team cloud →</button>' +
          '</div>'
        );
      }
      if (info.state === 'team-cloud-creator' || info.state === 'team-cloud-member') {
        var isCreator = info.state === 'team-cloud-creator';
        return (
          renderConnectionSummary(info) +
          '<div style="margin-top:10px;font-size:13px">' +
            '<strong>Team:</strong> ' + escapeHtml(info.teamName || '(unnamed)') +
            (isCreator ? ' · <span style="color:var(--accent)">you are the creator</span>' : ' · <span style="color:var(--text-muted)">member</span>') +
          '</div>' +
          '<div class="team-actions" style="margin-top:10px">' +
            (isCreator ? '<button class="btn primary" data-act="open-invite">Generate invite token</button>' : '') +
          '</div>' +
          // Leave (member) / Destroy (creator) now live on your own row in
          // the members list below — no separate top-level button.
          '<div id="db-members-host" style="margin-top:12px"><div style="font-size:12px;color:var(--text-muted)">Loading members…</div></div>'
        );
      }
      if (info.state === 'team-cloud-needs-invite') {
        return (
          renderConnectionSummary(info) +
          '<p style="margin-top:10px;color:var(--warn);font-size:13px">' +
            'This cloud DB is a team — paste your invite token to join.' +
          '</p>' +
          '<div style="display:grid;grid-template-columns:1fr;gap:8px;margin-top:6px">' +
            '<div><label class="field-label">Invite token</label>' +
            '<textarea id="db-rejoin-token" placeholder="latinv_..." style="width:100%;height:54px;font-family:JetBrains Mono,monospace"></textarea></div>' +
          '</div>' +
          '<div class="team-actions" style="margin-top:10px">' +
            '<button class="btn primary" data-act="rejoin-with-token">Join team →</button>' +
          '</div>'
        );
      }
      return '<p style="color:var(--text-muted)">Unknown database state.</p>';
    }

    function renderConnectionSummary(info) {
      var parts = [];
      if (info.label) parts.push('<strong>Label:</strong> <code>' + escapeHtml(info.label) + '</code>');
      if (info.host) parts.push('<strong>Host:</strong> ' + escapeHtml(info.host) + ':' + (info.port || 5432));
      if (info.dbname) parts.push('<strong>DB:</strong> ' + escapeHtml(info.dbname));
      if (info.user) parts.push('<strong>User:</strong> ' + escapeHtml(info.user));
      return '<p style="margin:0;color:var(--text-muted);font-size:13px;line-height:1.7">' + parts.join(' · ') + '</p>';
    }

    function wireStateActions(host, info) {
      var setMsg = function (text, ok) {
        var el = document.getElementById('db-msg');
        if (!el) return;
        el.textContent = text;
        el.style.color = ok ? 'var(--accent)' : 'var(--text-muted)';
      };
      var rerender = function () { renderDatabasePanel(document.getElementById('dbconfig-host')); };

      var migrateBtn = host.querySelector('[data-act="open-migrate"]');
      if (migrateBtn) migrateBtn.addEventListener('click', function () {
        showMigrateToCloudModal(rerender);
      });

      var connectExBtn = host.querySelector('[data-act="open-connect-existing"]');
      if (connectExBtn) connectExBtn.addEventListener('click', function () {
        showConnectExistingModal(rerender);
      });

      var upgradeBtn = host.querySelector('[data-act="open-upgrade"]');
      if (upgradeBtn) upgradeBtn.addEventListener('click', function () {
        showUpgradeToTeamModal(rerender);
      });

      // team_id / my_user_id / isCreator come from /api/dbconfig (info),
      // resolved against the ACTIVE cloud DB — not a local connection row
      // (which doesn't exist when the team cloud itself is active). This
      // is what fixes "No local team connection found" for members + the
      // creator's own invite flow.
      var teamId = info.teamId;
      var myUserId = info.myUserId;
      var isCreator = !!info.isCreator;

      // After leaving/destroying, the left DB is torn down on the backend
      // (config + credential removed). Switch to another database the
      // operator still has and navigate off the (now-gone) DB page.
      var switchAway = function () {
        return fetchJson('/api/databases').then(function (data) {
          var current = (data && data.current && data.current.path) || null;
          var configs = (data && data.configs) || [];
          var target = configs.filter(function (c) { return c.path !== current; })[0];
          if (!target) return reloadEverything();
          return fetchJson('/api/databases/switch', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: target.path }),
          }).then(function () { return reloadEverything(); });
        }).then(function () { location.hash = '#/'; renderRoute(); });
      };

      var inviteBtn = host.querySelector('[data-act="open-invite"]');
      if (inviteBtn) inviteBtn.addEventListener('click', function () {
        if (!teamId) { alert('No team is active.'); return; }
        showInviteByEmailModal(teamId);
      });

      // Inline member list for the active team cloud. Marks "you"; your
      // own row carries Leave (member) / Destroy team (creator); other
      // rows carry Kick, shown only to the creator.
      var membersHost = host.querySelector('#db-members-host');
      if (membersHost && teamId && (info.state === 'team-cloud-creator' || info.state === 'team-cloud-member')) {
        fetchJson('/api/teams-gui/teams/' + teamId + '/members').then(function (res) {
          var members = res.members || [];
          membersHost.innerHTML = renderMembersList(members, myUserId, isCreator);
          // Kick another member (creator only).
          membersHost.querySelectorAll('[data-act="kick"]').forEach(function (btn) {
            var row = btn.closest('[data-user-id]');
            var userId = row && row.getAttribute('data-user-id');
            btn.addEventListener('click', function () {
              if (!confirm('Remove this member from the team?')) return;
              withBusy(btn, function () {
                return fetchJson('/api/teams-gui/teams/' + teamId + '/members/' + encodeURIComponent(userId), { method: 'DELETE' })
                  .then(function () { rerender(); })
                  .catch(function (e) { setMsg('Kick failed: ' + e.message, false); });
              });
            });
          });
          // Leave (member) / Destroy team (creator) — your own row.
          var selfBtn = membersHost.querySelector('[data-act="leave-self"]');
          if (selfBtn) selfBtn.addEventListener('click', function () {
            
            if (isCreator) {
              if (!confirm('Destroy team "' + (info.teamName || 'this team') + '"? This soft-deletes it on the cloud for everyone.')) return;
              withBusy(selfBtn, function () {
                return fetchJson('/api/teams-gui/teams/' + teamId, { method: 'DELETE' })
                  .then(function () { showToast('Team destroyed', {}); return switchAway(); })
                  .catch(function (e) { setMsg('Destroy failed: ' + e.message, false); });
              });
            } else {
              if (!confirm('Leave team "' + (info.teamName || 'this team') + '"?')) return;
              withBusy(selfBtn, function () {
                return fetchJson('/api/teams-gui/teams/' + teamId + '/members/' + encodeURIComponent(myUserId), { method: 'DELETE' })
                  .then(function () { showToast('Left the team', {}); return switchAway(); })
                  .catch(function (e) { setMsg('Leave failed: ' + e.message, false); });
              });
            }
          });
        }).catch(function () { membersHost.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">Members unavailable.</div>'; });
      }

      var rejoinBtn = host.querySelector('[data-act="rejoin-with-token"]');
      if (rejoinBtn) rejoinBtn.addEventListener('click', function () {
        var token = (document.getElementById('db-rejoin-token').value || '').trim();
        if (!token) { setMsg('Invite token required.', false); return; }
        // Without form re-entry the credentials are already saved; we
        // call the connect-existing endpoint with just the invite
        // token. The handler reads credentials from db-credentials.enc
        // via the active configPath's label.
        setMsg('Joining team…');
        fetch('/api/dbconfig/connect-existing', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'postgres',
            label: info.label,
            host: info.host, port: info.port, dbname: info.dbname,
            user: info.user, password: '', // password lives in db-credentials.enc; backend will pull
            invite_token: token,
          }),
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d.error) { setMsg('Failed: ' + d.error, false); return; }
            setMsg('Joined.', true); rerender();
          })
          .catch(function (e) { setMsg('Failed: ' + e.message, false); });
      });
    }

    // ── v1.13 wizards ─────────────────────────────────────────────

    function postgresFormHtml(prefill) {
      prefill = prefill || {};
      // autocapitalize="off" + autocorrect="off" + spellcheck="false" keep
      // mobile / macOS keyboards from "helpfully" capitalizing the first
      // letter of usernames + host fragments. Supabase tenant users
      // (postgres.<ref>) are case-sensitive and silently failed
      // authentication when iOS Safari turned the leading "p" into "P".
      var attrs = ' autocapitalize="off" autocorrect="off" spellcheck="false"';
      return (
        '<div class="grid" style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px">' +
          '<div><label class="field-label">Label</label><input type="text" id="w-label" placeholder="atlas" value="' + escapeHtml(prefill.label || '') + '" style="width:100%"' + attrs + '></div>' +
          '<div><label class="field-label">Host</label><input type="text" id="w-host" placeholder="db.example.com" value="' + escapeHtml(prefill.host || '') + '" style="width:100%"' + attrs + '></div>' +
          '<div><label class="field-label">Port</label><input type="number" id="w-port" placeholder="5432" value="' + escapeHtml(String(prefill.port || 5432)) + '" style="width:100%"></div>' +
          '<div><label class="field-label">Database name</label><input type="text" id="w-dbname" placeholder="app" value="' + escapeHtml(prefill.dbname || '') + '" style="width:100%"' + attrs + '></div>' +
          '<div><label class="field-label">User</label><input type="text" id="w-user" placeholder="lattice_user" value="' + escapeHtml(prefill.user || '') + '" style="width:100%"' + attrs + '></div>' +
          '<div><label class="field-label">Password</label><input type="password" id="w-password" placeholder="••••••••" style="width:100%"' + attrs + '></div>' +
        '</div>'
      );
    }

    function readPostgresWizardForm() {
      // Every text field is trimmed — pasted credentials frequently carry a
      // trailing newline or leading space that breaks URL construction
      // (zero-length identifier errors from the Postgres parser) or SCRAM
      // auth (silent password mismatch). Trim once, here, so every caller
      // benefits.
      var get = function (id) { return (document.getElementById(id).value || '').trim(); };
      return {
        type: 'postgres',
        label: get('w-label'),
        host: get('w-host'),
        port: Number(document.getElementById('w-port').value || 5432),
        dbname: get('w-dbname'),
        user: get('w-user'),
        password: get('w-password'),
      };
    }

    // Detect common Supabase pooler URL mistakes the form gives no hint
    // about. Returns an array of human-readable hints, or [] when the
    // form looks plausible. Conservative — only flags clear patterns.
    function detectSupabasePoolerMistakes(body) {
      var hints = [];
      var host = (body.host || '').toLowerCase();
      if (host.indexOf('pooler.supabase') !== -1) {
        // Pooler requires the tenant-prefixed user form postgres.<ref>.
        if (body.user && body.user.indexOf('.') === -1) {
          hints.push(
            'Supabase pooler hosts require a tenant-prefixed user like ' +
            '<code>postgres.&lt;project-ref&gt;</code>. You entered <code>' +
            escapeHtml(body.user) + '</code> — Supabase will reject SCRAM ' +
            'auth with a misleading "password authentication failed" error.'
          );
        }
        // Session-mode is on 5432; transaction-mode on 6543. latticesql
        // wants session-mode (transactions span multiple statements).
        if (Number(body.port) === 6543) {
          hints.push(
            'Supabase pooler port <code>6543</code> is transaction mode. ' +
            'Lattice needs session mode — use port <code>5432</code> on ' +
            'the same pooler host.'
          );
        }
      } else if (host.indexOf('.supabase.co') !== -1 && host.indexOf('pooler') === -1) {
        // Direct host form uses bare postgres user, not the tenant-
        // prefixed pooler form. Easy to mix up.
        if (body.user && body.user.indexOf('.') !== -1) {
          hints.push(
            'The direct host <code>db.&lt;project-ref&gt;.supabase.co</code> ' +
            'uses a bare <code>postgres</code> user (no tenant prefix). ' +
            'You entered <code>' + escapeHtml(body.user) + '</code> — ' +
            'Supabase will reject SCRAM auth with "password authentication ' +
            'failed".'
          );
        }
      }
      return hints;
    }

    // Probe the cloud and validate Supabase form patterns. Resolves to
    // the probe result on success; rejects with a human-readable error
    // when the form has obvious mistakes or the probe is unreachable.
    // Shared by Migrate + Connect so the credential is never saved
    // without first proving the form values can actually connect.
    function probeBeforeCredentialSave(body, msgEl) {
      var hints = detectSupabasePoolerMistakes(body);
      if (hints.length > 0) {
        // Block submit until the form is fixed. Show the hints inline.
        msgEl.innerHTML =
          '<strong style="color:var(--warn)">Connection looks wrong:</strong>' +
          '<ul style="margin:6px 0 0 18px;padding:0;color:var(--warn)">' +
          hints.map(function (h) { return '<li>' + h + '</li>'; }).join('') +
          '</ul>';
        return Promise.reject(new Error('Fix the issues above and try again.'));
      }
      msgEl.textContent = 'Testing connection…';
      return fetch('/api/dbconfig/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (r) { return r.json(); })
        .then(function (probe) {
          if (!probe.reachable) {
            throw new Error(
              'Cloud unreachable: ' + (probe.error || 'unknown error') +
              '. Double-check host, port, user, and password.'
            );
          }
          return probe;
        });
    }

    function showMigrateToCloudModal(onClose) {
      // List every non-system user-defined table so the operator can
      // opt-OUT of sharing per-table before migrating. Default: every
      // user table is checked. System tables (__lattice_*, _lattice_*)
      // are filtered out — they're always migrated and never "shared"
      // in the team sense.
      var shareableTables = ((state.entities && state.entities.tables) || [])
        .filter(function (t) { return !/^_/.test(t.name) && !isJunction(t); })
        .map(function (t) { return t.name; });
      var shareRows = shareableTables.length === 0
        ? '<p style="margin:0;color:var(--text-muted);font-size:12px">No user-defined tables to share yet.</p>'
        : shareableTables.map(function (t) {
            return '<label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-weight:400;text-transform:none;letter-spacing:0">' +
              '<input type="checkbox" class="mig-share" data-table="' + escapeHtml(t) + '" checked />' +
              '<span style="font-family:ui-monospace,monospace;font-size:12.5px">' + escapeHtml(t) + '</span>' +
            '</label>';
          }).join('');
      var bodyHtml =
        '<p style="margin:0 0 12px;font-size:13px;color:var(--text-muted)">' +
          'Enter credentials for a <strong>fresh, empty</strong> Postgres database. ' +
          'Lattice will copy every row from your local SQLite into the new DB, then ' +
          'rename the SQLite file to <code>.db.local-bak</code> and switch the project ' +
          'to read from the cloud. This action cannot be undone.' +
        '</p>' +
        postgresFormHtml({}) +
        '<div style="margin-top:14px;padding:10px;border:1px solid var(--border);border-radius:6px;background:rgba(255,255,255,0.02)">' +
          '<div style="font-size:12px;color:var(--text);text-transform:uppercase;letter-spacing:0.04em;font-weight:500;margin-bottom:6px">Share with cloud</div>' +
          '<p style="margin:0 0 8px;font-size:12px;color:var(--text-muted)">' +
            'Checked tables become visible to every team member you invite. Uncheck any you want to keep ' +
            'cloud-stored but unshared. You can change this later from Data Model.' +
          '</p>' +
          shareRows +
        '</div>' +
        '<div id="w-msg" style="margin-top:10px;font-size:12px;color:var(--text-muted)"></div>';
      showModal('Migrate to cloud', bodyHtml, {
        primaryLabel: 'Migrate →',
        onSubmit: function (scope) {
          var body = readPostgresWizardForm();
          var msg = document.getElementById('w-msg');
          // Snapshot which tables the user wants shared before the
          // migrate runs — we share them after the migrate completes.
          var tablesToShare = [];
          scope.querySelectorAll('input.mig-share').forEach(function (cb) {
            if (cb.checked) tablesToShare.push(cb.getAttribute('data-table'));
          });
          // Validate Supabase URL pattern + probe the cloud before
          // persisting a credential that would just blow up on the next
          // open.
          return probeBeforeCredentialSave(body, msg).then(function (probe) {
            if (probe.teamEnabled) {
              throw new Error(
                'Target is already a cloud DB with a team' +
                (probe.teamName ? ' (' + probe.teamName + ')' : '') +
                '. Migrate-to-cloud only works against fresh empty targets.'
              );
            }
            msg.textContent = 'Migrating… (this may take a moment for large DBs)';
            return fetch('/api/dbconfig/migrate-to-cloud', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
            })
              .then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
              .then(function (r) {
                if (!r.body.ok) throw new Error(r.body.error || ('HTTP ' + r.status));
                // After the migrate, the active DB has been swapped to
                // the cloud. Share the checked tables — best-effort; a
                // share failure surfaces a toast but doesn't undo the
                // migration. The user can retry from Data Model later.
                if (tablesToShare.length === 0) {
                  if (onClose) onClose();
                  return;
                }
                return shareTablesPostMigrate(tablesToShare).finally(function () {
                  if (onClose) onClose();
                });
              });
          });
        },
      });
    }

    function shareTablesPostMigrate(tables) {
      // After migrate-to-cloud the user has a single team. Look it up
      // and share each requested table. Best-effort: errors surface as
      // toasts, the migrated DB is still good.
      return fetchJson('/api/teams-gui/connections').then(function (data) {
        var conns = (data && data.connections) || [];
        var teamId = conns[0] && conns[0].team_id;
        if (!teamId) return;
        return tables.reduce(function (chain, table) {
          return chain.then(function () {
            return fetchJson('/api/teams-gui/teams/' + encodeURIComponent(teamId) + '/shared', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ table: table }),
            }).catch(function (err) {
              showToast('Share "' + table + '" failed: ' + err.message, {});
            });
          });
        }, Promise.resolve());
      });
    }

    function showConnectExistingModal(onClose) {
      var bodyHtml =
        '<p style="margin:0 0 12px;font-size:13px;color:var(--text-muted)">' +
          'Switch this project to an <strong>existing</strong> cloud Postgres. ' +
          'Your local SQLite file is preserved — only this project\\'s active ' +
          'connection changes. Switch back any time by editing ' +
          '<code>lattice.config.yml</code>\\'s <code>db:</code> line or via the ' +
          'Databases catalog under User Config. If you want to <em>push</em> ' +
          'your local rows into the target instead, use Migrate to cloud. If ' +
          'the target is a teams DB you\\'ll be asked for an invite token ' +
          'after the probe.' +
        '</p>' +
        postgresFormHtml({}) +
        '<div id="w-team-zone" style="margin-top:10px"></div>' +
        '<div id="w-msg" style="margin-top:10px;font-size:12px;color:var(--text-muted)"></div>';
      var teamZoneShown = false;
      showModal('Connect to existing cloud', bodyHtml, {
        primaryLabel: 'Connect →',
        onSubmit: function () {
          var body = readPostgresWizardForm();
          var msg = document.getElementById('w-msg');
          // probeBeforeCredentialSave validates Supabase form patterns
          // before sending the probe; surfaces inline warnings (with
          // hints) when the user clearly has e.g. the wrong port or
          // missing tenant prefix in the pooler user.
          return probeBeforeCredentialSave(body, msg)
            .then(function (probe) {
              if (probe.teamEnabled && !teamZoneShown) {
                var zone = document.getElementById('w-team-zone');
                zone.innerHTML =
                  '<div style="padding:10px;background:rgba(251,146,60,0.08);border:1px solid var(--warn);border-radius:6px">' +
                    '<p style="margin:0 0 8px;font-size:13px;color:var(--warn)">Target is a teams DB' +
                    (probe.teamName ? ' (<strong>' + escapeHtml(probe.teamName) + '</strong>)' : '') +
                    '. Paste your invite token to join:</p>' +
                    '<textarea id="w-invite-token" placeholder="latinv_..." style="width:100%;height:54px;font-family:JetBrains Mono,monospace"></textarea>' +
                  '</div>';
                teamZoneShown = true;
                msg.textContent = 'Enter invite token, then click Connect again.';
                throw new Error('__PROBE_REQUIRES_TOKEN__');
              }
              // Either non-team, or we already showed the token zone.
              var tokenEl = document.getElementById('w-invite-token');
              var payload = Object.assign({}, body);
              if (tokenEl && tokenEl.value.trim()) payload.invite_token = tokenEl.value.trim();
              msg.textContent = 'Connecting…';
              return fetch('/api/dbconfig/connect-existing', {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
              })
                .then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
                .then(function (r) {
                  if (!r.body.ok) throw new Error(r.body.error || ('HTTP ' + r.status));
                  if (onClose) onClose();
                });
            })
            .catch(function (e) {
              if (e.message === '__PROBE_REQUIRES_TOKEN__') {
                // Suppress error — token zone is now visible.
                throw new Error(' '); // forces modal to stay open with a no-op message
              }
              throw e;
            });
        },
      });
    }

    function showUpgradeToTeamModal(onClose) {
      var bodyHtml =
        '<p style="margin:0 0 12px;font-size:13px;color:var(--text-muted)">' +
          'Upgrade this cloud DB to a team DB by registering as the founding member. ' +
          'Your display name + email from <strong>User Config → Identity</strong> are used.' +
        '</p>' +
        '<div><label class="field-label">Team name</label>' +
          '<input type="text" id="w-team-name" placeholder="Atlas" style="width:100%"></div>' +
        '<div id="w-msg" style="margin-top:10px;font-size:12px;color:var(--text-muted)"></div>';
      showModal('Upgrade to team cloud', bodyHtml, {
        primaryLabel: 'Upgrade →',
        onSubmit: function () {
          var teamName = (document.getElementById('w-team-name').value || '').trim();
          if (!teamName) throw new Error('Team name is required.');
          var msg = document.getElementById('w-msg');
          msg.textContent = 'Upgrading…';
          return fetch('/api/dbconfig/upgrade-to-team', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ team_name: teamName }),
          })
            .then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
            .then(function (r) {
              if (!r.body.ok) throw new Error(r.body.error || ('HTTP ' + r.status));
              if (onClose) onClose();
            });
        },
      });
    }

    function renderMembersList(members, myUserId, isCreator) {
      var rows = members.map(function (m) {
        var label = m.name || m.email || '(unknown)';
        var isSelf = m.user_id === myUserId;
        // Your own row: Leave (member) or Destroy team (creator). Other
        // rows: Kick, but only the creator may remove other members.
        var btn = '';
        if (isSelf) {
          btn = '<button class="btn danger-btn" data-act="leave-self">' +
            (isCreator ? 'Destroy team' : 'Leave') + '</button>';
        } else if (isCreator) {
          btn = '<button class="btn danger-btn" data-act="kick">Kick</button>';
        }
        return '<div class="member-row" data-user-id="' + escapeHtml(m.user_id) + '">' +
          '<span>' + escapeHtml(label) +
            (isSelf ? ' <span style="color:var(--accent);font-size:11px">(you)</span>' : '') +
            ' <span style="color:var(--text-muted);font-size:11px">' + escapeHtml(m.email || '') + '</span>' +
            ' <span class="role-tag' + (m.role === 'creator' ? '' : ' role-member') + '">' + m.role + '</span>' +
          '</span>' +
          btn +
        '</div>';
      }).join('');
      return '<div class="members-list"><h4>Members</h4>' + rows + '</div>';
    }

    function showInviteByEmailModal(teamId) {
      var bodyHtml =
        '<div class="field"><label>Invitee email</label>' +
        '<input name="invitee_email" type="email" placeholder="bob@example.com" /></div>' +
        '<p style="font-size:12px;color:var(--text-muted);margin:0">' +
        'Invitations are bound to this email — only the recipient can redeem.' +
        '</p>';
      showModal('Invite member', bodyHtml, {
        primaryLabel: 'Generate invite',
        onSubmit: function (scope) {
          var data = collectFormValues(scope);
          if (!data.invitee_email) throw new Error('invitee_email is required');
          return fetchJson('/api/teams-gui/teams/' + teamId + '/invitations', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ invitee_email: data.invitee_email }),
          }).then(function (inv) { showInviteTokenModal(inv); });
        },
      });
    }

    function showInviteTokenModal(inv) {
      var bodyHtml =
        '<p style="margin-top:0">Share this token with the invitee (one-time use). It expires at <code>' +
        escapeHtml(inv.expires_at || '(no expiry)') + '</code>.</p>' +
        '<div class="copy-token" id="copy-token">' + escapeHtml(inv.raw_token) + '</div>' +
        '<p style="font-size:12px;color:var(--text-muted);margin-bottom:0">Click the token to copy.</p>';
      var handle = showModal('Invitation token', bodyHtml, { primaryLabel: 'Done', onSubmit: function () {} });
      var tokenEl = document.getElementById('copy-token');
      if (tokenEl) {
        tokenEl.addEventListener('click', function () {
          navigator.clipboard.writeText(inv.raw_token).then(function () {
            tokenEl.textContent = 'Copied!';
            setTimeout(function () { tokenEl.textContent = inv.raw_token; }, 1200);
          });
        });
      }
      // Suppress unused-var on handle
      void handle;
    }

    init();
  })();
  </script>
</body>
</html>`;
