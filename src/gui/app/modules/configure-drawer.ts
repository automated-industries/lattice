// Auto-composed segment of the GUI client script (see modules/index.ts). The
// Configure drawer's two new tabs — Data Model (Tables explorer + schema editor |
// Graph) and Inputs (Files | Connectors | Databases) — dispatched from
// selectDrawerTab (table-view.ts). Reuses the existing renderers + element ids so
// their render/wire fns work unchanged. Must stay INSIDE the client IIFE (uses
// fetchJson/renderModelTables/renderSchemaGraph/renderSourcesConnectors/…);
// registered before createDatabaseWizardJs.
export const configureDrawerJs = `
    // Open the Configure drawer to a tab. Guarded call to openSettingsDrawer (the drawer
    // machinery), which then calls selectDrawerTab. The subtab arg is legacy — Graph is now
    // its own top-level Configure tab, so a caller asking for the graph opens that tab.
    function openConfigureDrawer(tab, subtab) {
      if (typeof openSettingsDrawer === 'function') {
        openSettingsDrawer(subtab === 'graph' ? 'graph' : tab || 'datamodel');
      }
    }

    // ── Data Model tab: the tiered Tables explorer, FULL WIDTH. Graph is now its own
    // Configure tab (renderGraphTab). Selecting a table shows its read-only detail in the
    // explorer's own panel; the column/relationship editor stays an opt-in button, so
    // "selecting an object is enough". No 340px side panel eats the width.
    function renderDataModelTab(body) {
      if (!body) return;
      body.innerHTML =
        '<div class="dm-fullwidth"><div id="model-tables-host"></div>' +
        '<div id="dm-panel" class="dm-panel"></div></div>';
      if (typeof renderModelTables === 'function') {
        renderModelTables(document.getElementById('model-tables-host'));
      }
    }

    // ── Graph tab: the force-directed schema graph, FULL WIDTH, with a Link / Merge
    // toolbar. Link/Merge is a click-to-pick flow (click the button, then two nodes) —
    // the only mode that works on the graph, whose nodes own their own drag. Clicking a
    // table node drills into that table's rows shown visually as a graph; Back returns.
    function graphToolbarHtml(lead) {
      return (
        '<div class="graph-toolbar">' +
        (lead || '') +
        '<span class="graph-tools-spacer"></span>' +
        '<button type="button" class="btn btn-sm" id="wm-wire-btn">Link</button>' +
        '<button type="button" class="btn btn-sm" id="wm-merge-btn">Merge</button>' +
        '</div>'
      );
    }
    function wireGraphToolbar() {
      var w = document.getElementById('wm-wire-btn');
      if (w) w.addEventListener('click', function () { if (typeof wmSetMode === 'function') wmSetMode('wire'); });
      var m = document.getElementById('wm-merge-btn');
      if (m) m.addEventListener('click', function () { if (typeof wmSetMode === 'function') wmSetMode('merge'); });
      if (typeof wmRenderButtons === 'function') wmRenderButtons();
    }
    function renderGraphTab(body) {
      if (body) renderGraphSchema(body);
    }
    function renderGraphSchema(body) {
      if (!body) return;
      body.innerHTML =
        '<div class="graph-tab">' +
        graphToolbarHtml('') +
        '<div class="brain-graph"><div id="graph-mount">' +
        '<div class="graph-loading"><div class="graph-spinner"></div></div></div></div>' +
        '</div>';
      wireGraphToolbar();
      // A plain node click drills into that table's rows (shown visually as a graph).
      schemaNodeDrill = function (table) { renderGraphEntity(body, table); };
      if (typeof renderSchemaGraph === 'function') renderSchemaGraph();
    }
    function renderGraphEntity(body, table) {
      if (!body) return;
      var d = typeof displayFor === 'function' ? displayFor(table) : { icon: '', label: table };
      body.innerHTML =
        '<div class="graph-tab">' +
        graphToolbarHtml(
          '<button type="button" class="btn btn-sm" id="graph-back">\\u2190 All objects</button>' +
            '<span class="graph-drill-label">' + d.icon + ' ' + escapeHtml(d.label) + '</span>',
        ) +
        '<div class="brain-graph entity-graph"><div id="graph-mount">' +
        '<div class="graph-loading"><div class="graph-spinner"></div></div></div></div>' +
        '</div>';
      var back = document.getElementById('graph-back');
      if (back) back.addEventListener('click', function () { renderGraphSchema(body); });
      wireGraphToolbar();
      schemaNodeDrill = null; // at row level, a node click opens that record (below)
      if (typeof renderEntityGraphInto === 'function') {
        renderEntityGraphInto(document.getElementById('graph-mount'), table, {
          onRecord: function (t, id) {
            location.hash = '#/w/table/' + encodeURIComponent(t) + '/' + encodeURIComponent(id);
          },
        });
      }
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
