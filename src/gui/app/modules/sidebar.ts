// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const sidebarJs = `    // ────────────────────────────────────────────────────────────
    // Dashboard
    // ────────────────────────────────────────────────────────────
    function dashboardPreferenceRank(name) {
      // DASHBOARD_ORDER is a preference for ordering only; tables not in it
      // appear after, in declaration order.
      var idx = DASHBOARD_ORDER.indexOf(name);
      return idx === -1 ? DASHBOARD_ORDER.length : idx;
    }
    // Fallback dashboard data from the already-loaded entities list, used if
    // the /api/dashboard call fails (no freshness/recent, just counts).
    function dashboardFallback() {
      var tables = (state.entities.tables || []).filter(function (t) {
        return !isJunction(t) && t.name.charAt(0) !== '_';
      });
      return {
        totals: { entities: tables.length, rows: 0, stale: 0 },
        staleDays: 14,
        entities: tables.map(function (t) {
          return { name: t.name, rowCount: t.rowCount, lastUpdatedAt: null, stale: false };
        }),
      };
    }
    function drawDashboard(content, d) {
      var ents = (d.entities || []).slice().sort(function (a, b) {
        return dashboardPreferenceRank(a.name) - dashboardPreferenceRank(b.name);
      });
      if (ents.length === 0) {
        // Generic, role-agnostic empty state — the old copy told everyone to
        // "edit lattice.config.yml / db.define()", which a joined cloud member
        // cannot act on (they just have nothing shared with them yet).
        content.innerHTML =
          '<div class="placeholder">' +
            '<h2>This workspace is empty</h2>' +
            '<p>There are no tables to show yet. Create one in the Data Model editor, ' +
            'or — on a cloud workspace — ask the owner to share a table with you.</p>' +
          '</div>';
        return;
      }
      // No overview stat tiles — the per-entity cards already show counts, and
      // the "stale" indicator was removed (relative "updated" time is signal
      // enough, without flagging anything as stale or coloring it).
      var cardPrefix = advancedMode() ? '#/objects/' : '#/fs/';
      var cards = ents.map(function (e) {
        var disp = displayFor(e.name);
        var count = (e.rowCount != null) ? e.rowCount : 0;
        var fresh = e.lastUpdatedAt
          ? '<div class="card-fresh" title="Last updated ' +
              escapeHtml(String(e.lastUpdatedAt)) + '">' + relTime(e.lastUpdatedAt) + '</div>'
          : '';
        return '<a class="card" data-table="' + escapeHtml(e.name) + '" href="' + cardPrefix + e.name + '"' + titleAttr(tableDesc(e.name)) + '>' +
          '<div class="card-icon">' + disp.icon + '</div>' +
          '<div class="card-label">' + escapeHtml(disp.label) + '</div>' +
          '<div class="card-count">' + count + '</div>' +
          fresh +
          // Hidden until a background render touches this table; revealed by the
          // .is-rendering class applied in applyCardProgress(). The fill is the
          // bottom-edge bar (width = %); the pill is the ⟳ <pct>% corner badge.
          '<div class="card-render" aria-hidden="true">' +
            '<div class="card-render-fill"></div>' +
            '<span class="card-render-pill"><span class="spinner" aria-hidden="true"></span><span class="card-render-pct">Rendering 0%...</span></span>' +
          '</div>' +
          '</a>';
      }).join('');
      content.innerHTML = '<div class="dashboard">' + cards + '</div>';
      // drawDashboard wiped the previous overlays; repaint any still-in-flight
      // render state from the renderProgress map onto the freshly-built cards.
      reapplyRenderOverlays();
    }
    function renderDashboard(content) {
      // Workspace overview: counts + freshness + recent activity from
      // /api/dashboard. Falls back to plain cards if the call fails.
      var myGen = renderGen;
      fetchJson('/api/dashboard').then(function (d) {
        if (myGen !== renderGen) return;
        drawDashboard(content, d);
      }).catch(function () {
        if (myGen !== renderGen) return;
        drawDashboard(content, dashboardFallback());
      });
    }

`;
