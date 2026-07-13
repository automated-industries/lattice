// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const tableViewJs = `    // ────────────────────────────────────────────────────────────
    // Settings drawer (gear icon → slide-over). Reuses the existing
    // settings render functions, one per tab, plus the Advanced toggle.
    // ────────────────────────────────────────────────────────────
    var drawerTab = 'user';
    function drawerIsOpen() {
      var d = document.getElementById('settings-drawer');
      return !!(d && !d.hidden);
    }
    // Highlight the header trigger whose takeover is open: the clock for the
    // Version-history tab, the gear for everything else.
    function updateTakeoverTriggers() {
      var open = drawerIsOpen();
      var hist = document.getElementById('history-link');
      var gear = document.getElementById('configure-trigger');
      if (hist) hist.classList.toggle('on', open && drawerTab === 'history');
      if (gear) gear.classList.toggle('on', open && drawerTab !== 'history');
    }
    // Pending close-hide timer (the fade-out delay before the drawer is display:none'd).
    // Tracked so a reopen within the fade window cancels it — otherwise a stale timeout
    // would hide a just-reopened drawer AND leave body.drawer-open behind, freezing page
    // scroll with no visible drawer to close.
    var drawerHideTimer = null;
    function openSettingsDrawer(section) {
      drawerTab = section || drawerTab || 'user';
      var drawer = document.getElementById('settings-drawer');
      var backdrop = document.getElementById('drawer-backdrop');
      if (!drawer || !backdrop) return;
      // Cancel any pending close-hide so this reopen can't be undone by a stale timeout.
      if (drawerHideTimer) { window.clearTimeout(drawerHideTimer); drawerHideTimer = null; }
      // The panel fills the workspace BELOW the header — measure the real
      // topbar height (the CSS default is a fallback).
      var bar = document.querySelector('header.topbar');
      if (bar) drawer.style.top = bar.offsetHeight + 'px';
      // Lock background scroll: the drawer is an opaque full-workspace takeover, so
      // the columns beneath it must not scroll (wheel/trackpad would otherwise chain
      // out to the document). Removed symmetrically in closeSettingsDrawer.
      document.body.classList.add('drawer-open');
      backdrop.hidden = false;
      drawer.hidden = false;
      // Allow the elements to lay out before transitioning in.
      window.requestAnimationFrame(function () {
        drawer.classList.add('open');
        backdrop.classList.add('open');
      });
      selectDrawerTab(drawerTab);
    }
    function closeSettingsDrawer() {
      var drawer = document.getElementById('settings-drawer');
      var backdrop = document.getElementById('drawer-backdrop');
      if (!drawer || !backdrop) return;
      document.body.classList.remove('drawer-open');
      drawer.classList.remove('open');
      backdrop.classList.remove('open');
      if (drawerHideTimer) window.clearTimeout(drawerHideTimer);
      drawerHideTimer = window.setTimeout(function () {
        drawerHideTimer = null;
        // A reopen during the fade re-adds .open (and cleared this timer already); if we
        // somehow still run, don't hide/strand the reopened drawer.
        if (drawer.classList.contains('open')) return;
        drawer.hidden = true;
        backdrop.hidden = true;
      }, 220);
      updateTakeoverTriggers();
      var hist = document.getElementById('history-link');
      var gear = document.getElementById('configure-trigger');
      if (hist) hist.classList.remove('on');
      if (gear) gear.classList.remove('on');
      // Keep the URL in sync with what's actually on screen. Any drawer-opening
      // hash — a settings hash (#/settings/..., e.g. from a "User Settings" link) OR
      // a Configure route (#/graph, #/tables) that configureRouteFor maps to this
      // drawer — makes renderRoute REOPEN the drawer for that hash. So if the hash
      // stayed put, a later re-render (submitting a chat message, a live data
      // refresh) would pop the panel open on its own. Reset the hash to the
      // workspace the drawer was overlaying. replaceState (not a location.hash
      // assignment) avoids both a spurious history entry and a redundant re-render
      // — the workspace is already on screen beneath the drawer.
      if (
        (location.hash.indexOf('#/settings/') === 0 ||
          (typeof configureRouteFor === 'function' && configureRouteFor(location.hash))) &&
        window.history &&
        window.history.replaceState
      ) {
        window.history.replaceState(null, '', '#/');
      }
    }
    function selectDrawerTab(tab) {
      drawerTab = tab;
      document.querySelectorAll('.drawer-tab').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-tab') === tab);
      });
      // History is a standalone takeover: hide the Settings tab row so it doesn't
      // read as a Settings sub-tab. Show the row for the real settings tabs.
      var tabsRow = document.getElementById('drawer-tabs');
      if (tabsRow) tabsRow.hidden = (tab === 'history');
      var body = document.getElementById('drawer-body');
      if (!body) return;
      // Data Model + Graph + Databases run edge-to-edge (no 980px cap) — Data
      // Model/Graph for the canvas, Databases for its multi-column table. The
      // rest of the Configure tabs stay in the centered reading column.
      body.classList.toggle(
        'dm-wide',
        tab === 'datamodel' || tab === 'graph' || tab === 'databases',
      );
      var title = document.querySelector('#settings-drawer .drawer-title');
      if (title) title.textContent = tab === 'history' ? 'Version history' : 'Configure';
      if (tab === 'history') renderHistory(body);
      else if (tab === 'datamodel' && typeof renderDataModelTab === 'function') renderDataModelTab(body);
      else if (tab === 'graph' && typeof renderGraphTab === 'function') renderGraphTab(body);
      else if (tab === 'files' && typeof renderFilesTab === 'function') renderFilesTab(body);
      else if (tab === 'connectors' && typeof renderConnectorsTab === 'function') renderConnectorsTab(body);
      else if (tab === 'databases' && typeof renderDatabasesTab === 'function') renderDatabasesTab(body);
      else if (tab === 'database') renderDatabaseSettings(body);
      else renderUserConfig(body);
      updateTakeoverTriggers();
    }
    function wireSettingsDrawer() {
      // Both header triggers TOGGLE the takeover: click to open (highlighted),
      // click the same trigger again to collapse. Clicking the other trigger
      // switches the panel's content in place.
      var gear = document.getElementById('configure-trigger');
      if (gear) gear.addEventListener('click', function () {
        if (drawerIsOpen() && drawerTab !== 'history') { closeSettingsDrawer(); return; }
        openSettingsDrawer(drawerTab === 'history' ? 'user' : drawerTab || 'user');
      });
      var histBtn = document.getElementById('history-link');
      if (histBtn) histBtn.addEventListener('click', function () {
        if (drawerIsOpen() && drawerTab === 'history') { closeSettingsDrawer(); return; }
        openSettingsDrawer('history');
      });
      var closeBtn = document.getElementById('drawer-close');
      if (closeBtn) closeBtn.addEventListener('click', closeSettingsDrawer);
      var backdrop = document.getElementById('drawer-backdrop');
      if (backdrop) backdrop.addEventListener('click', closeSettingsDrawer);
      document.querySelectorAll('.drawer-tab').forEach(function (b) {
        b.addEventListener('click', function () { selectDrawerTab(b.getAttribute('data-tab')); });
      });
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        var drawer = document.getElementById('settings-drawer');
        if (drawer && !drawer.hidden) closeSettingsDrawer();
      });
    }

`;
