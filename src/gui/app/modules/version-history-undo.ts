// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const versionHistoryUndoJs = `    // ────────────────────────────────────────────────────────────
    // Sidebar
    // ────────────────────────────────────────────────────────────
    function renderSidebar() {
      var ul = document.getElementById('object-nav');
      var prefix = advancedMode() ? '#/objects/' : '#/fs/';
      var firstClass = state.entities.tables.filter(function (t) { return !isJunction(t); });
      // Objects list is ordered alphabetically by display label (case-insensitive).
      firstClass.sort(function (a, b) {
        return displayFor(a.name).label.toLowerCase().localeCompare(displayFor(b.name).label.toLowerCase());
      });
      ul.innerHTML = firstClass.map(function (t) {
        var d = displayFor(t.name);
        var unseen = unseenByTable[t.name] || 0;
        var badge = unseen > 0
          ? ' <span class="nav-badge" title="' + unseen + ' change' + (unseen === 1 ? '' : 's') +
            ' from another editor">' + (unseen > 99 ? '99+' : unseen) + '</span>'
          : '';
        // Connected data types (synced from an external source) get a link chip.
        var connBadge = t.connectorToolkit
          ? ' <span class="nav-badge" title="Connected — synced from ' + escapeHtml(t.connectorToolkit) + '">🔗</span>'
          : '';
        return '<li><a data-route="' + prefix + t.name + '" href="' + prefix + t.name +
          '"' + titleAttr(tableDesc(t.name)) + '><span class="nav-icon">' + d.icon + '</span> <span class="nav-text">' + escapeHtml(d.label) + '</span>' + navVisIcon(t) + badge + connBadge + '</a></li>';
      }).join('');

      var section = document.getElementById('system-section');
      // System tables surface in Advanced View (no separate preference).
      var show = advancedMode();
      if (section) section.hidden = !show;
      // The flat Objects list is Advanced-view only; the Sources sidebar (Files /
      // Artifacts / Connectors) is the default-mode entry point.
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

      // Populate the Sources sidebar (Files tree / Artifacts / Connectors).
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
