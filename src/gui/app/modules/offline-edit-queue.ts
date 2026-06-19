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
      // Guard against an infinite reload loop. Reloading when the server version
      // changes is the seamless-update trigger — but if the version the page was
      // SERVED with keeps disagreeing with /api/version (e.g. a stale or duplicate
      // server is holding the port and reporting a different version), every fresh
      // page would reload again. That unbounded loop pegs memory and crashes the
      // browser. Cap reloads to MAX within WINDOW; past that, stop and surface the
      // mismatch instead of spinning. A genuine update reloads once and then the
      // versions agree, which clears the counter (see checkServerVersion).
      var KEY = 'lattice:updateReloads',
        MAX = 3,
        WINDOW = 60000,
        now = Date.now(),
        recent = [];
      try {
        recent = (JSON.parse(sessionStorage.getItem(KEY) || '[]') || []).filter(function (t) {
          return now - t < WINDOW;
        });
      } catch (_) {
        /* sessionStorage blocked — degrade to a single best-effort reload below */
      }
      if (recent.length >= MAX) {
        showUpdatePill('Version mismatch — stopped auto-reloading. Reload manually if needed.');
        return;
      }
      recent.push(now);
      try {
        sessionStorage.setItem(KEY, JSON.stringify(recent));
      } catch (_) {
        /* best-effort */
      }
      reloadingForUpdate = true;
      showUpdatePill(label || 'Updated — reloading…');
      setTimeout(function () {
        location.reload();
      }, 600);
    }
    // Manual upgrade fallback: show an "Update available — Upgrade" link next to
    // the version chip only when the server reports a newer, installable version.
    // The auto-updater installs in the background on its own cadence; this lets
    // the user force it now. Best-effort; the link stays hidden on any failure.
    function checkUpdateAvailable() {
      var el = document.getElementById('app-update-link');
      if (!el) return;
      fetch('/api/update/status')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) {
          if (s && s.latest && s.current && s.latest !== s.current && s.installable) {
            el.textContent = 'Update available — Upgrade';
            el.title = 'Install v' + s.latest + ' and restart';
            el.hidden = false;
          } else {
            el.hidden = true;
          }
        })
        .catch(function () { /* best-effort — keep the link hidden */ });
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
          else {
            hideUpdatePill();
            // Versions agree — clear the reload-loop guard so a later genuine
            // update can reload again from a clean slate.
            try {
              sessionStorage.removeItem('lattice:updateReloads');
            } catch (_) {
              /* best-effort */
            }
          }
        })
        .catch(function () { /* offline / mid-restart — the next reconnect retries */ });
      // Refresh the manual-upgrade link alongside the reconnect version check.
      checkUpdateAvailable();
    }
    // Wire the manual-upgrade link's click: kick off the install (the server
    // installs the latest and restarts onto it) and surface the progress. On
    // success we do nothing else — the update-applied event + the reconnect
    // version check land the page on the new version (no manual reload). A
    // false ok means the install can't run (unsupervised) — toast why.
    function wireUpdateLink() {
      var el = document.getElementById('app-update-link');
      if (!el) return;
      el.addEventListener('click', function (e) {
        e.preventDefault();
        el.hidden = true;
        showUpdatePill('Updating…');
        fetch('/api/update/apply', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.ok === false) {
              hideUpdatePill();
              showToast(d.error || 'Update unavailable', {});
            }
          })
          .catch(function () { /* server may already be restarting */ });
      });
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
