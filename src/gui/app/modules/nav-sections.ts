// Auto-composed segment of the GUI client script (see modules/index.ts). The
// left-sidebar TABLES nav section beneath Dashboards. Tables are grouped by their
// provenance SCHEMA (LATTICE / one per connector / one per connected database —
// server-stamped as schemaKey/schemaLabel), each schema an independently collapsible
// group. Junctions (linkTable) and SQL-protected tables (sqlDenied) are excluded.
// Clicking a table opens its Workspace tab (#/w/table/<name>). Collapse state reuses
// the shared .section-toggle[data-group] idiom (sources.ts). Must stay INSIDE the
// client IIFE (uses state/escapeHtml/displayFor/sidebarGroupKey/
// setSidebarGroupCollapsed/applySidebarGroupState/wireSidebarGroupToggles). Function
// declarations hoist, so call order is free.
export const navSectionsJs = `
    // TABLES — every model table grouped by provenance SCHEMA, read from the in-memory
    // state.entities (no fetch). LATTICE first, then connector schemas, then connected
    // databases (alpha by label within each). Junctions + SQL-protected tables excluded
    // via the server stamps. Each schema is an independent collapsible group; LATTICE is
    // open by default, the rest collapsed on first sight.
    function renderNavTables() {
      var host = document.getElementById('nav-tables-list');
      if (!host) return;
      // Hide EMPTY connector / external-DB tables (0 live rows = never synced = noise),
      // and — because a schema group only forms around the tables that survive this filter —
      // a connector schema whose tables are all empty drops out entirely (header and all).
      // The user's OWN entities (LATTICE schema, i.e. no connector schemaKey) always show,
      // even when empty, so a table they just created still appears. rowCount null = unknown
      // → keep, so a counting hiccup never hides real data.
      var tables = ((state.entities && state.entities.tables) || []).filter(function (t) {
        if (!t || !t.name || t.linkTable || t.sqlDenied) return false;
        var isConnectorSchema = !!(t.schemaKey && t.schemaKey !== 'lattice');
        if (isConnectorSchema && t.rowCount === 0) return false;
        return true;
      });
      var activeM = /^#\\/w\\/table\\/([^\\/]+)/.exec(location.hash);
      var activeName = activeM ? decodeURIComponent(activeM[1]) : '';
      // Bucket by schema.
      var groups = {};
      tables.forEach(function (t) {
        var key = t.schemaKey || 'lattice';
        if (!groups[key]) groups[key] = { key: key, label: t.schemaLabel || 'LATTICE', tables: [] };
        groups[key].tables.push(t);
      });
      // LATTICE (0) → connector schemas (1) → db-source schemas (2); alpha within each.
      function rank(g) { return g.key === 'lattice' ? 0 : (g.key.indexOf('conn:') === 0 ? 1 : 2); }
      var ordered = Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (a, b) {
        var ra = rank(a), rb = rank(b);
        if (ra !== rb) return ra - rb;
        return String(a.label).localeCompare(String(b.label));
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
      // Seed non-LATTICE schemas collapsed on first sight (no stored preference yet);
      // LATTICE stays open. Then apply the (possibly stored) collapse state + caret.
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
      // (Files no longer has its own sidebar section — it is a table in the LATTICE
      // schema above.) Enforce the outer single-open accordion (Dashboards | Tables) +
      // wire the toggles (both idempotent).
      if (typeof enforceNavAccordion === 'function') enforceNavAccordion();
      else if (typeof applySidebarGroupState === 'function') {
        ['nav-tables', 'nav-dashboards'].forEach(applySidebarGroupState);
      }
      if (typeof wireSidebarGroupToggles === 'function') wireSidebarGroupToggles();
    }
`;
