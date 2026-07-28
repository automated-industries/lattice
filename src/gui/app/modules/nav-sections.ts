// Auto-composed segment of the GUI client script (see modules/index.ts). The
// left-sidebar DATA nav section beneath Dashboards. Every model table sits under
// one of three fixed subheads — TABLES (the user's own entities, the lattice
// schema), CONNECTORS (every connector schema), DATABASES (every connected
// database) — each an independently collapsible group. Junctions (linkTable),
// SQL-protected tables (sqlDenied) and tables with their own dedicated home
// (navHidden — files, which has its own sidebar section) are excluded. Clicking a table opens its
// Workspace tab (#/w/table/<name>). Collapse state reuses the shared
// .section-toggle[data-group] idiom (sources.ts). All three subheads render even
// when their buckets are empty — an empty bucket shows an empty state + add
// affordance instead of the section collapsing to a bare line. Must stay INSIDE
// the client IIFE (uses state/escapeHtml/displayFor/sidebarGroupKey/
// setSidebarGroupCollapsed/applySidebarGroupState/wireSidebarGroupToggles/
// sidebarGroupCollapsed/toggleSidebarGroup/openConfigureDrawer).
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
      // so a source whose tables are all empty contributes nothing to its bucket —
      // though the bucket's SUBHEAD still renders (with its empty state) below.
      // The user's OWN entities (TABLES subhead, i.e. no connector schemaKey) always
      // show, even when empty, so a table they just created still appears. rowCount
      // null = unknown → keep, so a counting hiccup never hides real data.
      var tables = ((state.entities && state.entities.tables) || []).filter(function (t) {
        if (!t || !t.name || t.linkTable || t.sqlDenied || t.navHidden) return false;
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
      // ALL THREE subheads always render. An empty bucket keeps its group and
      // shows an empty state + add affordance instead of vanishing, so a fresh
      // workspace still lays out where data can come from — the old behavior
      // replaced the whole section body with a single bare "No tables yet." line.
      var groups = {};
      ['lattice', 'connectors', 'databases'].forEach(function (k) {
        groups[k] = { key: k, label: LABELS[k], tables: [] };
      });
      tables.forEach(function (t) {
        groups[bucketOf(t)].tables.push(t);
      });
      // Empty-state body for a bucket with no tables: a short line + the add
      // affordance. Files are added from the FILES section's own menu; the
      // connector / database add forms live inline in their Configure tabs, so
      // opening the tab IS the add surface (same routing the dashboard broker's
      // add actions use).
      function navEmptyBucketHtml(key) {
        if (key === 'connectors') {
          return '<div class="nav-empty">No connectors yet.</div>' +
            '<button type="button" class="nav-add-item" data-nav-add="connectors">＋ Add a connector</button>';
        }
        if (key === 'databases') {
          return '<div class="nav-empty">No databases yet.</div>' +
            '<button type="button" class="nav-add-item" data-nav-add="databases">＋ Connect a database</button>';
        }
        return '<div class="nav-empty">No tables yet.</div>' +
          '<button type="button" class="nav-add-item" data-nav-add="files">＋ Add files</button>';
      }
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
        if (!items) items = navEmptyBucketHtml(g.key);
        return '<div class="nav-schema">' +
          '<button type="button" class="section-label section-toggle nav-schema-head" data-group="' + gkey + '" aria-expanded="true">' +
          '<span class="section-caret">▾</span><span class="nav-schema-label">' + escapeHtml(g.label) + '</span></button>' +
          '<div class="section-body" data-group-body="' + gkey + '">' + items + '</div></div>';
      }).join('');
      host.innerHTML = html;
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
      // Empty-bucket add affordances. Never a navigation: files opens the FILES
      // section's add menu in place; the other two open the matching Configure tab.
      host.querySelectorAll('.nav-add-item').forEach(function (b) {
        if (b.__wired) return; b.__wired = true;
        b.addEventListener('click', function () {
          var kind = b.getAttribute('data-nav-add');
          if (kind === 'files') {
            if (typeof sidebarGroupCollapsed === 'function' && typeof toggleSidebarGroup === 'function' &&
                sidebarGroupCollapsed('nav-files')) {
              toggleSidebarGroup('nav-files');
            }
            var fb = document.getElementById('src-add-files');
            if (fb) fb.click();
            return;
          }
          if (typeof openConfigureDrawer === 'function') openConfigureDrawer(kind);
        });
      });
      // Wire the schema-header toggles (idempotent; independent open/close since the
      // nav-schema-* groups are not in NAV_ACCORDION_GROUPS).
      if (typeof wireSidebarGroupToggles === 'function') wireSidebarGroupToggles();
    }

    function renderNavSections() {
      renderNavTables();
      // Enforce the outer single-open accordion (Files | Data | Dashboards) + wire
      // the toggles (both idempotent). The FILES section's own body is rendered by
      // renderSources() in sources.ts, not here.
      if (typeof enforceNavAccordion === 'function') enforceNavAccordion();
      else if (typeof applySidebarGroupState === 'function') {
        ['nav-files', 'nav-tables', 'nav-dashboards'].forEach(applySidebarGroupState);
      }
      if (typeof wireSidebarGroupToggles === 'function') wireSidebarGroupToggles();
    }
`;
