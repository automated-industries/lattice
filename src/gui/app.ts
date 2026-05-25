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
    .view-header .entity-icon { font-size: 22px; }
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

    /* Row delete control */
    .row-actions { width: 36px; text-align: center; }
    .row-delete {
      background: transparent; border: none; color: var(--text-muted);
      font-size: 16px; cursor: pointer; padding: 4px 8px;
      border-radius: 4px;
    }
    tr:hover .row-delete { color: #b42318; }
    .row-delete:hover { background: #fef3f2; }

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

    var state = { entities: null, rowCache: {} };

    function displayFor(name) {
      return DISPLAY[name] || { label: titleCase(name), icon: '·' };
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
      fetchJson('/api/entities').then(function (data) {
        state.entities = data;
        renderSidebar();
        renderRoute();
      }).catch(function (err) {
        document.getElementById('content').innerHTML =
          '<div class="placeholder"><h2>Failed to load</h2>' + escapeHtml(err.message) + '</div>';
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

    var loadedTables = {};
    function loadAllRows(tableName) {
      if (loadedTables[tableName]) return Promise.resolve(loadedTables[tableName]);
      return fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows').then(function (d) {
        loadedTables[tableName] = d.rows;
        return d.rows;
      });
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
     * Refresh /api/entities so dashboard row counts stay in sync after a
     * mutation. The Objects sidebar doesn't change, so we don't re-render it.
     */
    function refreshEntities() {
      return fetchJson('/api/entities').then(function (d) {
        state.entities = d;
      });
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

      // Fetch this entity's rows + every related entity's rows so we can resolve names.
      var fetches = [loadAllRows(tableName)];
      belongsTo.forEach(function (b) { fetches.push(loadAllRows(b.rel.table)); });
      junctions.forEach(function (j) {
        fetches.push(loadAllRows(j.junction));
        fetches.push(loadAllRows(j.remoteRel.table));
      });

      Promise.all(fetches).then(function () {
        var rows = loadedTables[tableName];
        var headers = intrinsic.map(fieldLabel)
          .concat(belongsTo.map(function (b) { return titleCase(b.relName); }))
          .concat(junctions.map(function (j) { return titleCase(j.remoteRel.table); }))
          .map(function (h) { return '<th>' + escapeHtml(h) + '</th>'; }).join('');
        headers += '<th class="row-actions"></th>';

        var bodyRows;
        var totalCols = intrinsic.length + belongsTo.length + junctions.length + 1;
        if (rows.length === 0) {
          bodyRows = '<tr class="empty-row"><td colspan="' + totalCols + '">No rows yet — click “+ New” to add one</td></tr>';
        } else {
          bodyRows = rows.map(function (r) {
            var tds = intrinsic.map(function (c) {
              return '<td>' + escapeHtml(truncate(r[c], 120)) + '</td>';
            });
            belongsTo.forEach(function (b) {
              var ref = (loadedTables[b.rel.table] || []).find(function (x) { return x.id === r[b.rel.foreignKey]; });
              tds.push('<td>' + (ref ? '<span class="chip">' + escapeHtml(displayNameFor(ref)) + '</span>' : '<span class="muted">—</span>') + '</td>');
            });
            junctions.forEach(function (j) {
              var matches = (loadedTables[j.junction] || []).filter(function (jr) { return jr[j.localFk] === r.id; });
              var remoteFkCol = j.remoteRel.foreignKey;
              var chips = matches.map(function (jr) {
                var ref = (loadedTables[j.remoteRel.table] || []).find(function (x) { return x.id === jr[remoteFkCol]; });
                return ref ? '<span class="chip">' + escapeHtml(displayNameFor(ref)) + '</span>' : '';
              }).join('');
              tds.push('<td>' + (chips || '<span class="muted">—</span>') + '</td>');
            });
            tds.push('<td class="row-actions"><button class="row-delete" title="Delete" data-del="' + escapeHtml(r.id) + '">✕</button></td>');
            return '<tr data-id="' + escapeHtml(r.id) + '">' + tds.join('') + '</tr>';
          }).join('');
        }

        content.innerHTML =
          '<div class="view-header">' +
            '<span class="entity-icon">' + d.icon + '</span>' +
            '<h1>' + escapeHtml(d.label) + '</h1>' +
            '<span class="count">' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + '</span>' +
            '<div class="actions">' +
              '<button class="btn primary" id="new-row">+ New</button>' +
            '</div>' +
          '</div>' +
          '<table>' +
            '<thead><tr>' + headers + '</tr></thead>' +
            '<tbody>' + bodyRows + '</tbody>' +
          '</table>';

        document.getElementById('new-row').addEventListener('click', function () {
          openCreateModal(tableName);
        });

        content.querySelectorAll('button.row-delete').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var id = btn.getAttribute('data-del');
            if (!confirm('Delete this row?')) return;
            fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id), {
              method: 'DELETE',
            }).then(function () {
              invalidate(tableName);
              return refreshEntities();
            }).then(function () {
              renderTable(content, tableName);
            }).catch(function (err) {
              alert('Delete failed: ' + err.message);
            });
          });
        });

        content.querySelectorAll('tr[data-id]').forEach(function (tr) {
          tr.addEventListener('click', function (e) {
            if (e.target && e.target.closest('button')) return;
            location.hash = '#/objects/' + tableName + '/' + tr.getAttribute('data-id');
          });
        });
      }).catch(function (err) {
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    function openCreateModal(tableName) {
      var t = tableByName(tableName);
      var intrinsic = intrinsicColumns(t);
      var belongsTo = belongsToColumns(t);
      // Make sure referenced tables are loaded so the FK <select>s have options.
      var prefetch = Promise.all(belongsTo.map(function (b) { return loadAllRows(b.rel.table); }));
      prefetch.then(function () {
        var fkCols = belongsTo.map(function (b) { return b.rel.foreignKey; });
        var allCols = intrinsic.concat(fkCols);
        var body = allCols.map(function (c) {
          return '<div class="field"><label>' + escapeHtml(fieldLabel(c)) + '</label>' + fieldFor(c, '', t) + '</div>';
        }).join('');
        showModal('New ' + (displayFor(tableName).label.replace(/s$/, '') || tableName), body, {
          primaryLabel: 'Create',
          onSubmit: function (scope) {
            var values = collectFormValues(scope);
            return fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(values),
            }).then(function () {
              invalidate(tableName);
              return refreshEntities();
            }).then(function () {
              renderTable(document.getElementById('content'), tableName);
            });
          },
        });
      }).catch(function (err) {
        alert('Failed to prepare form: ' + err.message);
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
              dd = ref ? '<span class="chip">' + escapeHtml(displayNameFor(ref)) + '</span>' : '<span class="muted">—</span>';
            }
            rows.push('<dt>' + escapeHtml(titleCase(b.relName)) + '</dt><dd>' + dd + '</dd>');
          });
          // Junctions are read-only here — managed via Data Model.
          junctions.forEach(function (j) {
            var matches = (loadedTables[j.junction] || []).filter(function (jr) { return jr[j.localFk] === row.id; });
            var chips = matches.map(function (jr) {
              var ref = (loadedTables[j.remoteRel.table] || []).find(function (x) { return x.id === jr[j.remoteRel.foreignKey]; });
              return ref ? '<span class="chip">' + escapeHtml(displayNameFor(ref)) + '</span>' : '';
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
        var d = displayFor(tableName);
        var list = rows.map(function (r) {
          return '<li data-id="' + escapeHtml(r.id) + '">' + escapeHtml(displayNameFor(r)) + '</li>';
        }).join('');
        panel.innerHTML =
          '<h3>' + d.icon + ' ' + escapeHtml(d.label) + '</h3>' +
          (rows.length === 0
            ? '<div class="muted">No rows yet — use the Objects view to add one.</div>'
            : '<ul class="dm-rows">' + list + '</ul>');
        panel.querySelectorAll('li[data-id]').forEach(function (li) {
          li.addEventListener('click', function () {
            dmShowRowLinks(tableName, li.getAttribute('data-id'));
          });
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

      // Build edges between first-class entities via shared junctions.
      var entityEdges = [];
      state.entities.tables.forEach(function (t) {
        if (!isJunction(t)) return;
        var rels = Object.values(t.relations);
        if (rels.length === 2) {
          entityEdges.push({ source: 'table:' + rels[0].table, target: 'table:' + rels[1].table });
        }
      });
      // Plus belongsTo edges (e.g. repositories → projects).
      state.entities.tables.forEach(function (t) {
        if (isJunction(t)) return;
        Object.values(t.relations || {}).forEach(function (r) {
          if (r.type === 'belongsTo') {
            entityEdges.push({ source: 'table:' + t.name, target: 'table:' + r.table });
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
        return '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y +
          '" stroke="#c9cdd4" stroke-width="1.5" />';
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
