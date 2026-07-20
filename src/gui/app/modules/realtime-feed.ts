// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const realtimeFeedJs = `    // ────────────────────────────────────────────────────────────
    // Offline edit queue (cloud) — when the cloud is unreachable, row writes
    // are persisted to IndexedDB and replayed (in edit-timestamp order, with a
    // stable edit_id for server-side idempotency) the moment the realtime
    // channel reconnects. No edits are lost across a disconnect.
    // ────────────────────────────────────────────────────────────
    var cloudMode = false;
    var cloudConnected = false;
    var IDB_NAME = 'lattice-gui';
    var IDB_STORE = 'pending_mutations';
    var idbPromise = null;
    function openIdb() {
      if (idbPromise) return idbPromise;
      idbPromise = new Promise(function (resolve, reject) {
        if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return; }
        var req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE, { keyPath: 'editId' });
          }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
      return idbPromise;
    }
    function idbAll() {
      return openIdb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(IDB_STORE, 'readonly');
          var req = tx.objectStore(IDB_STORE).getAll();
          req.onsuccess = function () { resolve(req.result || []); };
          req.onerror = function () { reject(req.error); };
        });
      });
    }
    function idbPut(item) {
      return openIdb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put(item);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error); };
        });
      });
    }
    function idbDelete(editId) {
      return openIdb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).delete(editId);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error); };
        });
      });
    }
    // Pending edits in true edit-timestamp order (ties broken by insertion).
    function pendingOrdered(items) {
      return items.slice().filter(function (i) { return i.status !== 'failed'; })
        .sort(function (a, b) { return String(a.clientTs).localeCompare(String(b.clientTs)); });
    }
    function newEditId() {
      return (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
        : 'e-' + Date.now() + '-' + Math.round(Math.random() * 1e9);
    }
    function updatePendingPill(n) {
      // The offline-queue state now shows in the single top-right status indicator.
      if (n > 0) setStatus({ id: 'offline', kind: 'warn', text: '⏳ ' + n + ' pending', priority: 40, sticky: true });
      else clearStatus('offline');
    }
    function refreshPendingPill() {
      idbAll().then(function (items) {
        updatePendingPill(items.filter(function (i) { return i.status !== 'failed'; }).length);
      }).catch(function () { /* no idb — ignore */ });
    }
    /**
     * Perform a row mutation, queueing it offline when the cloud is
     * unreachable. ONLINE behaviour is identical to a plain fetchJson (returns
     * parsed JSON, throws on HTTP error). When the cloud is disconnected, or
     * the request fails with a network error, the edit is persisted to
     * IndexedDB and replayed on reconnect; returns { queued: true }.
     */
    function rowWrite(method, path, body) {
      // Coarse, anonymized analytics — the verb only, never the path/table/ids.
      var gaEvent =
        method === 'POST' ? 'row_create' : method === 'PUT' ? 'row_update' : method === 'DELETE' ? 'row_delete' : '';
      if (gaEvent) gaTrack(gaEvent, {});
      var editId = newEditId();
      var clientTs = new Date().toISOString();
      var item = { editId: editId, method: method, path: path, body: body || null, clientTs: clientTs, status: 'pending', attempts: 0 };
      function send() {
        return fetch(path, {
          method: method,
          headers: {
            'content-type': 'application/json',
            'x-lattice-edit-id': editId,
            'x-lattice-client-ts': clientTs,
          },
          body: body != null ? JSON.stringify(body) : undefined,
        }).then(function (r) {
          return r.json().then(function (j) {
            if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.httpStatus = r.status; throw e; }
            return j;
          });
        });
      }
      // Hold the edit when we know the cloud is unreachable.
      if (cloudMode && !cloudConnected) {
        return idbPut(item).then(function () {
          refreshPendingPill();
          showToast('Saved offline — will sync when the cloud reconnects', {});
          return { queued: true };
        });
      }
      return send().catch(function (err) {
        // A network error (no HTTP status) on a cloud DB → queue for replay.
        // A real HTTP error (4xx/5xx) is surfaced to the caller as before.
        if (cloudMode && err.httpStatus === undefined) {
          return idbPut(item).then(function () {
            refreshPendingPill();
            showToast('Saved offline — will sync when the cloud reconnects', {});
            return { queued: true };
          });
        }
        throw err;
      });
    }
    var draining = false;
    // Bounded exponential-backoff retry for a drain that left edits pending on a
    // transient failure. Mirrors the eventStreamBackoff style: start 2s, double
    // per consecutive failed drain, cap 60s; reset on a fully clean drain or a
    // real connectivity event. Without this, a cloud that stays "connected" but
    // 5xxes individual edits (or a blip that never fires 'online') would leave
    // queued edits unsynced indefinitely and silently.
    var drainRetryTimer = null; // pending retry timer (or null)
    var drainBackoff = 2000;    // retry delay, grows to a cap
    var MAX_DRAIN_ATTEMPTS = 8; // per-edit attempt cap → age-out to dead-letter
    // Pure decision helpers, factored out of the impure drainQueue so the retry
    // logic is unit-testable without a browser (IDB/fetch/timers). Keep these
    // first-class function declarations so a test can slice + eval them.
    function classifyDrainResponse(status) {
      // 2xx → done (delete). 4xx → permanent for a replay (dead-letter): 409
      // (unshared / stale schema / row gone), 403 (RLS owner-only), 404 (row not
      // visible), 400 (bad edit) won't succeed on retry. 5xx (and a network
      // error, signalled by a non-numeric status) → transient, retry later.
      if (status >= 200 && status < 300) return 'ok';
      if (status >= 400 && status < 500) return 'deadletter';
      return 'transient';
    }
    function nextBackoff(current) {
      return Math.min(current * 2, 60000);
    }
    function shouldDeadLetter(attempts) {
      return attempts >= MAX_DRAIN_ATTEMPTS;
    }
    function clearDrainRetry() {
      if (drainRetryTimer) { clearTimeout(drainRetryTimer); drainRetryTimer = null; }
    }
    /** Replay queued edits in edit-timestamp order once the cloud is back. */
    function drainQueue() {
      if (draining || !cloudConnected) return;
      draining = true;
      var pendingRemains = false; // any edit still pending after this pass?
      idbAll().then(function (items) {
        var queue = pendingOrdered(items);
        function step(i) {
          if (i >= queue.length) return Promise.resolve();
          var it = queue[i];
          return fetch(it.path, {
            method: it.method,
            headers: {
              'content-type': 'application/json',
              'x-lattice-edit-id': it.editId,
              'x-lattice-client-ts': it.clientTs,
            },
            body: it.body != null ? JSON.stringify(it.body) : undefined,
          }).then(function (r) {
            var verdict = classifyDrainResponse(r.status);
            // An edit is ONLY removed from IDB on a 2xx — never lost otherwise.
            if (verdict === 'ok') return idbDelete(it.editId);
            if (verdict === 'deadletter') {
              it.status = 'failed';
              return idbPut(it).then(function () {
                showToast('An offline edit could not sync (the object changed or you lack access). See pending edits.', {});
              });
            }
            // Transient server error (5xx) — count the attempt, and age out to
            // dead-letter once a single edit has failed too many times so a poison
            // edit can't retry forever (but is never silently lost — it becomes a
            // visible 'failed' row). Below the cap, leave it pending for the next
            // (backed-off) drain.
            it.attempts = (it.attempts || 0) + 1;
            if (shouldDeadLetter(it.attempts)) {
              it.status = 'failed';
              return idbPut(it).then(function () {
                showToast('An offline edit could not sync after repeated attempts — see pending edits.', {});
              });
            }
            pendingRemains = true;
            return idbPut(it);
          }).then(function () { return step(i + 1); },
          function () {
            // Network error on this edit — count the attempt + persist, age out
            // at the cap, then stop draining (the rest stay pending). The edit is
            // not deleted, so nothing is lost; the retry timer re-drains it.
            it.attempts = (it.attempts || 0) + 1;
            if (shouldDeadLetter(it.attempts)) {
              it.status = 'failed';
              return idbPut(it).then(function () {
                showToast('An offline edit could not sync after repeated attempts — see pending edits.', {});
              });
            }
            pendingRemains = true;
            return idbPut(it);
          });
        }
        return step(0);
      }).then(function () {
        draining = false;
        refreshPendingPill();
        afterMutation().catch(function () { /* ignore */ });
        if (pendingRemains) {
          // Self-heal: schedule a bounded-backoff retry so a transient failure
          // doesn't leave edits stranded until the next 'online'/reconnect event.
          clearDrainRetry();
          var t = setTimeout(drainQueue, drainBackoff);
          if (t && t.unref) t.unref(); // defensive — never pin a process (browser timers ignore)
          drainRetryTimer = t;
          drainBackoff = nextBackoff(drainBackoff);
        } else {
          // Fully clean drain — reset backoff and drop any pending retry.
          drainBackoff = 2000;
          clearDrainRetry();
        }
      }).catch(function () { draining = false; });
    }
    /** A real connectivity event supersedes the backoff — reset + drain now. */
    function drainNow() {
      clearDrainRetry();
      drainBackoff = 2000;
      drainQueue();
    }
    function initOffline() {
      refreshPendingPill();
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('online', function () { if (cloudConnected) drainNow(); });
      }
    }

    function setStatusPill(mode, state) {
      // Track cloud reachability so the offline queue knows when to hold edits
      // (cloud unreachable) vs. send them, and drains the moment we reconnect.
      var wasConnected = cloudConnected;
      cloudMode = mode === 'cloud';
      cloudConnected = cloudMode && state === 'connected';
      if (cloudConnected && !wasConnected) drainNow();
      // Update the single workspace-switcher status dot to reflect live realtime.
      ['ws-status'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.classList.remove('is-cloud-connected', 'is-cloud-disconnected', 'is-cloud-connecting');
        if (mode !== 'cloud') {
          el.title = 'Local — no realtime channel';
          return;
        }
        if (state === 'connected') {
          el.classList.add('is-cloud-connected');
          el.title = 'Cloud — live';
        } else if (state === 'connecting') {
          el.classList.add('is-cloud-connecting');
          el.title = 'Cloud — connecting…';
        } else {
          el.classList.add('is-cloud-disconnected');
          el.title = 'Cloud — disconnected';
        }
      });
    }
    function scheduleRealtimeRefresh(changedTable) {
      // Accumulate every table that changed across the debounce window so scoped
      // invalidation covers them all, not just the first. An absent table (schema
      // change / unknown) is sticky "ALL" → full wipe.
      if (!changedTable) {
        realtimeDirtyTables = 'ALL';
      } else if (realtimeDirtyTables !== 'ALL') {
        realtimeDirtyTables = realtimeDirtyTables || {};
        realtimeDirtyTables[changedTable] = true;
      }
      if (realtimePending) return;
      realtimePending = setTimeout(function () {
        realtimePending = null;
        var dirty = realtimeDirtyTables;
        realtimeDirtyTables = null;
        var tables = dirty && dirty !== 'ALL' ? Object.keys(dirty) : null;
        // afterMutation refreshes entities + the current view. Fire-and-
        // forget: any error just falls through to next manual action.
        afterMutation(tables).catch(function () { /* swallow */ });
      }, 200);
    }
`;
