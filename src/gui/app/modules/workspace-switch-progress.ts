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

      // Folders — the DEFAULT center view: the workspace's objects as a grid of
      // folders (double-click to open; rows inside show as files; linked objects
      // nest). #/folders/<obj> opens one object's folder.
      if (hash === '#/' || hash === '' || hash === '#/folders') { renderFoldersView(content); return; }
      var flm = /^#\\/folders\\/([^/]+)$/.exec(hash);
      if (flm) { renderFolderEntity(content, decodeURIComponent(flm[1])); return; }

      // The brain graph — a sibling tab of Folders/Tables. (Was the default; Folders
      // is now the landing view.)
      if (hash === '#/graph') {
        // A soft (background) refresh must NOT rebuild the graph — the ingest
        // animation owns in-place graph updates, and a rebuild here would wipe it.
        if (!soft) renderBrainGraph(content);
        return;
      }
      // Graph drill-in: #/graph/<obj> → that entity's rows as a graph (Object Page
      // of the Graph section). Soft refreshes skip the rebuild like #/graph.
      var grm = /^#\\/graph\\/([^/]+)$/.exec(hash);
      if (grm) { if (!soft) renderEntityGraph(content, decodeURIComponent(grm[1])); return; }
      // Graph section RECORD / relation-collection: #/graph/<obj>/<id>[/<rel>/…] →
      // the SHARED record renderer told section='graph', so the Graph tab stays lit
      // and the breadcrumb roots at Graph. Needs ≥2 segments, so it can't shadow the
      // single-segment entity-graph route above.
      var grItem = /^#\\/graph\\/([^/]+)\\/(.+)$/.exec(hash);
      if (grItem) {
        var gs = (grItem[1] + '/' + grItem[2]).split('/').map(function (s) { return decodeURIComponent(s); });
        if (gs.length % 2 === 1) renderFsCollection(content, gs, 'graph');
        else renderFsItem(content, gs, 'graph');
        return;
      }
      // Model > Tables — the tiered explorer, a sibling tab of the graph.
      if (hash === '#/tables') { renderModelTablesView(content); return; }
      // Tables section Object Page + RECORD: #/tables/<obj>[/<id>][/<rel>/…] → the
      // shared renderer told section='tables' (Object Page = the rows list). Comes
      // AFTER the exact #/tables match so it only catches the drill-in paths.
      var tbItem = /^#\\/tables\\/(.+)$/.exec(hash);
      if (tbItem) {
        var ts = tbItem[1].split('/').map(function (s) { return decodeURIComponent(s); });
        if (ts.length % 2 === 1) renderFsCollection(content, ts, 'tables');
        else renderFsItem(content, ts, 'tables');
        return;
      }

      if (hash === '#/dashboard') { renderDashboard(content); return; }

      // Folder drill-in (the Files object's on-disk hierarchy): #/folder/<abs path>.
      var folm = /^#\\/folder\\/(.+)$/.exec(hash);
      if (folm) { renderFolderView(content, decodeURIComponent(folm[1])); return; }

      // File-system workspace (default mode): #/fs/<table>[/<id>/<rel>/<id>…].
      // Even segment count → item view; odd → folder/collection view.
      var fsegs = fsParse(hash);
      if (fsegs) {
        // The inline record-create view was removed; redirect any lingering
        // #/fs/<table>/new link to that table's collection.
        if (fsegs[fsegs.length - 1] === 'new') { location.hash = fsHref(fsegs.slice(0, -1)); return; }
        if (fsegs.length % 2 === 1) renderFsCollection(content, fsegs, 'folders');
        else renderFsItem(content, fsegs, 'folders');
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
