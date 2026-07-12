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
    // Single layout: everything IS the workspace, so this predicate is always true
    // (kept as a shim so drop-to-dock + other call sites keep working unchanged).
    function isAnalyticsHash(h) { return true; }
    var lastAnalyticsHash = '#/';
    var lastConfigureHash = '#/';

    // No view flip in the single layout — kept as a harmless no-op for any caller.
    function applyAppView(hash) {}

    function goAnalytics() {
      location.hash = '#/';
      var input = document.getElementById('chat-input');
      if (input) setTimeout(function () { input.focus(); }, 0);
    }
    // The Configure button opens the Configure drawer (not a view flip).
    function goConfigure() {
      if (typeof openConfigureDrawer === 'function') openConfigureDrawer('datamodel');
      else if (typeof openSettingsDrawer === 'function') openSettingsDrawer('database');
    }

    var ASK_DOCK_KEY = 'lattice.askDockWidth';
    function applyAskDockWidth(px) {
      var w = Math.max(300, Math.min(640, Math.round(px)));
      document.documentElement.style.setProperty('--ask-dock-width', w + 'px');
    }

    function initAnalyticsView() {
      // The Configure button + the drawer are wired by wireSettingsDrawer (it now
      // targets #configure-trigger); the old Ask-Gladys view-toggle button is gone
      // (the Ask Gladys dock is always visible in the single layout).
      // "+" in the Dashboards header → open-or-focus the seeded "Welcome to Lattice!"
      // dashboard. Dedupe is automatic: the router reconciles #/w/dash/<id> to the
      // existing tab, so a second click just re-activates it. If Welcome was deleted
      // (not in the loaded list), fall back to the home empty-state, whose prompt box
      // is the "ask Gladys to build one" starting point.
      var newBtn = document.getElementById('dash-new-btn');
      if (newBtn && !newBtn.__wired) {
        newBtn.__wired = true;
        newBtn.addEventListener('click', function () {
          var hasWelcome =
            anDashRows &&
            anDashRows.some(function (r) {
              return String(r.id) === 'welcome-lattice';
            });
          location.hash = hasWelcome ? '#/w/dash/welcome-lattice' : AN_HOME_HASH;
        });
      }
      // The brand logo just navigates home (#/) via its href — no view toggle in
      // the single layout.
      // Restore + wire the adjustable Ask Gladys dock width (drag its left edge).
      var savedW = parseInt(window.localStorage.getItem(ASK_DOCK_KEY) || '', 10);
      if (!isNaN(savedW)) applyAskDockWidth(savedW);
      var handle = document.getElementById('ask-dock-resize');
      if (handle && !handle.__wired) {
        handle.__wired = true;
        handle.addEventListener('pointerdown', function (e) {
          e.preventDefault();
          var startX = e.clientX;
          var dock = document.getElementById('ask-dock');
          var startW = dock ? dock.getBoundingClientRect().width : 360;
          handle.classList.add('dragging');
          function move(ev) {
            // Dock is on the right; dragging LEFT (smaller clientX) widens it.
            applyAskDockWidth(startW - (ev.clientX - startX));
          }
          function upFn() {
            handle.classList.remove('dragging');
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', upFn);
            var cur = parseInt(
              getComputedStyle(document.documentElement).getPropertyValue('--ask-dock-width'), 10);
            if (!isNaN(cur)) window.localStorage.setItem(ASK_DOCK_KEY, String(cur));
          }
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', upFn);
        });
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
              var key = 'dashboard:' + r.id;
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
              location.hash = '#/w/dash/' + encodeURIComponent(el.getAttribute('data-dash-id'));
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

    // Realtime hook: a dashboards row changed (most often Gladys building one via
    // chat). Nothing else watches the dashboards table, and renderAnalyticsHome
    // short-circuits on the cached anDashRows (which is [] after the first empty
    // load), so without this a newly-created dashboard never appears in the
    // sidebar or home until a hard reload. Bust the cache, refresh the sidebar,
    // and re-render the home when it is the active view. Called from the feed
    // dispatcher for table === 'dashboards'.
    function refreshDashboardsLive() {
      anDashRows = null;
      renderDashList().then(function () {
        if (location.hash === AN_HOME_HASH) {
          var host = document.getElementById('content');
          if (host) renderAnalyticsHome(host);
        }
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
            ? 'Open a dashboard from the left, or start one below.'
            : 'Ask Gladys a question about your data — when a picture answers it best, she builds a dashboard for you.') +
          '</p>' +
          // A prompt box right in the empty state: describe a dashboard / ask a
          // question and it goes to Gladys (the same chat turn the dock composer
          // fires). This is the "New Dashboard" starting point.
          '<form class="analytics-home-prompt" id="an-home-prompt">' +
          '<textarea id="an-home-input" rows="1" placeholder="Describe a dashboard, or ask a question about your data…"></textarea>' +
          '<button type="submit" class="btn primary" id="an-home-send">Ask Gladys</button>' +
          '</form>' +
          '</div>');
        var form = host.querySelector('#an-home-prompt');
        var input = host.querySelector('#an-home-input');
        if (input) {
          // Grow to fit, and Enter (no shift) submits like the dock composer.
          input.addEventListener('input', function () {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 200) + 'px';
          });
          input.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            if (e.metaKey || e.ctrlKey) {
              e.preventDefault();
              var s = input.selectionStart, en = input.selectionEnd;
              input.value = input.value.slice(0, s) + '\\n' + input.value.slice(en);
              input.selectionStart = input.selectionEnd = s + 1;
              input.dispatchEvent(new Event('input'));
              return;
            }
            if (!e.shiftKey) { e.preventDefault(); if (form) form.requestSubmit(); }
          });
          setTimeout(function () { input.focus(); }, 0);
        }
        if (form) {
          form.addEventListener('submit', function (e) {
            e.preventDefault();
            var q = input ? input.value.trim() : '';
            if (!q) return;
            input.value = '';
            input.style.height = 'auto';
            // Hand off to the assistant exactly like the dock composer — the
            // reply (and any dashboard it builds) streams into the Ask Gladys dock.
            if (typeof sendChat === 'function') sendChat(q);
          });
        }
      });
    }

    // ── Dashboard page (one open tab) ──────────────────────────────────────
    function renderDashboardPage(host, id) {
      var myGen = renderGen;
      fetchJson('/api/tables/dashboards/rows/' + encodeURIComponent(id))
        .then(function (row) {
          if (!row || row.error || !row.id) throw new Error('not found');
          anSetTabTitle('dashboard:' + id, String(row.title || 'Dashboard'));
          if (myGen !== renderGen) return;
          setContent(host, myGen,
            '<div class="dash-page">' +
            '<div class="view-header dash-header">' +
            '<h1 class="dash-title">' + escapeHtml(String(row.title || 'Dashboard')) + '</h1>' +
            '<span class="dash-vis-slot" id="dash-vis-slot"></span>' +
            '<div class="file-menu-wrap dash-menu-wrap">' +
            '<button type="button" class="btn file-menu-btn" id="dash-menu-btn" title="Dashboard actions" aria-haspopup="menu" aria-expanded="false">⋯</button>' +
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
            // detailVisLineEl returns an HTML STRING (not a node) — set it as
            // innerHTML. Using appendChild here threw on cloud/team workspaces
            // (where row._access is populated, so the string is non-empty),
            // which the outer .catch swallowed by closing the tab and bouncing
            // home — dashboards never opened on a shared workspace.
            var visHtml = detailVisLineEl(row);
            if (visHtml) {
              slot.innerHTML = visHtml;
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
          anCloseTab('dashboard:' + id);
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
                anSetTabTitle('dashboard:' + id, next);
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
            // Confirm before the immediate DELETE (the undo toast still lets the
            // user recover, but the delete shouldn't fire on a single stray click).
            if (!window.confirm('Remove "' + (row.title || 'dashboard') + '"? You can undo this from history.')) return;
            fetch('/api/tables/dashboards/rows/' + encodeURIComponent(id), {
              method: 'DELETE',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            })
              .then(function (r) { if (!r.ok) throw new Error('delete failed (' + r.status + ')'); return r.json(); })
              .then(function () {
                showToast('Deleted "' + (row.title || 'dashboard') + '"', { undo: undoLast });
                anCloseTab('dashboard:' + id);
                renderDashList();
                if (isAnalyticsHash(location.hash) && anTabKeyForHash(location.hash) === 'dashboard:' + id) {
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
      if (typeof renderNavSections === 'function') renderNavSections();
      var host = document.getElementById('content');
      if (!host) return;
      if (!soft) host.innerHTML = routeLoadingHtml();
      // Typed Workspace tabs: #/w/(dash|table|file|md)/<first>[/<drill-in>…].
      var m = /^#\\/w\\/(dash|table|file|md)\\/(.+)$/.exec(hash);
      if (m) {
        var kind = m[1], rest = m[2];
        if (kind === 'dash') { renderDashboardPage(host, decodeURIComponent(rest.split('/')[0])); return; }
        if (kind === 'file') { renderFsItem(host, ['files', decodeURIComponent(rest.split('/')[0])], 'w:file'); return; }
        // table + markdown: <name>[/<rowId>/<rel>/<id>…]; odd seg count = collection,
        // even = a record (the same split the fs renderers use).
        var segs = rest.split('/').map(function (s) { return decodeURIComponent(s); });
        var section = kind === 'md' ? 'w:md' : 'w:table';
        if (segs.length % 2 === 1) renderFsCollection(host, segs, section);
        else renderFsItem(host, segs, section);
        return;
      }
      renderAnalyticsHome(host);
    }
`;
