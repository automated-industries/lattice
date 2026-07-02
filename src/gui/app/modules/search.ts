// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const searchJs = `    // ────────────────────────────────────────────────────────────
    // Version history (undo / redo / log)
    // ────────────────────────────────────────────────────────────
    function wireHistoryControls() {
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

    /** Refetch everything after a DB switch and rerender. */
    function reloadEverything() {
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
        if (location.hash !== '#/') location.hash = '#/';
        // Already on the dashboard hash: re-render in place as a soft refresh so a
        // workspace switch/reload doesn't flash the loading frame over the pane.
        else renderRoute({ soft: true });
        loadedTables = {};
        // The Tables explorer's cached edges + any in-flight wire/merge selection
        // are per-workspace module state — reset them so the new workspace doesn't
        // inherit the previous one's relationship edges or picked source.
        mtResetState();
        // A switch swaps the server-side buses to the new workspace; drop the old
        // workspace's render overlay state and reconnect the multiplexed event
        // stream so realtime/feed/render all rebind to this workspace.
        renderProgress = {};
        startEventStream();
      });
    }

`;
