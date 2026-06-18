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
      var el = document.getElementById('offline-pill');
      if (!el) return;
      if (n > 0) { el.hidden = false; el.textContent = '⏳ ' + n + ' pending'; }
      else { el.hidden = true; el.textContent = ''; }
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
    /** Replay queued edits in edit-timestamp order once the cloud is back. */
    function drainQueue() {
      if (draining || !cloudConnected) return;
      draining = true;
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
            if (r.ok) return idbDelete(it.editId);
            // #4.5 — ANY 4xx is permanent for a replay: 409 (unshared / stale
            // schema / row gone), 403 (RLS owner-only), 404 (row not visible),
            // 400 (bad edit). Mark the edit failed + surface it (dead-letter)
            // instead of retrying it forever; only 5xx / network errors are
            // transient and left pending for the next drain. Previously only 409
            // was caught, so an RLS-rejected edit retried endlessly, unseen.
            if (r.status >= 400 && r.status < 500) {
              it.status = 'failed';
              return idbPut(it).then(function () {
                showToast('An offline edit could not sync (the object changed or you lack access). See pending edits.', {});
              });
            }
            // Transient server error (5xx) — leave pending, retry on the next drain.
            return Promise.resolve();
          }).then(function () { return step(i + 1); },
          function () { return Promise.resolve(); /* network error — stop draining */ });
        }
        return step(0);
      }).then(function () {
        draining = false;
        refreshPendingPill();
        afterMutation().catch(function () { /* ignore */ });
      }).catch(function () { draining = false; });
    }
    function initOffline() {
      refreshPendingPill();
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('online', function () { if (cloudConnected) drainQueue(); });
      }
    }

    function setStatusPill(mode, state) {
      // Track cloud reachability so the offline queue knows when to hold edits
      // (cloud unreachable) vs. send them, and drains the moment we reconnect.
      var wasConnected = cloudConnected;
      cloudMode = mode === 'cloud';
      cloudConnected = cloudMode && state === 'connected';
      if (cloudConnected && !wasConnected) drainQueue();
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
    function scheduleRealtimeRefresh() {
      if (realtimePending) return;
      realtimePending = setTimeout(function () {
        realtimePending = null;
        // afterMutation refreshes entities + the current view. Fire-and-
        // forget: any error just falls through to next manual action.
        afterMutation().catch(function () { /* swallow */ });
      }, 200);
    }
`;
