// Auto-composed segment of the GUI client script (see modules/index.ts). The
// Sources sidebar: Files (a lazy, infinitely-nestable tree of on-disk roots,
// local-only) + Artifacts (Lattice-created files). MCP connectors live entirely
// in the Configure drawer's MCP Connectors tab, not the sidebar.
// renderSources() is called wherever renderSidebar() is. Must stay
// INSIDE the client IIFE (uses fetchJson/escapeHtml/loadAllRows/openSettingsDrawer),
// inserted before createDatabaseWizardJs.
export const sourcesJs = `
    // Map of on-disk path → ingested files-row id, refreshed on each renderSources
    // so a Files-tree leaf click opens the already-ingested row's tab.
    var sourcesFilesByPath = {};

    function renderSources() {
      renderInputsDatabases();
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
          // Source files = everything the user ingested/uploaded (NOT Lattice-created
          // artifacts). Shown in the Files section alongside any registered on-disk
          // roots — so existing files appear even before a folder is added.
          renderSourcesFiles(rows.filter(function (r) { return !r.artifact_type; }));
        })
        .catch(function () { renderSourcesFiles([]); });
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
      renderSourcesFilesInto(document.getElementById('src-files-tree'), sourceFiles);
    }
    // Render the source-files tree (roots + loose files + lazy folders) INTO a given
    // host element — used by the Configure drawer's Files tab (#inputs-files-tree). Leaf
    // clicks navigate to #/fs/files/<id>, which the router normalizes to #/w/file/<id>.
    function renderSourcesFilesInto(host, sourceFiles) {
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
            host.innerHTML = '<div class="src-empty">No files yet — add files or a whole folder below.</div>';
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
        'objects', 'system',
        // Left-sidebar single-layout nav sections (Files is now a table, not a section).
        'nav-dashboards', 'nav-tables',
      ].forEach(applySidebarGroupState);
    }
    // The left-sidebar nav sections behave as a single-open ACCORDION — opening one
    // collapses the other. The Configure-drawer groups (files/connectors/databases/
    // objects/system) are NOT in this set, so they stay independent.
    // The left sidebar has two single-open sections — Dashboards and Tables. TABLES is
    // the default OPEN one (index 0 → enforceNavAccordion's fallback when none is open):
    // it's the primary data nav, so a fresh load lands with your tables visible.
    // (nav-schema-* groups WITHIN Tables are independent — not listed here.)
    var NAV_ACCORDION_GROUPS = ['nav-tables', 'nav-dashboards'];
    function toggleSidebarGroup(group) {
      var willExpand = sidebarGroupCollapsed(group); // currently collapsed → about to open
      if (NAV_ACCORDION_GROUPS.indexOf(group) !== -1) {
        // Single-open accordion (the left-sidebar nav sections): a header click always
        // OPENS its section and collapses the siblings. Clicking the already-open section
        // is a no-op — never collapse the only-open one, so exactly one section stays
        // visible at all times.
        if (!willExpand) return;
        NAV_ACCORDION_GROUPS.forEach(function (g) {
          if (g !== group) { setSidebarGroupCollapsed(g, true); applySidebarGroupState(g); }
        });
        setSidebarGroupCollapsed(group, false);
        applySidebarGroupState(group);
        return;
      }
      // Independent groups (the Configure-drawer sections) keep a plain open/close toggle.
      setSidebarGroupCollapsed(group, !sidebarGroupCollapsed(group));
      applySidebarGroupState(group);
    }
    // Enforce single-open among the nav accordion on (re)render: keep the FIRST
    // currently-open nav section open (default the first when none) and collapse the
    // rest. Nav groups default expanded, so a fresh load would show all three — this
    // reduces it to one. Idempotent; safe to call on every renderNavSections.
    function enforceNavAccordion() {
      var openGroup = null;
      NAV_ACCORDION_GROUPS.forEach(function (g) {
        if (!openGroup && !sidebarGroupCollapsed(g)) openGroup = g;
      });
      if (!openGroup) openGroup = NAV_ACCORDION_GROUPS[0];
      NAV_ACCORDION_GROUPS.forEach(function (g) {
        setSidebarGroupCollapsed(g, g !== openGroup);
        applySidebarGroupState(g);
      });
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
      // One "＋ Add files or folder" button covers both: click opens a small menu to add
      // file(s) OR a folder (the OS picker for each differs, so they stay two
      // menu items behind one button rather than two sidebar buttons).
      var addFiles = document.getElementById('src-add-files');
      var addFilesMenu = document.getElementById('src-add-files-menu');
      if (addFiles && addFilesMenu && !addFiles.__wired) {
        addFiles.__wired = true;
        function closeAddMenu() {
          addFilesMenu.hidden = true;
          addFiles.setAttribute('aria-expanded', 'false');
        }
        addFiles.addEventListener('click', function (e) {
          e.stopPropagation();
          var show = addFilesMenu.hidden;
          addFilesMenu.hidden = !show;
          addFiles.setAttribute('aria-expanded', show ? 'true' : 'false');
        });
        addFilesMenu.querySelectorAll('.src-add-menu-item').forEach(function (mi) {
          mi.addEventListener('click', function () {
            closeAddMenu();
            addSource(mi.getAttribute('data-pick'));
          });
        });
        // Dismiss on an outside click / Escape.
        document.addEventListener('click', closeAddMenu);
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAddMenu(); });
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
              // Show result feedback: ingested/skipped counts.
              var result = res.result;
              var msg = '';
              if (kind === 'folder' && result) {
                var ingested = result.ingested || 0;
                var skipped = result.skipped || 0;
                if (ingested === 0 && skipped === 0) {
                  msg = 'Folder added, but it contains no files — nothing ingested.';
                } else if (ingested === 0 && skipped > 0) {
                  msg = 'No files ingested — ' + skipped + ' skipped (unsupported, too large, or unreadable).';
                } else {
                  msg = 'Ingested ' + ingested + ' file' + (ingested === 1 ? '' : 's');
                  if (skipped > 0) {
                    msg += ', ' + skipped + ' skipped';
                  }
                  msg += '.';
                }
              } else if (kind === 'file') {
                if (res.id) {
                  msg = 'Ingested 1 file.';
                } else {
                  msg = 'File was not ingested (unsupported, too large, or unreadable).';
                }
              }
              if (msg) showToast(msg, {});
              renderSources();
            });
        })
        .catch(function (e) { showToast('Add failed: ' + (e && e.message ? e.message : e), {}); });
    }
`;
