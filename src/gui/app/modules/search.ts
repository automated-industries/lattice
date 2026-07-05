// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const searchJs = `    // ────────────────────────────────────────────────────────────
    // Version history (undo / redo / log)
    // ────────────────────────────────────────────────────────────
    // ── Page-navigation history — PER WORKSPACE ──────────────────
    // Back/Forward operate on an app-managed hash-history stack keyed by the
    // active workspace, NOT window.history: the browser history spans workspace
    // switches (a switch is a soft reload, no page load), so its Back walked into
    // hashes from the PREVIOUS workspace — records/tables the new workspace does
    // not even have. Each workspace keeps its own stack for the session;
    // switching swaps stacks and lands on the NEW workspace's last location
    // (home for a first visit), never the old one's.
    var navStacks = {};
    var navKey = '_';
    var navSuppress = false;
    function navStack() {
      if (!navStacks[navKey]) navStacks[navKey] = { entries: [location.hash || '#/'], index: 0 };
      return navStacks[navKey];
    }
    function navUpdateButtons() {
      var st = navStack();
      var b = document.getElementById('nav-back-btn');
      var f = document.getElementById('nav-fwd-btn');
      if (b) b.disabled = st.index <= 0;
      if (f) f.disabled = st.index >= st.entries.length - 1;
    }
    function navRecord() {
      if (navSuppress) { navSuppress = false; navUpdateButtons(); return; }
      var st = navStack();
      var h = location.hash || '#/';
      if (st.entries[st.index] === h) { navUpdateButtons(); return; }
      st.entries = st.entries.slice(0, st.index + 1);
      st.entries.push(h);
      if (st.entries.length > 100) st.entries.shift(); // bounded
      st.index = st.entries.length - 1;
      navUpdateButtons();
    }
    function navGo(delta) {
      var st = navStack();
      var ni = st.index + delta;
      if (ni < 0 || ni >= st.entries.length) return;
      st.index = ni;
      if ((location.hash || '#/') === st.entries[ni]) { navUpdateButtons(); return; }
      navSuppress = true;
      location.hash = st.entries[ni];
      navUpdateButtons();
    }
    function navSetWorkspace(id, initOnly) {
      navKey = String(id || '_');
      if (!navStacks[navKey]) {
        // A first visit seeds HOME on a switch (the old workspace's hash must not
        // leak in), but seeds the current hash at boot (deep links keep working).
        navStacks[navKey] = { entries: [initOnly ? (location.hash || '#/') : '#/analytics'], index: 0 };
      }
      if (!initOnly) {
        var st = navStack();
        var target = st.entries[st.index] || '#/';
        if ((location.hash || '#/') !== target) {
          navSuppress = true;
          location.hash = target;
        }
      }
      navUpdateButtons();
    }
    window.addEventListener('hashchange', navRecord);

    function wireHistoryControls() {
      // Back / Forward move through the app-managed, per-workspace page history
      // (see above). They sit next to Undo/Redo (which are for DATA edits).
      var back = document.getElementById('nav-back-btn');
      if (back) back.addEventListener('click', function () { navGo(-1); });
      var fwd = document.getElementById('nav-fwd-btn');
      if (fwd) fwd.addEventListener('click', function () { navGo(1); });
      navUpdateButtons();
      document.getElementById('undo-btn').addEventListener('click', function () {
        gaTrack('history_action', { action: 'undo' });
        fetchJson('/api/history/undo', { method: 'POST' })
          .then(function () { return afterMutation(); })
          .then(function () { showToast('Last change undone', {}); })
          .catch(function (err) { showToast('Undo failed: ' + err.message, {}); });
      });
      document.getElementById('redo-btn').addEventListener('click', function () {
        gaTrack('history_action', { action: 'redo' });
        fetchJson('/api/history/redo', { method: 'POST' })
          .then(function () { return afterMutation(); })
          .then(function () { showToast('Redone', {}); })
          .catch(function (err) { showToast('Redo failed: ' + err.message, {}); });
      });
    }

    /**
     * Re-fetch everything that might have changed and re-render. Used after
     * any mutation that goes through the audit log: row CRUD, link/unlink,
     * undo, redo, revert.
     */
    function afterMutation(changedTables) {
      // Scoped invalidation: drop only the tables that actually changed so a
      // collaborator's edit to one table doesn't force re-fetching every OTHER
      // cached table this view references (the dominant cloud egress cost). A
      // null/empty list (local mutation, schema change, or unknown table) falls
      // back to a full cache wipe — the safe default.
      if (changedTables && changedTables.length) {
        for (var i = 0; i < changedTables.length; i++) delete loadedTables[changedTables[i]];
      } else {
        loadedTables = {};
      }
      return Promise.all([
        fetchJson('/api/entities-summary'),
        refreshHistoryState(),
      ]).then(function (r) {
        state.entities = r[0];
        renderSidebar();
        // Soft re-render: this is a background refresh (a mutation landed, or the
        // render finished), not a navigation — keep the current view on screen and
        // swap in the fresh data without flashing through a loading frame.
        renderRoute({ soft: true });
      });
    }

    function refreshHistoryState() {
      return fetchJson('/api/history?limit=1').then(function (h) {
        document.getElementById('undo-btn').disabled = !h.canUndo;
        document.getElementById('redo-btn').disabled = !h.canRedo;
        return h;
      }).catch(function () { /* swallow */ });
    }

    // A full-app fade overlay shown while a workspace switch (or schema reload)
    // rebuilds every column — so the Inputs/Model/Outputs panes appear to switch
    // together instead of popping in at different speeds.
    function wsOverlayEl() {
      var el = document.getElementById('ws-switch-overlay');
      if (!el) {
        el = document.createElement('div');
        el.id = 'ws-switch-overlay';
        el.className = 'ws-switch-overlay';
        el.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
        document.body.appendChild(el);
      }
      return el;
    }
    function showSwitchOverlay() { wsOverlayEl().classList.add('show'); }
    function hideSwitchOverlay() { var el = document.getElementById('ws-switch-overlay'); if (el) el.classList.remove('show'); }

    /** Refetch everything after a DB switch and rerender. */
    function reloadEverything() {
      showSwitchOverlay();
      return Promise.all([
        fetchJson('/api/entities-summary'),
        fetchJson('/api/gui-meta').catch(function () { return {}; }),
        fetchJson('/api/gui-meta/columns').catch(function () { return {}; }),
        fetchJson('/api/system-tables').catch(function () { return { tables: [] }; }),
        fetchJson('/api/workspaces').catch(function () { return null; }),
        fetchJson('/api/dbconfig').catch(function () { return {}; }),
      ]).then(function (results) {
        state.entities = results[0];
        state.iconOverrides = results[1] || {};
        state.columnMeta = results[2] || {};
        state.systemTables = (results[3] && results[3].tables) || [];
        renderWsSwitcher(results[4]);
        // Re-point the header logo at the NEW workspace's mark — the switch path
        // must refresh branding the way boot does (the etag cache-busts the
        // <img>), else the previous workspace's logo stays until a hard refresh.
        applyWorkspaceLogo((results[5] || {}).logoEtag);
        renderSidebar();
        // The Outputs column (Markdown context tree + Tables mirror) is
        // per-workspace; refresh it on switch or the new workspace shows the
        // PREVIOUS workspace's rendered context until a hard reload.
        renderOutputs();
        // renderWsSwitcher set cloudMode from the new workspace's kind; re-render
        // the composer so the Private-mode toggle reflects local vs cloud (it is
        // forced checked+disabled on local). See #7.
        renderComposer();
        // #G — the chat rail is per-workspace (chat_threads/chat_messages live in
        // the workspace DB), so a switch/create must reset it to the NEW
        // workspace's conversation instead of stranding the previous one on screen.
        // (Reset inline rather than via newChat() so it doesn't fire the
        // assistant_thread_new analytics event on every switch.)
        currentThreadId = null;
        clearChat();
        refreshThreadList(true);
        // A switch stays in the SAME view the user is in — Analytics stays in
        // Analytics (its home; the new workspace has its own dashboards),
        // Configure stays in Configure (its home). It never yanks the user
        // across views. (The new workspace's own last location is in its nav
        // stack for Back.)
        var switchTarget = (typeof isAnalyticsHash === 'function' && isAnalyticsHash(location.hash))
          ? '#/analytics'
          : '#/';
        if (location.hash !== switchTarget) location.hash = switchTarget;
        // Already on the target home: re-render in place as a soft refresh so a
        // workspace switch/reload doesn't flash the loading frame over the pane.
        else renderRoute({ soft: true });
        loadedTables = {};
        // The Tables explorer's cached edges + any in-flight wire/merge selection
        // are per-workspace module state — reset them so the new workspace doesn't
        // inherit the previous one's relationship edges or picked source.
        mtResetState();
        // Open dashboard tabs + the cached Dashboards list are per-workspace too —
        // stale tabs from the previous workspace would 404 in the new one.
        anResetTabs();
        anDashRows = null;
        // A switch swaps the server-side buses to the new workspace; drop the old
        // workspace's render overlay state and reconnect the multiplexed event
        // stream so realtime/feed/render all rebind to this workspace.
        renderProgress = {};
        startEventStream();
      }).finally(function () {
        // Reveal the freshly-rebuilt columns together (a short tick lets the last
        // synchronous renders settle before the overlay fades out).
        setTimeout(hideSwitchOverlay, 60);
      });
    }

`;
