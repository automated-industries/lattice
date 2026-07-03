// Auto-composed segment of the GUI client script (see modules/index.ts). The
// ANALYTICS view's tab strip: one closable tab per open dashboard, none
// permanent. Recovered from the original dynamic center-pane tab strip and
// kept behaviorally identical — router-driven (a tab IS a hash), dedup by
// logical key, close falls back right neighbor → left → the Analytics home,
// and a width-based "⋯ N" overflow menu keeps the active tab always visible
// with no horizontal scrollbar. Every identifier and element id is an-/antab-
// prefixed: this segment coexists in ONE shared IIFE with the Configure
// strip's tabs.ts, whose function names it must never redeclare (a duplicate
// declaration would silently replace the Configure implementation — see the
// bare-identifier guard in tests/unit/app-js-composition.test.ts).
// Must stay INSIDE the client IIFE (uses escapeHtml/location); inserted after
// tabsJs in modules/index.ts.
export const analyticsTabsJs = `
    var AN_HOME_HASH = '#/analytics';
    var anTabs = [];
    var anActiveTabKey = '';

    // Map a hash to a stable logical tab key, or null = no tab. The Analytics
    // home has NO tab (an empty strip is a legitimate state); each open
    // dashboard keys by id so re-opening from the sidebar activates the
    // existing tab instead of duplicating it.
    function anTabKeyForHash(hash) {
      hash = hash || '';
      var m = /^#\\/analytics\\/(.+)$/.exec(hash);
      if (m) return 'dash:' + decodeURIComponent(m[1]);
      return null;
    }

    function anFindTab(key) {
      for (var i = 0; i < anTabs.length; i++) if (anTabs[i].key === key) return anTabs[i];
      return null;
    }

    // Ensure a tab exists for the current hash and mark it active. Called by
    // renderRoute before its body dispatch. A null key (the Analytics home)
    // deselects — the strip can legitimately show no active tab.
    function anReconcileTab(hash) {
      var key = anTabKeyForHash(hash);
      if (!key) { anActiveTabKey = ''; return; }
      var tab = anFindTab(key);
      if (!tab) {
        anTabs.push({ key: key, title: 'Dashboard', icon: '📊', hash: hash, closable: true });
      } else {
        tab.hash = hash;
      }
      anActiveTabKey = key;
    }

    // Let the dashboard page refine its tab's title once the row is loaded.
    // No-op if the tab is gone.
    function anSetTabTitle(key, title) {
      var tab = anFindTab(key);
      if (tab && title && tab.title !== title) { tab.title = title; anRenderTabStrip(); }
    }

    function anCloseTab(key) {
      var idx = -1;
      for (var i = 0; i < anTabs.length; i++) if (anTabs[i].key === key) { idx = i; break; }
      if (idx < 0 || !anTabs[idx].closable) return;
      var wasActive = anActiveTabKey === key;
      anTabs.splice(idx, 1);
      if (wasActive) {
        // Activate the right neighbor, else the left, else the Analytics home.
        var next = anTabs[idx] || anTabs[idx - 1] || null;
        location.hash = next ? next.hash : AN_HOME_HASH;
      } else {
        anRenderTabStrip();
      }
    }

    // Drop every open tab (workspace switch — the new workspace has its own
    // dashboards; stale tabs would 404).
    function anResetTabs() {
      anTabs = [];
      anActiveTabKey = '';
      anRenderTabStrip();
    }

    // A shrunk, ~square tab is about this wide (icon + padding); used to decide how
    // many tabs fit before the rest collapse into the overflow menu.
    var AN_TAB_MIN_W = 38;
    var anTabOverflowWired = false;
    function anTabBtnHtml(t) {
      var active = t.key === anActiveTabKey ? ' active' : '';
      return '<button type="button" class="tab' + active + '" data-key="' + escapeHtml(t.key) +
        '" title="' + escapeHtml(t.title) + '">' +
        '<span class="tab-icon">' + (t.icon || '📊') + '</span>' +
        '<span class="tab-title">' + escapeHtml(t.title) + '</span>' +
        (t.closable
          ? '<span class="tab-close" data-close="' + escapeHtml(t.key) +
              '" role="button" aria-label="Close tab" title="Close">✕</span>'
          : '') +
        '</button>';
    }
    function anRenderTabStrip() {
      var wrap = document.getElementById('antabstrip-tabs');
      if (!wrap) return;
      // Tabs shrink (CSS flex) to fit the strip; only when even at minimum width
      // they'd overflow do the trailing ones collapse into a "⋯" overflow menu —
      // so a horizontal scrollbar never appears. The active tab is always visible.
      var avail = wrap.clientWidth || 600;
      var visible = anTabs.slice();
      var overflow = [];
      if (anTabs.length * AN_TAB_MIN_W > avail) {
        var maxVisible = Math.max(1, Math.floor((avail - 44) / AN_TAB_MIN_W));
        if (maxVisible < anTabs.length) {
          visible = anTabs.slice(0, maxVisible);
          var activeIdx = -1;
          for (var i = 0; i < anTabs.length; i++) if (anTabs[i].key === anActiveTabKey) { activeIdx = i; break; }
          if (activeIdx >= maxVisible) visible = anTabs.slice(0, maxVisible - 1).concat([anTabs[activeIdx]]);
          var shown = {};
          visible.forEach(function (t) { shown[t.key] = true; });
          overflow = anTabs.filter(function (t) { return !shown[t.key]; });
        }
      }
      var html = visible.map(anTabBtnHtml).join('');
      if (overflow.length) {
        html += '<div class="tab-overflow-wrap">' +
          '<button type="button" class="tab tab-overflow-btn" id="antab-overflow-btn" aria-haspopup="menu" aria-expanded="false" title="More tabs">⋯ ' + overflow.length + '</button>' +
          '<div class="tab-overflow-menu" id="antab-overflow-menu" role="menu" hidden>' +
          overflow.map(function (t) {
            return '<div class="tab-ov-item' + (t.key === anActiveTabKey ? ' active' : '') + '" data-key="' + escapeHtml(t.key) + '" role="menuitem">' +
              '<span class="tab-icon">' + (t.icon || '📊') + '</span>' +
              '<span class="tab-ov-label">' + escapeHtml(t.title) + '</span>' +
              (t.closable ? '<span class="tab-close" data-close="' + escapeHtml(t.key) + '" role="button" aria-label="Close tab" title="Close">✕</span>' : '') +
              '</div>';
          }).join('') +
          '</div></div>';
      }
      wrap.innerHTML = html;
      wrap.querySelectorAll('.tab[data-key]').forEach(function (el) {
        el.addEventListener('click', function (ev) {
          var closeEl = ev.target && ev.target.closest ? ev.target.closest('.tab-close') : null;
          if (closeEl) { ev.stopPropagation(); anCloseTab(closeEl.getAttribute('data-close')); return; }
          var t = anFindTab(el.getAttribute('data-key'));
          if (t) location.hash = t.hash;
        });
      });
      var ovBtn = document.getElementById('antab-overflow-btn');
      var ovMenu = document.getElementById('antab-overflow-menu');
      if (ovBtn && ovMenu) {
        ovBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          var show = ovMenu.hidden; ovMenu.hidden = !show;
          ovBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
        });
        ovMenu.querySelectorAll('.tab-ov-item').forEach(function (it) {
          it.addEventListener('click', function (ev) {
            var closeEl = ev.target && ev.target.closest ? ev.target.closest('.tab-close') : null;
            if (closeEl) { ev.stopPropagation(); anCloseTab(closeEl.getAttribute('data-close')); return; }
            var t = anFindTab(it.getAttribute('data-key'));
            if (t) { ovMenu.hidden = true; location.hash = t.hash; }
          });
        });
      }
      anWireTabOverflowGlobal();
    }
    // Close the overflow menu on an outside click; re-fit the strip on resize.
    // Registered once (the menu is re-created with a stable id each render).
    function anWireTabOverflowGlobal() {
      if (anTabOverflowWired) return;
      anTabOverflowWired = true;
      document.addEventListener('click', function (e) {
        var menu = document.getElementById('antab-overflow-menu');
        var btn = document.getElementById('antab-overflow-btn');
        if (!menu || menu.hidden) return;
        if ((btn && btn.contains(e.target)) || menu.contains(e.target)) return;
        menu.hidden = true; if (btn) btn.setAttribute('aria-expanded', 'false');
      });
      window.addEventListener('resize', function () { anRenderTabStrip(); });
    }
`;
