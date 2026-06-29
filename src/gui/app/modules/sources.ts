// Auto-composed segment of the GUI client script (see modules/index.ts). The
// Sources sidebar: three peer sections — Files (a lazy, infinitely-nestable tree
// of on-disk roots, local-only), Artifacts (Lattice-created files), and
// Connectors. renderSources() is called wherever renderSidebar() is. Must stay
// INSIDE the client IIFE (uses fetchJson/escapeHtml/loadAllRows/openSettingsDrawer),
// inserted before createDatabaseWizardJs.
export const sourcesJs = `
    // Map of on-disk path → ingested files-row id, refreshed on each renderSources
    // so a Files-tree leaf click opens the already-ingested row's tab.
    var sourcesFilesByPath = {};

    function renderSources() {
      renderSourcesConnectors();
      renderInputsDatabases();
      // The Outputs > Tables mirror reflects the same entities; keep it fresh as
      // the sidebar re-renders (cheap — reads in-memory state, no fetch).
      if (typeof renderOutputsTables === 'function') renderOutputsTables();
      // One files load drives both the Files ref_uri map and the Artifacts list.
      // Project OUT the heavy extracted_text/description columns (up to ~200 KB a
      // row) the sidebar never reads — this runs on every sidebar re-render, so a
      // SELECT * here would be a large repeated read (bounded-reads). RLS scoping
      // is unchanged (same /rows endpoint).
      fetchJson('/api/tables/files/rows?exclude=' + encodeURIComponent('extracted_text,description'))
        .then(function (data) {
          var rows = (data && data.rows) || [];
          rows = rows.filter(function (r) { return !r.deleted_at; });
          sourcesFilesByPath = {};
          rows.forEach(function (r) {
            if (r.ref_kind === 'local_ref' && r.ref_uri) sourcesFilesByPath[r.ref_uri] = r.id;
          });
          // Artifacts (Lattice-created files) now live in the Outputs column.
          renderOutputsArtifacts(rows.filter(function (r) { return r.artifact_type; }));
          // Source files = everything the user ingested/uploaded (NOT Lattice-created
          // artifacts). Shown in the Files section alongside any registered on-disk
          // roots — so existing files appear even before a folder is added.
          renderSourcesFiles(rows.filter(function (r) { return !r.artifact_type; }));
        })
        .catch(function () { renderOutputsArtifacts([]); renderSourcesFiles([]); });
      wireSourcesButtons();
    }

    function sourceNodeHtml(path, name, kind, depth) {
      var pad = depth * 12;
      if (kind === 'folder') {
        return '<li class="src-node src-folder" data-path="' + escapeHtml(path) +
          '" data-depth="' + depth + '" data-loaded="0">' +
          '<div class="src-row" style="padding-left:' + pad + 'px">' +
            '<span class="src-caret">▸</span><span class="src-ic">📁</span>' +
            '<span class="src-name">' + escapeHtml(name) + '</span></div>' +
          '<ul class="src-children" hidden></ul></li>';
      }
      return '<li class="src-node src-file" data-path="' + escapeHtml(path) +
        '"><div class="src-row" style="padding-left:' + (pad + 14) + 'px">' +
        '<span class="src-ic">📄</span><span class="src-name">' + escapeHtml(name) + '</span></div></li>';
    }

    function renderSourcesFiles(sourceFiles) {
      var host = document.getElementById('src-files-tree');
      if (!host) return;
      sourceFiles = sourceFiles || [];
      // The Files section shows the user's source files (ingested/uploaded) PLUS any
      // registered on-disk roots as lazy trees. Roots live on the local FS so the
      // roots endpoint reports enabled:false on a cloud/locked workspace; the
      // already-ingested source files still show there (they're DB rows).
      fetchJson('/api/sources/roots')
        .then(function (data) {
          var roots = (data && data.roots) || [];
          var folderPaths = roots
            .filter(function (r) { return r.kind === 'folder'; })
            .map(function (r) { return r.path; });
          // Normalize path separators so the containment checks below work on
          // Windows (the server stores native-separator absolute paths) as well as
          // POSIX — '\\' → '/'.
          var fsNorm = function (p) { return (p || '').replace(/\\\\/g, '/'); };
          // Loose files = source files NOT under a registered folder root (those show
          // inside the tree); an uploaded file (no on-disk path) is always loose.
          var loose = sourceFiles.filter(function (r) {
            if (!r.ref_uri) return true;
            var u = fsNorm(r.ref_uri);
            return !folderPaths.some(function (p) {
              var np = fsNorm(p);
              return u === np || u.indexOf(np + '/') === 0;
            });
          });
          // Only show roots that aren't nested INSIDE another shown root. A folder
          // that physically lives under another folder (e.g. Downloads/Hello world)
          // must appear ONLY in its real place — lazily, under its parent — never
          // duplicated at the top level. Mirrors the real filesystem tree (separator-
          // agnostic, so it holds on Windows too).
          var topRoots = roots.filter(function (r) {
            if (r.kind !== 'folder' || !r.path) return true;
            var rn = fsNorm(r.path);
            return !roots.some(function (o) {
              return o !== r && o.kind === 'folder' && o.path && rn.indexOf(fsNorm(o.path) + '/') === 0;
            });
          });
          var rootsHtml = topRoots.length
            ? '<ul class="src-tree">' + topRoots.map(function (r) {
                return sourceNodeHtml(r.path, r.name, r.kind, 0);
              }).join('') + '</ul>'
            : '';
          var looseHtml = loose.length
            ? '<ul class="src-tree">' + loose.map(function (r) {
                var name = r.name || r.original_name || 'Untitled';
                return '<li class="src-node src-file" data-id="' + escapeHtml(r.id) +
                  '"><div class="src-row" style="padding-left:14px">' +
                  '<span class="src-ic">' + fileEmoji(r) + '</span>' +
                  '<span class="src-name">' + escapeHtml(name) + '</span></div></li>';
              }).join('') + '</ul>'
            : '';
          // Preserve expanded folders across this re-render so an in-progress
          // ingest (which re-renders the sidebar) never snaps an open folder shut.
          // Capture each expanded folder's path + its lazily-loaded children markup,
          // then re-attach + re-open them after the rebuild (no re-fetch, no flicker).
          var openFolders = {};
          host.querySelectorAll('.src-folder[data-loaded="1"]').forEach(function (li) {
            var ul0 = li.querySelector(':scope > .src-children');
            if (ul0 && !ul0.hidden) openFolders[li.getAttribute('data-path')] = ul0.innerHTML;
          });
          if (!rootsHtml && !looseHtml) {
            host.innerHTML = '<div class="src-empty">No files yet.</div>';
            return;
          }
          host.innerHTML = rootsHtml + looseHtml;
          wireSourceTree(host);
          host.querySelectorAll('.src-folder').forEach(function (li) {
            var saved = openFolders[li.getAttribute('data-path')];
            if (saved == null) return;
            var ul1 = li.querySelector(':scope > .src-children');
            var caret = li.querySelector(':scope > .src-row > .src-caret');
            if (!ul1) return;
            ul1.innerHTML = saved;
            ul1.hidden = false;
            li.setAttribute('data-loaded', '1');
            if (caret) caret.textContent = '▾';
            wireSourceTree(ul1);
          });
        })
        .catch(function () { host.innerHTML = ''; });
    }

    function wireSourceTree(scope) {
      scope.querySelectorAll('.src-folder > .src-row').forEach(function (row) {
        if (row.__wired) return;
        row.__wired = true;
        row.addEventListener('click', function () { toggleSourceFolder(row.parentNode); });
      });
      scope.querySelectorAll('.src-file > .src-row').forEach(function (row) {
        if (row.__wired) return;
        row.__wired = true;
        row.addEventListener('click', function () {
          var li = row.parentNode;
          // A loose source file carries the files-row id (open it directly); an
          // on-disk tree leaf carries its path (resolve/ingest, then open).
          var id = li.getAttribute('data-id');
          if (id) { location.hash = '#/fs/files/' + encodeURIComponent(id); return; }
          openSourceFile(li.getAttribute('data-path'));
        });
      });
    }

    function toggleSourceFolder(li) {
      var childrenUl = li.querySelector(':scope > .src-children');
      var caret = li.querySelector(':scope > .src-row > .src-caret');
      if (!childrenUl) return;
      if (!childrenUl.hidden) { childrenUl.hidden = true; if (caret) caret.textContent = '▸'; return; }
      if (li.getAttribute('data-loaded') === '1') {
        childrenUl.hidden = false;
        if (caret) caret.textContent = '▾';
        return;
      }
      var path = li.getAttribute('data-path');
      var depth = Number(li.getAttribute('data-depth') || '0') + 1;
      fetchJson('/api/sources/list?path=' + encodeURIComponent(path))
        .then(function (data) {
          var entries = (data && data.entries) || [];
          childrenUl.innerHTML = entries.map(function (e) {
            return sourceNodeHtml(e.path, e.name, e.kind, depth);
          }).join('') + (data && data.truncated ? '<li class="src-note">…more not shown</li>' : '');
          li.setAttribute('data-loaded', '1');
          childrenUl.hidden = false;
          if (caret) caret.textContent = '▾';
          wireSourceTree(childrenUl);
        })
        .catch(function () {});
    }

    function openSourceFile(path) {
      var id = sourcesFilesByPath[path];
      if (id) { location.hash = '#/fs/files/' + encodeURIComponent(id); return; }
      // A file present on disk but not yet ingested (e.g. added to the folder
      // after the initial scan) — ingest it in place, then open its tab.
      fetch('/api/ingest/file', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: path }),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d.id) location.hash = '#/fs/files/' + encodeURIComponent(d.id); })
        .catch(function () {});
    }

    function renderSourcesConnectors() {
      var host = document.getElementById('src-connectors-list');
      if (!host) return;
      fetchJson('/api/connectors')
        .then(function (data) {
          var connectors = (data && data.connectors) || [];
          var presById = {};
          ((data && data.toolkits) || []).forEach(function (t) { presById[t.toolkit] = t; });
          host.innerHTML = connectors.length
            ? '<ul class="src-tree">' + connectors.map(function (c) {
                var pres = presById[c.toolkit] || {};
                var color = c.status === 'connected' ? 'var(--accent)'
                  : (c.status === 'error' ? 'var(--danger, #c0392b)' : 'var(--text-muted)');
                // Each connected source shows its logo, with the status as a small
                // colored ring/dot overlay.
                var mark = pres.icon
                  ? '<span class="src-conn-ic"><img class="connector-icon" src="' + escapeHtml(pres.icon) + '" alt="">' +
                      '<span class="src-conn-dot" style="background:' + color + '"></span></span>'
                  : '<span class="src-dot" style="background:' + color + '"></span>';
                var label = pres.label || (c.toolkit.charAt(0).toUpperCase() + c.toolkit.slice(1));
                return '<li class="src-node src-conn"><div class="src-row" style="padding-left:14px">' +
                  mark + '<span class="src-name">' + escapeHtml(label) + '</span></div></li>';
              }).join('') + '</ul>'
            : '<div class="src-empty">None connected.</div>';
          host.querySelectorAll('.src-conn > .src-row').forEach(function (row) {
            row.addEventListener('click', function () { openConnectorsDialog(); });
          });
        })
        .catch(function () { host.innerHTML = ''; });
    }

    // The add buttons live in the static shell, so wire them ONCE (renderSources
    // runs on every sidebar refresh).
    // ── Collapsible top-level sidebar groups ──────────────────────────────
    // Each top-level group header (Files, Built by Lattice, Connectors, plus
    // Objects/System in advanced mode) collapses its body. State persists per
    // group in localStorage (default expanded). The Objects/System collapse
    // toggles the inner .section-body ONLY — the #objects-section/#system-section
    // wrapper's hidden attribute stays owned by advanced-mode (renderSidebar), so
    // the two never fight. Reuses the chevron/hidden idiom of toggleSourceFolder.
    function sidebarGroupKey(group) { return 'lattice.sidebar.group.' + group; }
    function sidebarGroupCollapsed(group) {
      try { return window.localStorage.getItem(sidebarGroupKey(group)) === '0'; }
      catch (e) { return false; } // default expanded when storage is unavailable
    }
    function setSidebarGroupCollapsed(group, collapsed) {
      try { window.localStorage.setItem(sidebarGroupKey(group), collapsed ? '0' : '1'); }
      catch (e) { /* private mode / quota — state just won't persist */ }
    }
    function applySidebarGroupState(group) {
      var btn = document.querySelector('.section-toggle[data-group="' + group + '"]');
      var body = document.querySelector('.section-body[data-group-body="' + group + '"]');
      if (!btn || !body) return;
      var collapsed = sidebarGroupCollapsed(group);
      body.hidden = collapsed;
      var caret = btn.querySelector('.section-caret');
      if (caret) caret.textContent = collapsed ? '▸' : '▾';
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
    function applySidebarGroupStates() {
      [
        'files', 'connectors', 'databases',
        'out-artifacts', 'out-markdown', 'out-tables', 'out-serverdocs', 'out-apidocs', 'out-mcp',
        'objects', 'system',
      ].forEach(applySidebarGroupState);
    }
    function toggleSidebarGroup(group) {
      setSidebarGroupCollapsed(group, !sidebarGroupCollapsed(group));
      applySidebarGroupState(group);
    }
    function wireSidebarGroupToggles() {
      var btns = document.querySelectorAll('.section-toggle[data-group]');
      for (var i = 0; i < btns.length; i++) {
        var btn = btns[i];
        if (btn.__wired) continue;
        btn.__wired = true;
        (function (b) {
          b.addEventListener('click', function () { toggleSidebarGroup(b.getAttribute('data-group')); });
        })(btn);
      }
    }

    function wireSourcesButtons() {
      wireSidebarGroupToggles();
      applySidebarGroupStates();
      var addFolder = document.getElementById('src-add-folder');
      if (addFolder && !addFolder.__wired) {
        addFolder.__wired = true;
        addFolder.addEventListener('click', function () { addSource('folder'); });
      }
      var addFile = document.getElementById('src-add-file');
      if (addFile && !addFile.__wired) {
        addFile.__wired = true;
        addFile.addEventListener('click', function () { addSource('file'); });
      }
      var addConn = document.getElementById('src-add-connector');
      if (addConn && !addConn.__wired) {
        addConn.__wired = true;
        addConn.addEventListener('click', function () { openConnectorsDialog(); });
      }
    }

    function addSource(kind) {
      // Native OS picker (server-side); null path = cancelled.
      fetch('/api/sources/pick', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: kind }),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || d.enabled === false) { showToast('Local file access is disabled.', {}); return; }
          if (d.cancelled || !d.path) return;
          showToast(kind === 'folder' ? 'Ingesting folder…' : 'Ingesting file…', {});
          // A folder is registered as a browsable root (and its files ingested); a
          // single file is just ingested — it shows in the Files list as a loose
          // file. Registering a one-file "root" would double it (root leaf + the
          // ingested row). The ingest's realtime feed drives the graph animation;
          // we deliberately DON'T navigate to the new file (it just appears).
          var url = kind === 'folder' ? '/api/sources/roots' : '/api/ingest/file';
          var body = kind === 'folder' ? { path: d.path, kind: kind } : { path: d.path };
          return fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
            .then(function (r) { return r.json(); })
            .then(function (res) {
              if (res.error) { showToast('Add failed: ' + res.error, {}); return; }
              renderSources();
            });
        })
        .catch(function (e) { showToast('Add failed: ' + (e && e.message ? e.message : e), {}); });
    }
`;
