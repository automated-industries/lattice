// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const versionHistoryUndoJs = `    // ────────────────────────────────────────────────────────────
    // Sidebar
    // ────────────────────────────────────────────────────────────
    function renderSidebar() {
      // Single layout: the flat Objects list is gone (its #object-nav was removed with
      // the old sidebar — don't deref it). System tables stay advanced-only, guarded
      // for the absence of their now-removed hosts.
      var show = advancedMode();
      var section = document.getElementById('system-section');
      if (section) section.hidden = !show;
      var objSection = document.getElementById('objects-section');
      if (objSection) objSection.hidden = !show;
      var sys = document.getElementById('system-nav');
      if (sys) {
        sys.innerHTML = show
          ? (state.systemTables || []).map(function (t) {
              return '<li><a data-route="#/system/' + t.name + '" href="#/system/' + t.name +
                '"><span class="nav-icon">⚙</span> <span class="nav-text">' + escapeHtml(t.name) + '</span></a></li>';
            }).join('')
          : '';
      }
      // The left-sidebar nav sections (Tables / Files / Markdown).
      if (typeof renderNavSections === 'function') renderNavSections();
      // Populate the Inputs surfaces (Files / Connectors / Databases) — now hosted in
      // the Configure drawer's Inputs tab; no-ops until that tab is mounted.
      if (typeof renderSources === 'function') renderSources();
      highlightActive();
    }

    function highlightActive() {
      var hash = location.hash || '#/';
      document.querySelectorAll('nav a').forEach(function (a) {
        var route = a.getAttribute('data-route') || a.getAttribute('href');
        // Match the route exactly or as a full path segment (route + '/...'),
        // never as a bare string prefix — otherwise '#/fs/files' would also
        // light up '#/fs/files_projects' (any sibling whose name starts with
        // the same word). The '/' boundary stops the prefix bleed while still
        // keeping a parent active on its own detail routes.
        var on = !!route && (hash === route || hash.indexOf(route + '/') === 0);
        a.classList.toggle('active', on);
      });
    }

`;
