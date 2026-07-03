// Auto-composed segment of the GUI client script (see modules/index.ts). The
// ANALYTICS view — the app's landing surface: a Dashboards sidebar, a tabbed
// dashboard canvas, and the docked assistant. The view is hash-driven
// (#/analytics[...] = Analytics; every other route = Configure) and both
// layouts stay mounted — applyAppView() only flips a body class, so neither
// view loses live state when the user switches. Dashboard pages render the
// stored page in the SAME sandboxed-iframe + read-only-broker + chart-lib
// pipeline the Configure file preview uses (installHtmlFileBroker matches any
// iframe.html-frame), and sharing reuses detailVisLineEl/wireRowSharing
// unchanged. Must stay INSIDE the client IIFE (uses fetchJson/escapeHtml/
// showToast/undoLast + dashboard.ts + analytics-tabs.ts helpers); inserted
// after analyticsTabsJs in modules/index.ts. (Exported as analyticsViewJs —
// the bare analyticsJs name belongs to the separate telemetry script.)
export const analyticsViewJs = `
    function isAnalyticsHash(h) { return (h || '').indexOf('#/analytics') === 0; }
    var lastAnalyticsHash = '#/analytics';
    var lastConfigureHash = '#/';

    // Flip the body class that shows one layout and hides the other, and
    // remember each side's last hash so the header toggles return the user to
    // where they left off (not to a fixed landing page).
    function applyAppView(hash) {
      var an = isAnalyticsHash(hash);
      document.body.classList.toggle('view-analytics', an);
      if (an) lastAnalyticsHash = hash; else lastConfigureHash = hash;
    }

    function initAnalyticsView() {
      var ask = document.getElementById('ask-lattice-trigger');
      if (ask && !ask.__wired) {
        ask.__wired = true;
        ask.addEventListener('click', function () {
          location.hash = lastAnalyticsHash;
          var input = document.getElementById('chat-input');
          if (input) setTimeout(function () { input.focus(); }, 0);
        });
      }
      var cfg = document.getElementById('configure-trigger');
      if (cfg && !cfg.__wired) {
        cfg.__wired = true;
        cfg.addEventListener('click', function () { location.hash = lastConfigureHash; });
      }
    }

    // ── Dashboards sidebar ─────────────────────────────────────────────────
    // The fetched list is cached so the home empty-state and tab titles can
    // read it without refetching; soft refreshes re-fetch (an assistant-created
    // dashboard appears live via the same afterMutation → renderRoute(soft)
    // path every other view uses).
    var anDashRows = null;
    function renderDashList() {
      var host = document.getElementById('dash-list');
      if (!host) return Promise.resolve();
      var keepScroll = host.scrollTop;
      return fetchRowsPage('dashboards', { exclude: 'html', limit: 200 })
        .then(function (page) {
          anDashRows = page.rows || [];
          var activeKey = anTabKeyForHash(location.hash);
          if (!anDashRows.length) {
            host.innerHTML =
              '<div class="dash-list-empty">No dashboards yet — ask Gladys to build one.</div>';
            return;
          }
          host.innerHTML = anDashRows
            .map(function (r) {
              var key = 'dash:' + r.id;
              var vis = typeof visIndicator === 'function' ? visIndicator(r._access, 'dash-vis') : '';
              return (
                '<button type="button" class="dash-item' + (key === activeKey ? ' active' : '') +
                '" data-dash-id="' + escapeHtml(String(r.id)) + '" title="' + escapeHtml(String(r.title || 'Dashboard')) + '">' +
                '<span class="dash-item-icon" aria-hidden="true">📊</span>' +
                '<span class="dash-item-title">' + escapeHtml(String(r.title || 'Dashboard')) + '</span>' +
                vis +
                (r.description ? '<span class="dash-item-desc">' + escapeHtml(String(r.description)) + '</span>' : '') +
                '</button>'
              );
            })
            .join('');
          host.scrollTop = keepScroll;
          host.querySelectorAll('.dash-item').forEach(function (el) {
            el.addEventListener('click', function () {
              location.hash = '#/analytics/' + encodeURIComponent(el.getAttribute('data-dash-id'));
            });
          });
        })
        .catch(function () {
          // A member whose workspace hasn't been upgraded yet has no dashboards
          // surface — an empty list, never a broken sidebar.
          anDashRows = [];
          host.innerHTML = '<div class="dash-list-empty">No dashboards yet.</div>';
        });
    }

    // ── Analytics home (no tab open) ───────────────────────────────────────
    // A chat-only turn is a first-class outcome: the home stays useful with no
    // dashboards at all, and the strip legitimately shows no tabs.
    function renderAnalyticsHome(host) {
      var myGen = renderGen;
      var ready = anDashRows !== null ? Promise.resolve() : renderDashList();
      ready.then(function () {
        var hasDashboards = !!(anDashRows && anDashRows.length);
        setContent(host, myGen,
          '<div class="analytics-home">' +
          '<div class="analytics-home-mark" aria-hidden="true">📊</div>' +
          '<h1>Ask your company anything</h1>' +
          '<p class="muted">' +
          (hasDashboards
            ? 'Open a dashboard from the left, or ask a question below.'
            : 'Ask Gladys a question about your data — when a picture answers it best, she builds a dashboard for you.') +
          '</p>' +
          '</div>');
      });
    }

    // ── Dashboard page (one open tab) ──────────────────────────────────────
    function renderDashboardPage(host, id) {
      var myGen = renderGen;
      fetchJson('/api/tables/dashboards/rows/' + encodeURIComponent(id))
        .then(function (row) {
          if (!row || row.error || !row.id) throw new Error('not found');
          anSetTabTitle('dash:' + id, String(row.title || 'Dashboard'));
          if (myGen !== renderGen) return;
          setContent(host, myGen,
            '<div class="dash-page">' +
            '<div class="view-header dash-header">' +
            '<h1 class="dash-title">' + escapeHtml(String(row.title || 'Dashboard')) + '</h1>' +
            '<span class="dash-vis-slot" id="dash-vis-slot"></span>' +
            '<div class="file-menu-wrap dash-menu-wrap">' +
            '<button type="button" class="file-menu-btn" id="dash-menu-btn" title="Dashboard actions" aria-haspopup="menu" aria-expanded="false">⋯</button>' +
            '<div class="file-menu" id="dash-menu" role="menu" hidden>' +
            '<button type="button" class="file-menu-item" data-act="rename" role="menuitem">Rename</button>' +
            '<button type="button" class="file-menu-item" data-act="history" role="menuitem">Version history</button>' +
            '<button type="button" class="file-menu-item danger" data-act="delete" role="menuitem">Delete</button>' +
            '</div></div>' +
            '</div>' +
            (row.description ? '<div class="dash-desc muted">' + escapeHtml(String(row.description)) + '</div>' : '') +
            '<div id="record-history" class="dash-history" hidden></div>' +
            '<iframe id="dash-frame" class="html-frame dash-frame" title="' + escapeHtml(String(row.title || 'Dashboard')) + '" sandbox="allow-scripts"></iframe>' +
            '</div>');
          // Sharing: the SAME per-row visibility line + grants panel every
          // record page uses — dashboards are ordinary shareable rows.
          var slot = host.querySelector('#dash-vis-slot');
          if (slot && typeof detailVisLineEl === 'function') {
            var visEl = detailVisLineEl(row);
            if (visEl) {
              slot.appendChild(visEl);
              wireRowSharing(host, 'dashboards', String(row.id), row, function () {
                renderDashboardPage(host, id);
              });
            }
          }
          wireDashMenu(host, row, id);
          // Render the stored page in the isolated frame: read-only data broker
          // + preloaded chart lib + CSP'd srcdoc, exactly like HTML file previews.
          installHtmlFileBroker();
          ensureChartLib().then(function () {
            var f = host.querySelector('#dash-frame');
            if (f && myGen === renderGen) f.srcdoc = htmlFileSrcdoc(String(row.html || ''));
          });
        })
        .catch(function () {
          // Deleted / never existed / not visible: drop the tab and land home.
          anCloseTab('dash:' + id);
          if (location.hash !== AN_HOME_HASH) location.hash = AN_HOME_HASH;
          showToast('That dashboard is no longer available', {});
        });
    }

    function wireDashMenu(host, row, id) {
      var btn = host.querySelector('#dash-menu-btn');
      var menu = host.querySelector('#dash-menu');
      if (!btn || !menu) return;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var show = menu.hidden;
        menu.hidden = !show;
        btn.setAttribute('aria-expanded', show ? 'true' : 'false');
      });
      wireDashMenuGlobal();
      menu.querySelectorAll('.file-menu-item').forEach(function (item) {
        item.addEventListener('click', function () {
          menu.hidden = true;
          var act = item.getAttribute('data-act');
          if (act === 'rename') {
            var next = window.prompt('Rename dashboard', String(row.title || ''));
            if (next === null) return;
            next = next.trim();
            if (!next || next === row.title) return;
            fetch('/api/tables/dashboards/rows/' + encodeURIComponent(id), {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ title: next }),
            })
              .then(function (r) { if (!r.ok) throw new Error('rename failed (' + r.status + ')'); })
              .then(function () {
                row.title = next;
                anSetTabTitle('dash:' + id, next);
                var h1 = host.querySelector('.dash-title');
                if (h1) h1.textContent = next;
                renderDashList();
              })
              .catch(function (e) { showToast('Rename failed: ' + e.message, {}); });
          } else if (act === 'history') {
            var hist = host.querySelector('#record-history');
            if (!hist) return;
            if (!hist.hidden) { hist.hidden = true; return; }
            hist.hidden = false;
            loadRowHistoryInto(host, 'dashboards', id);
          } else if (act === 'delete') {
            fetch('/api/tables/dashboards/rows/' + encodeURIComponent(id), {
              method: 'DELETE',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            })
              .then(function (r) { if (!r.ok) throw new Error('delete failed (' + r.status + ')'); return r.json(); })
              .then(function () {
                showToast('Deleted "' + (row.title || 'dashboard') + '"', { undo: undoLast });
                anCloseTab('dash:' + id);
                renderDashList();
                if (isAnalyticsHash(location.hash) && anTabKeyForHash(location.hash) === 'dash:' + id) {
                  location.hash = AN_HOME_HASH;
                }
              })
              .catch(function (e) { showToast('Delete failed: ' + e.message, {}); });
          }
        });
      });
    }

    // Close the dashboard ⋯ menu on an outside click. Registered once; reads
    // the ids live so it survives re-renders. (The Configure record page has
    // its own closer for #file-menu — separate ids, separate wiring.)
    var anDashMenuWired = false;
    function wireDashMenuGlobal() {
      if (anDashMenuWired) return;
      anDashMenuWired = true;
      document.addEventListener('click', function (e) {
        var menu = document.getElementById('dash-menu');
        var btn = document.getElementById('dash-menu-btn');
        if (!menu || menu.hidden) return;
        if ((btn && btn.contains(e.target)) || menu.contains(e.target)) return;
        menu.hidden = true;
        if (btn) btn.setAttribute('aria-expanded', 'false');
      });
    }

    // ── Assistant working status ───────────────────────────────────────────
    // The chat stream's tool_use events map to ONE transient plain-language
    // line under the feed (never tool names or technical detail — the user
    // sees "Building your dashboard…", not an internal call). Cleared when the
    // turn's text starts streaming or the stream ends.
    function anToolStatus(toolName) {
      var el = document.getElementById('ask-status');
      if (!el) return;
      if (!toolName) { el.textContent = ''; el.hidden = true; return; }
      el.textContent =
        toolName === 'create_dashboard' || toolName === 'edit_dashboard'
          ? 'Building your dashboard…'
          : 'Working on your data…';
      el.hidden = false;
    }

    // Route dispatch for the Analytics side — called by renderRoute after it
    // bumps renderGen and applies the view class, BEFORE it would paint the
    // Configure loading frame (the hidden Configure content must stay intact).
    function renderAnalyticsRoute(hash, soft) {
      anReconcileTab(hash);
      anRenderTabStrip();
      renderDashList();
      var host = document.getElementById('analytics-content');
      if (!host) return;
      if (!soft) host.innerHTML = routeLoadingHtml();
      var m = /^#\\/analytics\\/(.+)$/.exec(hash);
      if (m) { renderDashboardPage(host, decodeURIComponent(m[1])); return; }
      renderAnalyticsHome(host);
    }
`;
