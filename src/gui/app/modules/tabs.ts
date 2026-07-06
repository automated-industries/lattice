// Auto-composed segment of the GUI client script (see modules/index.ts). Defines
// the center "Model" header's tab strip: exactly TWO permanent (non-closable)
// tabs — Graph and Tables — that switch the Model view between the force-directed
// brain graph (#/graph) and the tiered Tables explorer (#/tables). Tabs are
// router-driven (a tab IS a hash). Every other route — records, collections,
// dashboard, version history, system tables — renders in the content area below
// with NO tab (reached by drilling; a breadcrumb navigates back). Must stay
// INSIDE the client IIFE (uses escapeHtml/location), so it is inserted before
// createDatabaseWizardJs in modules/index.ts.
export const tabsJs = `
    var GRAPH_HASH = '#/graph';
    // The center "Model" pane has exactly TWO views, expressed as two permanent
    // (non-closable) tabs: Graph and Tables. Every other route — records,
    // collections, dashboard, version history, system tables — renders in the
    // content area below with NO tab (it's reached by drilling in; a breadcrumb
    // navigates back). So the strip never grows beyond these two.
    var tabs = [
      { key: 'folders', title: 'Objects', icon: '', hash: '#/folders', closable: false },
      { key: 'graph', title: 'Graph', icon: '', hash: GRAPH_HASH, closable: false },
      { key: 'tables', title: 'Tables', icon: '', hash: '#/tables', closable: false },
    ];
    var activeTabKey = 'folders';
    // Count of unanswered ingestion questions. Drives a transient 'Data Questions'
    // tab (appended after Tables) with an unread badge — it appears only while
    // questions are outstanding and vanishes when they're all answered/dismissed.
    // setQuestionsTab (called by the questions module) keeps this in sync.
    var questionsBadge = 0;
    var QUESTIONS_HASH = '#/questions';
    function questionsTabPresent() { return !!findTab('questions'); }
    // Add / remove the Data Questions tab and refresh its badge. When the count
    // drops to zero while the user is viewing it, route them back to Tables so they
    // aren't stranded on a tab that's about to disappear.
    function setQuestionsTab(count) {
      questionsBadge = count > 0 ? count : 0;
      var present = questionsTabPresent();
      if (count > 0 && !present) {
        tabs.push({ key: 'questions', title: 'Data Questions', icon: '', hash: QUESTIONS_HASH, closable: false });
      } else if (count <= 0 && present) {
        // Bounce to Tables ONLY if the user is actually viewing the questions page.
        // Keying off activeTabKey would be wrong — it can be a stale 'questions' after
        // a Configure→Analytics toggle (renderRoute skips reconcileTab for analytics
        // hashes), which would yank an Analytics user to Tables when they answer the
        // last dock question. location.hash is the source of truth for where they are.
        var onQuestionsPage = location.hash === QUESTIONS_HASH;
        tabs = tabs.filter(function (t) { return t.key !== 'questions'; });
        if (onQuestionsPage) { location.hash = '#/tables'; return; } // re-render on hashchange
      }
      renderTabStrip();
    }

    // 'folders' | 'graph' | 'tables' | null. Each model view maps to its tab; object
    // / collection / record pages (#/folders/*, #/fs/*, #/objects/*) belong to the
    // Folders view — they're reached by drilling in from it — so they keep the
    // Folders tab lit. Folders is the default landing view.
    function tabKeyForHash(hash) {
      hash = hash || '#/';
      if (hash === '#/' || hash === '' || hash === '#/folders') return 'folders';
      // #/graph and its drill-in #/graph/<obj>[/<id>…] all belong to the Graph section.
      if (hash === GRAPH_HASH || hash.indexOf('#/graph/') === 0) return 'graph';
      // #/tables and its Object Page / record drill-ins #/tables/<obj>[/<id>…].
      if (hash === '#/tables' || hash.indexOf('#/tables/') === 0) return 'tables';
      // The computed-table builder is part of the Tables section.
      if (hash.indexOf('#/computed/') === 0) return 'tables';
      // The transient Data Questions section (only lit while its tab exists).
      if (hash === QUESTIONS_HASH) return 'questions';
      if (
        hash.indexOf('#/folders/') === 0 ||
        hash.indexOf('#/fs/') === 0 ||
        hash.indexOf('#/objects/') === 0 ||
        hash.indexOf('#/folder/') === 0
      ) {
        return 'folders';
      }
      return null;
    }

    function findTab(key) {
      for (var i = 0; i < tabs.length; i++) if (tabs[i].key === key) return tabs[i];
      return null;
    }

    // Sync which model tab is highlighted for the current hash. Settings drawer
    // overlays (except history) float over the current view and must NOT change
    // the active tab; every other non-model route deselects both tabs.
    function reconcileTab(hash) {
      if (hash.indexOf('#/settings/') === 0) return; // settings + history are takeovers, not pages
      activeTabKey = tabKeyForHash(hash) || '';
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

    // A shrunk, ~square tab is about this wide (icon + padding); used to decide how
    // many tabs fit before the rest collapse into the overflow menu.
    var TAB_MIN_W = 38;
    var tabOverflowWired = false;
    function tabBtnHtml(t) {
      var active = t.key === activeTabKey ? ' active' : '';
      // The Data Questions tab carries an unread badge with the outstanding count.
      var badge = t.key === 'questions' && questionsBadge > 0
        ? '<span class="tab-badge" aria-label="' + questionsBadge + ' unanswered">' + questionsBadge + '</span>'
        : '';
      return '<button type="button" class="tab' + active + '" data-key="' + escapeHtml(t.key) +
        '" title="' + escapeHtml(t.title) + '">' +
        (t.icon ? '<span class="tab-icon">' + t.icon + '</span>' : '') +
        '<span class="tab-title">' + escapeHtml(t.title) + '</span>' +
        badge +
        (t.closable
          ? '<span class="tab-close" data-close="' + escapeHtml(t.key) +
              '" role="button" aria-label="Close tab" title="Close">✕</span>'
          : '') +
        '</button>';
    }
    function renderTabStrip() {
      var wrap = document.getElementById('tabstrip-tabs');
      if (!wrap) return;
      // Tabs shrink (CSS flex) to fit the strip; only when even at minimum width
      // they'd overflow do the trailing ones collapse into a "⋯" overflow menu —
      // so a horizontal scrollbar never appears. The active tab is always visible.
      var avail = wrap.clientWidth || 600;
      var visible = tabs.slice();
      var overflow = [];
      if (tabs.length * TAB_MIN_W > avail) {
        var maxVisible = Math.max(1, Math.floor((avail - 44) / TAB_MIN_W));
        if (maxVisible < tabs.length) {
          visible = tabs.slice(0, maxVisible);
          var activeIdx = -1;
          for (var i = 0; i < tabs.length; i++) if (tabs[i].key === activeTabKey) { activeIdx = i; break; }
          if (activeIdx >= maxVisible) visible = tabs.slice(0, maxVisible - 1).concat([tabs[activeIdx]]);
          var shown = {};
          visible.forEach(function (t) { shown[t.key] = true; });
          overflow = tabs.filter(function (t) { return !shown[t.key]; });
        }
      }
      var html = visible.map(tabBtnHtml).join('');
      if (overflow.length) {
        html += '<div class="tab-overflow-wrap">' +
          '<button type="button" class="tab tab-overflow-btn" id="tab-overflow-btn" aria-haspopup="menu" aria-expanded="false" title="More tabs">⋯ ' + overflow.length + '</button>' +
          '<div class="tab-overflow-menu" id="tab-overflow-menu" role="menu" hidden>' +
          overflow.map(function (t) {
            var ovBadge = t.key === 'questions' && questionsBadge > 0
              ? '<span class="tab-badge" aria-label="' + questionsBadge + ' unanswered">' + questionsBadge + '</span>'
              : '';
            return '<div class="tab-ov-item' + (t.key === activeTabKey ? ' active' : '') + '" data-key="' + escapeHtml(t.key) + '" role="menuitem">' +
              '<span class="tab-icon">' + (t.icon || '📄') + '</span>' +
              '<span class="tab-ov-label">' + escapeHtml(t.title) + '</span>' +
              ovBadge +
              (t.closable ? '<span class="tab-close" data-close="' + escapeHtml(t.key) + '" role="button" aria-label="Close tab" title="Close">✕</span>' : '') +
              '</div>';
          }).join('') +
          '</div></div>';
      }
      wrap.innerHTML = html;
      wrap.querySelectorAll('.tab[data-key]').forEach(function (el) {
        el.addEventListener('click', function (ev) {
          var closeEl = ev.target && ev.target.closest ? ev.target.closest('.tab-close') : null;
          if (closeEl) { ev.stopPropagation(); closeTab(closeEl.getAttribute('data-close')); return; }
          var t = findTab(el.getAttribute('data-key'));
          if (t) location.hash = t.hash;
        });
      });
      var ovBtn = document.getElementById('tab-overflow-btn');
      var ovMenu = document.getElementById('tab-overflow-menu');
      if (ovBtn && ovMenu) {
        ovBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          var show = ovMenu.hidden; ovMenu.hidden = !show;
          ovBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
        });
        ovMenu.querySelectorAll('.tab-ov-item').forEach(function (it) {
          it.addEventListener('click', function (ev) {
            var closeEl = ev.target && ev.target.closest ? ev.target.closest('.tab-close') : null;
            if (closeEl) { ev.stopPropagation(); closeTab(closeEl.getAttribute('data-close')); return; }
            var t = findTab(it.getAttribute('data-key'));
            if (t) { ovMenu.hidden = true; location.hash = t.hash; }
          });
        });
      }
      wireTabOverflowGlobal();
    }
    // Close the overflow menu on an outside click; re-fit the strip on resize.
    // Registered once (the menu is re-created with a stable id each render).
    function wireTabOverflowGlobal() {
      if (tabOverflowWired) return;
      tabOverflowWired = true;
      document.addEventListener('click', function (e) {
        var menu = document.getElementById('tab-overflow-menu');
        var btn = document.getElementById('tab-overflow-btn');
        if (!menu || menu.hidden) return;
        if ((btn && btn.contains(e.target)) || menu.contains(e.target)) return;
        menu.hidden = true; if (btn) btn.setAttribute('aria-expanded', 'false');
      });
      window.addEventListener('resize', function () { renderTabStrip(); });
    }
`;
