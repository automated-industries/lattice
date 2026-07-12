// Auto-composed segment of the GUI client script (see modules/index.ts). The
// Configure drawer's two new tabs — Data Model (Tables explorer + schema editor |
// Graph) and Inputs (Files | Connectors | Databases) — dispatched from
// selectDrawerTab (table-view.ts). Reuses the existing renderers + element ids so
// their render/wire fns work unchanged. Must stay INSIDE the client IIFE (uses
// fetchJson/renderModelTables/renderSchemaGraph/renderSourcesConnectors/…);
// registered before createDatabaseWizardJs.
export const configureDrawerJs = `
    var DM_SUBTAB_KEY = 'lattice.datamodel.subtab';
    var pendingDmSubtab = null;

    // Open the Configure drawer to a tab (+ optional Data-Model subtab). Guarded call
    // to openSettingsDrawer (the drawer machinery), which then calls selectDrawerTab.
    function openConfigureDrawer(tab, subtab) {
      if (subtab) pendingDmSubtab = subtab;
      if (typeof openSettingsDrawer === 'function') openSettingsDrawer(tab || 'datamodel');
    }

    // ── Data Model tab: Tables (tiered explorer + schema editor) | Graph ──
    function renderDataModelTab(body) {
      if (!body) return;
      var sub = pendingDmSubtab;
      pendingDmSubtab = null;
      if (!sub) { try { sub = window.localStorage.getItem(DM_SUBTAB_KEY); } catch (e) {} }
      sub = sub === 'graph' ? 'graph' : 'tables';
      try { window.localStorage.setItem(DM_SUBTAB_KEY, sub); } catch (e) {}
      body.innerHTML =
        '<div class="dm-subtabs">' +
        '<button type="button" class="tab' + (sub === 'tables' ? ' active' : '') + '" data-dmsub="tables">Tables</button>' +
        '<button type="button" class="tab' + (sub === 'graph' ? ' active' : '') + '" data-dmsub="graph">Graph</button>' +
        '</div>' +
        (sub === 'graph'
          ? '<div class="dm-tables-merge"><div class="brain-graph"><div id="graph-mount"></div></div><div id="dm-panel" class="dm-panel"></div></div>'
          : '<div class="dm-tables-merge"><div id="model-tables-host"></div><div id="dm-panel" class="dm-panel"></div></div>');
      body.querySelectorAll('[data-dmsub]').forEach(function (b) {
        b.addEventListener('click', function () {
          try { window.localStorage.setItem(DM_SUBTAB_KEY, b.getAttribute('data-dmsub')); } catch (e) {}
          renderDataModelTab(body);
        });
      });
      if (sub === 'graph') { if (typeof renderSchemaGraph === 'function') renderSchemaGraph(); }
      else if (typeof renderModelTables === 'function') renderModelTables(document.getElementById('model-tables-host'));
    }

    // ── Inputs tab: Files | Connectors | Databases (existing ids, existing fns) ──
    var INPUTS_FILES_VIEW_KEY = 'lattice.inputs.files.view';
    function inputsFilesView() {
      try { return window.localStorage.getItem(INPUTS_FILES_VIEW_KEY) === 'grid' ? 'grid' : 'list'; }
      catch (e) { return 'list'; }
    }
    // Render the Inputs Files as the source tree (list, default) OR a tile grid
    // (fsTileHtml). Both open a file with #/w/file/<id>.
    function renderInputsFiles(rows) {
      var host = document.getElementById('inputs-files-tree');
      if (!host) return;
      var view = inputsFilesView();
      var toggle = document.getElementById('inputs-files-toggle');
      if (toggle) {
        toggle.querySelectorAll('[data-view]').forEach(function (b) {
          b.classList.toggle('on', b.getAttribute('data-view') === view);
        });
      }
      if (view === 'grid' && typeof fsTileHtml === 'function') {
        host.innerHTML = rows.length
          ? '<div class="fs-grid">' + rows.map(function (r) {
              var nm = r.name || r.original_name || 'Untitled';
              var ic = typeof fileEmoji === 'function' ? fileEmoji(r) : '📄';
              return fsTileHtml('#/w/file/' + encodeURIComponent(r.id), ic, nm, 'files', '', 'file');
            }).join('') + '</div>'
          : '<div class="src-empty">No files yet.</div>';
        host.querySelectorAll('.fs-tile[data-href]').forEach(function (t) {
          t.addEventListener('click', function () { location.hash = t.getAttribute('data-href'); });
        });
      } else if (typeof renderSourcesFilesInto === 'function') {
        renderSourcesFilesInto(host, rows);
      }
    }
    // Files / Connectors / Databases are now three separate Configure tabs (the tab
    // name IS the heading, so the old .inputs-group-head subheadings are dropped). Each
    // reuses the same element ids + wiring fns as the former single Inputs tab.
    function renderFilesTab(body) {
      if (!body) return;
      body.innerHTML =
        '<div class="inputs-group">' +
        '<div class="inputs-files-bar u-mb-2" style="display:flex;justify-content:flex-end">' +
        '<span class="inputs-files-toggle" id="inputs-files-toggle">' +
        '<button type="button" class="ift-btn" data-view="list" title="List view">☰</button>' +
        '<button type="button" class="ift-btn" data-view="grid" title="Grid view">▦</button></span></div>' +
        '<div id="inputs-files-tree"></div>' +
        '<div class="src-add-row src-add-files-wrap">' +
        '<button class="src-add" id="src-add-files" type="button" aria-haspopup="menu" aria-expanded="false">＋ File(s)</button>' +
        '<div class="src-add-menu" id="src-add-files-menu" role="menu" hidden>' +
        '<button type="button" class="src-add-menu-item" data-pick="file" role="menuitem">Add file(s)…</button>' +
        '<button type="button" class="src-add-menu-item" data-pick="folder" role="menuitem">Add a folder…</button>' +
        '</div></div>' +
        '<div class="src-note"><span class="src-note-ic">🔒</span>Secured: files never leave your computer.</div>' +
        '</div>';
      if (typeof wireSourcesButtons === 'function') wireSourcesButtons();
      var loadFiles = function () {
        fetchJson('/api/tables/files/rows?exclude=' + encodeURIComponent('extracted_text,description'))
          .then(function (data) {
            renderInputsFiles(((data && data.rows) || []).filter(function (r) { return !r.deleted_at && !r.artifact_type; }));
          })
          .catch(function () { renderInputsFiles([]); });
      };
      var toggle = document.getElementById('inputs-files-toggle');
      if (toggle) {
        toggle.querySelectorAll('[data-view]').forEach(function (b) {
          b.addEventListener('click', function () {
            try { window.localStorage.setItem(INPUTS_FILES_VIEW_KEY, b.getAttribute('data-view')); } catch (e) {}
            loadFiles();
          });
        });
      }
      loadFiles();
    }
    function renderConnectorsTab(body) {
      if (!body) return;
      body.innerHTML =
        '<div class="inputs-group"><div id="src-connectors-list"></div>' +
        '<button class="src-add" id="src-add-connector" type="button">＋ Add a Connector</button></div>';
      if (typeof renderSourcesConnectors === 'function') renderSourcesConnectors();
      if (typeof wireSourcesButtons === 'function') wireSourcesButtons();
    }
    function renderDatabasesTab(body) {
      if (!body) return;
      body.innerHTML =
        '<div class="inputs-group"><div id="src-databases-list"></div>' +
        '<button class="src-add" id="src-add-database" type="button">＋ Connect a Database</button></div>';
      if (typeof renderInputsDatabases === 'function') renderInputsDatabases();
    }
`;
