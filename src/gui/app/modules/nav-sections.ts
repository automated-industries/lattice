// Auto-composed segment of the GUI client script (see modules/index.ts). The
// left-sidebar nav sections beneath Dashboards: Tables, Files. Each opens a typed
// Workspace tab by setting the hash (the tab host renders it). Collapse state reuses
// the shared .section-toggle[data-group] idiom (sources.ts). Must stay INSIDE the
// client IIFE (uses state/escapeHtml/fetchJson/displayFor/mtClassifyTier/MT_LAYERS/
// renderSourcesFilesInto); registered before createDatabaseWizardJs. Function
// declarations hoist, so call order is free.
export const navSectionsJs = `
    // TABLES — every model table grouped by tier (Inputs / Derived / Computed),
    // read from the in-memory state.entities (no fetch). Click → #/w/table/<name>.
    function renderNavTables() {
      var host = document.getElementById('nav-tables-list');
      if (!host) return;
      var tables = ((state.entities && state.entities.tables) || []).filter(function (t) {
        return t && t.name && !(typeof isJunction === 'function' && isJunction(t.name));
      });
      var activeM = /^#\\/w\\/table\\/([^\\/]+)/.exec(location.hash);
      var activeName = activeM ? decodeURIComponent(activeM[1]) : '';
      var html = MT_LAYERS.map(function (layer) {
        var group = tables.filter(function (t) { return mtClassifyTier(t) === layer.id; });
        if (!group.length) return '';
        return '<div class="nav-tier"><div class="nav-tier-head">' + escapeHtml(layer.short || layer.name) + '</div>' +
          group.map(function (t) {
            var d = typeof displayFor === 'function' ? displayFor(t.name) : { icon: '🗂️', label: t.name };
            return '<button type="button" class="nav-table-item' + (t.name === activeName ? ' active' : '') +
              '" data-table="' + escapeHtml(t.name) + '" title="' + escapeHtml(d.label) + '">' +
              '<span class="nav-item-ic">' + (d.icon || '🗂️') + '</span>' +
              '<span class="nav-item-name">' + escapeHtml(d.label) + '</span></button>';
          }).join('') + '</div>';
      }).join('');
      host.innerHTML = html || '<div class="nav-empty">No tables yet.</div>';
      host.querySelectorAll('.nav-table-item').forEach(function (b) {
        if (b.__wired) return; b.__wired = true;
        b.addEventListener('click', function () {
          location.hash = '#/w/table/' + encodeURIComponent(b.getAttribute('data-table'));
        });
      });
    }

    // FILES — the source-files tree (roots + loose files), into the sidebar host.
    // Leaf click → #/fs/files/<id>, which the router normalizes to #/w/file/<id>.
    function renderNavFiles() {
      var host = document.getElementById('nav-files-tree');
      if (!host) return;
      fetchJson('/api/tables/files/rows?exclude=' + encodeURIComponent('extracted_text,description'))
        .then(function (data) {
          var rows = ((data && data.rows) || []).filter(function (r) { return !r.deleted_at && !r.artifact_type; });
          renderSourcesFilesInto(host, rows);
        })
        .catch(function () { renderSourcesFilesInto(host, []); });
    }

    function renderNavSections() {
      renderNavTables();
      renderNavFiles();
      // Enforce the single-open accordion (keeps one nav section open, collapses the
      // rest) + wire the toggles (both idempotent — enforceNavAccordion reconciles
      // localStorage, wire guards on __wired).
      if (typeof enforceNavAccordion === 'function') enforceNavAccordion();
      else if (typeof applySidebarGroupState === 'function') {
        ['nav-tables', 'nav-files', 'nav-md'].forEach(applySidebarGroupState);
      }
      if (typeof wireSidebarGroupToggles === 'function') wireSidebarGroupToggles();
    }
`;
