// Auto-composed segment of the GUI client script (see modules/index.ts). The
// "Folders" view — the default center tab. Objects are shown as a grid of FOLDERS;
// double-click a folder to open it, where its rows show as "files" (icon by type)
// and its LINKED objects show as nested sub-folders (A appears inside B and B
// inside A when they're linked). Clicking a file opens that record's file page
// (#/fs/<obj>/<id>). Reuses the shared fs-grid / fs-tile styling and mtBuildModel /
// fsRelations / fileEmoji / displayFor from the earlier segments (one client IIFE,
// function declarations hoist), so it must be composed after model-tables.js and
// before createDatabaseWizard.js (where the IIFE closes).
export const foldersJs = `
    // Every non-junction object, alphabetised — each is a folder.
    function foldersModel() {
      return mtBuildModel().slice().sort(function (a, b) {
        return String(a.label || '').toLowerCase().localeCompare(String(b.label || '').toLowerCase());
      });
    }

    // Top level (#/folders): every object as a folder tile.
    function renderFoldersView(content) {
      var myGen = renderGen;
      var model = foldersModel();
      if (!model.length) {
        setContent(content, myGen, '<div class="folders-view"><div class="fs-empty" style="padding:32px">No objects yet — add a source or create one.</div></div>');
        return;
      }
      var tiles = model.map(function (e) {
        var meta = (typeof e.rowCount === 'number') ? (e.rowCount + (e.rowCount === 1 ? ' item' : ' items')) : '';
        return foldersTileHtml('#/folders/' + encodeURIComponent(e.name), e.icon, e.label, e.name, meta, 'folder');
      }).join('');
      setContent(content, myGen,
        '<div class="folders-view"><div class="fs-grid folders-grid" id="folders-grid">' + tiles + '</div></div>');
      foldersWireGrid(document.getElementById('folders-grid'));
    }

    // One folder opened (#/folders/<obj>): linked objects as sub-folders + rows as files.
    function renderFolderEntity(content, table) {
      var myGen = renderGen;
      if (!tableByName(table)) {
        setContent(content, myGen, '<div class="folders-view"><div class="fs-empty" style="padding:32px">Unknown object: ' + escapeHtml(table) + '</div></div>');
        return;
      }
      var d = displayFor(table);
      var rels = fsRelations(table);
      var subFolders = rels.map(function (rel) {
        return foldersTileHtml('#/folders/' + encodeURIComponent(rel.targetTable),
          displayFor(rel.targetTable).icon, rel.label, rel.targetTable, 'linked', 'folder');
      }).join('');
      var crumb = '<div class="folders-crumbs"><a href="#/folders">Folders</a>' +
        '<span class="folders-crumb-sep">/</span>' +
        '<span class="folders-crumb-cur">' + d.icon + ' ' + escapeHtml(d.label) + '</span>' +
        '<button type="button" class="folders-rename-cur" data-table="' + escapeHtml(table) + '" title="Rename object">✎ Rename</button>' +
        '</div>';
      setContent(content, myGen,
        '<div class="folders-view">' + crumb +
          (subFolders ? '<h3 class="folders-section">Linked</h3><div class="fs-grid folders-grid folders-sub" id="folders-sub">' + subFolders + '</div>' : '') +
          '<h3 class="folders-section">Items</h3>' +
          '<div class="fs-grid folders-grid folders-files" id="folders-files"><div class="fs-empty" style="padding:12px">Loading…</div></div>' +
        '</div>');
      foldersWireGrid(document.getElementById('folders-sub'));
      var renameCur = content.querySelector('.folders-rename-cur');
      if (renameCur) renameCur.addEventListener('click', function () {
        foldersRenameObject(table, null);
      });
      // Load the object's rows → file tiles.
      fetchRowsPage(table, { limit: 300 }).then(fsServerPage).then(function (view) {
        if (myGen !== renderGen) return;
        var host = document.getElementById('folders-files');
        if (!host) return;
        if (!view.rows.length) { host.innerHTML = '<div class="fs-empty" style="padding:12px">No items yet.</div>'; return; }
        host.innerHTML = view.rows.map(function (r) {
          return foldersTileHtml('#/fs/' + encodeURIComponent(table) + '/' + encodeURIComponent(r.id),
            fileEmoji(r), foldersRowLabel(r), table, '', 'file');
        }).join('');
        foldersWireGrid(host);
      }).catch(function (err) {
        if (myGen !== renderGen) return;
        var host = document.getElementById('folders-files');
        if (host) host.innerHTML = '<div class="fs-empty" style="padding:12px">Failed to load items: ' + escapeHtml(err.message) + '</div>';
      });
    }

    // A folder or file tile. Also an mt-card + data-table so the global wire/merge
    // drag handler can treat it as a wireable object. Double-click / Enter opens.
    function foldersTileHtml(href, icon, label, table, meta, kind) {
      var isFolder = kind === 'folder';
      return '<div class="fs-tile fs-' + kind + ' mt-card" role="link" tabindex="0" ' +
        'data-href="' + escapeHtml(href) + '" data-table="' + escapeHtml(table) + '" data-kind="' + kind + '" ' +
        'title="' + escapeHtml(label) + '">' +
        (isFolder ? '<button type="button" class="fs-tile-rename" title="Rename" aria-label="Rename">✎</button>' : '') +
        '<div class="fs-tile-icon">' + icon + '</div>' +
        '<div class="fs-tile-label">' + escapeHtml(label) + '</div>' +
        (meta ? '<div class="fs-folder-count">' + escapeHtml(String(meta)) + '</div>' : '') +
        '</div>';
    }

    // Human label for a row: name/title/label/… then a first meaningful field, else id.
    function foldersRowLabel(r) {
      var pref = ['name', 'title', 'label', 'subject', 'original_name', 'slug'];
      for (var i = 0; i < pref.length; i++) { if (r[pref[i]]) return String(r[pref[i]]); }
      for (var k in r) {
        if (!r.hasOwnProperty(k)) continue;
        if (k === 'id' || k.slice(-3) === '_id' || k.slice(-3) === '_at' || k === 'deleted_at') continue;
        if (r[k]) return String(r[k]).slice(0, 60);
      }
      return String(r.id || '(item)');
    }

    // Open on double-click / Enter (single click is left for wire/merge selection);
    // the hover pencil renames a folder object.
    function foldersWireGrid(grid) {
      if (!grid) return;
      grid.querySelectorAll('.fs-tile').forEach(function (tile) {
        tile.addEventListener('dblclick', function () {
          var href = tile.getAttribute('data-href');
          if (href) location.hash = href;
        });
        tile.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { var href = tile.getAttribute('data-href'); if (href) location.hash = href; }
        });
        var rn = tile.querySelector('.fs-tile-rename');
        if (rn) rn.addEventListener('click', function (e) {
          e.stopPropagation();
          foldersRenameObject(tile.getAttribute('data-table'), tile.querySelector('.fs-tile-label'));
        });
      });
    }

    // Slugify a friendly name to a valid object identifier (the rename route requires
    // /^[a-z][a-z0-9_]*$/); the display label derives back from it (title-cased).
    function foldersSlugify(s) {
      var slug = String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      if (/^[0-9]/.test(slug)) slug = '_' + slug;
      return slug;
    }

    // Rename an object (folder). Renames the table via the schema rename route; the
    // shown name derives from the identifier, so a friendly name is slugified.
    function foldersRenameObject(table, labelEl) {
      if (!table) return;
      var cur = labelEl ? labelEl.textContent : displayFor(table).label;
      var next = window.prompt('Rename "' + cur + '" to:', cur);
      if (next == null) return;
      var slug = foldersSlugify(next);
      if (!slug || slug === table) return;
      fetch('/api/schema/entities/' + encodeURIComponent(table) + '/rename', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: slug }),
      }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Rename failed');
          var goHash = location.hash.indexOf('#/folders/') === 0 ? '#/folders/' + encodeURIComponent(slug) : location.hash;
          if (typeof refreshEntities === 'function') {
            refreshEntities().then(function () { location.hash = goHash; renderRoute(); if (location.hash === goHash) renderRoute(); });
          }
          if (typeof showToast === 'function') showToast('Renamed to "' + slug + '"');
        });
      }).catch(function (err) { if (typeof showToast === 'function') showToast(err.message, 'error'); });
    }
`;
