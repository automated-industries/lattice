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
      // One files load drives both the Files ref_uri map and the Artifacts list.
      loadAllRows('files')
        .then(function (rows) {
          rows = (rows || []).filter(function (r) { return !r.deleted_at; });
          sourcesFilesByPath = {};
          rows.forEach(function (r) {
            if (r.ref_kind === 'local_ref' && r.ref_uri) sourcesFilesByPath[r.ref_uri] = r.id;
          });
          renderSourcesArtifacts(rows.filter(function (r) { return r.artifact_type; }));
        })
        .catch(function () { renderSourcesArtifacts([]); });
      renderSourcesFiles();
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

    function renderSourcesFiles() {
      var host = document.getElementById('src-files-tree');
      if (!host) return;
      // Files are on-disk + local-only; the endpoint reports enabled:false on a
      // cloud/locked workspace, where the tree simply isn't offered.
      fetchJson('/api/sources/roots')
        .then(function (data) {
          if (!data || data.enabled === false) {
            host.innerHTML = '<div class="src-note">Available on a local workspace.</div>';
            return;
          }
          var roots = data.roots || [];
          host.innerHTML = roots.length
            ? '<ul class="src-tree">' + roots.map(function (r) {
                return sourceNodeHtml(r.path, r.name, r.kind, 0);
              }).join('') + '</ul>'
            : '<div class="src-empty">No files yet.</div>';
          wireSourceTree(host);
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
        row.addEventListener('click', function () { openSourceFile(row.parentNode.getAttribute('data-path')); });
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

    function renderSourcesArtifacts(artifacts) {
      var host = document.getElementById('src-artifacts-tree');
      if (!host) return;
      if (!artifacts.length) { host.innerHTML = '<div class="src-empty">Nothing created yet.</div>'; return; }
      host.innerHTML = '<ul class="src-tree">' + artifacts.map(function (r) {
        var name = r.name || r.original_name || 'Untitled';
        var ic = r.artifact_type === 'html' ? '🌐' : '📝';
        return '<li class="src-node src-file" data-id="' + escapeHtml(r.id) +
          '"><div class="src-row" style="padding-left:14px"><span class="src-ic">' + ic +
          '</span><span class="src-name">' + escapeHtml(name) + '</span></div></li>';
      }).join('') + '</ul>';
      host.querySelectorAll('.src-file > .src-row').forEach(function (row) {
        row.addEventListener('click', function () {
          location.hash = '#/fs/files/' + encodeURIComponent(row.parentNode.getAttribute('data-id'));
        });
      });
    }

    function renderSourcesConnectors() {
      var host = document.getElementById('src-connectors-list');
      if (!host) return;
      fetchJson('/api/connectors')
        .then(function (data) {
          var connectors = (data && data.connectors) || [];
          host.innerHTML = connectors.length
            ? '<ul class="src-tree">' + connectors.map(function (c) {
                var color = c.status === 'connected' ? 'var(--accent)'
                  : (c.status === 'error' ? 'var(--danger, #c0392b)' : 'var(--text-muted)');
                var title = c.toolkit.charAt(0).toUpperCase() + c.toolkit.slice(1);
                return '<li class="src-node src-conn"><div class="src-row" style="padding-left:14px">' +
                  '<span class="src-dot" style="background:' + color + '"></span>' +
                  '<span class="src-name">' + escapeHtml(title) + '</span></div></li>';
              }).join('') + '</ul>'
            : '<div class="src-empty">None connected.</div>';
          host.querySelectorAll('.src-conn > .src-row').forEach(function (row) {
            row.addEventListener('click', function () { openSettingsDrawer('connectors'); });
          });
        })
        .catch(function () { host.innerHTML = ''; });
    }

    // The add buttons live in the static shell, so wire them ONCE (renderSources
    // runs on every sidebar refresh).
    function wireSourcesButtons() {
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
        addConn.addEventListener('click', function () { openSettingsDrawer('connectors'); });
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
          return fetch('/api/sources/roots', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: d.path, kind: kind }),
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
