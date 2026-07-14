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
      setStatus({ id: 'update', kind: 'accent', text: text, priority: 60, sticky: true });
    }
    function hideUpdatePill() {
      clearStatus('update');
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
    // One-time badge on the version chip for a build that can't silently keep
    // itself current — a dev/linked checkout, or a session pinned with
    // auto-update off. Without it a stale dev server looks identical to a live
    // auto-updating install, which is exactly how an old version goes unnoticed.
    var updateBadgeApplied = false;
    function applyUpdateBadge(s) {
      if (updateBadgeApplied || !s) return;
      var ver = document.getElementById('app-version');
      if (!ver) return;
      if (s.kind === 'linked-dev') {
        ver.textContent = ver.textContent + ' (dev)';
        ver.title = 'development build — auto-update disabled';
        updateBadgeApplied = true;
      } else if (s.autoUpdate === false) {
        ver.title = 'auto-update disabled';
        updateBadgeApplied = true;
      }
    }
    // Show an "Update available" link next to the version chip when the server
    // reports a newer version AND this surface can act on it. The action depends
    // on how this copy updates: an npm install can upgrade in place ("Upgrade"),
    // the desktop app applies on relaunch ("Restart to update"). A dev/linked
    // build reports the newer version but offers no action (action:'none') — the
    // (dev) badge already explains why. Best-effort; hidden on any failure.
    function checkUpdateAvailable() {
      fetch('/api/update/status')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) {
          if (!s) return;
          applyUpdateBadge(s);
          var el = document.getElementById('app-update-link');
          if (!el) return;
          var hasUpdate = s.latest && s.current && s.latest !== s.current;
          if (hasUpdate && s.action === 'upgrade-in-place') {
            el.textContent = 'Update available — Upgrade';
            el.title = 'Install v' + s.latest + ' and restart';
            el.hidden = false;
          } else if (hasUpdate && s.action === 'restart-to-update') {
            el.textContent = 'Update available — Restart to update';
            el.title = 'Download v' + s.latest + ' and relaunch';
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
        // Pass the changed table so only its cache entry is invalidated; a missing
        // table falls back to a full wipe (unchanged behavior).
        scheduleRealtimeRefresh(data && data.table);
        // A dashboards change from any source (another session, a direct write)
        // refreshes the Analytics sidebar/home live — same reason as the feed hook.
        if (data && data.table === 'dashboards' && typeof refreshDashboardsLive === 'function') {
          refreshDashboardsLive();
        }
      } else if (type === 'feed') {
        // A clarification-question lifecycle event (enqueued / answered /
        // dismissed) is a signal, not a data change: reconcile the pending
        // cards + trigger dot (auto-opening the panel on a new question) and
        // skip the activity-card/refresh handling below.
        if (data && data.op === 'question') {
          try { onQuestionFeedEvent(); } catch (_) { /* best-effort */ }
          return;
        }
        // A chat thread's AI title landed after its stream closed — refresh the
        // conversation list so the friendly title replaces the first-message
        // placeholder. Also a signal, not a data change: no activity card.
        if (data && data.op === 'thread_title') {
          try { if (typeof refreshThreadList === 'function') refreshThreadList(); } catch (_) { /* best-effort */ }
          return;
        }
        // A folder ingest progress event — update the shared progress bar state.
        // Completion comes from the event's explicit terminal flag: a capped
        // ingest finishes with done < total, so counts alone can't signal it.
        // done >= total is kept as a fallback for a missing flag.
        if (data && data.op === 'ingest_progress' && data.progress) {
          try {
            var bar = ingestProgress(data.progress.total, 'server');
            bar.update(data.progress.done, data.progress.total, 'server');
            if (data.progress.terminal || data.progress.done >= data.progress.total) bar.done();
          } catch (_) { /* best-effort */ }
          return;
        }
        // renderFeedItem now flashes each change as a transient top-right status
        // (the realtime update) — no rail pills.
        try { renderFeedItem(data); } catch (_) { /* best-effort */ }
        // Any structural change drives the live brain-graph animation (node
        // bubble-in / edge draw) — a new object/edge, OR a row that takes a table
        // from empty to non-empty. Not only ingests: an assistant-created object
        // must appear without a refresh too. scheduleGraphIngestAnim no-ops unless
        // the graph is the visible view, so this never fetches off-graph.
        if (data && ['insert', 'link', 'schema'].indexOf(data.op) !== -1) {
          scheduleGraphIngestAnim();
        }
        // A schema change can alter any table's shape → full wipe (no table arg);
        // a row/link change scopes invalidation to its own table.
        if (data && (data.table || data.op === 'schema')) {
          // A schema change (e.g. an assistant-created computed table adds a computes
          // edge) can change the relationship graph too — drop the cached schema-graph
          // edges so the Data Model explorer, brain graph, and table-view lineage refetch
          // fresh instead of showing a stale model until the next reload.
          if (data.op === 'schema') mtEdgesCache = null;
          scheduleRealtimeRefresh(data.op === 'schema' ? null : data.table);
        }
        // Dashboards live in the Analytics sidebar/home, which the generic
        // realtime refresh above does not touch — refresh them explicitly so a
        // Gladys-built dashboard appears without a manual reload.
        if (data && data.table === 'dashboards' && typeof refreshDashboardsLive === 'function') {
          refreshDashboardsLive();
        }
      } else if (type === 'render-snapshot') {
        if (data) applyRenderSnapshot(data);
        updateRenderStatus();
      } else if (type === 'render-progress') {
        if (data) onRenderEvent(data);
        updateRenderStatus();
      } else if (type === 'chat-progress') {
        // A chat turn's streamed event { threadId, messageId, event } — the async
        // replacement for the held-open POST response. Routed to the turn's bubble by
        // messageId; gated per user server-side so one member never sees another's chat.
        if (data && typeof onChatProgress === 'function') onChatProgress(data);
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
      ws.onopen = function () {
        eventStreamBackoff = 1000;
        checkServerVersion();
        // The bus has no replay: reconcile any chat turn bound before this (re)connect, so
        // a terminal 'done' published while the socket was down can't strand the composer.
        if (typeof resyncChatTurns === 'function') resyncChatTurns();
      };
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
        // Preserve the KNOWN mode (cloudMode is the single source of truth, set
        // from the server's realtime-state message) — never hardcode 'cloud',
        // which on a LOCAL (SQLite) workspace would flip cloudMode=true and divert
        // writes into the offline queue with a bogus "will sync when cloud
        // reconnects" toast against a workspace that has no cloud.
        setStatusPill(cloudMode ? 'cloud' : 'local', 'disconnected');
        scheduleEventStreamReconnect();
      };
    }

`;
