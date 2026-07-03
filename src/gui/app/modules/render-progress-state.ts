// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const renderProgressStateJs = `    // ────────────────────────────────────────────────────────────
    // openSearchHit — jump to a row's record page. Retained for the activity feed,
    // the create-database wizard, and onboarding. (The old top search BOX was
    // removed — the assistant, "Ask Gladys", is the single search surface.)
    // ────────────────────────────────────────────────────────────
    function openSearchHit(table, id) {
      // Dashboards open in the Analytics view (their record page is only a
      // deep-link fallback) — every other table opens its Configure record page.
      // This is the single mapping the assistant's open events, lattice:// link
      // pills, and activity-card clicks all route through.
      if (table === 'dashboards') {
        location.hash = '#/analytics/' + encodeURIComponent(id);
        return;
      }
      location.hash = '#/fs/' + encodeURIComponent(table) + '/' + encodeURIComponent(id);
    }

    /** Reload column meta after a secret-flag change. */
    function refreshColumnMeta() {
      return fetchJson('/api/gui-meta/columns').then(function (d) {
        state.columnMeta = d || {};
      });
    }

    /**
     * Light, in-place refresh of the Data Model editor after a schema mutation.
     * Refetches only the state the editor reads and re-renders just the side
     * panel (#dm-panel) + sidebar — it NEVER rewrites #drawer-body (the scroll
     * container), so the user's scroll position is preserved. Use this instead
     * of reloadEverything()/renderRoute() in the editor handlers.
     *
     * rebuildGraph is kept for call-site compatibility; the Settings editor now
     * refreshes the entity list (the schema graph moved to the center brain view
     * and reloads its own data whenever it is shown).
     */
    function dmRefreshPanel(name, rebuildGraph) {
      return Promise.all([
        fetchJson('/api/entities-summary'),
        fetchJson('/api/gui-meta/columns').catch(function () { return {}; }),
        fetchJson('/api/gui-meta').catch(function () { return {}; }),
      ]).then(function (r) {
        state.entities = r[0];
        state.columnMeta = r[1] || {};
        state.iconOverrides = r[2] || {};
        loadedTables = {};
        renderSidebar();
        dmActiveTable = name || null;
        // The schema graph moved to the center brain view; Settings → Data Model
        // shows an entity list. Refresh the list + (re)show the editor for the
        // active entity, or hide the panel when there is none.
        renderEntityList();
        if (name) dmShowEntityEditor(name);
        else {
          var p = document.getElementById('dm-panel');
          if (p) p.hidden = true;
        }
      });
    }

`;
