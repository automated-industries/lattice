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

    // Map a legacy hash (old producers / bookmarks) to the canonical single-layout
    // #/w/* scheme, or null when it is already canonical / not a legacy record route.
    // The caller uses location.replace so no phantom history entry is created.
    function normalizeLegacyHash(hash) {
      hash = hash || '';
      var m;
      if (hash === '#/analytics' || hash === '#/analytics/') return '#/';
      m = /^#\\/analytics\\/(.+)$/.exec(hash);
      if (m) return '#/w/dash/' + m[1];
      // A single file (old #/fs/files/<id> or #/tables/files/<id>) → the file tab.
      m = /^#\\/(?:fs|tables)\\/files\\/([^/]+)$/.exec(hash);
      if (m) return '#/w/file/' + m[1];
      // Objects/Folders object page → that table's collection tab.
      m = /^#\\/folders\\/([^/]+)$/.exec(hash);
      if (m) return '#/w/table/' + m[1];
      // A graph node drill-in (old #/graph/<entity>[/<id>]) → that entity's table
      // tab. The bare #/graph (Data Model → Graph drawer) is matched by
      // configureRouteFor first, so only the node-level form reaches here.
      m = /^#\\/graph\\/(.+)$/.exec(hash);
      if (m) return '#/w/table/' + m[1];
      // #/fs/<t>[/…] and #/tables/<t>[/…] (record/collection drill-ins) → #/w/table/…
      // (bare #/tables is the Data Model drawer, matched by configureRouteFor first).
      m = /^#\\/fs\\/(.+)$/.exec(hash);
      if (m) return '#/w/table/' + m[1];
      m = /^#\\/tables\\/(.+)$/.exec(hash);
      if (m) return '#/w/table/' + m[1];
      return null;
    }

    // A hash that should open the Configure drawer (to a tab/subtab) OVER the
    // Workspace home, rather than a center tab. Returns {tab, subtab} or null.
    function configureRouteFor(hash) {
      hash = hash || '';
      if (hash === '#/graph') return { tab: 'graph' };
      if (hash === '#/tables') return { tab: 'datamodel' };
      if (hash === '#/settings/history') return { tab: 'history' };
      // Lattice tab merged into User.
      if (hash === '#/settings/lattice') return { tab: 'user' };
      if (hash === '#/settings/database' || hash === '#/settings/project-config' || hash === '#/settings/data-model')
        return { tab: 'datamodel' };
      // Inputs split into three tabs; keep the legacy #/settings/inputs → Files.
      if (hash === '#/settings/files') return { tab: 'files' };
      if (hash === '#/settings/connectors') return { tab: 'connectors' };
      if (hash === '#/settings/databases') return { tab: 'databases' };
      if (hash === '#/settings/inputs') return { tab: 'files' };
      if (hash === '#/settings/user-config') return { tab: 'user' };
      return null;
    }

    function renderRoute(opts) {
      // soft = a BACKGROUND refresh (a live data change / render-progress reconcile),
      // not a user navigation; the per-route renderer swaps content in place once new
      // data is ready (setContent + the renderGen guard), so the pane never flashes.
      var soft = !!(opts && opts.soft);
      var content = document.getElementById('content');
      // A degraded boot — the active workspace's data could not be read — shows the
      // escape-hatch notice INSTEAD of a route render, and keeps showing it across every
      // re-render (the boot hashchange, a render-done event, etc.) until the self-heal
      // repopulates state.entities. Without this guard the async route render clobbers a
      // one-shot placeholder written after it, and the failure goes silently invisible.
      if (state.entities && state.entities.__failed) {
        if (content) content.innerHTML =
          '<div class="placeholder boot-degraded-notice"><h2>This workspace is still loading</h2>' +
          '<p>Its data could not be read yet. Reconnecting automatically. You can also ' +
          'pick another workspace from the switcher above, or reload.</p></div>';
        return;
      }
      var hash = location.hash || '#/';
      renderGen++;
      // Redirect legacy hashes to the canonical single-layout scheme (no history spam).
      var norm = normalizeLegacyHash(hash);
      if (norm && norm !== hash) { location.replace(norm); return; }
      if (window.LatticeGA) window.LatticeGA.pageView(routeType(hash));
      // Configure-drawer routes: render the Workspace home beneath, open the drawer.
      var cfg = configureRouteFor(hash);
      if (cfg) {
        renderAnalyticsRoute('#/', soft);
        if (typeof openConfigureDrawer === 'function') openConfigureDrawer(cfg.tab, cfg.subtab);
        else if (typeof openSettingsDrawer === 'function') openSettingsDrawer(cfg.tab);
        return;
      }
      if (!state.entities) { if (content && !soft) content.innerHTML = routeLoadingHtml(); return; }
      // The computed-table builder (#/computed/new to create, #/computed/<name> to
      // edit) renders as a full center page. It is launched from the Data Model →
      // Tables explorer inside the Configure drawer, so close that drawer first —
      // otherwise the builder renders hidden behind the open panel.
      var cbm = /^#\\/computed\\/([^/]+)$/.exec(hash);
      if (cbm) {
        // A background (soft) refresh must NOT rebuild the builder: renderComputedBuilder
        // resets its in-progress definition to a blank/last-saved form, so a landed
        // mutation (a collaborator edit, an ingest completing, a render-done event) would
        // silently wipe the user's unsaved work. Leave the mounted builder untouched — it
        // self-fetches its base fields; there is nothing to reconcile in. (Mirrors the
        // #/questions branch below, another unsaved-form surface.)
        if (soft) return;
        if (typeof drawerIsOpen === 'function' && drawerIsOpen() && typeof closeSettingsDrawer === 'function') closeSettingsDrawer();
        if (content) content.innerHTML = routeLoadingHtml();
        renderComputedBuilder(content, decodeURIComponent(cbm[1]));
        return;
      }
      // A few center-rendered utility routes that aren't Workspace tabs.
      if (hash === '#/questions') {
        if (content && !soft) content.innerHTML = routeLoadingHtml();
        if (!soft) renderQuestionsView(content);
        return;
      }
      var sm = /^#\\/system\\/([^/]+)$/.exec(hash);
      if (sm) {
        if (content && !soft) content.innerHTML = routeLoadingHtml();
        renderSystemTable(content, sm[1]);
        return;
      }
      var folm = /^#\\/folder\\/(.+)$/.exec(hash);
      if (folm) {
        if (content && !soft) content.innerHTML = routeLoadingHtml();
        renderFolderView(content, decodeURIComponent(folm[1]));
        return;
      }
      var om = /^#\\/objects\\/([^/]+)(?:\\/(.+))?$/.exec(hash);
      if (om) { location.replace('#/w/table/' + om[1] + (om[2] ? '/' + om[2] : '')); return; }
      // Everything else (home + #/w/dash|table|file|md/*) → the single Workspace layout.
      renderAnalyticsRoute(hash, soft);
    }

`;
