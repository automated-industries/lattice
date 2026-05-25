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

    /* Data Model legacy graph container */
    #graph-mount { width: 100%; min-height: 70vh; background: var(--surface);
      border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
    #graph-mount svg { width: 100%; height: 65vh; }
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
    // Table view (read-only in this commit)
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

        var bodyRows;
        if (rows.length === 0) {
          var emptyCols = intrinsic.length + belongsTo.length + junctions.length;
          bodyRows = '<tr class="empty-row"><td colspan="' + emptyCols + '">No rows yet</td></tr>';
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
            return '<tr data-id="' + escapeHtml(r.id) + '">' + tds.join('') + '</tr>';
          }).join('');
        }

        content.innerHTML =
          '<div class="view-header">' +
            '<span class="entity-icon">' + d.icon + '</span>' +
            '<h1>' + escapeHtml(d.label) + '</h1>' +
            '<span class="count">' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + '</span>' +
          '</div>' +
          '<table>' +
            '<thead><tr>' + headers + '</tr></thead>' +
            '<tbody>' + bodyRows + '</tbody>' +
          '</table>';

        content.querySelectorAll('tr[data-id]').forEach(function (tr) {
          tr.addEventListener('click', function () {
            location.hash = '#/objects/' + tableName + '/' + tr.getAttribute('data-id');
          });
        });
      }).catch(function (err) {
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // ────────────────────────────────────────────────────────────
    // Detail view (read-only in this commit)
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
        var rows = [];
        intrinsic.forEach(function (c) {
          rows.push('<dt>' + escapeHtml(fieldLabel(c)) + '</dt>' +
                    '<dd>' + (row[c] == null ? '<span class="muted">—</span>' : escapeHtml(row[c])) + '</dd>');
        });
        belongsTo.forEach(function (b) {
          var ref = (loadedTables[b.rel.table] || []).find(function (x) { return x.id === row[b.rel.foreignKey]; });
          rows.push('<dt>' + escapeHtml(titleCase(b.relName)) + '</dt>' +
                    '<dd>' + (ref ? '<span class="chip">' + escapeHtml(displayNameFor(ref)) + '</span>' : '<span class="muted">—</span>') + '</dd>');
        });
        junctions.forEach(function (j) {
          var matches = (loadedTables[j.junction] || []).filter(function (jr) { return jr[j.localFk] === row.id; });
          var chips = matches.map(function (jr) {
            var ref = (loadedTables[j.remoteRel.table] || []).find(function (x) { return x.id === jr[j.remoteRel.foreignKey]; });
            return ref ? '<span class="chip">' + escapeHtml(displayNameFor(ref)) + '</span>' : '';
          }).join(' ');
          rows.push('<dt>' + escapeHtml(titleCase(j.remoteRel.table)) + '</dt>' +
                    '<dd>' + (chips || '<span class="muted">—</span>') + '</dd>');
        });

        content.innerHTML =
          '<a class="breadcrumb" href="#/objects/' + tableName + '">← ' + escapeHtml(d.label) + '</a>' +
          '<div class="view-header">' +
            '<span class="entity-icon">' + d.icon + '</span>' +
            '<h1>' + escapeHtml(displayNameFor(row) || d.label) + '</h1>' +
          '</div>' +
          '<div class="detail"><dl>' + rows.join('') + '</dl></div>';
      }).catch(function (err) {
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // ────────────────────────────────────────────────────────────
    // Data Model — bare SVG graph (will get link/unlink UI later)
    // ────────────────────────────────────────────────────────────
    function renderDataModel(content) {
      content.innerHTML =
        '<div class="view-header">' +
          '<span class="entity-icon">⚙</span>' +
          '<h1>Data Model</h1>' +
        '</div>' +
        '<div id="graph-mount"><div class="muted">Loading graph…</div></div>';

      fetchJson('/api/graph').then(function (graph) {
        var mount = document.getElementById('graph-mount');
        mount.innerHTML = renderGraphSvg(graph);
      }).catch(function (err) {
        document.getElementById('graph-mount').innerHTML =
          '<div class="muted">Failed to load graph: ' + escapeHtml(err.message) + '</div>';
      });
    }

    function renderGraphSvg(graph) {
      // Simple circular layout — table nodes only, since junctions encode edges.
      var tableNodes = graph.nodes.filter(function (n) { return n.type === 'table'; });
      var keep = new Set(tableNodes.map(function (n) { return n.id; }));
      var edges = graph.edges.filter(function (e) { return keep.has(e.source) && keep.has(e.target) && e.type !== 'markdown'; });
      var cx = 500, cy = 320, r = 240;
      var pos = {};
      tableNodes.forEach(function (n, i) {
        var a = (i / tableNodes.length) * Math.PI * 2 - Math.PI / 2;
        pos[n.id] = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
      });
      var edgeSvg = edges.map(function (e) {
        var a = pos[e.source], b = pos[e.target];
        if (!a || !b) return '';
        return '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y +
          '" stroke="#c9cdd4" stroke-width="1.5" />';
      }).join('');
      var nodeSvg = tableNodes.map(function (n) {
        var p = pos[n.id];
        return '<g><circle cx="' + p.x + '" cy="' + p.y + '" r="22" fill="#e7efff" stroke="#2f6feb" stroke-width="1.5" />' +
          '<text x="' + p.x + '" y="' + (p.y + 38) + '" text-anchor="middle" font-size="12" fill="#1f2328">' +
          escapeHtml(n.label) + '</text></g>';
      }).join('');
      return '<svg viewBox="0 0 1000 640" xmlns="http://www.w3.org/2000/svg">' + edgeSvg + nodeSvg + '</svg>';
    }

    init();
  })();
  </script>
</body>
</html>`;
