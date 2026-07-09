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
          ? '<div class="brain-graph"><div id="graph-mount"></div></div>'
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
    function renderInputsTab(body) {
      if (!body) return;
      body.innerHTML =
        '<div class="inputs-group"><div class="inputs-group-head">Files</div>' +
        '<div id="inputs-files-tree"></div>' +
        '<div class="src-add-row src-add-files-wrap">' +
        '<button class="src-add" id="src-add-files" type="button" aria-haspopup="menu" aria-expanded="false">＋ File(s)</button>' +
        '<div class="src-add-menu" id="src-add-files-menu" role="menu" hidden>' +
        '<button type="button" class="src-add-menu-item" data-pick="file" role="menuitem">Add file(s)…</button>' +
        '<button type="button" class="src-add-menu-item" data-pick="folder" role="menuitem">Add a folder…</button>' +
        '</div></div>' +
        '<div class="src-note"><span class="src-note-ic">🔒</span>Secured: files never leave your computer.</div>' +
        '</div>' +
        '<div class="inputs-group"><div class="inputs-group-head">Connectors</div>' +
        '<div id="src-connectors-list"></div>' +
        '<button class="src-add" id="src-add-connector" type="button">＋ Add a Connector</button></div>' +
        '<div class="inputs-group"><div class="inputs-group-head">Databases</div>' +
        '<div id="src-databases-list"></div>' +
        '<button class="src-add" id="src-add-database" type="button">＋ Connect a Database</button></div>';
      if (typeof renderSourcesConnectors === 'function') renderSourcesConnectors();
      if (typeof renderInputsDatabases === 'function') renderInputsDatabases();
      if (typeof wireSourcesButtons === 'function') wireSourcesButtons();
      fetchJson('/api/tables/files/rows?exclude=' + encodeURIComponent('extracted_text,description'))
        .then(function (data) {
          var rows = ((data && data.rows) || []).filter(function (r) { return !r.deleted_at && !r.artifact_type; });
          if (typeof renderSourcesFilesInto === 'function') {
            renderSourcesFilesInto(document.getElementById('inputs-files-tree'), rows);
          }
        })
        .catch(function () {});
    }
`;
