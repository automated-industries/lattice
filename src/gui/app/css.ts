// Extracted verbatim from app.ts — the GUI stylesheet (static template, no interpolation).
export const css = `
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

      /* Elevation — layered, dark-tuned (the flat --shadow becomes an alias) */
      --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4);
      --shadow-2: 0 2px 8px -2px rgba(0, 0, 0, 0.5);
      --shadow-3: 0 10px 30px -8px rgba(0, 0, 0, 0.55);
      --shadow-4: 0 24px 60px -16px rgba(0, 0, 0, 0.65), 0 2px 8px rgba(0, 0, 0, 0.4);
      --shadow: var(--shadow-1);            /* back-compat alias for existing uses */
      --hl-top: inset 0 1px 0 rgba(255, 255, 255, 0.06); /* top highlight for elevated/glass surfaces */

      /* Glass (frosted chrome) */
      --glass: rgba(19, 23, 27, 0.72);
      --glass-strong: rgba(19, 23, 27, 0.85);
      --blur: saturate(140%) blur(14px);
      --blur-lg: saturate(140%) blur(20px);

      /* Single-hue sheen + lime glow */
      --sheen: linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0) 64px);
      --glow-accent: 0 0 0 1px rgba(190, 242, 100, 0.35), 0 0 18px -2px rgba(190, 242, 100, 0.45);
      --glow-accent-soft: 0 0 14px -4px rgba(190, 242, 100, 0.35);
      --glow-focus: 0 0 0 2px #0b0d10, 0 0 0 4px rgba(190, 242, 100, 0.55);

      --nav-width: 220px;
      --sidebar-width: 320px;
    }
    /* Keep frosted surfaces opaque where backdrop-filter is unsupported */
    @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
      header.topbar, .assistant-rail, .modal, .settings-drawer,
      .db-menu, .search-results, .emoji-grid { background: var(--surface); }
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

    /* Lime focus ring for keyboard nav (mouse focus unaffected) */
    :where(button, a, [tabindex]):focus-visible {
      outline: none; box-shadow: var(--glow-focus); border-radius: 6px;
    }
    input:focus-visible, select:focus-visible, textarea:focus-visible {
      outline: none; border-color: var(--accent-deep); box-shadow: 0 0 0 3px var(--accent-soft);
    }

    /* ── Top bar ───────────────────────────────────────── */
    header.topbar {
      display: flex; align-items: center; gap: 12px;
      min-height: 56px; padding: 8px 20px;
      background: var(--glass);
      -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      box-shadow: var(--shadow-1), var(--hl-top);
      color: var(--text);
      flex-wrap: wrap;
    }
    .brand {
      display: inline-flex; align-items: center;
      flex-shrink: 0; border-radius: 6px;
      padding: 2px; cursor: pointer;
    }
    .brand:hover { background: rgba(255, 255, 255, 0.06); }
    .brand-logo {
      width: 32px; height: 32px; display: block;
      filter: drop-shadow(0 0 6px rgba(190, 242, 100, 0.35));
      transition: filter 0.18s ease;
    }
    .brand:hover .brand-logo { filter: drop-shadow(0 0 10px rgba(190, 242, 100, 0.55)); }

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
    .history-op.op-schema { background: rgba(168, 85, 247, 0.15); color: #c084fc; }
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
      min-width: 260px; background: var(--glass-strong);
      -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
      border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 8px;
      box-shadow: var(--shadow-3), var(--hl-top);
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

    /* ── Full-text search (top bar) ────────────────────── */
    .topsearch { position: relative; flex: 1 1 auto; max-width: 440px; display: flex; align-items: center; }
    .topsearch-icon {
      position: absolute; left: 10px; font-size: 12px; opacity: 0.6; pointer-events: none;
    }
    #search-input {
      width: 100%; height: 32px; padding: 0 10px 0 30px;
      background: var(--surface-2); color: var(--text);
      border: 1px solid var(--border); border-radius: 6px; font-size: 13px;
    }
    #search-input:focus { outline: none; border-color: var(--border-strong); }
    .search-results {
      position: absolute; top: 38px; left: 0; right: 0;
      max-height: 60vh; overflow-y: auto;
      background: var(--glass-strong);
      -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
      border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 8px;
      box-shadow: var(--shadow-3), var(--hl-top); z-index: 70; padding: 6px;
    }
    .search-empty { padding: 12px 10px; color: var(--text-muted); font-size: 13px; text-align: center; }
    .search-group { margin-bottom: 4px; }
    .search-group-head {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; color: var(--text-muted); text-transform: uppercase;
      letter-spacing: 0.05em; padding: 6px 8px 3px;
    }
    .search-group-icon { font-size: 12px; }
    .search-more {
      margin-left: auto; background: var(--accent-soft); color: var(--accent);
      border-radius: 999px; padding: 0 6px; font-size: 10px; letter-spacing: 0;
    }
    .search-hit {
      width: 100%; display: block; text-align: left;
      padding: 6px 10px; border: none; background: transparent; color: var(--text);
      border-radius: 6px; cursor: pointer; font-size: 13px;
    }
    .search-hit:hover { background: var(--row-hover); }
    .search-snippet {
      display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    @media (max-width: 720px) { .topsearch { order: 9; flex-basis: 100%; max-width: none; } }
    .last-edited { margin: -4px 0 12px; font-size: 12px; color: var(--text-muted); }
    .last-edited:empty { display: none; }

    /* ── Realtime collaboration cues ───────────────────── */
    /* Flash a row when another editor changes it. */
    @keyframes lattice-flash-kf {
      0%   { background: var(--accent-soft); }
      100% { background: transparent; }
    }
    tr.lattice-flash > td { animation: lattice-flash-kf 1.2s ease-out; }
    @media (prefers-reduced-motion: reduce) {
      tr.lattice-flash > td { animation: none; }
      .feed-item, .chat-msg { animation: none; }
      .assistant-rail .rail-title { animation: none !important; }
      *, *::before, *::after { transition-duration: 0.01ms !important; }
    }
    /* Pending offline-edit indicator in the top bar. */
    .offline-pill {
      flex: 0 0 auto; padding: 3px 9px; border-radius: 999px;
      background: rgba(251, 146, 60, 0.16); color: var(--warn);
      font-size: 11px; font-weight: 600; white-space: nowrap;
    }
    /* Unseen-change count next to a sidebar entity. */
    .nav-badge {
      display: inline-block; min-width: 16px; text-align: center;
      margin-left: 4px; padding: 0 5px; border-radius: 999px;
      background: var(--accent-soft); color: var(--accent);
      font-size: 10px; font-weight: 600; line-height: 16px; vertical-align: middle;
    }

    /* ── Layout ────────────────────────────────────────── */
    /* minmax(0, 1fr) on the content track lets a wide child (a table with
       chip-heavy cells) shrink instead of forcing the page wider than the
       viewport. Without the explicit 0 lower bound, the implicit auto
       minimum keeps the track at content-width and the whole page scrolls
       horizontally. */
    .layout {
      display: grid; grid-template-columns: var(--nav-width) minmax(0, 1fr) var(--sidebar-width);
      height: calc(100vh - 56px);
    }
    @media (max-width: 720px) {
      main#content { padding-bottom: 24px; }
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
    /* Extra breathing room above the "SYSTEM" heading so it isn't cramped
       against the object list above it. */
    #system-section .section-label { margin-top: 20px; }
    nav ul { list-style: none; padding: 0; margin: 0; }
    nav li a {
      display: flex; align-items: center; gap: 10px;
      padding: 7px 12px; border-radius: 6px;
      color: var(--text); font-size: 13.5px;
    }
    nav li a .nav-icon { width: 18px; text-align: center; font-size: 14px; }
    nav li a:hover { background: var(--row-hover); }
    nav li a.active { background: var(--accent-soft); color: var(--accent); font-weight: 500; box-shadow: var(--glow-accent-soft); }

    main#content { padding: 24px; overflow: auto; }

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
    .file-preview .md-body { font-size: 13.5px; line-height: 1.55; color: var(--text); max-height: 60vh; overflow: auto; padding: 4px 2px; }
    .file-preview .md-body h1, .file-preview .md-body h2, .file-preview .md-body h3,
    .file-preview .md-body h4 { margin: 12px 0 6px; line-height: 1.3; }
    .file-preview .md-body ul { margin: 6px 0; padding-left: 20px; }
    .file-preview .md-body code { background: var(--surface-2); padding: 1px 4px; border-radius: 4px; font-size: 12.5px; }
    .file-preview .md-body pre { background: var(--surface-2); padding: 10px; border-radius: 8px; overflow: auto; }
    .file-preview .md-body pre code { background: none; padding: 0; }
    .file-preview .md-body a { color: var(--accent); }
    .file-preview .file-actions { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }

    /* ── Dashboard ────────────────────────────────────── */
    .dashboard {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;
      max-width: 1100px;
    }
    .card {
      background: var(--sheen), var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 22px;
      min-height: 160px;
      display: flex; flex-direction: column; gap: 8px;
      box-shadow: var(--shadow-2), var(--hl-top);
      transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
    }
    .card:hover { transform: translateY(-2px); border-color: var(--accent); box-shadow: var(--shadow-3), var(--glow-accent-soft); }
    .card-icon { font-size: 22px; }
    .card-label { font-size: 15px; font-weight: 600; }
    .card-count { font-size: 28px; font-weight: 700; color: var(--text-muted); margin-top: auto; }
    .card-fresh { font-size: 11px; color: var(--text-muted); }

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
      box-shadow: var(--shadow-2);
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
    /* Inline object-reference pills the assistant emits — render flush in prose. */
    a.lattice-ref { text-decoration: none; vertical-align: baseline; }
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

    /* Data Model: a force-directed schema graph on top, edit panel below. */
    .dm-layout {
      display: flex; flex-direction: column; gap: 20px;
    }
    #graph-mount {
      position: relative; background: var(--bg);
      border: 1px solid var(--border); border-radius: 10px; height: 64vh; overflow: hidden;
    }
    svg.dm-graph { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
    svg.dm-graph:active { cursor: grabbing; }
    .dm-graph .gnode { cursor: pointer; }
    .dm-graph .gnode-glow { fill: var(--accent); opacity: 0; transition: opacity 0.1s ease; }
    .dm-graph .gnode-dot { fill: var(--surface-2); stroke: var(--border-strong); stroke-width: 1.5; transition: stroke 0.1s ease; }
    .dm-graph .gnode-label { fill: var(--text); font-size: 12px; font-weight: 500; }
    .dm-graph .gnode-icon { dominant-baseline: middle; }
    .dm-graph .gnode:hover .gnode-dot { stroke: var(--text-muted); }
    /* Share-status stroke (cloud workspaces only): yellow = shared, red = private. */
    .dm-graph .gnode-shared .gnode-dot { stroke: #eab308; stroke-width: 2; }
    .dm-graph .gnode-private .gnode-dot { stroke: #ef4444; stroke-width: 2; }
    /* Selected (green) wins over share status — higher specificity (.gnode.active). */
    .dm-graph .gnode.active .gnode-dot { stroke: var(--accent); stroke-width: 2; }
    .dm-graph .gnode.active .gnode-glow { opacity: 0.18; }
    .dm-graph .gnode.active .gnode-label { fill: var(--accent); }
    .dm-edge { transition: opacity 0.1s ease; }
    .dm-legend {
      position: absolute; top: 10px; left: 12px; display: flex; gap: 14px;
      font-size: 11px; color: var(--text-muted);
      background: rgba(11, 13, 16, 0.7); border: 1px solid var(--border);
      border-radius: 8px; padding: 6px 10px; backdrop-filter: blur(2px);
    }
    .dm-legend span { display: inline-flex; align-items: center; gap: 6px; }
    .dm-legend i { width: 16px; height: 0; border-top: 2px solid currentColor; display: inline-block; }
    .dm-legend i.dash { border-top-style: dashed; }
    /* Share-status swatches: filled dots rather than the relationship line. */
    .dm-legend i.sw { width: 10px; height: 10px; border-top: 0; border-radius: 50%; }
    .dm-legend i.sw-shared { background: #eab308; }
    .dm-legend i.sw-private { background: #ef4444; }
    .dm-legend i.sw-selected { background: var(--accent); }
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
    .chip-removable button:hover { background: var(--accent-soft); }
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
    /* Columns: name | type | secret. Links live in their own section. */
    .dm-col-row {
      display: grid; grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 8px; align-items: center;
    }
    .dm-col-type {
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11px;
      color: var(--text-muted); white-space: nowrap;
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
    /* Links: read-only foreign-key columns (name → target) + Destroy. */
    .dm-links { display: flex; flex-direction: column; gap: 6px; }
    .dm-link-row {
      display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto;
      gap: 8px; align-items: center;
    }
    .dm-link-name {
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12.5px;
      color: var(--text); white-space: nowrap;
    }
    .dm-link-arrow { font-size: 12px; color: var(--signal); white-space: nowrap; }
    .dm-link-row .dm-link-destroy { height: 28px; padding: 0 10px; font-size: 12px; }
    /* Danger zone — whole-table deletion (typed confirmation). */
    .dm-danger {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 10px; border: 1px solid var(--danger, #ef4444); border-radius: 8px;
      background: color-mix(in srgb, var(--danger, #ef4444) 6%, transparent);
    }
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
      background: var(--glass-strong);
      -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
      padding: 8px; border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      box-shadow: var(--shadow-3), var(--hl-top);
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
    /* Deprecation banner: shown when the workspace holds a grandfathered
       direct database cloud connection (no row-level security). Amber so
       it reads as a warning, not an error. */
    .deprecation-banner {
      display: flex; align-items: center; gap: 12px;
      padding: 8px 16px; font-size: 13px;
      background: rgba(234, 179, 8, 0.12); color: var(--text);
      border-bottom: 1px solid rgba(234, 179, 8, 0.45);
    }
    .deprecation-banner button {
      margin-left: auto; background: transparent; border: none; cursor: pointer;
      color: var(--text-muted); font-size: 13px; padding: 2px 6px; border-radius: 4px;
    }
    .deprecation-banner button:hover { background: rgba(234, 179, 8, 0.18); }

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
      max-width: 900px; box-shadow: var(--shadow-2);
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
      background: var(--sheen), var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 16px 18px; margin-bottom: 14px;
      box-shadow: var(--shadow-2), var(--hl-top);
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
    /* Role/status pills inside the settings-drawer member list, which is not
       under .team-card — so the .team-card-scoped .role-tag rules don't reach
       it. Covers creator / member / and the pending-invitee invited/expired. */
    .members-list .role-tag {
      display: inline-block; padding: 2px 8px; border-radius: 4px;
      font-size: 11px; font-weight: 600; text-transform: uppercase;
      background: var(--accent-soft); color: var(--accent);
    }
    .members-list .role-tag.role-member { background: #eef0f3; color: var(--text-muted); }
    .members-list .role-tag.role-expired { background: #fde2e1; color: #b91c1c; }
    .member-row-pending { opacity: 0.85; }
    .teams-empty {
      padding: 32px; text-align: center; color: var(--text-muted);
      border: 1px dashed var(--border-strong); border-radius: 8px;
    }
    .danger-btn { background: rgba(251, 146, 60, 0.12); color: var(--warn); border-color: rgba(251, 146, 60, 0.4); }
    .danger-btn:hover { background: rgba(251, 146, 60, 0.2); }

    /* Modal — used by the teams flows. Self-contained so it doesn't
       collide with any modal styles the GUI agent may add later. */
    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(7, 9, 11, 0.55);
      -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
      display: flex; align-items: center; justify-content: center;
      z-index: 1000;
    }
    .modal {
      background: rgba(19, 23, 27, 0.80);
      -webkit-backdrop-filter: var(--blur-lg); backdrop-filter: var(--blur-lg);
      border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 12px;
      box-shadow: var(--shadow-4), var(--hl-top);
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
      background: linear-gradient(135deg, var(--accent-glow), var(--accent-deep)); color: #0b0d10; border-color: var(--accent-deep); font-weight: 600; box-shadow: var(--glow-accent-soft);
    }
    .modal-foot .btn.primary:hover { background: linear-gradient(135deg, var(--accent-glow), var(--accent)); border-color: var(--accent-glow); box-shadow: var(--glow-accent); }
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

    /* ── Header settings gear (top-right) ───────────────── */
    #settings-gear {
      margin-left: auto; display: inline-flex; align-items: center; justify-content: center;
      width: 32px; height: 32px; background: transparent; border: 1px solid #2a2f36;
      border-radius: 6px; cursor: pointer; color: #e6e8eb; flex-shrink: 0;
    }
    #settings-gear:hover { background: rgba(255, 255, 255, 0.06); }
    #settings-gear svg { width: 18px; height: 18px; display: block; }

    /* ── Slim / collapsible left sidebar ────────────────── */
    /* Advanced-mode toggle at the top of the sidebar. */
    .sidebar-advanced {
      margin: 0 0 12px 2px; padding: 4px 6px; border-radius: 6px;
    }
    .sidebar-advanced:hover { background: var(--row-hover); }
    .sidebar-advanced .toggle-label { font-size: 12px; color: var(--text-muted); }

    /* ── File-system workspace (default view) ───────────── */
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
      display: flex; flex-direction: column; align-items: center; gap: 8px;
      padding: 18px 12px 14px; text-align: center;
      background: var(--sheen), var(--surface); border: 1px solid var(--border);
      border-radius: 12px; box-shadow: var(--shadow-2), var(--hl-top); cursor: pointer;
      transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
    }
    .fs-tile:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: var(--shadow-3), var(--glow-accent-soft); }
    .fs-tile-create { border-style: dashed; background: transparent; }
    .fs-tile-create .fs-tile-icon { color: var(--accent); }
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

    /* ── Settings drawer (slide-over) ───────────────────── */
    .drawer-backdrop {
      position: fixed; inset: 0; background: rgba(7, 9, 11, 0.55);
      -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
      z-index: 120; opacity: 0; transition: opacity 0.2s ease;
    }
    .drawer-backdrop.open { opacity: 1; }
    .settings-drawer {
      position: fixed; top: 0; right: 0; height: 100vh;
      width: min(620px, 94vw); background: rgba(19, 23, 27, 0.82);
      -webkit-backdrop-filter: var(--blur-lg); backdrop-filter: var(--blur-lg);
      border-left: 1px solid rgba(255, 255, 255, 0.06);
      box-shadow: -12px 0 32px rgba(0, 0, 0, 0.4), var(--shadow-4);
      z-index: 130; display: flex; flex-direction: column;
      transform: translateX(100%); transition: transform 0.22s ease;
    }
    .settings-drawer.open { transform: translateX(0); }
    .drawer-head {
      flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
      padding: 14px 18px; border-bottom: 1px solid var(--border);
    }
    .drawer-title { font-size: 16px; font-weight: 600; }
    .drawer-close {
      margin-left: auto; width: 30px; height: 30px; border: 1px solid var(--border);
      border-radius: 6px; background: transparent; color: var(--text-muted);
      cursor: pointer; font-size: 16px; line-height: 1;
    }
    .drawer-close:hover { background: var(--row-hover); color: var(--text); }
    .drawer-tabs {
      flex: 0 0 auto; display: flex; gap: 4px; padding: 10px 14px 0;
    }
    .drawer-tab {
      padding: 7px 14px; border: 1px solid var(--border); border-bottom: none;
      border-radius: 6px 6px 0 0; background: var(--surface-2); color: var(--text-muted);
      font-size: 13px; cursor: pointer;
    }
    .drawer-tab.active { background: var(--surface); color: var(--text); font-weight: 600; border-color: var(--border-strong); }
    .drawer-body { flex: 1 1 auto; overflow-y: auto; padding: 4px 4px 20px; }
    .drawer-body .teams-page { padding: 16px 18px; }

    /* Toggle switch (advanced mode) */
    .toggle { display: flex; align-items: center; gap: 10px; cursor: pointer; }
    .toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
    .toggle-track {
      position: relative; flex: 0 0 auto; width: 38px; height: 22px;
      background: var(--border-strong); border-radius: 999px; transition: background 0.15s ease;
    }
    .toggle-thumb {
      position: absolute; top: 2px; left: 2px; width: 18px; height: 18px;
      background: #fff; border-radius: 50%; transition: transform 0.15s ease;
    }
    .toggle input:checked + .toggle-track { background: var(--accent); }
    .toggle input:checked + .toggle-track .toggle-thumb { transform: translateX(16px); }
    .toggle-label { font-size: 13.5px; color: var(--text); }
    .toggle-label small { display: block; font-size: 11px; color: var(--text-muted); }


    /* ============ AI assistant rail (2.0) ============ */
    .feed-item.feed-pending { opacity: 0.85; }
    .feed-spinner {
      display: inline-block; width: 12px; height: 12px; border-radius: 50%;
      border: 2px solid var(--border-strong); border-top-color: var(--accent);
      animation: feedSpin 0.7s linear infinite; vertical-align: middle;
    }
    @keyframes feedSpin { to { transform: rotate(360deg); } }
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

    /* ── Chat bubbles + tool pills ─────────────────────── */
    .chat-msg { display: flex; animation: feedIn 0.18s ease-out; }
    .chat-msg.user { justify-content: flex-end; }
    .chat-msg.assistant { justify-content: flex-start; }
    .chat-bubble {
      max-width: 85%; padding: 8px 12px; font-size: 13.5px; line-height: 1.45;
      white-space: pre-wrap; word-break: break-word;
    }
    .chat-bubble.user {
      background: linear-gradient(135deg, var(--accent-glow), var(--accent) 55%, var(--accent-deep));
      color: #0b0d10;
      border-radius: 14px 14px 4px 14px;
      box-shadow: 0 2px 10px -2px rgba(132, 204, 22, 0.5);
    }
    .chat-bubble.assistant {
      background: var(--surface-2); color: var(--text); border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 14px 14px 14px 4px;
      white-space: normal; /* rendered Markdown flows as HTML, not pre-wrapped */
    }
    /* Markdown elements rendered inside assistant chat bubbles */
    .chat-bubble.assistant > :first-child { margin-top: 0; }
    .chat-bubble.assistant > :last-child { margin-bottom: 0; }
    .chat-bubble.assistant p { margin: 0 0 8px; }
    .chat-bubble.assistant ul, .chat-bubble.assistant ol { margin: 0 0 8px; padding-left: 20px; }
    .chat-bubble.assistant li { margin: 2px 0; }
    .chat-bubble.assistant h3, .chat-bubble.assistant h4,
    .chat-bubble.assistant h5, .chat-bubble.assistant h6 {
      margin: 10px 0 4px; font-weight: 700; line-height: 1.3;
    }
    .chat-bubble.assistant h3 { font-size: 15px; }
    .chat-bubble.assistant h4 { font-size: 14px; }
    .chat-bubble.assistant h5, .chat-bubble.assistant h6 { font-size: 13.5px; }
    .chat-bubble.assistant a { color: var(--accent); text-decoration: underline; }
    .chat-bubble.assistant strong { font-weight: 700; }
    .chat-bubble.assistant code {
      background: var(--surface); border: 1px solid var(--border); border-radius: 4px;
      padding: 0 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    }
    .chat-bubble.assistant pre {
      background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
      padding: 8px; margin: 0 0 8px; overflow-x: auto;
    }
    .chat-bubble.assistant pre code { background: none; border: none; padding: 0; white-space: pre; }
    /* The assistant's data changes render as activity-feed cards (.feed-item) in
       the rail — there is no separate inline pill style. Reads emit no card.
       Typing indicator: three pulsing dots shown in an assistant bubble while
       the model is generating (before the first text delta of a turn). */
    .chat-typing { display: inline-flex; align-items: center; gap: 4px; padding: 1px 0; }
    .chat-typing i {
      width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted);
      display: inline-block; animation: chat-typing-kf 1.2s ease-in-out infinite;
    }
    .chat-typing i:nth-child(2) { animation-delay: 0.18s; }
    .chat-typing i:nth-child(3) { animation-delay: 0.36s; }
    @keyframes chat-typing-kf {
      0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
      30% { opacity: 0.9; transform: translateY(-2px); }
    }
    .rail-composer {
      flex: 0 0 auto; border-top: 1px solid rgba(255, 255, 255, 0.06); padding: 10px 12px;
      background: linear-gradient(180deg, rgba(17, 21, 26, 0), rgba(17, 21, 26, 0.6) 40%);
    }
    .rail-composer textarea {
      width: 100%; min-width: 0; resize: none; min-height: 38px; max-height: 160px;
      background: var(--surface-2); color: var(--text);
      border: 1px solid var(--border-strong); border-radius: 8px;
      padding: 8px 10px; font: inherit; font-size: 13.5px; line-height: 1.4;
      /* Wrap instead of overflowing: min-width:0 lets the flex child shrink so
         text reflows to the rail width, and overflow-wrap breaks long tokens
         (URLs) that have no space to wrap at. JS auto-grows height to fit. */
      overflow-wrap: break-word; word-break: break-word;
    }
    .rail-composer textarea:focus { outline: none; border-color: var(--accent); box-shadow: var(--glow-focus); }
    /* While a voice note is being recorded/transcribed the textarea is read-only
       (shows a "Listening…" / "Transcribing…" placeholder, not editable). */
    .rail-composer textarea.recording { opacity: 0.6; cursor: not-allowed; }
    .rail-composer .composer-row { display: flex; gap: 8px; align-items: flex-end; }
    .rail-composer .composer-send {
      flex: 0 0 auto; height: 38px; padding: 0 14px; border: none; border-radius: 8px;
      background: linear-gradient(135deg, var(--accent-glow), var(--accent-deep)); color: #0b0d10; font-weight: 600; cursor: pointer;
      box-shadow: var(--glow-accent-soft); transition: filter 0.18s ease, box-shadow 0.18s ease, transform 0.08s ease;
    }
    .rail-composer .composer-send:hover:not(:disabled) { filter: brightness(1.06); box-shadow: var(--glow-accent); }
    .rail-composer .composer-send:active:not(:disabled) { transform: translateY(1px); }
    .rail-composer .composer-send:disabled { opacity: 0.4; cursor: default; box-shadow: none; }
    .rail-composer .composer-setup { font-size: 12.5px; color: var(--text-muted); text-align: center; }
    .rail-composer .composer-setup a { color: var(--accent); }
    .rail-composer .composer-mic {
      flex: 0 0 auto; height: 38px; width: 38px; font-size: 15px;
      border: 1px solid var(--border-strong); border-radius: 8px;
      background: var(--surface-2); color: var(--text-muted); cursor: pointer;
    }
    .rail-composer .composer-mic.recording { background: var(--warn); color: #0b0d10; border-color: var(--warn); box-shadow: 0 0 14px -2px rgba(251, 146, 60, 0.6); }
    .rail-composer .composer-mic.transcribing { color: var(--accent); }
    /* No microphone available: faded + not-allowed, but still hoverable so the
       title tooltip ("No microphone available") shows. Not natively disabled —
       disabled buttons suppress the tooltip. */
    .rail-composer .composer-mic.composer-mic-unavailable { opacity: 0.4; cursor: not-allowed; box-shadow: none; }
    .rail-composer .composer-clip {
      flex: 0 0 auto; height: 38px; width: 38px; font-size: 15px;
      border: 1px solid var(--border-strong); border-radius: 8px;
      background: var(--surface-2); color: var(--text-muted); cursor: pointer;
    }
    .assistant-rail.dragging-file::after {
      content: 'Drop to ingest'; position: absolute; inset: 0; z-index: 10;
      display: flex; align-items: center; justify-content: center;
      background: rgba(190, 242, 100, 0.10);
      -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
      border: 2px dashed var(--accent);
      box-shadow: inset 0 0 60px rgba(190, 242, 100, 0.25);
      color: var(--accent); font-weight: 600; pointer-events: none;
      text-shadow: 0 0 12px rgba(190, 242, 100, 0.6);
    }
    .rail-handle { display: none; }
    @media (max-width: 720px) {
      /* The assistant rail becomes a bottom drawer: composer always reachable,
         tap the handle to expand the feed/chat to ~62svh. */
      .layout { grid-template-columns: 220px minmax(0, 1fr); }
      .assistant-rail {
        position: fixed; left: 0; right: 0; bottom: 0; z-index: 50;
        border-left: none; border-top: 1px solid var(--border);
        max-height: 62svh; box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.4);
      }
      .rail-resize { display: none; }
      .rail-handle {
        display: block; flex: 0 0 auto; height: 22px; cursor: pointer; position: relative;
      }
      .rail-handle::after {
        content: ''; position: absolute; top: 9px; left: 50%; transform: translateX(-50%);
        width: 40px; height: 4px; border-radius: 2px; background: var(--border-strong);
      }
      .assistant-rail:not(.expanded) { max-height: none; }
      .assistant-rail:not(.expanded) .rail-feed { display: none; }
      main#content { padding-bottom: 96px; }
    }
  `;
