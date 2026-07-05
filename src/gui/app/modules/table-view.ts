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
      var gear = document.getElementById('settings-gear');
      if (hist) hist.classList.toggle('on', open && drawerTab === 'history');
      if (gear) gear.classList.toggle('on', open && drawerTab !== 'history');
    }
    function openSettingsDrawer(section) {
      drawerTab = section || drawerTab || 'user';
      var drawer = document.getElementById('settings-drawer');
      var backdrop = document.getElementById('drawer-backdrop');
      if (!drawer || !backdrop) return;
      // The panel fills the workspace BELOW the header — measure the real
      // topbar height (the CSS default is a fallback).
      var bar = document.querySelector('header.topbar');
      if (bar) drawer.style.top = bar.offsetHeight + 'px';
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
      drawer.classList.remove('open');
      backdrop.classList.remove('open');
      window.setTimeout(function () { drawer.hidden = true; backdrop.hidden = true; }, 220);
      updateTakeoverTriggers();
      var hist = document.getElementById('history-link');
      var gear = document.getElementById('settings-gear');
      if (hist) hist.classList.remove('on');
      if (gear) gear.classList.remove('on');
      // Keep the URL in sync with what's actually on screen. A settings hash
      // (#/settings/..., e.g. from a "User Settings" link) opens this drawer over
      // the dashboard, and renderRoute REOPENS the drawer for that hash — so if the
      // hash stayed put, a later re-render (submitting a chat message, a live data
      // refresh) would pop the panel open on its own. Reset the hash to the
      // dashboard the drawer was overlaying. replaceState (not a location.hash
      // assignment) avoids both a spurious history entry and a redundant re-render
      // — the dashboard is already on screen beneath the drawer.
      if (
        location.hash.indexOf('#/settings/') === 0 &&
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
      var title = document.querySelector('#settings-drawer .drawer-title');
      if (title) title.textContent = tab === 'history' ? 'Version history' : 'Settings';
      if (tab === 'history') renderHistory(body);
      else if (tab === 'database') renderDatabaseSettings(body);
      else if (tab === 'lattice') renderLatticeSettings(body);
      else renderUserConfig(body);
      updateTakeoverTriggers();
    }
    function wireSettingsDrawer() {
      // Both header triggers TOGGLE the takeover: click to open (highlighted),
      // click the same trigger again to collapse. Clicking the other trigger
      // switches the panel's content in place.
      var gear = document.getElementById('settings-gear');
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
