export const guiAppHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lattice Browser</title>
  <style>
    :root {
      --bg: #f4f5f7;
      --surface: #ffffff;
      --border: #e2e5ea;
      --border-strong: #c9cdd4;
      --text: #1f2328;
      --text-muted: #6b7280;
      --accent: #2f6feb;
      --accent-soft: #e7efff;
      --row-hover: #f6f7fa;
      --shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: var(--text);
      background: var(--bg);
      font-size: 14px;
    }
    a { color: inherit; text-decoration: none; }
    button { font: inherit; cursor: pointer; }

    /* ── Top bar ───────────────────────────────────────── */
    header.topbar {
      display: flex; align-items: center; gap: 16px;
      height: 56px; padding: 0 20px;
      background: var(--surface); border-bottom: 1px solid var(--border);
    }
    .brand { font-weight: 700; font-size: 16px; letter-spacing: -0.01em; }
    .query {
      flex: 1; max-width: 480px; margin-left: auto;
      height: 32px; padding: 0 12px;
      border: 1px solid var(--border-strong); border-radius: 6px;
      background: #fafbfc; color: var(--text-muted); font-size: 13px;
    }
    .query[disabled] { cursor: not-allowed; }

    /* History controls in top bar */
    .history-controls { display: inline-flex; gap: 4px; }
    .history-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 32px; height: 32px;
      background: transparent; border: 1px solid var(--border-strong);
      border-radius: 6px; cursor: pointer;
      color: var(--text); font-size: 16px; text-decoration: none;
    }
    .history-btn:hover:not([disabled]) { background: var(--row-hover); }
    .history-btn[disabled] { opacity: 0.35; cursor: not-allowed; }

    /* History page */
    .history-list {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; overflow: hidden; max-width: 980px;
    }
    .history-entry { display: flex; gap: 16px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
    .history-entry:last-child { border-bottom: none; }
    .history-entry.is-undone { background: #fafbfc; }
    .history-entry.is-undone .history-summary { color: var(--text-muted); text-decoration: line-through; }
    .history-meta { min-width: 200px; font-size: 12px; color: var(--text-muted); }
    .history-meta .history-op {
      display: inline-block; padding: 1px 8px;
      background: var(--accent-soft); color: var(--accent);
      border-radius: 8px; font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.04em; font-weight: 600;
    }
    .history-op.op-delete { background: #fef3f2; color: #b42318; }
    .history-op.op-link, .history-op.op-unlink { background: #f3f0fe; color: #6941c6; }
    .history-summary { flex: 1; font-size: 13.5px; }
    .history-summary .history-table { font-weight: 600; }
    .history-diff {
      margin-top: 8px; font-family: ui-monospace, monospace; font-size: 12px;
      background: #fafbfc; border: 1px solid var(--border); border-radius: 6px;
      padding: 8px 10px; white-space: pre-wrap;
    }
    .history-diff .diff-add { color: #027a48; }
    .history-diff .diff-rem { color: #b42318; }
    .history-actions { display: flex; flex-direction: column; gap: 4px; }
    .history-actions .btn { font-size: 12px; height: 26px; padding: 0 10px; }

    /* DB switcher in the top bar */
    .db-switcher { position: relative; }
    .db-button {
      display: inline-flex; align-items: center; gap: 6px;
      height: 32px; padding: 0 10px;
      background: #fafbfc; color: var(--text);
      border: 1px solid var(--border-strong); border-radius: 6px;
      font-size: 13px; cursor: pointer;
    }
    .db-button:hover { background: var(--row-hover); }
    .db-button .db-caret { color: var(--text-muted); font-size: 10px; }
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
      background: white; margin-bottom: 6px;
    }

    /* ── Layout ────────────────────────────────────────── */
    .layout {
      display: grid; grid-template-columns: 220px 1fr;
      height: calc(100vh - 56px);
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
      padding: 12px 14px; background: #fafbfc;
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

    /* Data Model: 2-column graph + side panel */
    .dm-layout { display: grid; grid-template-columns: 1fr 340px; gap: 16px; }
    #graph-mount { background: var(--surface);
      border: 1px solid var(--border); border-radius: 10px; padding: 16px; min-height: 70vh; }
    #graph-mount svg { width: 100%; height: 65vh; }
    #graph-mount g.gnode { cursor: pointer; }
    #graph-mount g.gnode circle { transition: fill 0.1s ease, stroke 0.1s ease; }
    #graph-mount g.gnode.active circle { fill: var(--accent); stroke: var(--accent); }
    #graph-mount g.gnode.active text { fill: var(--accent); font-weight: 600; }
    #dm-panel {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; padding: 16px;
      max-height: 70vh; overflow-y: auto;
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
      border: 1px solid var(--border-strong); border-radius: 6px; background: white; }

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
      display: grid; grid-template-columns: 70px 1fr; gap: 8px 10px;
      align-items: center; font-size: 12.5px;
    }
    .dm-edit-grid label { color: var(--text-muted); text-transform: uppercase;
      letter-spacing: 0.04em; font-size: 11px; }
    .dm-edit-grid input, .dm-edit-grid select {
      padding: 5px 8px; font: inherit; border: 1px solid var(--border-strong);
      border-radius: 5px; background: white; font-size: 12.5px;
    }
    .dm-row-inline { display: flex; gap: 6px; align-items: center; }
    .dm-row-inline input { flex: 1; min-width: 0; }
    .dm-row-inline select { width: 90px; }
    .dm-row-inline .btn { height: 28px; font-size: 12px; padding: 0 10px; }
    .dm-cols { display: flex; flex-direction: column; gap: 4px; }
    .dm-col-row { display: flex; gap: 6px; align-items: center; }
    .dm-col-row input { flex: 1; min-width: 0;
      padding: 5px 8px; font: inherit; border: 1px solid var(--border);
      border-radius: 5px; background: white; font-size: 12.5px;
    }
    .dm-col-rename { height: 28px; padding: 0 10px; font-size: 12px; }

    /* ── Buttons ──────────────────────────────────────── */
    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      height: 30px; padding: 0 12px;
      background: var(--surface); color: var(--text);
      border: 1px solid var(--border-strong); border-radius: 6px;
      font-size: 13px;
    }
    .btn:hover { background: var(--row-hover); }
    .btn.primary { background: var(--accent); color: white; border-color: var(--accent); }
    .btn.primary:hover { background: #1f5dd1; }
    .btn.danger { color: #b42318; border-color: #f2c4c0; }
    .btn.danger:hover { background: #fef3f2; }
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
    tr:hover .row-delete { color: #b42318; }
    .row-delete:hover { background: #fef3f2; }
    .row-restore:hover { background: var(--accent-soft); color: var(--accent); }
    tr.row-deleted td { background: #fefbf3; color: var(--text-muted); }
    tr.row-deleted:hover td { background: #fcf5e3; }

    /* Inline create-row at the bottom of every table */
    tr.create-row td { background: #fafbfc; }
    tr.create-row input, tr.create-row textarea, tr.create-row select {
      width: 100%; padding: 6px 8px; font: inherit;
      border: 1px solid var(--border); border-radius: 4px; background: white;
    }
    tr.create-row textarea { min-height: 32px; resize: vertical; }
    tr.create-row #inline-create {
      height: 30px; width: 30px; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 18px;
    }

    /* ── Modal ────────────────────────────────────────── */
    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(15, 23, 42, 0.35);
      display: flex; align-items: center; justify-content: center;
      z-index: 100;
    }
    .modal {
      background: var(--surface); border-radius: 10px;
      width: 480px; max-width: calc(100vw - 40px); max-height: 80vh;
      display: flex; flex-direction: column;
      box-shadow: 0 16px 40px rgba(15, 23, 42, 0.18);
    }
    .modal-head { padding: 16px 20px; border-bottom: 1px solid var(--border);
      font-size: 15px; font-weight: 600; }
    .modal-body { padding: 16px 20px; overflow-y: auto; }
    .modal-foot { padding: 12px 20px; border-top: 1px solid var(--border);
      display: flex; justify-content: flex-end; gap: 8px; }
    .field { display: block; margin-bottom: 12px; }
    .field label { display: block; font-size: 12px; color: var(--text-muted);
      margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em; }
    .field input, .field textarea, .field select {
      width: 100%; padding: 7px 10px; font: inherit;
      border: 1px solid var(--border-strong); border-radius: 6px;
      background: white;
    }
    .field textarea { min-height: 72px; resize: vertical; }
    .field:last-child { margin-bottom: 0; }

    /* Detail inputs (inline editing) */
    .detail dl.editing input,
    .detail dl.editing textarea {
      width: 100%; padding: 6px 9px; font: inherit;
      border: 1px solid var(--border-strong); border-radius: 6px; background: white;
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
      margin: 0; padding: 12px; background: #fafbfc;
      border: 1px solid var(--border); border-radius: 6px;
      font-family: ui-monospace, 'SF Mono', 'Menlo', Consolas, monospace;
      font-size: 12.5px; line-height: 1.55;
      white-space: pre-wrap; word-break: break-word;
    }
    .context-empty { padding: 16px 18px; color: var(--text-muted); font-style: italic; }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">Lattice</div>
    <div class="history-controls">
      <button class="history-btn" id="undo-btn" title="Undo" disabled>↶</button>
      <button class="history-btn" id="redo-btn" title="Redo" disabled>↷</button>
      <a class="history-btn" id="history-link" href="#/settings/history" title="Version history">📜</a>
    </div>
    <div class="db-switcher">
      <button class="db-button" id="db-button" title="Switch database">
        <span class="db-icon">💾</span>
        <span class="db-name" id="db-name">loading…</span>
        <span class="db-caret">▾</span>
      </button>
      <div class="db-menu" id="db-menu" hidden></div>
    </div>
    <input class="query" type="text" placeholder="Query + Prompt Workspace..." disabled />
  </header>
  <div class="layout">
    <nav class="sidebar">
      <div class="section-label">Objects</div>
      <ul id="object-nav"></ul>
      <div class="section-label">Settings</div>
      <ul id="settings-nav">
        <li><a href="#/settings/data-model"><span class="nav-icon">⚙</span> Data Model</a></li>
        <li><a href="#/settings/project-config"><span class="nav-icon">⚙</span> Project Config</a></li>
        <li><a href="#/settings/user-config"><span class="nav-icon">👤</span> User Config</a></li>
      </ul>
    </nav>
    <main id="content"></main>
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

    var state = { entities: null, rowCache: {}, iconOverrides: {} };

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

    // ────────────────────────────────────────────────────────────
    // Boot
    // ────────────────────────────────────────────────────────────
    function init() {
      Promise.all([
        fetchJson('/api/entities'),
        fetchJson('/api/gui-meta').catch(function () { return {}; }),
        fetchJson('/api/databases').catch(function () { return null; }),
      ]).then(function (results) {
        state.entities = results[0];
        state.iconOverrides = results[1] || {};
        renderDbSwitcher(results[2]);
        renderSidebar();
        wireHistoryControls();
        refreshHistoryState();
        renderRoute();
      }).catch(function (err) {
        document.getElementById('content').innerHTML =
          '<div class="placeholder"><h2>Failed to load</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // ────────────────────────────────────────────────────────────
    // Version history (undo / redo / log)
    // ────────────────────────────────────────────────────────────
    function wireHistoryControls() {
      document.getElementById('undo-btn').addEventListener('click', function () {
        fetchJson('/api/history/undo', { method: 'POST' }).then(afterMutation).catch(function (err) {
          alert('Undo failed: ' + err.message);
        });
      });
      document.getElementById('redo-btn').addEventListener('click', function () {
        fetchJson('/api/history/redo', { method: 'POST' }).then(afterMutation).catch(function (err) {
          alert('Redo failed: ' + err.message);
        });
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
      ]).then(function (results) {
        state.entities = results[0];
        state.iconOverrides = results[1] || {};
        renderDbSwitcher(results[2]);
        renderSidebar();
        // Always reset to dashboard after a switch — the previous URL's table
        // may not exist in the new DB.
        if (location.hash !== '#/') location.hash = '#/';
        else renderRoute();
        // Reset row cache.
        loadedTables = {};
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
      nameEl.textContent = data.current.dbFile;

      function buildMenu() {
        var items = data.configs.map(function (c) {
          return '<button class="db-item' + (c.active ? ' active' : '') +
            '" data-path="' + escapeHtml(c.path) + '">' +
            '<span>' + escapeHtml(c.name) + '</span>' +
            '<span class="db-item-file">' + escapeHtml(c.dbFile) + '</span>' +
            '</button>';
        }).join('');
        menu.innerHTML =
          '<div class="db-section">Available databases</div>' +
          items +
          '<div class="db-section">Create new</div>' +
          '<div class="db-create">' +
            '<input id="db-create-name" type="text" placeholder="e.g. scratch, demo-2" maxlength="48" />' +
            '<button class="btn primary" id="db-create-btn" style="width:100%;">Create blank database</button>' +
          '</div>';
        menu.querySelectorAll('button.db-item').forEach(function (b) {
          b.addEventListener('click', function () {
            var path = b.getAttribute('data-path');
            if (path === data.current.path) { menu.hidden = true; return; }
            fetchJson('/api/databases/switch', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path: path }),
            }).then(function () {
              menu.hidden = true;
              return reloadEverything();
            }).catch(function (err) { alert('Switch failed: ' + err.message); });
          });
        });
        document.getElementById('db-create-btn').addEventListener('click', function () {
          var nameInput = document.getElementById('db-create-name');
          var name = nameInput.value.trim();
          if (!name) { nameInput.focus(); return; }
          fetchJson('/api/databases/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: name }),
          }).then(function () {
            menu.hidden = true;
            return reloadEverything();
          }).catch(function (err) { alert('Create failed: ' + err.message); });
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

      if (hash === '#/settings/data-model') { renderDataModel(content); return; }
      if (hash === '#/settings/history') { renderHistory(content); return; }
      if (hash === '#/settings/project-config' || hash === '#/settings/user-config') {
        content.innerHTML = '<div class="placeholder"><h2>Coming soon</h2>' +
          '<p>This view will be wired up in a follow-up release.</p></div>';
        return;
      }
      content.innerHTML = '<div class="placeholder"><h2>Unknown route</h2></div>';
    }

    // ────────────────────────────────────────────────────────────
    // Dashboard
    // ────────────────────────────────────────────────────────────
    function renderDashboard(content) {
      var cards = DASHBOARD_ORDER.map(function (name) {
        var t = tableByName(name);
        if (!t) return '';
        var d = displayFor(name);
        var count = (t.rowCount != null) ? t.rowCount : 0;
        return '<a class="card" href="#/objects/' + name + '">' +
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

    // ────────────────────────────────────────────────────────────
    // Modal helper
    // ────────────────────────────────────────────────────────────
    function showModal(title, bodyHtml, opts) {
      opts = opts || {};
      var primaryLabel = opts.primaryLabel || 'Save';
      var backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML =
        '<div class="modal">' +
          '<div class="modal-head">' + escapeHtml(title) + '</div>' +
          '<div class="modal-body">' + bodyHtml + '</div>' +
          '<div class="modal-foot">' +
            '<button class="btn" data-act="cancel">Cancel</button>' +
            '<button class="btn primary" data-act="ok">' + escapeHtml(primaryLabel) + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(backdrop);
      function close() { document.body.removeChild(backdrop); }
      backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) close();
      });
      backdrop.querySelector('[data-act="cancel"]').addEventListener('click', close);
      backdrop.querySelector('[data-act="ok"]').addEventListener('click', function () {
        try {
          var result = opts.onSubmit ? opts.onSubmit(backdrop) : null;
          if (result && typeof result.then === 'function') {
            result.then(close).catch(function (err) {
              alert('Failed: ' + err.message);
            });
          } else {
            close();
          }
        } catch (err) {
          alert('Failed: ' + err.message);
        }
      });
      return { close: close };
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
              return '<td>' + escapeHtml(truncate(r[c], 120)) + '</td>';
            });
            belongsTo.forEach(function (b) {
              var ref = (loadedTables[b.rel.table] || []).find(function (x) { return x.id === r[b.rel.foreignKey]; });
              tds.push('<td>' + chipLink(b.rel.table, ref) + '</td>');
            });
            junctions.forEach(function (j) {
              var matches = (loadedTables[j.junction] || []).filter(function (jr) { return jr[j.localFk] === r.id; });
              var remoteFkCol = j.remoteRel.foreignKey;
              var chips = matches.map(function (jr) {
                var ref = (loadedTables[j.remoteRel.table] || []).find(function (x) { return x.id === jr[remoteFkCol]; });
                return ref ? chipLink(j.remoteRel.table, ref) : '';
              }).join('');
              tds.push('<td>' + (chips || '<span class="muted">—</span>') + '</td>');
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
          }).catch(function (err) {
            alert('Create failed: ' + err.message);
          });
        });

        content.querySelectorAll('button.row-delete').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var softId = btn.getAttribute('data-del');
            var hardId = btn.getAttribute('data-hard-del');
            var id = softId || hardId;
            var hard = !!hardId;
            var prompt = hard
              ? 'Permanently delete this row? This cannot be undone.'
              : (supportsSoftDelete
                  ? 'Move this row to trash? You can restore it later.'
                  : 'Delete this row?');
            if (!confirm(prompt)) return;
            var url = '/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id);
            if (hard) url += '?hard=true';
            fetchJson(url, { method: 'DELETE' }).then(function () {
              invalidate(tableName);
              return refreshEntities();
            }).then(function () {
              renderTable(content, tableName);
            }).catch(function (err) {
              alert('Delete failed: ' + err.message);
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
            }).catch(function (err) {
              alert('Restore failed: ' + err.message);
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
            var dd = editing
              ? fieldFor(c, row[c], t)
              : (row[c] == null ? '<span class="muted">—</span>' : escapeHtml(row[c]));
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
          // Junctions are read-only here — managed via Data Model.
          junctions.forEach(function (j) {
            var matches = (loadedTables[j.junction] || []).filter(function (jr) { return jr[j.localFk] === row.id; });
            var chips = matches.map(function (jr) {
              var ref = (loadedTables[j.remoteRel.table] || []).find(function (x) { return x.id === jr[j.remoteRel.foreignKey]; });
              return ref ? chipLink(j.remoteRel.table, ref) : '';
            }).join(' ');
            rows.push('<dt>' + escapeHtml(titleCase(j.remoteRel.table)) + '</dt>' +
                      '<dd>' + (chips || '<span class="muted">—</span>') + '</dd>');
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
            '<div class="detail"><dl class="' + (editing ? 'editing' : '') + '">' + rows.join('') + '</dl></div>' +
            '<div id="row-context"></div>';

          // Skip the context fetch while editing — the just-PATCHed row may
          // not have re-rendered yet, so we'd flash stale content.
          if (!editing) loadRowContext(tableName, id);

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
              }).catch(function (err) {
                alert('Save failed: ' + err.message);
              });
            });
          } else {
            document.getElementById('edit-row').addEventListener('click', function () { paint(true); });
            document.getElementById('del-row').addEventListener('click', function () {
              if (!confirm('Delete this row? This cannot be undone.')) return;
              fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id), {
                method: 'DELETE',
              }).then(function () {
                invalidate(tableName);
                return refreshEntities();
              }).then(function () {
                location.hash = '#/objects/' + tableName;
              }).catch(function (err) {
                alert('Delete failed: ' + err.message);
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
    // Version history page (#/settings/history)
    // ────────────────────────────────────────────────────────────
    function renderHistory(content) {
      content.innerHTML =
        '<div class="view-header">' +
          '<span class="entity-icon">📜</span>' +
          '<h1>Version history</h1>' +
        '</div>' +
        '<div class="history-list" id="history-list"><div class="muted" style="padding:20px;">Loading…</div></div>';

      fetchJson('/api/history?limit=500').then(function (data) {
        var mount = document.getElementById('history-list');
        if (!data.entries || data.entries.length === 0) {
          mount.innerHTML = '<div class="muted" style="padding:24px;">No history yet — make a change to see it here.</div>';
          return;
        }
        mount.innerHTML = data.entries.map(historyEntryHtml).join('');
        mount.querySelectorAll('button.history-revert').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-id');
            if (!confirm('Revert this change?')) return;
            fetchJson('/api/history/revert/' + encodeURIComponent(id), { method: 'POST' })
              .then(afterMutation)
              .then(function () { renderHistory(document.getElementById('content')); })
              .catch(function (err) { alert('Revert failed: ' + err.message); });
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
    // Data Model — entity graph + row-level link/unlink picker
    // ────────────────────────────────────────────────────────────
    var dmActiveTable = null;
    var dmActiveRowId = null;

    function renderDataModel(content) {
      content.innerHTML =
        '<div class="view-header">' +
          '<span class="entity-icon">⚙</span>' +
          '<h1>Data Model</h1>' +
        '</div>' +
        '<div class="dm-layout">' +
          '<div id="graph-mount"><div class="muted">Loading graph…</div></div>' +
          '<aside id="dm-panel"><div class="muted">Click an entity to explore its rows and links.</div></aside>' +
        '</div>';

      fetchJson('/api/graph').then(function (graph) {
        document.getElementById('graph-mount').innerHTML = renderGraphSvg(graph);
        document.querySelectorAll('#graph-mount g.gnode').forEach(function (g) {
          g.addEventListener('click', function () {
            var name = g.getAttribute('data-table');
            dmShowTableRows(name);
            highlightGraphNode(name);
          });
        });
        if (dmActiveTable) highlightGraphNode(dmActiveTable);
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

    function dmShowTableRows(tableName) {
      dmActiveTable = tableName;
      dmActiveRowId = null;
      var panel = document.getElementById('dm-panel');
      panel.innerHTML = '<div class="muted">Loading…</div>';
      loadAllRows(tableName).then(function (rows) {
        var t = tableByName(tableName);
        var d = displayFor(tableName);
        var override = state.iconOverrides[tableName];
        var overrideIcon = (override && override.icon) || '';

        // ── Edit section: name / icon / columns ──
        var editableCols = (t.columns || []).filter(function (c) { return c !== 'id'; });
        var columnsHtml = editableCols.map(function (c) {
          return '<div class="dm-col-row">' +
            '<input class="dm-col-name" data-col="' + escapeHtml(c) + '" value="' + escapeHtml(c) + '" />' +
            '<button class="btn dm-col-rename" data-col="' + escapeHtml(c) + '" title="Rename">↻</button>' +
            '</div>';
        }).join('');
        var editPanel =
          '<details class="dm-section" open>' +
            '<summary><strong>Edit entity</strong></summary>' +
            '<div class="dm-edit-grid">' +
              '<label>Name</label>' +
              '<div class="dm-row-inline">' +
                '<input id="dm-rename-input" value="' + escapeHtml(tableName) + '" />' +
                '<button class="btn" id="dm-rename-btn">Save</button>' +
              '</div>' +
              '<label>Icon</label>' +
              '<div class="dm-row-inline">' +
                '<input id="dm-icon-input" maxlength="8" placeholder="📋" value="' + escapeHtml(overrideIcon) + '" />' +
                '<button class="btn" id="dm-icon-btn">Save</button>' +
              '</div>' +
              '<label>Columns</label>' +
              '<div class="dm-cols">' + (columnsHtml || '<span class="muted">No editable columns</span>') + '</div>' +
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
                '<button class="btn primary" id="dm-newcol-btn">Add</button>' +
              '</div>' +
            '</div>' +
          '</details>';

        // ── Browse section: existing row picker ──
        var list = rows.map(function (r) {
          return '<li data-id="' + escapeHtml(r.id) + '">' + escapeHtml(displayNameFor(r)) + '</li>';
        }).join('');
        var browsePanel =
          '<details class="dm-section">' +
            '<summary><strong>Browse rows (' + rows.length + ')</strong></summary>' +
            (rows.length === 0
              ? '<div class="muted">No rows yet — use the Objects view to add one.</div>'
              : '<ul class="dm-rows">' + list + '</ul>') +
          '</details>';

        panel.innerHTML =
          '<h3>' + d.icon + ' ' + escapeHtml(d.label) + '</h3>' +
          editPanel + browsePanel;

        wireEntityEditPanel(panel, tableName);
        panel.querySelectorAll('li[data-id]').forEach(function (li) {
          li.addEventListener('click', function () {
            dmShowRowLinks(tableName, li.getAttribute('data-id'));
          });
        });
      });
    }

    /** Wire up the edit-entity controls in the Data Model side panel. */
    function wireEntityEditPanel(panel, tableName) {
      // Rename entity
      panel.querySelector('#dm-rename-btn').addEventListener('click', function () {
        var to = panel.querySelector('#dm-rename-input').value.trim();
        if (!to || to === tableName) return;
        if (!confirm('Rename entity "' + tableName + '" to "' + to + '"? This rewrites the SQL table and the YAML config.')) return;
        fetchJson('/api/schema/entities/' + encodeURIComponent(tableName) + '/rename', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ to: to }),
        }).then(function () {
          return reloadEverything();
        }).then(function () {
          location.hash = '#/settings/data-model';
        }).catch(function (err) { alert('Rename failed: ' + err.message); });
      });
      // Edit icon
      panel.querySelector('#dm-icon-btn').addEventListener('click', function () {
        var icon = panel.querySelector('#dm-icon-input').value.trim();
        fetchJson('/api/gui-meta/' + encodeURIComponent(tableName), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ icon: icon }),
        }).then(refreshIcons).then(function () { dmShowTableRows(tableName); })
          .catch(function (err) { alert('Icon save failed: ' + err.message); });
      });
      // Add column
      panel.querySelector('#dm-newcol-btn').addEventListener('click', function () {
        var name = panel.querySelector('#dm-newcol-name').value.trim();
        var type = panel.querySelector('#dm-newcol-type').value;
        if (!name) return;
        fetchJson('/api/schema/entities/' + encodeURIComponent(tableName) + '/columns', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: name, type: type }),
        }).then(function () {
          return reloadEverything();
        }).then(function () {
          location.hash = '#/settings/data-model';
        }).catch(function (err) { alert('Add column failed: ' + err.message); });
      });
      // Rename column
      panel.querySelectorAll('.dm-col-rename').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var col = btn.getAttribute('data-col');
          var input = panel.querySelector('input.dm-col-name[data-col="' + col + '"]');
          var to = input.value.trim();
          if (!to || to === col) return;
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
            location.hash = '#/settings/data-model';
          }).catch(function (err) { alert('Rename column failed: ' + err.message); });
        });
      });
    }

    function dmShowRowLinks(tableName, rowId) {
      dmActiveRowId = rowId;
      var t = tableByName(tableName);
      var junctions = junctionsFor(tableName);
      var panel = document.getElementById('dm-panel');
      panel.innerHTML = '<div class="muted">Loading…</div>';

      // Preload junctions + remote-side rows so chips + pickers can render.
      var fetches = [];
      junctions.forEach(function (j) {
        fetches.push(loadAllRows(j.junction));
        fetches.push(loadAllRows(j.remoteRel.table));
      });
      // Also reload the row itself in case it changed.
      fetches.push(loadAllRows(tableName));

      Promise.all(fetches).then(function () {
        var row = (loadedTables[tableName] || []).find(function (r) { return r.id === rowId; });
        if (!row) {
          panel.innerHTML = '<div class="muted">Row no longer exists.</div>';
          return;
        }

        var sections = junctions.map(function (j) {
          var matches = (loadedTables[j.junction] || []).filter(function (jr) {
            return jr[j.localFk] === rowId;
          });
          var linkedIds = new Set(matches.map(function (m) { return m[j.remoteRel.foreignKey]; }));
          var available = (loadedTables[j.remoteRel.table] || []).filter(function (o) {
            return !linkedIds.has(o.id);
          });
          var chips = matches.map(function (jr) {
            var remoteId = jr[j.remoteRel.foreignKey];
            var ref = (loadedTables[j.remoteRel.table] || []).find(function (x) { return x.id === remoteId; });
            if (!ref) return '';
            return '<span class="chip-removable" data-junction="' + escapeHtml(j.junction) +
              '" data-localfk="' + escapeHtml(j.localFk) +
              '" data-remotefk="' + escapeHtml(j.remoteRel.foreignKey) +
              '" data-local="' + escapeHtml(rowId) +
              '" data-remote="' + escapeHtml(remoteId) + '">' +
              escapeHtml(displayNameFor(ref)) +
              ' <button class="remove-link" title="Remove">×</button></span>';
          }).join('');
          var picker = available.length
            ? '<select class="dm-add" data-junction="' + escapeHtml(j.junction) +
                '" data-localfk="' + escapeHtml(j.localFk) +
                '" data-remotefk="' + escapeHtml(j.remoteRel.foreignKey) +
                '" data-local="' + escapeHtml(rowId) + '">' +
                '<option value="">+ Add link…</option>' +
                available.map(function (o) {
                  return '<option value="' + escapeHtml(o.id) + '">' +
                    escapeHtml(displayNameFor(o)) + '</option>';
                }).join('') +
              '</select>'
            : '<span class="muted">All ' + escapeHtml(titleCase(j.remoteRel.table).toLowerCase()) + ' linked</span>';
          return '<div class="dm-junction">' +
            '<h4>' + escapeHtml(titleCase(j.remoteRel.table)) + '</h4>' +
            '<div class="dm-chips">' + (chips || '<span class="muted">None yet</span>') + '</div>' +
            picker +
            '</div>';
        }).join('');

        panel.innerHTML =
          '<a class="breadcrumb" data-back-to="' + escapeHtml(tableName) + '">← ' +
            escapeHtml(displayFor(tableName).label) + '</a>' +
          '<h3>' + escapeHtml(displayNameFor(row) || row.id) + '</h3>' +
          (sections || '<div class="muted">This entity has no relationships to link.</div>');

        var back = panel.querySelector('[data-back-to]');
        if (back) {
          back.addEventListener('click', function (e) {
            e.preventDefault();
            dmShowTableRows(back.getAttribute('data-back-to'));
          });
        }

        panel.querySelectorAll('.remove-link').forEach(function (btn) {
          btn.addEventListener('click', function () {
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
              dmShowRowLinks(tableName, rowId);
            }).catch(function (err) {
              alert('Unlink failed: ' + err.message);
            });
          });
        });

        panel.querySelectorAll('select.dm-add').forEach(function (sel) {
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
              dmShowRowLinks(tableName, rowId);
            }).catch(function (err) {
              alert('Link failed: ' + err.message);
            });
          });
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

      var cx = 500, cy = 320, r = 240;
      var pos = {};
      tableNodes.forEach(function (n, i) {
        var a = (i / tableNodes.length) * Math.PI * 2 - Math.PI / 2;
        pos[n.id] = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
      });
      var edgeSvg = entityEdges.map(function (e) {
        var a = pos[e.source], b = pos[e.target];
        if (!a || !b) return '';
        var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        var color = e.type === 'belongs-to' ? '#2f6feb' : '#a16207';
        var dash = e.type === 'belongs-to' ? '' : ' stroke-dasharray="6 4"';
        var labelBg = '<rect x="' + (mx - 56) + '" y="' + (my - 9) + '" width="112" height="18" rx="9" fill="white" stroke="' + color + '" stroke-width="1" />';
        var labelText = '<text x="' + mx + '" y="' + (my + 4) + '" text-anchor="middle" font-size="10" fill="' + color + '">' +
          escapeHtml(e.type + (e.via && e.type === 'many-to-many' ? ' · ' + e.via : '')) + '</text>';
        return '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y +
          '" stroke="' + color + '" stroke-width="1.5"' + dash + ' />' + labelBg + labelText;
      }).join('');
      var nodeSvg = tableNodes.map(function (n) {
        var p = pos[n.id];
        var tableName = n.table || n.label;
        var d = displayFor(tableName);
        return '<g class="gnode" data-table="' + escapeHtml(tableName) + '">' +
          '<circle cx="' + p.x + '" cy="' + p.y + '" r="26" fill="#e7efff" stroke="#2f6feb" stroke-width="1.5" />' +
          '<text x="' + p.x + '" y="' + (p.y + 6) + '" text-anchor="middle" font-size="16">' + d.icon + '</text>' +
          '<text x="' + p.x + '" y="' + (p.y + 44) + '" text-anchor="middle" font-size="12" fill="#1f2328">' +
          escapeHtml(d.label) + '</text></g>';
      }).join('');
      return '<svg viewBox="0 0 1000 640" xmlns="http://www.w3.org/2000/svg">' + edgeSvg + nodeSvg + '</svg>';
    }

    init();
  })();
  </script>
</body>
</html>`;
