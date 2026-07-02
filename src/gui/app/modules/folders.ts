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
    // Top-level objects, alphabetised — each is a folder. A nested object (one
    // that belongsTo a parent) is hidden here: it shows INSIDE its parent instead
    // (via fsRelations reverse-1:N). Objects with no belongsTo parent are roots.
    function foldersModel() {
      return mtBuildModel().filter(function (e) {
        return foldersParentTables(e.name).length === 0;
      }).slice().sort(function (a, b) {
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
      // Breadcrumb parent chain: root … immediate-parent … this folder. Each
      // ancestor is a link AND a drop target (drag a folder onto it to move it
      // out to that level); the "Folders" root drops to the top level.
      var chain = foldersAncestorChain(table);
      var crumbParents = chain.map(function (p) {
        var pd = displayFor(p);
        return '<span class="folders-crumb-sep">/</span>' +
          '<a class="folders-crumb-link" href="#/folders/' + encodeURIComponent(p) + '" data-crumb-table="' + escapeHtml(p) + '">' +
            pd.icon + ' ' + escapeHtml(pd.label) + '</a>';
      }).join('');
      var crumb = '<div class="folders-crumbs"><a href="#/folders" data-crumb-table="">Objects</a>' +
        crumbParents +
        '<span class="folders-crumb-sep">/</span>' +
        '<span class="folders-crumb-cur">' + d.icon + ' ' +
          '<span class="fs-tile-name" data-rename="' + escapeHtml(table) + '" title="Click to rename">' + escapeHtml(d.label) + '</span>' +
        '</span>' +
        '</div>';
      setContent(content, myGen,
        '<div class="folders-view">' + crumb +
          // ONE "Items" section: child + linked folders list FIRST, then the rows.
          '<h3 class="folders-section">Items</h3>' +
          '<div class="fs-grid folders-grid folders-files" id="folders-files">' +
            subFolders +
            '<div class="fs-empty folders-loading" style="padding:12px">Loading…</div>' +
          '</div>' +
        '</div>');
      // Wire the folders now so a nest drag works before the rows finish loading.
      foldersWireGrid(document.getElementById('folders-files'));
      var crumbName = content.querySelector('.folders-crumb-cur .fs-tile-name[data-rename]');
      if (crumbName) crumbName.addEventListener('click', function (e) { e.stopPropagation(); foldersRenameInline(crumbName); });
      // Load the object's rows → file tiles, then re-render the Items grid as
      // (folders first) + (file rows). Folders and files share the one grid.
      fetchRowsPage(table, { limit: 300 }).then(fsServerPage).then(function (view) {
        if (myGen !== renderGen) return;
        var host = document.getElementById('folders-files');
        if (!host) return;
        var filesHtml = view.rows.map(function (r) {
          return foldersTileHtml('#/fs/' + encodeURIComponent(table) + '/' + encodeURIComponent(r.id),
            fileEmoji(r), foldersRowLabel(r), table, '', 'file');
        }).join('');
        host.innerHTML = (subFolders + filesHtml) || '<div class="fs-empty" style="padding:12px">No items yet.</div>';
        foldersWireGrid(host);
      }).catch(function (err) {
        if (myGen !== renderGen) return;
        var host = document.getElementById('folders-files');
        if (host) host.innerHTML = subFolders + '<div class="fs-empty" style="padding:12px">Failed to load items: ' + escapeHtml(err.message) + '</div>';
      });
    }

    // An object or file tile. Also an mt-card + data-table so the global wire/merge
    // drag handler can treat it as a wireable object. Double-click / Enter opens.
    // An OBJECT (its own emoji + name as its label) or a FILE (the file-type emoji +
    // name). An object's name is click-to-rename inline (no button, no popup). We use
    // the object's OWN emoji — not a folder icon — since these are objects, not folders.
    function foldersTileHtml(href, icon, label, table, meta, kind) {
      var isFolder = kind === 'folder';
      var iconHtml = icon;
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
      // Folder tiles: DRAG one folder onto another to NEST it (a one-to-many
      // relationship — the dragged folder becomes a child of the target). This is
      // distinct from the global Wire/Merge many-to-many link, which on the
      // Folders page is reached with the "Link" button (click a source, then a
      // target). Dragging a nested folder out onto empty space un-nests it.
      if (typeof wmWire === 'function') wmWire(grid, foldersNestDrop, foldersUnnestDrop);
    }

    // The belongsTo parents of a table (the folders IT is nested under).
    function foldersParentTables(table) {
      var t = tableByName(table);
      if (!t) return [];
      var out = [];
      var rels = t.relations || {};
      for (var k in rels) {
        if (!Object.prototype.hasOwnProperty.call(rels, k)) continue;
        if (rels[k] && rels[k].type === 'belongsTo' && rels[k].table) out.push(rels[k].table);
      }
      return out;
    }
    // Walk UP the belongsTo chain from the table; true if maybeAncestor is reached.
    // Used to reject a nest that would create a cycle (nesting A under one of its
    // own descendants). Bounded by a seen-set so a pre-existing cycle can't hang.
    function foldersIsAncestor(maybeAncestor, table) {
      var seen = {};
      var stack = foldersParentTables(table);
      while (stack.length) {
        var p = stack.pop();
        if (p === maybeAncestor) return true;
        if (seen[p]) continue;
        seen[p] = 1;
        stack = stack.concat(foldersParentTables(p));
      }
      return false;
    }
    // The parent chain [root, …, immediate-parent] for breadcrumbs. Follows the
    // first belongsTo parent at each level (a folder usually has one), seen-set
    // bounded so a cycle can't loop forever.
    function foldersAncestorChain(table) {
      var chain = [];
      var seen = {};
      var cur = table;
      while (true) {
        var parents = foldersParentTables(cur);
        if (!parents.length) break;
        var p = parents[0];
        if (seen[p]) break;
        seen[p] = 1;
        chain.unshift(p);
        cur = p;
      }
      return chain;
    }

    // Nest source under target: source belongsTo target (target becomes the
    // parent). A completed folder-on-folder drag calls this.
    function foldersNestDrop(source, target) {
      if (!source || !target || source === target) return;
      // A folder can't be nested into its own descendant (would loop the tree).
      if (foldersIsAncestor(source, target)) {
        if (typeof showToast === 'function') showToast("Can't nest a folder inside its own child", { type: 'error' });
        return;
      }
      fetch('/api/schema/entities/' + encodeURIComponent(source) + '/links', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: target }),
      }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
        .then(function (res) {
          if (!res.ok) {
            // Already nested there → desired end state already holds; fail silently.
            var e = (res.body && res.body.error) || '';
            if (!/already link/i.test(e) && typeof showToast === 'function') showToast('Could not nest: ' + (e || 'failed'), { type: 'error' });
            return;
          }
          if (typeof showToast === 'function') showToast(displayFor(source).label + ' nested under ' + displayFor(target).label);
          if (typeof refreshEntities === 'function') refreshEntities().then(function () { renderRoute({ soft: true }); }); else renderRoute({ soft: true });
        }).catch(function () { if (typeof showToast === 'function') showToast('Could not nest', { type: 'error' }); });
    }

    // Drag a folder onto the BREADCRUMB → un-nest it from the CURRENT parent (the
    // folder whose view we're in), moving it up a level. Requiring the drop to
    // land on the breadcrumb keeps a stray drop on empty space from un-nesting by
    // accident. Only meaningful inside a folder view (the top level has no parent).
    function foldersUnnestDrop(source, ev) {
      var at = (ev && document.elementFromPoint) ? document.elementFromPoint(ev.clientX, ev.clientY) : null;
      if (!at || !at.closest || !at.closest('.folders-crumbs')) return;
      var m = /^#\\/folders\\/([^/]+)/.exec(location.hash || '');
      var parent = m ? decodeURIComponent(m[1]) : '';
      if (!parent || parent === source) return;
      foldersUnnest(source, parent);
    }

    // Remove source's belongsTo → parent (drop the FK), un-nesting it. The row
    // data is preserved (soft-delete on the server), so it's undoable.
    function foldersUnnest(source, parent) {
      var t = tableByName(source);
      if (!t) return;
      var fk = null;
      var rels = t.relations || {};
      for (var k in rels) {
        if (!Object.prototype.hasOwnProperty.call(rels, k)) continue;
        if (rels[k] && rels[k].type === 'belongsTo' && rels[k].table === parent) { fk = rels[k].foreignKey; break; }
      }
      if (!fk) return; // not nested under this parent
      fetch('/api/schema/entities/' + encodeURIComponent(source) + '/links/' + encodeURIComponent(fk), { method: 'DELETE' })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
        .then(function (res) {
          if (!res.ok) { if (typeof showToast === 'function') showToast('Could not move out: ' + ((res.body && res.body.error) || 'failed'), { type: 'error' }); return; }
          if (typeof showToast === 'function') showToast(displayFor(source).label + ' moved out of ' + displayFor(parent).label);
          if (typeof refreshEntities === 'function') refreshEntities().then(function () { renderRoute({ soft: true }); }); else renderRoute({ soft: true });
        }).catch(function () { if (typeof showToast === 'function') showToast('Could not move out', { type: 'error' }); });
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
