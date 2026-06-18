// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const offlineEditQueueJs = `    // ────────────────────────────────────────────────────────────
    // Multiplexed event stream — ONE WebSocket carries realtime state/change,
    // the activity feed, and background-render progress (previously three
    // separate SSE streams). Holding one connection per tab instead of three
    // keeps the browser's per-host HTTP budget free for data requests, so the
    // GUI never freezes when several tabs are open. Each server message is
    // { type, data }; we demux to the same handlers the SSE listeners used.
    // ────────────────────────────────────────────────────────────
    var eventStream = null; // the active WebSocket (or null)
    var eventStreamReconnect = null; // pending reconnect timer
    var eventStreamBackoff = 1000; // reconnect delay, grows to a cap
    var eventStreamClosed = false; // true ⇒ closed on purpose (switch/teardown), don't reconnect
    // Version this page was served with (from the shell's version chip, "v3.3.5").
    // When a reconnect reports a different server version, the server relaunched
    // onto a new build (a background auto-update) so the tab reloads itself — the
    // universal "no manual refresh" trigger, independent of how the restart happened.
    var BOOT_VERSION = (function () {
      var el = document.getElementById('app-version');
      return el ? String(el.textContent || '').replace(/^v/, '').trim() : '';
    })();
    var reloadingForUpdate = false;
    function showUpdatePill(text) {
      var el = document.getElementById('app-update');
      if (el) { el.textContent = text; el.hidden = false; }
    }
    function hideUpdatePill() {
      var el = document.getElementById('app-update');
      if (el) { el.hidden = true; }
    }
    function reloadForUpdate(label) {
      if (reloadingForUpdate) return;
      reloadingForUpdate = true;
      showUpdatePill(label || 'Updated — reloading…');
      setTimeout(function () { location.reload(); }, 600);
    }
    // On every (re)connect, ask the server its version. A change vs BOOT_VERSION
    // means a relaunch onto new code → reload. Best-effort; never throws.
    function checkServerVersion() {
      if (!BOOT_VERSION) return;
      fetch('/api/version')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var v = d && d.version ? String(d.version).replace(/^v/, '').trim() : '';
          if (!v) return;
          if (v !== BOOT_VERSION) reloadForUpdate('Updated to v' + v + ' — reloading…');
          else hideUpdatePill();
        })
        .catch(function () { /* offline / mid-restart — the next reconnect retries */ });
    }
    function dispatchStreamMessage(type, data) {
      if (type === 'realtime-state') {
        setStatusPill((data && data.mode) || 'local', (data && data.state) || 'local');
      } else if (type === 'realtime-change') {
        if (data) onRealtimeChange(data);
        scheduleRealtimeRefresh();
      } else if (type === 'feed') {
        try { renderFeedItem(data); } catch (_) { /* render best-effort */ }
        if (data && (data.table || data.op === 'schema')) scheduleRealtimeRefresh();
      } else if (type === 'render-snapshot') {
        if (data) applyRenderSnapshot(data);
      } else if (type === 'render-progress') {
        if (data) onRenderEvent(data);
      } else if (type === 'update-applied') {
        // Files on disk are the new version; the server is about to relaunch.
        // Don't reload yet (the server is exiting) — the reconnect version check
        // does the actual reload once it's back up on the new code.
        showUpdatePill('Updating…');
      } else if (type === 'update-error') {
        showToast('Update failed: ' + ((data && data.message) || 'unknown error'), {});
      }
    }
    function scheduleEventStreamReconnect() {
      if (eventStreamClosed || eventStreamReconnect) return;
      var delay = eventStreamBackoff;
      eventStreamBackoff = Math.min(eventStreamBackoff * 2, 15000);
      eventStreamReconnect = setTimeout(function () {
        eventStreamReconnect = null;
        startEventStream();
      }, delay);
    }
    function stopEventStream() {
      eventStreamClosed = true;
      if (eventStreamReconnect) { clearTimeout(eventStreamReconnect); eventStreamReconnect = null; }
      if (eventStream) {
        // Drop the onclose handler first so an intentional close doesn't trip the
        // reconnect/disconnect path.
        try { eventStream.onclose = null; eventStream.close(); } catch (_) { /* ignore */ }
        eventStream = null;
      }
    }
    function startEventStream() {
      stopEventStream();
      eventStreamClosed = false;
      if (typeof WebSocket === 'undefined') return;
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      var ws;
      try { ws = new WebSocket(proto + '//' + location.host + '/api/stream'); }
      catch (_) { scheduleEventStreamReconnect(); return; }
      eventStream = ws;
      ws.onopen = function () { eventStreamBackoff = 1000; checkServerVersion(); };
      ws.onmessage = function (ev) {
        var msg = null;
        try { msg = JSON.parse(ev.data); } catch (_) { return; /* ignore malformed */ }
        if (msg && msg.type) dispatchStreamMessage(msg.type, msg.data);
      };
      ws.onerror = function () { /* surfaced via onclose → reconnect */ };
      ws.onclose = function () {
        if (eventStream === ws) eventStream = null;
        if (eventStreamClosed) return;
        // Unexpected drop: show the disconnect on the pill and auto-reconnect with
        // backoff (the server replays state + render snapshot on reconnect).
        setStatusPill('cloud', 'disconnected');
        scheduleEventStreamReconnect();
      };
    }

`;
