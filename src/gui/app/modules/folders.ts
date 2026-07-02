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
        '<span class="folders-crumb-cur">' + d.icon + ' ' +
          '<span class="fs-tile-name" data-rename="' + escapeHtml(table) + '" title="Click to rename">' + escapeHtml(d.label) + '</span>' +
        '</span>' +
        '</div>';
      setContent(content, myGen,
        '<div class="folders-view">' + crumb +
          // Linked + child folders show FIRST (no "Linked" header), then the items.
          (subFolders ? '<div class="fs-grid folders-grid folders-sub" id="folders-sub">' + subFolders + '</div>' : '') +
          '<h3 class="folders-section">Items</h3>' +
          '<div class="fs-grid folders-grid folders-files" id="folders-files"><div class="fs-empty" style="padding:12px">Loading…</div></div>' +
        '</div>');
      foldersWireGrid(document.getElementById('folders-sub'));
      var crumbName = content.querySelector('.folders-crumb-cur .fs-tile-name[data-rename]');
      if (crumbName) crumbName.addEventListener('click', function (e) { e.stopPropagation(); foldersRenameInline(crumbName); });
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
    // A FOLDER (the 📁 icon — the same one used across the app — with the object's
    // emoji + name as its label) or a FILE (the file-type emoji + name). A folder's
    // name is click-to-rename inline (no button, no popup).
    function foldersTileHtml(href, icon, label, table, meta, kind) {
      var isFolder = kind === 'folder';
      // Folder = the 📁 icon with the object's emoji laid on its face; name below.
      var iconHtml = isFolder
        ? '<span class="fs-folder-icon"><span class="fs-folder-base">📁</span>' +
            '<span class="fs-folder-badge">' + icon + '</span></span>'
        : icon;
      var labelHtml = isFolder
        ? '<span class="fs-tile-name" data-rename="' + escapeHtml(table) + '">' + escapeHtml(label) + '</span>'
        : escapeHtml(label);
      return '<div class="fs-tile fs-' + kind + ' mt-card" role="link" tabindex="0" ' +
        'data-href="' + escapeHtml(href) + '" data-table="' + escapeHtml(table) + '" data-kind="' + kind + '" ' +
        'title="' + escapeHtml(label) + '">' +
        '<div class="fs-tile-icon">' + iconHtml + '</div>' +
        '<div class="fs-tile-label">' + labelHtml + '</div>' +
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

    // Single-click opens the object/file page; right-click a folder renames it
    // inline (no button, no popup). A finished wire/merge drag is swallowed so it
    // doesn't also open.
    function foldersWireGrid(grid) {
      if (!grid) return;
      grid.querySelectorAll('.fs-tile').forEach(function (tile) {
        tile.addEventListener('click', function () {
          if (wmSuppressClick) return; // a wire/merge drag just finished
          var href = tile.getAttribute('data-href');
          if (href) location.hash = href;
        });
        tile.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { var href = tile.getAttribute('data-href'); if (href) location.hash = href; }
        });
        var nm = tile.querySelector('.fs-tile-name[data-rename]');
        if (nm) tile.addEventListener('contextmenu', function (e) { e.preventDefault(); foldersRenameInline(nm); });
      });
      // Folder tiles are wire/merge objects: drag one onto another to link,
      // Shift-drag to merge (the global Wire/Merge layer; skips file tiles).
      if (typeof wmWire === 'function') wmWire(grid);
    }

    // Slugify a friendly name to a valid object identifier (the rename route requires
    // /^[a-z][a-z0-9_]*$/); the display label derives back from it (title-cased).
    function foldersSlugify(s) {
      var slug = String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      if (/^[0-9]/.test(slug)) slug = '_' + slug;
      return slug;
    }

    // Inline rename: make the folder-name span editable in place; Enter/blur saves,
    // Esc cancels. The typed name is slugified to an identifier server-side.
    function foldersRenameInline(nm) {
      var table = nm.getAttribute('data-rename');
      if (!table || nm.getAttribute('contenteditable') === 'true') return;
      var orig = nm.textContent;
      nm.setAttribute('contenteditable', 'true');
      nm.classList.add('fs-renaming');
      nm.focus();
      try {
        var range = document.createRange(); range.selectNodeContents(nm);
        var sel = window.getSelection(); if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      } catch (e) { /* selection unavailable */ }
      function cleanup() {
        nm.removeAttribute('contenteditable'); nm.classList.remove('fs-renaming');
        nm.removeEventListener('keydown', onKey); nm.removeEventListener('blur', onBlur);
      }
      function onKey(e) {
        if (e.key === 'Enter') { e.preventDefault(); nm.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); nm.textContent = orig; nm.blur(); }
      }
      function onBlur() {
        var next = nm.textContent;
        cleanup();
        if (next && next.trim() && foldersSlugify(next) !== table) foldersDoRename(table, next);
        else nm.textContent = orig;
      }
      nm.addEventListener('keydown', onKey);
      nm.addEventListener('blur', onBlur);
    }
    function foldersDoRename(table, name) {
      var slug = foldersSlugify(name);
      if (!slug || slug === table) return;
      fetch('/api/schema/entities/' + encodeURIComponent(table) + '/rename', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: slug }),
      }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Rename failed');
          var goHash = location.hash.indexOf('#/folders/') === 0 ? '#/folders/' + encodeURIComponent(slug) : location.hash;
          if (typeof refreshEntities === 'function') {
            refreshEntities().then(function () { if (location.hash !== goHash) location.hash = goHash; renderRoute(); });
          }
          if (typeof showToast === 'function') showToast('Renamed to "' + slug + '"');
        });
      }).catch(function (err) { if (typeof showToast === 'function') showToast(err.message, { type: 'error' }); });
    }
`;
