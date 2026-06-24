// Auto-composed segment of the GUI client script (see modules/index.ts). Defines
// the center tab strip: one tab per open view, plus a permanent (non-closable)
// Brain Graph tab. Tabs are router-driven — a tab IS a hash, so opening/closing a
// tab is just navigation. tabKeyForHash collapses the fs/objects prefixes so
// re-clicking a sidebar item activates the existing tab instead of duplicating it.
// Must stay INSIDE the client IIFE (uses escapeHtml/displayFor/location), so it is
// inserted before createDatabaseWizardJs in modules/index.ts.
export const tabsJs = `
    var GRAPH_HASH = '#/graph';
    var tabs = [{ key: 'graph', title: 'Brain Graph', icon: '🧠', hash: GRAPH_HASH, closable: false }];
    var activeTabKey = 'graph';

    // Map a hash to a stable logical tab key, or null = no tab (drawer-settings
    // overlays). #/fs/<t> and #/objects/<t> collapse to the same key so toggling
    // modes or re-clicking a sidebar item never duplicates a tab.
    function tabKeyForHash(hash) {
      hash = hash || '#/';
      if (hash === '#/' || hash === '' || hash === GRAPH_HASH) return 'graph';
      if (hash === '#/dashboard') return 'dashboard';
      if (hash === '#/settings/history') return 'history';
      if (hash.indexOf('#/settings/') === 0) return null; // drawer overlay — no tab
      var fs = /^#\\/fs\\/(.+)$/.exec(hash);
      if (fs) {
        var segs = fs[1].split('/').filter(Boolean);
        if (segs[segs.length - 1] === 'new') return 'new:' + segs[0];
        // even segment count → item (table/id[/rel/id…]); odd → collection.
        if (segs.length % 2 === 0) return 'item:' + segs[0] + ':' + segs[segs.length - 1];
        return 'table:' + segs[0];
      }
      var ob = /^#\\/objects\\/([^/]+)(?:\\/(.+))?$/.exec(hash);
      if (ob) return ob[2] ? 'item:' + ob[1] + ':' + ob[2] : 'table:' + ob[1];
      var sys = /^#\\/system\\/([^/]+)$/.exec(hash);
      if (sys) return 'system:' + sys[1];
      return null;
    }

    function tabKeyParts(key) {
      var m = /^(item|table|new|system):([^:]+)/.exec(key || '');
      return m ? { kind: m[1], table: m[2] } : null;
    }
    function tabTitleForHash(key) {
      if (key === 'graph') return 'Brain Graph';
      if (key === 'dashboard') return 'Dashboard';
      if (key === 'history') return 'Version History';
      var p = tabKeyParts(key);
      if (p) {
        var d = (typeof displayFor === 'function') ? displayFor(p.table) : { label: p.table };
        return p.kind === 'new' ? 'New ' + d.label : d.label;
      }
      return 'View';
    }
    function tabIconForHash(key) {
      if (key === 'graph') return '🧠';
      if (key === 'dashboard') return '🏠';
      if (key === 'history') return '🕐';
      var p = tabKeyParts(key);
      if (p && typeof displayFor === 'function') return displayFor(p.table).icon;
      return '📄';
    }

    function findTab(key) {
      for (var i = 0; i < tabs.length; i++) if (tabs[i].key === key) return tabs[i];
      return null;
    }

    // Ensure a tab exists for the current hash and mark it active. Called by
    // renderRoute before its body dispatch. A null key (settings overlay) leaves
    // the active tab unchanged.
    function reconcileTab(hash) {
      var key = tabKeyForHash(hash);
      if (!key) return;
      var tab = findTab(key);
      if (!tab) {
        tabs.push({
          key: key,
          title: tabTitleForHash(key),
          icon: tabIconForHash(key),
          hash: hash,
          closable: key !== 'graph',
        });
      } else {
        tab.hash = hash; // keep the latest hash for this logical tab (fs↔objects)
      }
      activeTabKey = key;
    }

    // Let a view refine its tab's title once it has the display name (e.g. a
    // file's name). No-op if the tab is gone.
    function setTabTitle(key, title) {
      var tab = findTab(key);
      if (tab && title && tab.title !== title) { tab.title = title; renderTabStrip(); }
    }

    function closeTab(key) {
      var idx = -1;
      for (var i = 0; i < tabs.length; i++) if (tabs[i].key === key) { idx = i; break; }
      if (idx < 0 || !tabs[idx].closable) return;
      var wasActive = activeTabKey === key;
      tabs.splice(idx, 1);
      if (wasActive) {
        // Activate the right neighbor, else the left, else the permanent graph.
        var next = tabs[idx] || tabs[idx - 1] || findTab('graph');
        location.hash = next ? next.hash : GRAPH_HASH;
      } else {
        renderTabStrip();
      }
    }

    function renderTabStrip() {
      var wrap = document.getElementById('tabstrip-tabs');
      if (!wrap) return;
      wrap.innerHTML = tabs.map(function (t) {
        var active = t.key === activeTabKey ? ' active' : '';
        return '<button type="button" class="tab' + active + '" data-key="' + escapeHtml(t.key) +
          '" title="' + escapeHtml(t.title) + '">' +
          '<span class="tab-icon">' + (t.icon || '📄') + '</span>' +
          '<span class="tab-title">' + escapeHtml(t.title) + '</span>' +
          (t.closable
            ? '<span class="tab-close" data-close="' + escapeHtml(t.key) +
                '" role="button" aria-label="Close tab" title="Close">✕</span>'
            : '') +
          '</button>';
      }).join('');
      wrap.querySelectorAll('.tab').forEach(function (el) {
        el.addEventListener('click', function (ev) {
          var closeEl = ev.target && ev.target.closest ? ev.target.closest('.tab-close') : null;
          if (closeEl) { ev.stopPropagation(); closeTab(closeEl.getAttribute('data-close')); return; }
          var t = findTab(el.getAttribute('data-key'));
          if (t) location.hash = t.hash;
        });
      });
    }
`;
