// Auto-composed segment of the GUI client script (see modules/index.ts). The
// left-sidebar DATA nav section beneath Dashboards. Every model table sits under
// one of three fixed subheads — TABLES (the user's own entities, the lattice
// schema), CONNECTORS (every connector schema), DATABASES (every connected
// database) — each an independently collapsible group. Junctions (linkTable) and
// SQL-protected tables (sqlDenied) are excluded. Clicking a table opens its
// Workspace tab (#/w/table/<name>). Collapse state reuses the shared
// .section-toggle[data-group] idiom (sources.ts). Must stay INSIDE the client
// IIFE (uses state/escapeHtml/displayFor/sidebarGroupKey/
// setSidebarGroupCollapsed/applySidebarGroupState/wireSidebarGroupToggles).
// Function declarations hoist, so call order is free.
export const navSectionsJs = `
    // DATA — every model table under three FIXED subheads, read from the in-memory
    // state.entities (no fetch): TABLES (lattice schema, the user's own entities),
    // CONNECTORS (all connector schemas merged, ordered by source label so each
    // source's tables stay contiguous), DATABASES (connected databases, same).
    // Junctions + SQL-protected tables excluded via the server stamps. TABLES is
    // open by default, the rest collapsed on first sight.
    function renderNavTables() {
      var host = document.getElementById('nav-tables-list');
      if (!host) return;
      // Hide EMPTY connector / external-DB tables (0 live rows = never synced = noise),
      // and — because a subhead only forms around the tables that survive this filter —
      // a source whose tables are all empty drops out entirely (header and all).
      // The user's OWN entities (TABLES subhead, i.e. no connector schemaKey) always
      // show, even when empty, so a table they just created still appears. rowCount
      // null = unknown → keep, so a counting hiccup never hides real data.
      var tables = ((state.entities && state.entities.tables) || []).filter(function (t) {
        if (!t || !t.name || t.linkTable || t.sqlDenied) return false;
        var isConnectorSchema = !!(t.schemaKey && t.schemaKey !== 'lattice');
        if (isConnectorSchema && t.rowCount === 0) return false;
        return true;
      });
      var activeM = /^#\\/w\\/table\\/([^\\/]+)/.exec(location.hash);
      var activeName = activeM ? decodeURIComponent(activeM[1]) : '';
      // Bucket into the three fixed subheads. The TABLES bucket keeps the historical
      // 'nav-schema-lattice' group key so persisted collapse state survives the
      // relabel; the merged buckets get stable keys of their own.
      function bucketOf(t) {
        var key = t.schemaKey || 'lattice';
        if (key === 'lattice') return 'lattice';
        return key.indexOf('conn:') === 0 ? 'connectors' : 'databases';
      }
      var LABELS = { lattice: 'TABLES', connectors: 'CONNECTORS', databases: 'DATABASES' };
      var groups = {};
      tables.forEach(function (t) {
        var key = bucketOf(t);
        if (!groups[key]) groups[key] = { key: key, label: LABELS[key], tables: [] };
        groups[key].tables.push(t);
      });
      // Within a merged bucket, order by source label first so each connector's /
      // database's tables stay contiguous under the shared subhead.
      Object.keys(groups).forEach(function (k) {
        if (k === 'lattice') return;
        groups[k].tables.sort(function (a, b) {
          var la = String(a.schemaLabel || ''), lb = String(b.schemaLabel || '');
          if (la !== lb) return la.localeCompare(lb);
          return String(a.name).localeCompare(String(b.name));
        });
      });
      // TABLES (0) → CONNECTORS (1) → DATABASES (2).
      function rank(g) { return g.key === 'lattice' ? 0 : (g.key === 'connectors' ? 1 : 2); }
      var ordered = Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (a, b) {
        return rank(a) - rank(b);
      });
      var rendered = [];
      var html = ordered.map(function (g) {
        var gkey = 'nav-schema-' + g.key;
        rendered.push({ gkey: gkey, isLattice: g.key === 'lattice' });
        var items = g.tables.map(function (t) {
          var d = typeof displayFor === 'function' ? displayFor(t.name) : { icon: '🗂️', label: t.name };
          return '<button type="button" class="nav-table-item' + (t.name === activeName ? ' active' : '') +
            '" data-table="' + escapeHtml(t.name) + '" title="' + escapeHtml(d.label) + '">' +
            '<span class="nav-item-ic">' + (d.icon || '🗂️') + '</span>' +
            '<span class="nav-item-name">' + escapeHtml(d.label) + '</span></button>';
        }).join('');
        return '<div class="nav-schema">' +
          '<button type="button" class="section-label section-toggle nav-schema-head" data-group="' + gkey + '" aria-expanded="true">' +
          '<span class="section-caret">▾</span><span class="nav-schema-label">' + escapeHtml(g.label) + '</span></button>' +
          '<div class="section-body" data-group-body="' + gkey + '">' + items + '</div></div>';
      }).join('');
      host.innerHTML = html || '<div class="nav-empty">No tables yet.</div>';
      // Seed CONNECTORS/DATABASES collapsed on first sight (no stored preference yet);
      // TABLES stays open. Then apply the (possibly stored) collapse state + caret.
      rendered.forEach(function (r) {
        try {
          if (!r.isLattice && typeof sidebarGroupKey === 'function' &&
              typeof setSidebarGroupCollapsed === 'function' &&
              window.localStorage.getItem(sidebarGroupKey(r.gkey)) === null) {
            setSidebarGroupCollapsed(r.gkey, true);
          }
        } catch (e) {}
        if (typeof applySidebarGroupState === 'function') applySidebarGroupState(r.gkey);
      });
      host.querySelectorAll('.nav-table-item').forEach(function (b) {
        if (b.__wired) return; b.__wired = true;
        b.addEventListener('click', function () {
          location.hash = '#/w/table/' + encodeURIComponent(b.getAttribute('data-table'));
        });
      });
      // Wire the schema-header toggles (idempotent; independent open/close since the
      // nav-schema-* groups are not in NAV_ACCORDION_GROUPS).
      if (typeof wireSidebarGroupToggles === 'function') wireSidebarGroupToggles();
    }

    function renderNavSections() {
      renderNavTables();
      // (Files no longer has its own sidebar section — it is a table under the TABLES
      // subhead above.) Enforce the outer single-open accordion (Dashboards | Data) +
      // wire the toggles (both idempotent).
      if (typeof enforceNavAccordion === 'function') enforceNavAccordion();
      else if (typeof applySidebarGroupState === 'function') {
        ['nav-tables', 'nav-dashboards'].forEach(applySidebarGroupState);
      }
      if (typeof wireSidebarGroupToggles === 'function') wireSidebarGroupToggles();
    }
`;
