// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const workspaceSwitchProgressJs = `    // ────────────────────────────────────────────────────────────
    // Routing
    // ────────────────────────────────────────────────────────────
    // Monotonic render generation. Bumped on every renderRoute() so a renderer's
    // async data load that resolves AFTER a newer navigation refuses to commit
    // (it would otherwise clobber the newer view). See setContent + the per-
    // renderer myGen guards.
    var renderGen = 0;
    function routeLoadingHtml() {
      return '<div class="route-loading" aria-busy="true"><span class="spinner" aria-hidden="true"></span></div>';
    }
    // Commit HTML only if this render is still the current one — drops a stale
    // async result instead of clobbering a newer view.
    function setContent(content, gen, html) {
      if (content && gen === renderGen) content.innerHTML = html;
    }

    function renderRoute(opts) {
      // soft = a BACKGROUND refresh (a live data change or the render-progress
      // reconcile), not a user navigation. A soft refresh re-renders the current
      // view IN PLACE: it keeps the existing content on screen and lets the
      // per-route renderer swap it only once the new data is ready (setContent +
      // the renderGen guard), so the middle pane no longer flashes to a loading
      // spinner on every refresh. A navigation (default; also the hashchange
      // Event arg, which has no soft flag) still paints the loading frame
      // synchronously for instant click feedback.
      var soft = !!(opts && opts.soft);
      var content = document.getElementById('content');
      var hash = location.hash || '#/';
      // Bumping renderGen invalidates any in-flight (older) render either way.
      renderGen++;
      if (content && !soft) content.innerHTML = routeLoadingHtml();
      if (!state.entities) return; // shell still booting — the loading frame stays
      highlightActive();
      // Reconcile the center tab strip with this hash (creates/activates a tab),
      // then paint it. Settings overlays map to no tab and leave the active one.
      reconcileTab(hash);
      renderTabStrip();
      if (window.LatticeGA) window.LatticeGA.pageView(routeType(hash));

      // The brain graph is the default + permanent view; the dashboard moves to
      // its own reachable route.
      if (hash === '#/' || hash === '' || hash === '#/graph') {
        // A soft (background) refresh must NOT rebuild the graph — the ingest
        // animation owns in-place graph updates, and a rebuild here would wipe it.
        if (!soft) renderBrainGraph(content);
        return;
      }
      // Model > Tables — the tiered explorer, a sibling tab of the graph.
      if (hash === '#/tables') { renderModelTablesView(content); return; }
      if (hash === '#/dashboard') { renderDashboard(content); return; }

      // Folder drill-in (the Files object's on-disk hierarchy): #/folder/<abs path>.
      var folm = /^#\\/folder\\/(.+)$/.exec(hash);
      if (folm) { renderFolderView(content, decodeURIComponent(folm[1])); return; }

      // File-system workspace (default mode): #/fs/<table>[/<id>/<rel>/<id>…].
      // Even segment count → item view; odd → folder/collection view.
      var fsegs = fsParse(hash);
      if (fsegs) {
        // #/fs/<table>/new → inline create view (must precede the even/odd
        // item-vs-collection heuristic, since [table,'new'] is even-length).
        if (fsegs[fsegs.length - 1] === 'new') renderFsCreate(content, fsegs);
        else if (fsegs.length % 2 === 1) renderFsCollection(content, fsegs);
        else renderFsItem(content, fsegs);
        return;
      }

      var m = /^#\\/objects\\/([^/]+)(?:\\/(.+))?$/.exec(hash);
      if (m) {
        if (m[2]) renderDetail(content, m[1], m[2]);
        else      renderTable(content, m[1]);
        return;
      }

      var sm = /^#\\/system\\/([^/]+)$/.exec(hash);
      if (sm) { renderSystemTable(content, sm[1]); return; }

      // Settings live in a slide-over drawer (gear icon, top-right). The legacy
      // hashes open the drawer to the matching tab over the dashboard, so deep
      // links and existing bookmarks keep working. Version history stays a page.
      if (hash === '#/settings/history') { renderHistory(content); return; }
      if (hash === '#/settings/lattice') { renderDashboard(content); openSettingsDrawer('lattice'); return; }
      if (hash === '#/settings/database' || hash === '#/settings/project-config' || hash === '#/settings/data-model') {
        renderDashboard(content); openSettingsDrawer('database'); return;
      }
      if (hash === '#/settings/user-config') { renderDashboard(content); openSettingsDrawer('user'); return; }
      content.innerHTML = '<div class="placeholder"><h2>Unknown route</h2></div>';
    }

`;
