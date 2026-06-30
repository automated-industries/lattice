// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const renderProgressStateJs = `    // ────────────────────────────────────────────────────────────
    // Search — the top box hands the query to the AI ASSISTANT (which answers
    // conversationally using its search/read tools), not a plain full-text
    // match. hideSearchResults/openSearchHit are retained because the activity
    // feed still uses openSearchHit to jump to a row.
    // ────────────────────────────────────────────────────────────
    function hideSearchResults() {
      var box = document.getElementById('search-results');
      if (box) { box.hidden = true; box.innerHTML = ''; }
    }
    function openSearchHit(table, id) {
      hideSearchResults();
      var input = document.getElementById('search-input');
      if (input) input.value = '';
      // Open the hit in whichever mode the user is in: the file-workspace
      // (#/fs/) view in simple mode, the row editor (#/objects/) in advanced.
      var prefix = advancedMode() ? '#/objects/' : '#/fs/';
      location.hash = prefix + encodeURIComponent(table) + '/' + encodeURIComponent(id);
    }
    // Route the typed query into the floating Ask Lattice assistant as a chat turn.
    // Opens the panel and submits via the same path as the composer, so the
    // assistant searches + answers.
    function askAssistant(q) {
      hideSearchResults();
      var input = document.getElementById('search-input');
      if (input) input.value = '';
      if (typeof openAskLattice === 'function') openAskLattice();
      var chatInput = document.getElementById('chat-input');
      if (chatInput) chatInput.focus();
      sendChat(q);
    }
    function initSearch() {
      var input = document.getElementById('search-input');
      if (!input) return;
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { input.value = ''; input.blur(); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          var q = input.value.trim();
          if (q) { gaTrack('search', {}); askAssistant(q); } // event only — never the query text
        }
      });
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
