// Extracted verbatim from app.ts — the GUI client script (static template, no interpolation).
export const appJs = `
  (function () {
    // ────────────────────────────────────────────────────────────
    // Display config — labels + icons. Anything missing falls back
    // to title-case of the table name and a generic dot.
    // ────────────────────────────────────────────────────────────
    var DISPLAY = {
      meetings:     { label: 'Meetings',     icon: '📅' },
      people:       { label: 'People',       icon: '👥' },
      messages:     { label: 'Messages',     icon: '✉️' },
      projects:     { label: 'Projects',     icon: '📦' },
      repositories: { label: 'Repositories', icon: '💿' },
      files:        { label: 'Files',        icon: '📄' },
      secrets:      { label: 'Secrets',      icon: '🔐' },
    };
    // Cards shown on the dashboard (Secrets is sidebar-only by design).
    var DASHBOARD_ORDER = ['meetings', 'people', 'messages', 'projects', 'repositories', 'files'];

    var FIELD_DISPLAY = {
      starts_at: 'Date+Time',
      sent_at:   'Sent',
      role:      'Role',
      url:       'URL',
      path:      'Path',
      kind:      'Kind',
    };

    // Generic fallback icon when the user hasn't set one and the entity
    // name isn't in the built-in DISPLAY map.
    var DEFAULT_ICON = '📋';

    var state = {
      entities: null,
      rowCache: {},
      iconOverrides: {},
      columnMeta: {},
      systemTables: [],
      preferences: { show_system_tables: false, analytics: true },
    };

    function isSecretColumn(tableName, colName) {
      var t = state.columnMeta[tableName];
      return !!(t && t[colName] && t[colName].secret);
    }
    var SECRET_MASK = '••••••••'; // ••••••••
    // An encrypted-at-rest value (native secrets etc.) is stored with an "enc:"
    // sentinel prefix (see framework/native-entities decrypt). It is never
    // plaintext, so the GUI must never render the raw ciphertext — mask it the
    // same way an operator-flagged secret column is masked.
    function looksEncrypted(v) {
      return typeof v === 'string' && v.slice(0, 4) === 'enc:';
    }

    function displayFor(name) {
      var override = state.iconOverrides[name];
      var base = DISPLAY[name];
      var icon = (override && override.icon) || (base && base.icon) || DEFAULT_ICON;
      var label = (base && base.label) || titleCase(name);
      return { label: label, icon: icon };
    }
    function titleCase(s) {
      return s.replace(/_/g, ' ').replace(/\\b\\w/g, function (c) { return c.toUpperCase(); });
    }
    function fieldLabel(col) {
      return FIELD_DISPLAY[col] || titleCase(col);
    }

    function escapeHtml(v) {
      if (v == null) return '';
      return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Minimal, safe Markdown → HTML for assistant chat bubbles. The input is
    // HTML-escaped FIRST (in mdToHtml), so every rule below operates on already
    // neutralized text — no raw HTML can survive. Covers what the assistant
    // emits: headings, bold/italic, inline + fenced code, ordered/unordered
    // lists, links (http/https/mailto only), and paragraphs.
    function mdInline(s) {
      var BT = String.fromCharCode(96); // backtick (avoids escaping in this template)
      var codes = [];
      var reCode = new RegExp(BT + '([^' + BT + ']+)' + BT, 'g');
      s = s.replace(reCode, function (_, c) { codes.push(c); return '\\u0001' + (codes.length - 1) + '\\u0001'; });
      s = s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, function (_, t, u) {
        if (!/^(https?:|mailto:)/i.test(u)) return t;
        return '<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>';
      });
      s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      s = s.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
      s = s.replace(/\\u0001(\\d+)\\u0001/g, function (_, n) { return '<code>' + codes[n] + '</code>'; });
      return s;
    }
    function mdToHtml(text) {
      var src = escapeHtml(text == null ? '' : String(text));
      var lines = src.split('\\n');
      var FENCE = String.fromCharCode(96, 96, 96);
      var html = '', i = 0, listType = null;
      function closeList() { if (listType) { html += '</' + listType + '>'; listType = null; } }
      function lstrip(x) { return x.replace(/^\\s+/, ''); }
      while (i < lines.length) {
        var line = lines[i];
        if (lstrip(line).indexOf(FENCE) === 0) {
          closeList(); var code = []; i++;
          while (i < lines.length && lstrip(lines[i]).indexOf(FENCE) !== 0) { code.push(lines[i]); i++; }
          i++;
          html += '<pre><code>' + code.join('\\n') + '</code></pre>';
          continue;
        }
        var h = line.match(/^(#{1,6})\\s+(.*)$/);
        if (h) { closeList(); var tag = 'h' + Math.max(3, Math.min(6, h[1].length + 2)); html += '<' + tag + '>' + mdInline(h[2]) + '</' + tag + '>'; i++; continue; }
        var ul = line.match(/^\\s*[-*+]\\s+(.*)$/);
        if (ul) { if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; } html += '<li>' + mdInline(ul[1]) + '</li>'; i++; continue; }
        var ol = line.match(/^\\s*\\d+\\.\\s+(.*)$/);
        if (ol) { if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; } html += '<li>' + mdInline(ol[1]) + '</li>'; i++; continue; }
        if (/^\\s*$/.test(line)) { closeList(); i++; continue; }
        closeList();
        var para = [line]; i++;
        while (i < lines.length && !/^\\s*$/.test(lines[i]) && !/^\\s*(#{1,6}\\s|[-*+]\\s|\\d+\\.\\s)/.test(lines[i]) && lstrip(lines[i]).indexOf(FENCE) !== 0) { para.push(lines[i]); i++; }
        html += '<p>' + mdInline(para.join('<br>')) + '</p>';
      }
      closeList();
      return html;
    }

    // Redact the userinfo portion of a connection URL so the password
    // never reaches the rendered DOM. Used for every place the GUI
    // displays a cloud_url field (team cards, connection list, etc).
    // Defensive fallback returns the input as-is when it doesn't parse
    // as a URL — better to render a non-credential string verbatim than
    // to silently swallow the value.
    function redactUrlCredentials(url) {
      if (url == null) return '';
      var s = String(url);
      try {
        var u = new URL(s);
        if (u.password) {
          // Preserve the username (often useful for identification —
          // e.g. tenant prefixes like postgres.<ref>) but mask the
          // password portion. ASCII mask avoids URL.toString()
          // percent-encoding non-ASCII characters in userinfo.
          u.password = '****';
          return u.toString();
        }
        return s;
      } catch (_) {
        return s;
      }
    }

    function truncate(s, n) {
      if (s == null) return '';
      s = String(s);
      return s.length > n ? s.slice(0, n) + '…' : s;
    }

    // Lockstep mirror of isJunctionTable in src/gui/data.ts: a junction joins
    // exactly two entities and carries no payload — 2 belongsTo relations AND
    // every column is one of the 2 FK columns or a system column. A table with
    // extra data columns (e.g. tasks with a title) is a first-class entity, not
    // a junction. Keep this predicate identical to the server's.
    function isJunction(table) {
      var rels = Object.values(table.relations || {});
      if (rels.length !== 2 || !rels.every(function (r) { return r.type === 'belongsTo'; })) {
        return false;
      }
      var sys = { id: 1, created_at: 1, updated_at: 1, deleted_at: 1 };
      var fk = {};
      rels.forEach(function (r) { fk[r.foreignKey] = 1; });
      return (table.columns || []).every(function (c) { return fk[c] || sys[c]; });
    }

    function tableByName(name) {
      return state.entities.tables.find(function (t) { return t.name === name; });
    }

    function fetchJson(url, opts) {
      return fetch(url, opts).then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || r.statusText); });
        return r.json();
      });
    }

    // Disable a button + show an inline spinner for the duration of an
    // async action so a slow server round-trip can't be double-clicked.
    // The fn arg should return a Promise; the button is restored on settle.
    function withBusy(btn, fn) {
      if (!btn || btn.disabled) return undefined;
      var original = btn.innerHTML;
      btn.disabled = true;
      btn.classList.add('is-busy');
      btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + original;
      var restore = function () {
        btn.disabled = false;
        btn.classList.remove('is-busy');
        btn.innerHTML = original;
      };
      var result;
      try {
        result = fn();
      } catch (e) {
        restore();
        throw e;
      }
      if (result && typeof result.then === 'function') {
        return result.then(
          function (v) { restore(); return v; },
          function (e) { restore(); throw e; },
        );
      }
      restore();
      return result;
    }

    // ────────────────────────────────────────────────────────────
    // Boot
    // ────────────────────────────────────────────────────────────
    function init() {
      Promise.all([
        fetchJson('/api/entities'),
        fetchJson('/api/gui-meta').catch(function () { return {}; }),
        fetchJson('/api/gui-meta/columns').catch(function () { return {}; }),
        fetchJson('/api/system-tables').catch(function () { return { tables: [] }; }),
        fetchJson('/api/userconfig/preferences').catch(function () { return { show_system_tables: false, analytics: true }; }),
        fetchJson('/api/workspaces').catch(function () { return null; }),
      ]).then(function (results) {
        state.entities = results[0];
        state.iconOverrides = results[1] || {};
        state.columnMeta = results[2] || {};
        state.systemTables = (results[3] && results[3].tables) || [];
        state.preferences = results[4] || { show_system_tables: false, analytics: true };
        document.body.classList.toggle('advanced-mode', advancedMode());
        var advToggle = document.getElementById('advanced-toggle');
        if (advToggle) advToggle.checked = advancedMode();
        wireSettingsDrawer();
        renderWsSwitcher(results[5]);
        renderSidebar();
        wireHistoryControls();
        refreshHistoryState();
        renderRoute();
        startRealtime();
        initSearch();
        initLastEdited();
        initOffline();
        initRailResize();
        initRailDrawer();
        initRailDragDrop();
        startFeed();
        renderComposer();
        initThreadControls();
        checkNativeSetup();
      }).catch(function (err) {
        document.getElementById('content').innerHTML =
          '<div class="placeholder"><h2>Failed to load</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // ────────────────────────────────────────────────────────────
    // Realtime — Server-Sent Events from /api/realtime/stream.
    // One EventSource per session; on 'change' events we mark the
    // current view dirty and refetch via afterMutation() (debounced
    // to coalesce bursts). On 'state' events we drive the topbar pill.
    // ────────────────────────────────────────────────────────────
    var realtimeSource = null;
    var realtimePending = null;
    // Team-cloud collaboration state. usersById resolves "last edited by"
    // names; lastEditedByPk maps "<table>|<pk>" → { userId, at } from realtime
    // change envelopes + the /last-edited seed. Both stay empty on local.
    var usersById = {};
    var lastEditedByPk = {};
    // Count of changes from OTHER editors to tables not currently in view,
    // shown as a sidebar badge until the user opens that table.
    var unseenByTable = {};
    function leKey(table, pk) { return String(table) + '|' + String(pk); }
    // The table whose collection/detail is currently rendered (fs or objects
    // route), or null on the dashboard/settings.
    function currentViewTable() {
      var hash = location.hash || '#/';
      var f = (typeof fsParse === 'function') ? fsParse(hash) : null;
      if (f && f.length >= 1) return f[0];
      var m = /^#\\/objects\\/([^/]+)/.exec(hash);
      return m ? m[1] : null;
    }
    // Briefly highlight a row that just changed (data-id === pk) in the view.
    function flashRow(pk) {
      var content = document.getElementById('content');
      if (!content || !pk) return;
      var tr = content.querySelector('tr[data-id="' + (window.CSS && CSS.escape ? CSS.escape(pk) : pk) + '"]');
      if (!tr) return;
      tr.classList.remove('lattice-flash');
      void tr.offsetWidth; // reflow so the animation can replay
      tr.classList.add('lattice-flash');
      tr.addEventListener('animationend', function handler() {
        tr.classList.remove('lattice-flash');
        tr.removeEventListener('animationend', handler);
      });
    }
    function bumpUnseen(table) {
      if (!table) return;
      unseenByTable[table] = (unseenByTable[table] || 0) + 1;
      renderSidebar();
    }
    function clearUnseen(table) {
      if (table && unseenByTable[table]) {
        unseenByTable[table] = 0;
        renderSidebar();
      }
    }
    function userLabel(uid) {
      if (!uid) return 'someone';
      var u = usersById[uid];
      return (u && (u.name || u.email)) || 'someone';
    }
    function lastEditedHtml(table, pk) {
      var e = lastEditedByPk[leKey(table, pk)];
      if (!e) return '';
      return '<div class="last-edited">Last edited by ' + escapeHtml(userLabel(e.userId)) +
        ' · ' + escapeHtml(relTime(e.at)) + '</div>';
    }
    // Row-level data ops (post-Phase-A envelope ops, plus legacy uppercase
    // forms) that should flash a row / bump a count. Schema/share/link envelopes
    // don't.
    function isRowDataOp(op) {
      return op === 'upsert' || op === 'delete' ||
        op === 'INSERT' || op === 'UPDATE' || op === 'DELETE';
    }
    // Apply one realtime change payload to the local collaboration state:
    // record "last edited by", and either flash the row (current view) or bump
    // the table's unseen-change badge (other tables). Own edits land on the
    // current view (no badge) so we don't bother suppressing the self-echo.
    function onRealtimeChange(p) {
      if (!p || !p.table_name || !p.pk) return;
      lastEditedByPk[leKey(p.table_name, p.pk)] = {
        userId: p.owner_user_id || null,
        at: p.client_ts || p.created_at || '',
      };
      if (!isRowDataOp(p.op)) return;
      if (p.table_name === currentViewTable()) flashRow(p.pk);
      else bumpUnseen(p.table_name);
    }
    // Pull team members once so "last edited by" can show names, not ids.
    function initLastEdited() {
      fetchJson('/api/team/users').then(function (d) {
        (d && d.users || []).forEach(function (u) { usersById[u.id] = u; });
      }).catch(function () { /* local mode / unreachable — ignore */ });
    }
    // Seed last-edited info for one table's rows (edits before this session),
    // then refresh any visible "last edited" line.
    function seedLastEdited(table) {
      fetchJson('/api/tables/' + encodeURIComponent(table) + '/last-edited').then(function (d) {
        var edits = (d && d.edits) || {};
        Object.keys(edits).forEach(function (pk) {
          lastEditedByPk[leKey(table, pk)] = { userId: edits[pk].ownerUserId, at: edits[pk].at };
        });
        var el = document.getElementById('last-edited');
        if (el && el.getAttribute('data-table') === table) {
          el.outerHTML = lastEditedLineEl(table, el.getAttribute('data-pk'));
        }
      }).catch(function () { /* ignore */ });
    }
    // A keyed wrapper so seedLastEdited can replace the element in place.
    function lastEditedLineEl(table, pk) {
      var inner = lastEditedHtml(table, pk);
      return '<div id="last-edited" data-table="' + escapeHtml(table) + '" data-pk="' +
        escapeHtml(pk) + '">' + inner + '</div>';
    }
    // ────────────────────────────────────────────────────────────
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
            if (r.status === 409) {
              // Unshared / stale schema — can't replay; mark failed (kept for
              // inspection, surfaced) rather than silently dropped.
              it.status = 'failed';
              return idbPut(it).then(function () {
                showToast('An offline edit could not sync (the object changed). See pending edits.', {});
              });
            }
            // Other server error — leave pending, retry on the next drain.
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
    function startRealtime() {
      if (realtimeSource) {
        try { realtimeSource.close(); } catch (_) { /* ignore */ }
        realtimeSource = null;
      }
      if (typeof EventSource === 'undefined') return;
      realtimeSource = new EventSource('/api/realtime/stream');
      realtimeSource.addEventListener('state', function (ev) {
        try {
          var data = JSON.parse(ev.data);
          setStatusPill(data.mode || 'local', data.state || 'local');
        } catch (_) { /* ignore malformed */ }
      });
      realtimeSource.addEventListener('change', function (ev) {
        var p = null;
        try { p = JSON.parse(ev.data); } catch (_) { /* ignore malformed */ }
        if (p) onRealtimeChange(p);
        scheduleRealtimeRefresh();
      });
      realtimeSource.onerror = function () {
        // EventSource auto-reconnects; surface the disconnect on the pill
        // until the server's 'state' event reports recovery.
        setStatusPill('cloud', 'disconnected');
      };
    }

    // ────────────────────────────────────────────────────────────
    // Shared activity helpers — the operation-icon map and relative-time
    // formatter, used by Version History and the dashboard activity list. The
    // standalone Activity rail was removed in 1.16.1 (redundant with Version
    // History); multiplayer realtime convergence runs on the separate realtime
    // channel (startRealtime), not on this.
    // ────────────────────────────────────────────────────────────
    var FEED_ICONS = {
      insert: '➕', update: '✏️', delete: '🗑',
      link: '🔗', unlink: '⛓', undo: '↶', redo: '↷', schema: '🛠',
    };
    function relTime(iso) {
      try {
        var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
        if (s < 60) return s + 's ago';
        if (s < 3600) return Math.round(s / 60) + 'm ago';
        if (s < 86400) return Math.round(s / 3600) + 'h ago';
        // Day+ ranges are always relative (no absolute date): days → weeks →
        // months → years, whichever unit the elapsed time first fits.
        var days = Math.floor(s / 86400);
        if (days < 7) return days + (days === 1 ? ' day ago' : ' days ago');
        if (days < 30) { var w = Math.floor(days / 7); return w + (w === 1 ? ' week ago' : ' weeks ago'); }
        if (days < 365) { var mo = Math.floor(days / 30); return mo + (mo === 1 ? ' month ago' : ' months ago'); }
        var y = Math.floor(days / 365); return y + (y === 1 ? ' year ago' : ' years ago');
      } catch (_) { return ''; }
    }

    // Elapsed duration since a start timestamp (ms), for in-progress work like a
    // running upload — no "ago" suffix. Mirrors relTime's unit thresholds.
    function formatElapsed(ms) {
      var s = Math.max(0, Math.floor(ms / 1000));
      if (s < 60) return s + 's';
      if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
      return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    }

    // ────────────────────────────────────────────────────────────
    // Search — the top box hands the query to the AI ASSISTANT (which answers
    // conversationally using its search/read tools), not a plain full-text
    // match. hideSearchResults/openSearchHit are retained because the activity
    // feed still uses openSearchHit to jump to a row.
    // ────────────────────────────────────────────────────────────
    function hideSearchResults() {
      var box = document.getElementById('search-results');
      if (box) { box.hidden = true; box.innerHTML = ''; }
    }
    function openSearchHit(table, id) {
      hideSearchResults();
      var input = document.getElementById('search-input');
      if (input) input.value = '';
      // Open the hit in whichever mode the user is in: the file-workspace
      // (#/fs/) view in simple mode, the row editor (#/objects/) in advanced.
      var prefix = advancedMode() ? '#/objects/' : '#/fs/';
      location.hash = prefix + encodeURIComponent(table) + '/' + encodeURIComponent(id);
    }
    // Route the typed query into the assistant rail as a chat turn. Opens the
    // rail (a no-op on desktop; opens the mobile drawer) and submits via the
    // same path as the composer, so the assistant searches + answers.
    function askAssistant(q) {
      hideSearchResults();
      var input = document.getElementById('search-input');
      if (input) input.value = '';
      var rail = document.getElementById('assistant-rail');
      if (rail) rail.classList.add('expanded');
      var chatInput = document.getElementById('chat-input');
      if (chatInput) chatInput.focus();
      sendChat(q);
    }
    function initSearch() {
      var input = document.getElementById('search-input');
      if (!input) return;
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { input.value = ''; input.blur(); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          var q = input.value.trim();
          if (q) askAssistant(q);
        }
      });
    }

    /** Reload column meta after a secret-flag change. */
    function refreshColumnMeta() {
      return fetchJson('/api/gui-meta/columns').then(function (d) {
        state.columnMeta = d || {};
      });
    }

    /**
     * Light, in-place refresh of the Data Model editor after a schema mutation.
     * Refetches only the state the editor reads and re-renders just the side
     * panel (#dm-panel) + sidebar — it NEVER rewrites #drawer-body (the scroll
     * container), so the user's scroll position is preserved. Use this instead
     * of reloadEverything()/renderRoute() in the editor handlers.
     *
     * rebuildGraph: pass true when the node/edge set changed (add/destroy link,
     * rename, delete table) — remounts only #graph-mount. Omit for column-only
     * edits (add/rename column, secret, icon, share), which leave the graph as
     * is (node sizes may be slightly stale until the drawer is reopened).
     */
    function dmRefreshPanel(name, rebuildGraph) {
      return Promise.all([
        fetchJson('/api/entities'),
        fetchJson('/api/gui-meta/columns').catch(function () { return {}; }),
        fetchJson('/api/gui-meta').catch(function () { return {}; }),
      ]).then(function (r) {
        state.entities = r[0];
        state.columnMeta = r[1] || {};
        state.iconOverrides = r[2] || {};
        loadedTables = {};
        renderSidebar();
        dmActiveTable = name || null;
        if (rebuildGraph) {
          // renderSchemaGraph remounts #graph-mount and re-shows the editor for
          // dmActiveTable (or leaves the panel hidden when name is null).
          renderSchemaGraph();
          if (!name) {
            var p = document.getElementById('dm-panel');
            if (p) p.hidden = true;
          }
        } else if (name) {
          dmShowEntityEditor(name);
        }
      });
    }

    // ────────────────────────────────────────────────────────────
    // Toast banner (with optional one-click undo)
    // ────────────────────────────────────────────────────────────
    var activeToast = null;
    var toastDismissTimer = null;
    function showToast(message, opts) {
      opts = opts || {};
      if (activeToast) activeToast.remove();
      if (toastDismissTimer) clearTimeout(toastDismissTimer);
      var toast = document.createElement('div');
      toast.className = 'toast';
      var undoBtn = opts.undo ? '<button class="undo-link" type="button">Undo</button>' : '';
      toast.innerHTML =
        '<span>' + escapeHtml(message) + '</span>' +
        undoBtn +
        '<button class="toast-dismiss" type="button" title="Dismiss">×</button>';
      document.body.appendChild(toast);
      activeToast = toast;

      function close() {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
        if (activeToast === toast) activeToast = null;
      }
      toast.querySelector('.toast-dismiss').addEventListener('click', close);
      if (opts.undo) {
        toast.querySelector('.undo-link').addEventListener('click', function () {
          close();
          if (toastDismissTimer) clearTimeout(toastDismissTimer);
          opts.undo();
        });
      }
      toastDismissTimer = setTimeout(close, opts.duration || 6000);
    }

    /** Standard undo: hit /api/history/undo and refresh views. */
    function undoLast() {
      return fetchJson('/api/history/undo', { method: 'POST' })
        .then(afterMutation)
        .catch(function (err) { showToast('Undo failed: ' + err.message, {}); });
    }

    // ────────────────────────────────────────────────────────────
    // Version history (undo / redo / log)
    // ────────────────────────────────────────────────────────────
    function wireHistoryControls() {
      document.getElementById('undo-btn').addEventListener('click', function () {
        fetchJson('/api/history/undo', { method: 'POST' })
          .then(function () { return afterMutation(); })
          .then(function () { showToast('Last change undone', {}); })
          .catch(function (err) { showToast('Undo failed: ' + err.message, {}); });
      });
      document.getElementById('redo-btn').addEventListener('click', function () {
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
    function afterMutation() {
      loadedTables = {};
      return Promise.all([
        fetchJson('/api/entities'),
        refreshHistoryState(),
      ]).then(function (r) {
        state.entities = r[0];
        renderSidebar();
        renderRoute();
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
        fetchJson('/api/entities'),
        fetchJson('/api/gui-meta').catch(function () { return {}; }),
        fetchJson('/api/gui-meta/columns').catch(function () { return {}; }),
        fetchJson('/api/system-tables').catch(function () { return { tables: [] }; }),
        fetchJson('/api/workspaces').catch(function () { return null; }),
      ]).then(function (results) {
        state.entities = results[0];
        state.iconOverrides = results[1] || {};
        state.columnMeta = results[2] || {};
        state.systemTables = (results[3] && results[3].tables) || [];
        renderWsSwitcher(results[4]);
        renderSidebar();
        if (location.hash !== '#/') location.hash = '#/';
        else renderRoute();
        loadedTables = {};
        startRealtime();
      });
    }

    var wsOutsideClickBound = false;
    function renderWsSwitcher(data) {
      var wrap = document.getElementById('ws-switcher');
      var btn = document.getElementById('ws-button');
      var menu = document.getElementById('ws-menu');
      var nameEl = document.getElementById('ws-name');
      if (!wrap || !btn || !menu || !nameEl) return;
      // The workspace switcher is the SINGLE switcher: every database — local or
      // cloud, created or joined — is a workspace under the .lattice root, and
      // the GUI always has a root (see ensureRootForGui). No database mode.
      wrap.hidden = false;
      var list = (data && data.workspaces) || [];
      var current = list.filter(function (w) { return w.id === (data && data.current); })[0];
      nameEl.textContent = (current && current.label) || 'workspace';
      var curKind = (current && current.kind) || 'local';
      setStatusPill(curKind, curKind === 'cloud' ? 'connecting' : 'local');

      function buildMenu() {
        var currentId = data && data.current;
        var items = list.map(function (w) {
          var isCurrent = w.id === currentId;
          var isCloud = w.kind === 'cloud';
          var dotClass = isCloud ? 'is-cloud-connected' : '';
          var chipText = isCloud ? 'Cloud' : 'Local';
          var chipBg = isCloud ? 'var(--accent-soft)' : 'rgba(255,255,255,0.06)';
          var chipColor = isCloud ? 'var(--accent)' : 'var(--text-muted)';
          return '<button class="db-item' + (isCurrent ? ' active' : '') +
            '" data-id="' + escapeHtml(w.id) + '">' +
            '<span class="db-item-status db-status ' + dotClass + '" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' +
              (isCloud ? 'var(--accent)' : 'var(--warn)') +
            ';flex-shrink:0"></span>' +
            '<span style="flex:1;text-align:left">' + escapeHtml(w.label) + '</span>' +
            '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:' + chipBg + ';color:' + chipColor + ';text-transform:uppercase;letter-spacing:0.04em">' + chipText + '</span>' +
            '</button>';
        }).join('');
        menu.innerHTML =
          '<div class="db-section">Workspaces</div>' + items +
          '<div class="db-create">' +
            '<button class="btn primary" id="ws-create-btn" style="width:100%;">+ New workspace…</button>' +
          '</div>';
        menu.querySelectorAll('button.db-item').forEach(function (b) {
          b.addEventListener('click', function () {
            var id = b.getAttribute('data-id');
            if (id === currentId) { menu.hidden = true; return; }
            withBusy(b, function () {
              return fetchJson('/api/workspaces/switch', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: id }),
              }).then(function () {
                // Keep the menu OPEN with the item's spinner through the reload —
                // for a CLOUD workspace the slow part (connecting + fetching
                // against the remote DB) happens here in reloadEverything, AFTER
                // the switch POST. Hiding the menu now (the old behavior) hid the
                // only progress signal, so a cloud switch looked unresponsive.
                // renderWsSwitcher (inside reloadEverything) only re-binds the
                // toggle + updates the label, so the spinning item survives.
                return reloadEverything();
              }).then(function () {
                menu.hidden = true;
                // Conversations + activity both live in the workspace DB. Drop
                // the old workspace's thread + activity cards, reconnect the feed
                // to THIS workspace, and reload its thread list (+ latest convo).
                newChat();
                clearActivityFeed();
                startFeed();
                refreshThreadList(true);
                showToast('Switched workspace', {});
              }).catch(function (err) { menu.hidden = true; showToast('Switch failed: ' + err.message, {}); });
            });
          });
        });
        // Create + Join both live in the 3-step wizard (local / cloud / join) —
        // the single entry point for adding any workspace.
        document.getElementById('ws-create-btn').addEventListener('click', function () {
          menu.hidden = true;
          showCreateDatabaseWizard();
        });
      }

      btn.onclick = function (e) {
        e.stopPropagation();
        if (menu.hidden) buildMenu();
        menu.hidden = !menu.hidden;
      };
      // Attach the outside-click closer ONCE — renderWsSwitcher runs on every
      // reload, so adding it each time leaked a listener per render. Re-fetch
      // the elements by id inside the handler so it never holds a stale closure.
      if (!wsOutsideClickBound) {
        wsOutsideClickBound = true;
        document.addEventListener('click', function (e) {
          var m = document.getElementById('ws-menu');
          var b = document.getElementById('ws-button');
          if (!m || m.hidden) return;
          if (!m.contains(e.target) && e.target !== b && (!b || !b.contains(e.target))) {
            m.hidden = true;
          }
        });
      }
    }

    /** Reload icon overrides after a save, then re-render the current view. */
    function refreshIcons() {
      return fetchJson('/api/gui-meta').then(function (data) {
        state.iconOverrides = data || {};
        renderSidebar();
        renderRoute();
      });
    }

    window.addEventListener('hashchange', renderRoute);

    // ────────────────────────────────────────────────────────────
    // Sidebar
    // ────────────────────────────────────────────────────────────
    function renderSidebar() {
      var ul = document.getElementById('object-nav');
      var prefix = advancedMode() ? '#/objects/' : '#/fs/';
      var firstClass = state.entities.tables.filter(function (t) { return !isJunction(t); });
      ul.innerHTML = firstClass.map(function (t) {
        var d = displayFor(t.name);
        var unseen = unseenByTable[t.name] || 0;
        var badge = unseen > 0
          ? ' <span class="nav-badge" title="' + unseen + ' change' + (unseen === 1 ? '' : 's') +
            ' from another editor">' + (unseen > 99 ? '99+' : unseen) + '</span>'
          : '';
        return '<li><a data-route="' + prefix + t.name + '" href="' + prefix + t.name +
          '"><span class="nav-icon">' + d.icon + '</span> <span class="nav-text">' + escapeHtml(d.label) + '</span>' + badge + '</a></li>';
      }).join('');

      var section = document.getElementById('system-section');
      // System tables surface in Advanced View (no separate preference).
      var show = advancedMode();
      if (section) section.hidden = !show;
      var sys = document.getElementById('system-nav');
      if (sys) {
        sys.innerHTML = show
          ? (state.systemTables || []).map(function (t) {
              return '<li><a data-route="#/system/' + t.name + '" href="#/system/' + t.name +
                '"><span class="nav-icon">⚙</span> <span class="nav-text">' + escapeHtml(t.name) + '</span></a></li>';
            }).join('')
          : '';
      }

      highlightActive();
    }

    function highlightActive() {
      var hash = location.hash || '#/';
      document.querySelectorAll('nav a').forEach(function (a) {
        var route = a.getAttribute('data-route') || a.getAttribute('href');
        a.classList.toggle('active', route && hash.indexOf(route) === 0);
      });
    }

    // ────────────────────────────────────────────────────────────
    // Routing
    // ────────────────────────────────────────────────────────────
    function renderRoute() {
      if (!state.entities) return;
      highlightActive();
      var content = document.getElementById('content');
      var hash = location.hash || '#/';

      if (hash === '#/' || hash === '') { renderDashboard(content); return; }

      // File-system workspace (default mode): #/fs/<table>[/<id>/<rel>/<id>…].
      // Even segment count → item view; odd → folder/collection view.
      var fsegs = fsParse(hash);
      if (fsegs) {
        // #/fs/<table>/new → inline create view (must precede the even/odd
        // item-vs-collection heuristic, since [table,'new'] is even-length).
        if (fsegs[fsegs.length - 1] === 'new') renderFsCreate(content, fsegs);
        else if (fsegs.length % 2 === 1) renderFsCollection(content, fsegs);
        else renderFsItem(content, fsegs);
        return;
      }

      var m = /^#\\/objects\\/([^/]+)(?:\\/(.+))?$/.exec(hash);
      if (m) {
        if (m[2]) renderDetail(content, m[1], m[2]);
        else      renderTable(content, m[1]);
        return;
      }

      var sm = /^#\\/system\\/([^/]+)$/.exec(hash);
      if (sm) { renderSystemTable(content, sm[1]); return; }

      // Settings live in a slide-over drawer (gear icon, top-right). The legacy
      // hashes open the drawer to the matching tab over the dashboard, so deep
      // links and existing bookmarks keep working. Version history stays a page.
      if (hash === '#/settings/history') { renderHistory(content); return; }
      if (hash === '#/settings/lattice') { renderDashboard(content); openSettingsDrawer('lattice'); return; }
      if (hash === '#/settings/database' || hash === '#/settings/project-config' || hash === '#/settings/data-model') {
        renderDashboard(content); openSettingsDrawer('database'); return;
      }
      if (hash === '#/settings/user-config') { renderDashboard(content); openSettingsDrawer('user'); return; }
      content.innerHTML = '<div class="placeholder"><h2>Unknown route</h2></div>';
    }

    // ────────────────────────────────────────────────────────────
    // Dashboard
    // ────────────────────────────────────────────────────────────
    function dashboardPreferenceRank(name) {
      // DASHBOARD_ORDER is a preference for ordering only; tables not in it
      // appear after, in declaration order.
      var idx = DASHBOARD_ORDER.indexOf(name);
      return idx === -1 ? DASHBOARD_ORDER.length : idx;
    }
    // Fallback dashboard data from the already-loaded entities list, used if
    // the /api/dashboard call fails (no freshness/recent, just counts).
    function dashboardFallback() {
      var tables = (state.entities.tables || []).filter(function (t) {
        return !isJunction(t) && t.name.charAt(0) !== '_';
      });
      return {
        totals: { entities: tables.length, rows: 0, stale: 0 },
        staleDays: 14,
        entities: tables.map(function (t) {
          return { name: t.name, rowCount: t.rowCount, lastUpdatedAt: null, stale: false };
        }),
      };
    }
    function drawDashboard(content, d) {
      var ents = (d.entities || []).slice().sort(function (a, b) {
        return dashboardPreferenceRank(a.name) - dashboardPreferenceRank(b.name);
      });
      if (ents.length === 0) {
        // Generic, role-agnostic empty state — the old copy told everyone to
        // "edit lattice.config.yml / db.define()", which a joined cloud member
        // cannot act on (they just have nothing shared with them yet).
        content.innerHTML =
          '<div class="placeholder">' +
            '<h2>This workspace is empty</h2>' +
            '<p>There are no tables to show yet. Create one in the Data Model editor, ' +
            'or — on a cloud workspace — ask the owner to share a table with you.</p>' +
          '</div>';
        return;
      }
      // No overview stat tiles — the per-entity cards already show counts, and
      // the "stale" indicator was removed (relative "updated" time is signal
      // enough, without flagging anything as stale or coloring it).
      var cardPrefix = advancedMode() ? '#/objects/' : '#/fs/';
      var cards = ents.map(function (e) {
        var disp = displayFor(e.name);
        var count = (e.rowCount != null) ? e.rowCount : 0;
        var fresh = e.lastUpdatedAt
          ? '<div class="card-fresh" title="Last updated ' +
              escapeHtml(String(e.lastUpdatedAt)) + '">' + relTime(e.lastUpdatedAt) + '</div>'
          : '';
        return '<a class="card" href="' + cardPrefix + e.name + '">' +
          '<div class="card-icon">' + disp.icon + '</div>' +
          '<div class="card-label">' + escapeHtml(disp.label) + '</div>' +
          '<div class="card-count">' + count + '</div>' +
          fresh +
          '</a>';
      }).join('');
      content.innerHTML = '<div class="dashboard">' + cards + '</div>';
    }
    function renderDashboard(content) {
      // Workspace overview: counts + freshness + recent activity from
      // /api/dashboard. Falls back to plain cards if the call fails.
      fetchJson('/api/dashboard').then(function (d) {
        drawDashboard(content, d);
      }).catch(function () {
        drawDashboard(content, dashboardFallback());
      });
    }

    // ────────────────────────────────────────────────────────────
    // Table view
    // ────────────────────────────────────────────────────────────
    function intrinsicColumns(table) {
      // Drop id + foreign-key columns (rendered as belongsTo relations instead).
      var fkCols = new Set();
      Object.values(table.relations || {}).forEach(function (r) {
        if (r.type === 'belongsTo') fkCols.add(r.foreignKey);
      });
      return table.columns.filter(function (c) { return c !== 'id' && !fkCols.has(c); });
    }

    function belongsToColumns(table) {
      return Object.entries(table.relations || {})
        .filter(function (kv) { return kv[1].type === 'belongsTo'; })
        .map(function (kv) { return { relName: kv[0], rel: kv[1] }; });
    }

    function junctionsFor(tableName) {
      // Junctions where the LEFT side is this table.
      var out = [];
      state.entities.tables.forEach(function (t) {
        if (!isJunction(t)) return;
        var rels = Object.values(t.relations);
        var here = rels.find(function (r) { return r.table === tableName; });
        var other = rels.find(function (r) { return r.table !== tableName; });
        if (here && other) out.push({ junction: t.name, localFk: here.foreignKey, remoteRel: other });
      });
      return out;
    }

    /**
     * Every relationship for an entity, as a uniform bidirectional link. A link
     * between A and B is one thing — it appears in both editors and deleting it
     * from either side removes it from both. Each entry:
     *   { other, kind: 'junction' | 'fk', delTable, delCol? }
     *   • junction — a many-to-many junction table; delete drops that table.
     *   • fk — a legacy 1:N foreign-key column (this entity's own, or one on
     *     another table pointing here); delete drops that column.
     * New links are always junctions (M2M); fk entries exist only for tables
     * created before the M2M-only model.
     */
    function collectEntityLinks(name) {
      var links = [];
      var t = tableByName(name);
      // Many-to-many via junction tables (found on either side).
      junctionsFor(name).forEach(function (j) {
        links.push({ other: j.remoteRel.table, kind: 'junction', delTable: j.junction });
      });
      // This entity's own outgoing FK columns (legacy 1:N).
      if (t) {
        belongsToColumns(t).forEach(function (b) {
          links.push({ other: b.rel.table, kind: 'fk', delTable: name, delCol: b.rel.foreignKey });
        });
      }
      // Incoming FK columns on other (non-junction) tables pointing here (legacy).
      ((state.entities && state.entities.tables) || []).forEach(function (ot) {
        if (ot.name === name || isJunction(ot)) return;
        belongsToColumns(ot).forEach(function (b) {
          if (b.rel.table === name) {
            links.push({ other: ot.name, kind: 'fk', delTable: ot.name, delCol: b.rel.foreignKey });
          }
        });
      });
      return links;
    }

    function displayNameFor(row) {
      if (!row) return '';
      return row.name || row.title || row.url || row.path || row.id || '';
    }

    /**
     * Render a clickable chip linking to the detail page of a row in another
     * table. Used for belongsTo cells and junction-derived cells so the user
     * can navigate to the related object with one click.
     */
    function chipLink(table, row) {
      if (!row) return '<span class="muted">—</span>';
      return '<a class="chip chip-link" href="#/objects/' + encodeURIComponent(table) +
        '/' + encodeURIComponent(row.id) + '">' + escapeHtml(displayNameFor(row)) + '</a>';
    }

    var loadedTables = {};
    function loadAllRows(tableName) {
      if (loadedTables[tableName]) return Promise.resolve(loadedTables[tableName]);
      return fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows').then(function (d) {
        loadedTables[tableName] = d.rows;
        return d.rows;
      });
    }

    /** Force a fresh fetch — used for views that need to opt in/out of soft-delete filtering. */
    function fetchRows(tableName, deletedMode) {
      var url = '/api/tables/' + encodeURIComponent(tableName) + '/rows';
      if (deletedMode) url += '?deleted=' + encodeURIComponent(deletedMode);
      return fetchJson(url).then(function (d) { return d.rows; });
    }

    /**
     * Invalidate cached rows for one or more tables. Call after any mutation
     * so the next renderTable / renderDetail re-fetches from the server.
     */
    function invalidate(tableNames) {
      (Array.isArray(tableNames) ? tableNames : [tableNames]).forEach(function (n) {
        delete loadedTables[n];
      });
    }

    /**
     * Refresh /api/entities (dashboard row counts) AND the undo/redo button
     * state after a mutation. Called by every CRUD handler.
     */
    function refreshEntities() {
      return Promise.all([
        fetchJson('/api/entities').then(function (d) { state.entities = d; }),
        refreshHistoryState(),
      ]);
    }

    function fieldFor(col, value, table) {
      // Render an input element for a column. belongsTo FK columns become a
      // <select> over the referenced table's rows (must already be cached).
      var belongsTo = belongsToColumns(table).find(function (b) { return b.rel.foreignKey === col; });
      if (belongsTo) {
        var rows = loadedTables[belongsTo.rel.table] || [];
        var options = '<option value="">(none)</option>' + rows.map(function (r) {
          var sel = (r.id === value) ? ' selected' : '';
          return '<option value="' + escapeHtml(r.id) + '"' + sel + '>' + escapeHtml(displayNameFor(r)) + '</option>';
        }).join('');
        return '<select name="' + escapeHtml(col) + '">' + options + '</select>';
      }
      // Secret columns: use a password input so the value is masked while editing.
      if (isSecretColumn(table.name, col)) {
        return '<input type="password" name="' + escapeHtml(col) + '" value="' +
          escapeHtml(value || '') + '" autocomplete="off" data-1p-ignore data-lpignore="true" />';
      }
      // Multiline for ALL long-form fields (matches FS_LONGFORM, the same set
      // fsValInner renders as markdown) AND any value that already contains a
      // newline. A single-line <input> normalizes/strips newlines, so a
      // multi-line markdown value put in one would be silently corrupted on the
      // next blur (a spurious PATCH) and then re-rendered as mangled markdown
      // ("huge text"). A <textarea> round-trips the exact text.
      if (FS_LONGFORM.indexOf(col) >= 0 || (value != null && String(value).indexOf('\\n') >= 0)) {
        return '<textarea name="' + escapeHtml(col) + '">' + escapeHtml(value || '') + '</textarea>';
      }
      return '<input type="text" name="' + escapeHtml(col) + '" value="' + escapeHtml(value || '') + '" />';
    }

    function collectFormValues(scope) {
      var out = {};
      scope.querySelectorAll('[name]').forEach(function (el) {
        var v = el.value;
        out[el.getAttribute('name')] = v === '' ? null : v;
      });
      return out;
    }

    // Per-table view state: 'live' (default) or 'trash' (soft-deleted rows).
    var tableViewMode = {};

    function renderTable(content, tableName) {
      clearUnseen(tableName);
      var t = tableByName(tableName);
      if (!t) {
        // Conversation-storage tables (chat_messages/chat_threads) and other
        // Lattice internals aren't in the Objects list, but are browsable
        // read-only under "System". If something routed here for one of them,
        // fall back to the system-table view instead of "Unknown entity".
        if ((state.systemTables || []).some(function (s) { return s.name === tableName; })) {
          renderSystemTable(content, tableName);
          return;
        }
        content.innerHTML = '<div class="placeholder">Unknown entity: ' + escapeHtml(tableName) + '</div>';
        return;
      }
      var d = displayFor(tableName);
      var intrinsic = intrinsicColumns(t);
      var belongsTo = belongsToColumns(t);
      var junctions = junctionsFor(tableName);
      var supportsSoftDelete = (t.columns || []).indexOf('deleted_at') !== -1;
      var viewMode = tableViewMode[tableName] || 'live';
      // Fetch this entity's rows fresh (mode-aware), plus relation tables (live only) for chips.
      var fetches = [fetchRows(tableName, viewMode === 'trash' ? 'only' : '')];
      belongsTo.forEach(function (b) { fetches.push(loadAllRows(b.rel.table)); });
      junctions.forEach(function (j) {
        fetches.push(loadAllRows(j.junction));
        fetches.push(loadAllRows(j.remoteRel.table));
      });

      Promise.all(fetches).then(function (results) {
        var rows = results[0];
        var headers = intrinsic.map(fieldLabel)
          .concat(belongsTo.map(function (b) { return titleCase(b.relName); }))
          .concat(junctions.map(function (j) { return titleCase(j.remoteRel.table); }))
          .map(function (h) { return '<th>' + escapeHtml(h) + '</th>'; }).join('');
        headers += '<th class="row-actions"></th>';

        var bodyRows;
        if (rows.length === 0) {
          bodyRows = '';
        } else {
          bodyRows = rows.map(function (r) {
            var tds = intrinsic.map(function (c) {
              if ((isSecretColumn(tableName, c) || looksEncrypted(r[c])) && r[c] != null && r[c] !== '') {
                return '<td class="muted">' + SECRET_MASK + '</td>';
              }
              return '<td><div class="cell-clip">' + escapeHtml(truncate(r[c], 120)) + '</div></td>';
            });
            belongsTo.forEach(function (b) {
              var ref = (loadedTables[b.rel.table] || []).find(function (x) { return x.id === r[b.rel.foreignKey]; });
              tds.push('<td><div class="cell-clip">' + chipLink(b.rel.table, ref) + '</div></td>');
            });
            junctions.forEach(function (j) {
              var matches = (loadedTables[j.junction] || []).filter(function (jr) { return jr[j.localFk] === r.id; });
              var remoteFkCol = j.remoteRel.foreignKey;
              var chips = matches.map(function (jr) {
                var ref = (loadedTables[j.remoteRel.table] || []).find(function (x) { return x.id === jr[remoteFkCol]; });
                return ref ? chipLink(j.remoteRel.table, ref) : '';
              }).join('');
              tds.push('<td><div class="cell-clip">' + (chips || '<span class="muted">—</span>') + '</div></td>');
            });
            if (viewMode === 'trash') {
              tds.push('<td class="row-actions">' +
                '<button class="row-restore" title="Restore" data-restore="' + escapeHtml(r.id) + '">↺</button>' +
                '<button class="row-delete" title="Delete permanently" data-hard-del="' + escapeHtml(r.id) + '">✕</button>' +
                '</td>');
            } else {
              tds.push('<td class="row-actions"><button class="row-delete" title="Delete" data-del="' + escapeHtml(r.id) + '">✕</button></td>');
            }
            return '<tr data-id="' + escapeHtml(r.id) + '"' + (viewMode === 'trash' ? ' class="row-deleted"' : '') + '>' + tds.join('') + '</tr>';
          }).join('');
        }

        // Inline "+ new" row at the bottom of the table. Intrinsic + belongsTo
        // columns become inputs; junctions show a dim placeholder (links happen
        // via the Data Model page); the last cell is the create control.
        var createCells = intrinsic.map(function (c) {
          return '<td>' + fieldFor(c, '', t) + '</td>';
        });
        belongsTo.forEach(function (b) {
          createCells.push('<td>' + fieldFor(b.rel.foreignKey, '', t) + '</td>');
        });
        junctions.forEach(function () {
          createCells.push('<td><span class="muted">add after create</span></td>');
        });
        createCells.push('<td class="row-actions"><button class="btn primary" id="inline-create" title="Create">+</button></td>');
        var createRow = '<tr class="create-row">' + createCells.join('') + '</tr>';

        var trashToggle = supportsSoftDelete
          ? '<div class="actions"><button class="btn ghost" id="toggle-trash">' +
              (viewMode === 'trash' ? '← Back to live' : 'Show trash') +
            '</button></div>'
          : '';

        content.innerHTML =
          '<div class="view-header">' +
            '<span class="entity-icon">' + d.icon + '</span>' +
            '<h1>' + escapeHtml(d.label) + (viewMode === 'trash' ? ' · Trash' : '') + '</h1>' +
            '<span class="count">' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + '</span>' +
            trashToggle +
          '</div>' +
          '<table>' +
            '<thead><tr>' + headers + '</tr></thead>' +
            '<tbody>' + bodyRows + (viewMode === 'trash' ? '' : createRow) + '</tbody>' +
          '</table>';

        if (supportsSoftDelete) {
          document.getElementById('toggle-trash').addEventListener('click', function () {
            tableViewMode[tableName] = viewMode === 'trash' ? 'live' : 'trash';
            renderTable(content, tableName);
          });
        }

        if (viewMode === 'live') document.getElementById('inline-create').addEventListener('click', function () {
          var values = collectFormValues(content.querySelector('tr.create-row'));
          // Strip empty optional fields so they're left to DB defaults.
          Object.keys(values).forEach(function (k) {
            if (values[k] === null || values[k] === '') delete values[k];
          });
          rowWrite('POST', '/api/tables/' + encodeURIComponent(tableName) + '/rows', values).then(function (r) {
            if (r && r.queued) return; // saved offline; the queued toast already fired
            invalidate(tableName);
            return refreshEntities().then(function () {
              renderTable(content, tableName);
              showToast(d.label.replace(/s$/, '') + ' created', { undo: undoLast });
            });
          }).catch(function (err) {
            showToast('Create failed: ' + err.message, {});
          });
        });

        content.querySelectorAll('button.row-delete').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var softId = btn.getAttribute('data-del');
            var hardId = btn.getAttribute('data-hard-del');
            var id = softId || hardId;
            var hard = !!hardId;
            var url = '/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id);
            if (hard) url += '?hard=true';
            rowWrite('DELETE', url, null).then(function (r) {
              if (r && r.queued) return;
              invalidate(tableName);
              return refreshEntities().then(function () {
                renderTable(content, tableName);
                var msg = hard
                  ? d.label.replace(/s$/, '') + ' permanently deleted'
                  : d.label.replace(/s$/, '') + ' deleted';
                showToast(msg, { undo: undoLast });
              });
            }).catch(function (err) {
              showToast('Delete failed: ' + err.message, {});
            });
          });
        });

        content.querySelectorAll('button.row-restore').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var id = btn.getAttribute('data-restore');
            fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id), {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ deleted_at: null }),
            }).then(function () {
              invalidate(tableName);
              return refreshEntities();
            }).then(function () {
              renderTable(content, tableName);
              showToast(d.label.replace(/s$/, '') + ' restored', { undo: undoLast });
            }).catch(function (err) {
              showToast('Restore failed: ' + err.message, {});
            });
          });
        });

        content.querySelectorAll('tr[data-id]').forEach(function (tr) {
          tr.addEventListener('click', function (e) {
            // Let chip-link anchors and the delete button handle their own click.
            if (e.target && e.target.closest('a, button')) return;
            location.hash = '#/objects/' + tableName + '/' + tr.getAttribute('data-id');
          });
        });
      }).catch(function (err) {
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // ────────────────────────────────────────────────────────────
    // Detail view (with edit / delete)
    // ────────────────────────────────────────────────────────────
    // Minimal, safe Markdown → HTML for file previews. Escapes first, then
    // applies a known-tag subset (headings, lists, bold/italic, inline code,
    // paragraphs). Regexes use char classes + fromCharCode for the backtick so
    // there are no backslashes/backticks to fight the inline template literal.
    var MD_MIMES = [
      'text/markdown',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    function mdToHtml(src) {
      var bt = String.fromCharCode(96);
      function inline(s) {
        s = s.replace(new RegExp(bt + '([^' + bt + ']+?)' + bt, 'g'), '<code>$1</code>');
        s = s.replace(new RegExp('[*][*]([^*]+?)[*][*]', 'g'), '<strong>$1</strong>');
        s = s.replace(new RegExp('[*]([^*]+?)[*]', 'g'), '<em>$1</em>');
        return s;
      }
      var lines = escapeHtml(src).split('\\n');
      var html = '';
      var inList = false;
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        var h = 0;
        while (ln.charAt(h) === '#' && h < 6) h++;
        if (h > 0 && ln.charAt(h) === ' ') {
          if (inList) { html += '</ul>'; inList = false; }
          html += '<h' + h + '>' + inline(ln.slice(h + 1)) + '</h' + h + '>';
          continue;
        }
        if (ln.indexOf('- ') === 0 || ln.indexOf('* ') === 0) {
          if (!inList) { html += '<ul>'; inList = true; }
          html += '<li>' + inline(ln.slice(2)) + '</li>';
          continue;
        }
        if (inList) { html += '</ul>'; inList = false; }
        if (ln.trim() !== '') html += '<p>' + inline(ln) + '</p>';
      }
      if (inList) html += '</ul>';
      return html;
    }

    // Drop a leading YAML frontmatter block (--- … ---) so the rendered
    // document shows the body, not the generator metadata. Uses the same
    // real-newline split convention as mdToHtml.
    function stripFrontmatter(s) {
      var lines = String(s).split('\\n');
      if (lines[0] !== '---') return String(s);
      for (var i = 1; i < lines.length; i++) {
        if (lines[i] === '---') return lines.slice(i + 1).join('\\n').replace(/^\\n+/, '');
      }
      return String(s);
    }

    // A row is backed by a streamable local file when it has the legacy path
    // column (deprecated) or a v2.0 local_ref (ref_uri). Cloud refs aren't served.
    function hasLocalFile(row) {
      return !!(
        row.path ||
        (row.ref_kind === 'local_ref' && row.ref_uri) ||
        (row.ref_kind === 'blob' && row.blob_path)
      );
    }
    function renderFilePreview(row) {
      var host = document.getElementById('file-preview'); if (!host || !row) return;
      var id = row.id;
      var mime = row.mime || '';
      var blobUrl = '/api/files/' + encodeURIComponent(id) + '/blob';
      var html = '';
      if (row.description) html += '<div class="file-desc">' + escapeHtml(row.description) + '</div>';
      if (mime.indexOf('image/') === 0 && hasLocalFile(row)) {
        html += '<img src="' + blobUrl + '" alt="' + escapeHtml(row.original_name || 'image') + '">';
      } else if (mime === 'application/pdf' && hasLocalFile(row)) {
        html += '<iframe src="' + blobUrl + '" title="PDF preview"></iframe>';
      } else if (row.extracted_text && MD_MIMES.indexOf(mime) >= 0) {
        html += '<div class="md-body">' + mdToHtml(String(row.extracted_text).slice(0, 40000)) + '</div>';
      } else if (row.extracted_text) {
        html += '<pre>' + escapeHtml(String(row.extracted_text).slice(0, 20000)) + '</pre>';
      } else {
        html += '<div class="file-unsupported">No inline preview for this file type' +
          (mime ? ' (' + escapeHtml(mime) + ')' : '') + '.</div>';
      }
      if (hasLocalFile(row)) {
        html += '<div class="file-actions">' +
          '<button class="btn" id="file-open">Open in Finder</button>' +
          '<a class="btn" href="' + blobUrl + '" download="' + escapeHtml(row.original_name || 'file') + '">Download</a>' +
        '</div>';
      }
      host.innerHTML = html;
      var openBtn = document.getElementById('file-open');
      if (openBtn) openBtn.addEventListener('click', function () {
        fetch('/api/files/' + encodeURIComponent(id) + '/open-in-finder', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j && j.enabled === false) {
              if (row.path && navigator.clipboard) {
                navigator.clipboard.writeText(row.path).then(function () {
                  showToast('Path copied — set LATTICE_LOCAL_OPEN=1 to open directly', {});
                });
              } else {
                showToast('Set LATTICE_LOCAL_OPEN=1 to open files locally', {});
              }
            } else if (j && j.opened === false) {
              showToast('Could not open: ' + (j.error || 'unknown'), {});
            }
          })
          .catch(function (e) { showToast('Open failed: ' + e.message, {}); });
      });
    }

    function renderDetail(content, tableName, id) {
      var t = tableByName(tableName);
      if (!t) {
        content.innerHTML = '<div class="placeholder">Unknown entity: ' + escapeHtml(tableName) + '</div>';
        return;
      }
      var d = displayFor(tableName);
      var intrinsic = intrinsicColumns(t);
      var belongsTo = belongsToColumns(t);
      var junctions = junctionsFor(tableName);

      var fetches = [
        fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id)),
      ];
      belongsTo.forEach(function (b) { fetches.push(loadAllRows(b.rel.table)); });
      junctions.forEach(function (j) {
        fetches.push(loadAllRows(j.junction));
        fetches.push(loadAllRows(j.remoteRel.table));
      });

      Promise.all(fetches).then(function (results) {
        var row = results[0];

        function paint(editing) {
          var rows = [];
          intrinsic.forEach(function (c) {
            var secret = isSecretColumn(tableName, c) || looksEncrypted(row[c]);
            var dd;
            if (editing) {
              dd = fieldFor(c, row[c], t);
            } else if (row[c] == null || row[c] === '') {
              dd = '<span class="muted">—</span>';
            } else if (secret) {
              dd = '<span class="muted">' + SECRET_MASK + '</span>';
            } else {
              dd = escapeHtml(row[c]);
            }
            rows.push('<dt>' + escapeHtml(fieldLabel(c)) + '</dt><dd>' + dd + '</dd>');
          });
          belongsTo.forEach(function (b) {
            var dd;
            if (editing) {
              dd = fieldFor(b.rel.foreignKey, row[b.rel.foreignKey], t);
            } else {
              var ref = (loadedTables[b.rel.table] || []).find(function (x) { return x.id === row[b.rel.foreignKey]; });
              dd = chipLink(b.rel.table, ref);
            }
            rows.push('<dt>' + escapeHtml(titleCase(b.relName)) + '</dt><dd>' + dd + '</dd>');
          });
          // Junctions: always editable inline. Click × on a chip to unlink,
          // pick from the dropdown to link. Mutations are atomic — no Save.
          junctions.forEach(function (j) {
            var matches = (loadedTables[j.junction] || []).filter(function (jr) { return jr[j.localFk] === row.id; });
            var linkedIds = new Set(matches.map(function (m) { return m[j.remoteRel.foreignKey]; }));
            var available = (loadedTables[j.remoteRel.table] || []).filter(function (o) { return !linkedIds.has(o.id); });
            var chips = matches.map(function (jr) {
              var remoteId = jr[j.remoteRel.foreignKey];
              var ref = (loadedTables[j.remoteRel.table] || []).find(function (x) { return x.id === remoteId; });
              if (!ref) return '';
              return '<span class="chip-removable"' +
                ' data-junction="' + escapeHtml(j.junction) + '"' +
                ' data-localfk="' + escapeHtml(j.localFk) + '"' +
                ' data-remotefk="' + escapeHtml(j.remoteRel.foreignKey) + '"' +
                ' data-local="' + escapeHtml(row.id) + '"' +
                ' data-remote="' + escapeHtml(remoteId) + '">' +
                '<a class="chip-link" href="#/objects/' + encodeURIComponent(j.remoteRel.table) +
                  '/' + encodeURIComponent(remoteId) + '">' + escapeHtml(displayNameFor(ref)) + '</a>' +
                ' <button class="remove-link" title="Unlink">×</button></span>';
            }).join(' ');
            var picker = available.length
              ? '<select class="dm-add"' +
                  ' data-junction="' + escapeHtml(j.junction) + '"' +
                  ' data-localfk="' + escapeHtml(j.localFk) + '"' +
                  ' data-remotefk="' + escapeHtml(j.remoteRel.foreignKey) + '"' +
                  ' data-local="' + escapeHtml(row.id) + '">' +
                '<option value="">+ Add link…</option>' +
                available.map(function (o) {
                  return '<option value="' + escapeHtml(o.id) + '">' + escapeHtml(displayNameFor(o)) + '</option>';
                }).join('') +
                '</select>'
              : '';
            rows.push('<dt>' + escapeHtml(titleCase(j.remoteRel.table)) + '</dt>' +
                      '<dd>' + (chips || '<span class="muted">None yet</span>') + ' ' + picker + '</dd>');
          });

          var actions = editing
            ? '<button class="btn primary" id="save-row">Save</button>' +
              '<button class="btn" id="cancel-edit">Cancel</button>'
            : '<button class="btn" id="edit-row">Edit</button>' +
              '<button class="btn danger" id="del-row">Delete</button>';

          content.innerHTML =
            '<a class="breadcrumb" href="#/objects/' + tableName + '">← ' + escapeHtml(d.label) + '</a>' +
            '<div class="view-header">' +
              '<span class="entity-icon">' + d.icon + '</span>' +
              '<h1>' + escapeHtml(displayNameFor(row) || d.label) + '</h1>' +
              '<div class="actions">' + actions + '</div>' +
            '</div>' +
            lastEditedLineEl(tableName, id) +
            (tableName === 'files' ? '<div class="file-preview" id="file-preview"></div>' : '') +
            '<div class="detail"><dl class="' + (editing ? 'editing' : '') + '">' + rows.join('') + '</dl></div>' +
            '<div id="row-context"></div>';

          // Seed "last edited by" for this table (cloud only; no-op locally).
          if (!editing) seedLastEdited(tableName);
          // Skip the context fetch while editing — the just-PATCHed row may
          // not have re-rendered yet, so we'd flash stale content.
          if (!editing) loadRowContext(tableName, id);
          if (!editing && tableName === 'files') renderFilePreview(row);

          // Junction link/unlink handlers (active in both read and edit modes).
          content.querySelectorAll('.remove-link').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
              e.preventDefault();
              e.stopPropagation();
              var chip = btn.closest('[data-junction]');
              var body = {};
              body[chip.getAttribute('data-localfk')] = chip.getAttribute('data-local');
              body[chip.getAttribute('data-remotefk')] = chip.getAttribute('data-remote');
              fetchJson('/api/tables/' + encodeURIComponent(chip.getAttribute('data-junction')) + '/unlink', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              }).then(function () {
                invalidate(chip.getAttribute('data-junction'));
                return refreshEntities();
              }).then(function () {
                renderDetail(content, tableName, id);
                showToast('Link removed', { undo: undoLast });
              }).catch(function (err) { showToast('Unlink failed: ' + err.message, {}); });
            });
          });
          content.querySelectorAll('select.dm-add').forEach(function (sel) {
            sel.addEventListener('change', function () {
              if (!sel.value) return;
              var body = {};
              body[sel.getAttribute('data-localfk')] = sel.getAttribute('data-local');
              body[sel.getAttribute('data-remotefk')] = sel.value;
              fetchJson('/api/tables/' + encodeURIComponent(sel.getAttribute('data-junction')) + '/link', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              }).then(function () {
                invalidate(sel.getAttribute('data-junction'));
                return refreshEntities();
              }).then(function () {
                renderDetail(content, tableName, id);
                showToast('Linked', { undo: undoLast });
              }).catch(function (err) { showToast('Link failed: ' + err.message, {}); });
            });
          });

          if (editing) {
            document.getElementById('cancel-edit').addEventListener('click', function () { paint(false); });
            document.getElementById('save-row').addEventListener('click', function () {
              var values = collectFormValues(content.querySelector('.detail dl'));
              rowWrite('PATCH', '/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id), values).then(function (r) {
                if (r && r.queued) { renderDetail(content, tableName, id); return; }
                invalidate(tableName);
                return refreshEntities().then(function () {
                  renderDetail(content, tableName, id);
                  showToast(d.label.replace(/s$/, '') + ' modified', { undo: undoLast });
                });
              }).catch(function (err) {
                showToast('Save failed: ' + err.message, {});
              });
            });
          } else {
            document.getElementById('edit-row').addEventListener('click', function () { paint(true); });
            document.getElementById('del-row').addEventListener('click', function () {
              rowWrite('DELETE', '/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id), null).then(function (r) {
                if (r && r.queued) { location.hash = '#/objects/' + tableName; return; }
                invalidate(tableName);
                return refreshEntities().then(function () {
                  location.hash = '#/objects/' + tableName;
                  showToast(d.label.replace(/s$/, '') + ' deleted', { undo: undoLast });
                });
              }).catch(function (err) {
                showToast('Delete failed: ' + err.message, {});
              });
            });
          }
        }

        paint(false);
      }).catch(function (err) {
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // ════════════════════════════════════════════════════════════
    // File-system workspace (default view) + settings drawer
    //
    // The default GUI presents each object as a folder of file/folder
    // tiles; clicking a tile opens an "item view" that renders the row
    // as a document (built from its columns, click-to-edit) plus its
    // relationships as sub-folders you can drill into. The classic
    // row/table editor (renderTable / renderDetail) is preserved behind
    // an "Advanced mode" toggle in the settings drawer.
    // ════════════════════════════════════════════════════════════
    var FS_KEYS = { advanced: 'lattice-advanced-mode' };

    function advancedMode() {
      return window.localStorage.getItem(FS_KEYS.advanced) === '1';
    }
    function setAdvancedMode(on) {
      window.localStorage.setItem(FS_KEYS.advanced, on ? '1' : '0');
      document.body.classList.toggle('advanced-mode', on);
      // Preserve context: map the current location between the file-system
      // (#/fs/…) and the classic (#/objects/…) route families.
      var cur = location.hash || '#/';
      var mapped = mapHashForMode(cur, on);
      renderSidebar();
      if (mapped && mapped !== cur) location.hash = mapped; // triggers hashchange → renderRoute
      else renderRoute();
    }

    // Parse "#/fs/a/b/c…" into its decoded segment list (or null).
    function fsParse(hash) {
      var m = /^#\\/fs\\/(.+)$/.exec(hash || '');
      if (!m) return null;
      return m[1].split('/').map(function (s) { return decodeURIComponent(s); });
    }
    // Build a "#/fs/…" hash from a segment list.
    function fsHref(segs) {
      return '#/fs/' + segs.map(function (s) { return encodeURIComponent(s); }).join('/');
    }
    // Resolve the terminal (table, id) of a drill path WITHOUT fetching —
    // relation metadata alone is enough. Used for mode switching.
    function fsTerminal(segs) {
      var table = segs[0];
      var id = null;
      var i = 1;
      while (i < segs.length) {
        id = segs[i]; i++;
        if (i < segs.length) {
          var rel = resolveRelation(table, segs[i]); i++;
          if (!rel) return { table: table, id: id };
          table = rel.targetTable; id = null;
        }
      }
      return { table: table, id: id };
    }
    function mapHashForMode(hash, advanced) {
      if (advanced) {
        var fsegs = fsParse(hash);
        if (!fsegs) return hash;
        var term = fsTerminal(fsegs);
        return term.id
          ? '#/objects/' + encodeURIComponent(term.table) + '/' + encodeURIComponent(term.id)
          : '#/objects/' + encodeURIComponent(term.table);
      }
      var m = /^#\\/objects\\/([^/]+)(?:\\/(.+))?$/.exec(hash);
      if (!m) return hash;
      return m[2]
        ? '#/fs/' + encodeURIComponent(m[1]) + '/' + encodeURIComponent(m[2])
        : '#/fs/' + encodeURIComponent(m[1]);
    }

    // A human label for one row: first non-empty title-ish column; failing that
    // a short snippet of a body/description field; failing that a short id.
    function fsDisplayName(row) {
      if (!row) return '';
      var primary = row.name || row.title || row.label || row.original_name || row.subject;
      if (primary) return String(primary);
      var secondary = row.summary || row.description || row.body || row.content || row.url || row.path;
      if (secondary) return truncate(String(secondary).replace(/\\s+/g, ' '), 60);
      // No conventional label column — fall back to the first meaningful cell
      // value (skip id / timestamp / foreign-key columns) so an inferred entity
      // still reads as something human, not a bare #id. Mirrors the server's
      // rowLabel() so a card and its activity-feed bubble agree.
      for (var k in row) {
        if (!Object.prototype.hasOwnProperty.call(row, k)) continue;
        if (k === 'id' || /_id$|_at$/.test(k)) continue;
        var v = row[k];
        if (typeof v === 'number') return String(v);
        if (typeof v === 'string' && v.trim()) return truncate(v.trim().replace(/\\s+/g, ' '), 60);
      }
      return row.id ? '#' + String(row.id).slice(0, 8) : '(untitled)';
    }
    // File-type glyph for native files-entity rows.
    function fileEmoji(row) {
      var m = (row && row.mime) || '';
      if (m.indexOf('image/') === 0) return '🖼️';
      if (m === 'application/pdf') return '📕';
      if (MD_MIMES.indexOf(m) >= 0 || m.indexOf('text/') === 0) return '📝';
      return '📄';
    }

    // The navigable "sub-folder" relations of a table: reverse-1:N (other
    // entities that belongsTo this one) + many-to-many (junctions). Forward
    // belongsTo relations are NOT folders — they render as inline parent links.
    function fsRelations(tableName) {
      var out = [];
      var tables = (state.entities && state.entities.tables) || [];
      // Reverse 1:N — non-junction tables with a belongsTo pointing here.
      tables.forEach(function (t) {
        if (isJunction(t)) return;
        var belongs = Object.entries(t.relations || {}).filter(function (kv) {
          return kv[1].type === 'belongsTo' && kv[1].table === tableName;
        });
        belongs.forEach(function (kv) {
          var rel = kv[1];
          // Disambiguate when one source table points here more than once.
          var token = belongs.length > 1 ? (t.name + '~' + rel.foreignKey) : t.name;
          var label = displayFor(t.name).label + (belongs.length > 1 ? ' (' + titleCase(kv[0]) + ')' : '');
          out.push({ token: token, label: label, kind: 'hasMany', targetTable: t.name, foreignKey: rel.foreignKey });
        });
      });
      // Many-to-many — junctions where this table is one side.
      junctionsFor(tableName).forEach(function (j) {
        out.push({
          token: j.junction, label: displayFor(j.remoteRel.table).label, kind: 'm2m',
          targetTable: j.remoteRel.table, junction: j.junction, localFk: j.localFk, remoteRel: j.remoteRel,
        });
      });
      return out;
    }
    function resolveRelation(tableName, token) {
      return fsRelations(tableName).find(function (r) { return r.token === token; }) || null;
    }
    // Resolve the rows on the far side of a relation for one parent row.
    function fsRelatedRows(parentTable, parentRow, rel) {
      if (rel.kind === 'hasMany') {
        return loadAllRows(rel.targetTable).then(function (rows) {
          return rows.filter(function (r) { return r[rel.foreignKey] === parentRow.id; });
        });
      }
      return Promise.all([loadAllRows(rel.junction), loadAllRows(rel.targetTable)]).then(function (res) {
        var jrows = res[0], targets = res[1];
        var ids = {};
        jrows.forEach(function (jr) {
          if (jr[rel.localFk] === parentRow.id) ids[jr[rel.remoteRel.foreignKey]] = true;
        });
        return targets.filter(function (x) { return ids[x.id]; });
      });
    }

    // Walk a drill path, fetching each (table,id) node row and resolving each
    // relation token. Returns an ordered crumb list: 'node' crumbs (a row) and
    // 'rel' crumbs (a relation from the preceding node).
    function fsWalk(segs) {
      var crumbs = [];
      var table = segs[0];
      var i = 1;
      function step() {
        if (i >= segs.length) return Promise.resolve();
        var id = segs[i]; i++;
        return fetchJson('/api/tables/' + encodeURIComponent(table) + '/rows/' + encodeURIComponent(id)).then(function (row) {
          crumbs.push({ type: 'node', table: table, id: id, row: row });
          if (i >= segs.length) return;
          var relToken = segs[i]; i++;
          var rel = resolveRelation(table, relToken);
          if (!rel) throw new Error('Unknown relation "' + relToken + '" on ' + table);
          crumbs.push({ type: 'rel', parentTable: table, parentId: id, parentRow: row, relToken: relToken, rel: rel });
          table = rel.targetTable;
          return step();
        });
      }
      return step().then(function () { return crumbs; });
    }

    function fsBreadcrumb(segs, crumbs) {
      var parts = ['<a href="#/">Home</a>'];
      var t0 = segs[0];
      var prefix = '#/fs/' + encodeURIComponent(t0);
      parts.push('<a href="' + prefix + '">' + escapeHtml(displayFor(t0).label) + '</a>');
      (crumbs || []).forEach(function (c) {
        if (c.type === 'node') {
          prefix += '/' + encodeURIComponent(c.id);
          parts.push('<a href="' + prefix + '">' + escapeHtml(fsDisplayName(c.row)) + '</a>');
        } else {
          prefix += '/' + encodeURIComponent(c.relToken);
          parts.push('<a href="' + prefix + '">' + escapeHtml(c.rel.label) + '</a>');
        }
      });
      return '<nav class="fs-crumbs">' + parts.join('<span class="fs-sep">▸</span>') + '</nav>';
    }

    // Columns never offered for click-to-edit (identity / system / file-binary).
    var READONLY_COLS = ['id', 'created_at', 'updated_at', 'deleted_at', 'original_name',
      'mime', 'size_bytes', 'path', 'blob_path', 'extracted_text', 'extraction_status'];
    // Columns rendered as formatted markdown (also any value containing newlines).
    var FS_LONGFORM = ['body', 'summary', 'transcript', 'description', 'bio', 'notes',
      'content', 'text', 'abstract', 'review', 'message'];

    function fsIsReadonly(table, col) {
      return READONLY_COLS.indexOf(col) >= 0 || isSecretColumn(table, col);
    }
    // The rendered (display) HTML for a single value — markdown for long-form
    // fields, masked for secrets, plain otherwise.
    function fsValInner(table, row, col) {
      var raw = row[col];
      if (raw == null || raw === '') return '<span class="fs-empty-val">—</span>';
      if (isSecretColumn(table, col) || looksEncrypted(raw)) return '<span class="muted">' + SECRET_MASK + '</span>';
      var s = String(raw);
      if (FS_LONGFORM.indexOf(col) >= 0 || s.indexOf('\\n') >= 0) {
        return '<div class="md-body">' + mdToHtml(s.slice(0, 40000)) + '</div>';
      }
      return escapeHtml(s);
    }
    function fsFieldHtml(table, row, col) {
      var ro = fsIsReadonly(table, col);
      var cls = 'fs-field-val' + (ro ? ' readonly' : ' ce');
      var attr = ro ? '' : ' data-col="' + escapeHtml(col) + '" title="Click to edit"';
      return '<div class="fs-field"><div class="fs-field-label">' + escapeHtml(fieldLabel(col)) + '</div>' +
        '<div class="' + cls + '"' + attr + '>' + fsValInner(table, row, col) + '</div></div>';
    }

    // Collection view — a folder of tiles. Top-level (#/fs/<table>) shows every
    // row; a nested path (#/fs/<table>/<id>/<rel>) shows the related rows.
    function renderFsCollection(content, segs) {
      clearUnseen(segs[0]);
      var topLevel = segs.length === 1;
      var crumbsP = topLevel ? Promise.resolve([]) : fsWalk(segs);
      crumbsP.then(function (crumbs) {
        var table, rowsP;
        if (topLevel) {
          table = segs[0];
          if (!tableByName(table)) {
            content.innerHTML = '<div class="placeholder">Unknown entity: ' + escapeHtml(table) + '</div>';
            return;
          }
          rowsP = fetchRows(table, '');
        } else {
          var last = crumbs[crumbs.length - 1];
          if (!last || last.type !== 'rel') throw new Error('Bad collection path');
          table = last.rel.targetTable;
          rowsP = fsRelatedRows(last.parentTable, last.parentRow, last.rel);
        }
        return rowsP.then(function (rows) {
          var d = displayFor(table);
          var base = fsHref(segs);
          // "New" tile (top-level collections only) — a folder box with a + that
          // opens a create form. Related-row folders aren't a place to mint a
          // brand-new object, so the tile is top-level only.
          var createTile = topLevel
            ? '<a class="fs-tile fs-tile-create" href="' + fsHref([table, 'new']) + '" title="Create a new ' + escapeHtml(d.label) + '">' +
                '<div class="fs-tile-icon">➕</div>' +
                '<div class="fs-tile-label">New ' + escapeHtml(d.label) + '</div>' +
              '</a>'
            : '';
          var rowTiles = rows.length
            ? rows.map(function (r) {
                var icon = (table === 'files') ? fileEmoji(r) : '📁';
                return '<a class="fs-tile" href="' + base + '/' + encodeURIComponent(r.id) + '">' +
                  '<div class="fs-tile-icon">' + icon + '</div>' +
                  '<div class="fs-tile-label">' + escapeHtml(fsDisplayName(r)) + '</div>' +
                '</a>';
              }).join('')
            : (topLevel ? '' : '<div class="fs-empty">Nothing here yet.</div>');
          content.innerHTML =
            fsBreadcrumb(segs, crumbs) +
            '<div class="view-header">' +
              '<span class="entity-icon">' + d.icon + '</span>' +
              '<h1>' + escapeHtml(d.label) + '</h1>' +
              '<span class="count">' + rows.length + ' item' + (rows.length === 1 ? '' : 's') + '</span>' +
            '</div>' +
            '<div class="fs-grid">' + createTile + rowTiles + '</div>';
        });
      }).catch(function (err) {
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // Create a new object from the simple view — a form styled like the item
    // page with blank fields + a Save button, plus a select-menu + "+" for each
    // many-to-many link. Reuses fieldFor() (intrinsic + belongsTo) and the
    // existing row-create + junction-row endpoints (no new backend).
    // Inline create view (#/fs/<table>/new) — mirrors renderFsItem's formatted
    // layout (.fs-doc/.fs-field) with blank fields + Save/Cancel, instead of a
    // modal. Reuses fieldFor() + the row-create + junction /link endpoints.
    function renderFsCreate(content, segs) {
      var table = segs[0];
      var t = tableByName(table);
      if (!t) { content.innerHTML = '<div class="placeholder">Unknown entity: ' + escapeHtml(table) + '</div>'; return; }
      var d = displayFor(table);
      var bt = belongsToColumns(t);
      var juncs = junctionsFor(table);
      var collectionHref = fsHref([table]);
      // Preload FK + junction-remote target rows so the <select> menus populate.
      var needed = bt.map(function (b) { return b.rel.table; })
        .concat(juncs.map(function (j) { return j.remoteRel.table; }));
      Promise.all(needed.map(loadAllRows)).then(function () {
        var fieldsHtml = '';
        intrinsicColumns(t).forEach(function (c) {
          fieldsHtml += '<div class="fs-field"><div class="fs-field-label">' + escapeHtml(titleCase(c)) + '</div>' +
            '<div class="fs-field-val">' + fieldFor(c, '', t) + '</div></div>';
        });
        bt.forEach(function (b) {
          fieldsHtml += '<div class="fs-field"><div class="fs-field-label">' + escapeHtml(titleCase(b.relName)) + '</div>' +
            '<div class="fs-field-val">' + fieldFor(b.rel.foreignKey, '', t) + '</div></div>';
        });
        juncs.forEach(function (j) {
          var remoteRows = loadedTables[j.remoteRel.table] || [];
          var opts = '<option value="">(none)</option>' + remoteRows.map(function (r) {
            return '<option value="' + escapeHtml(r.id) + '">' + escapeHtml(displayNameFor(r)) + '</option>';
          }).join('');
          fieldsHtml += '<div class="fs-field"><div class="fs-field-label">' + escapeHtml(titleCase(j.remoteRel.table)) + ' (links)</div>' +
            '<div class="fs-field-val">' +
              '<div class="fs-link-stage" data-junction="' + escapeHtml(j.junction) + '" data-local-fk="' + escapeHtml(j.localFk) + '" data-remote-fk="' + escapeHtml(j.remoteRel.foreignKey) + '">' +
                '<select class="fs-link-select">' + opts + '</select>' +
              '</div>' +
              '<button type="button" class="btn fs-link-add">+ Add another</button>' +
            '</div></div>';
        });
        content.innerHTML =
          '<nav class="fs-crumbs"><a href="#/">Home</a><span class="fs-sep">▸</span>' +
            '<a href="' + collectionHref + '">' + escapeHtml(d.label) + '</a><span class="fs-sep">▸</span>' +
            '<span>New</span></nav>' +
          '<div class="view-header">' +
            '<span class="entity-icon">' + d.icon + '</span>' +
            '<h1>New ' + escapeHtml(d.label) + '</h1>' +
          '</div>' +
          '<div class="fs-doc fs-create-form">' + fieldsHtml + '</div>' +
          '<div class="fs-create-actions">' +
            '<button class="btn" id="fs-create-cancel">Cancel</button>' +
            '<button class="btn primary" id="fs-create-save">Save</button>' +
          '</div>';
        content.querySelectorAll('.fs-link-add').forEach(function (addBtn) {
          addBtn.addEventListener('click', function () {
            var stage = addBtn.previousElementSibling; // the .fs-link-stage
            var firstSel = stage && stage.querySelector('.fs-link-select');
            if (!firstSel) return;
            var clone = firstSel.cloneNode(true);
            clone.value = '';
            stage.appendChild(clone);
          });
        });
        content.querySelector('#fs-create-cancel').addEventListener('click', function () {
          location.hash = collectionHref;
        });
        var saveBtn = content.querySelector('#fs-create-save');
        saveBtn.addEventListener('click', function () {
          var values = {};
          content.querySelectorAll('.fs-create-form [name]').forEach(function (el) {
            var v = el.value;
            if (v !== '' && v != null) values[el.getAttribute('name')] = v;
          });
          var links = [];
          content.querySelectorAll('.fs-link-stage').forEach(function (stage) {
            var junction = stage.getAttribute('data-junction');
            var localFk = stage.getAttribute('data-local-fk');
            var remoteFk = stage.getAttribute('data-remote-fk');
            stage.querySelectorAll('.fs-link-select').forEach(function (sel) {
              if (sel.value) links.push({ junction: junction, localFk: localFk, remoteFk: remoteFk, remoteId: sel.value });
            });
          });
          withBusy(saveBtn, function () {
            return rowWrite('POST', '/api/tables/' + encodeURIComponent(table) + '/rows', values).then(function (res) {
              var newId = res && (res.id || (res.row && res.row.id));
              var chain = Promise.resolve();
              links.forEach(function (lk) {
                chain = chain.then(function () {
                  // Junction /link endpoint (INSERT OR IGNORE on the two FKs) —
                  // works for pk-less junctions + is idempotent.
                  var jrow = {};
                  jrow[lk.localFk] = newId;
                  jrow[lk.remoteFk] = lk.remoteId;
                  return rowWrite('POST', '/api/tables/' + encodeURIComponent(lk.junction) + '/link', jrow);
                });
              });
              return chain.then(function () { return newId; });
            }).then(function (newId) {
              invalidate(table);
              return refreshEntities().then(function () {
                showToast('Created', {});
                location.hash = newId ? fsHref([table, String(newId)]) : collectionHref;
              });
            }).catch(function (err) { showToast('Create failed: ' + err.message, {}); });
          });
        });
      }).catch(function (err) { content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>'; });
    }

    // Item view — one row as a document (click-to-edit) + its relationship folders.
    function renderFsItem(content, segs) {
      fsWalk(segs).then(function (crumbs) {
        var leaf = crumbs[crumbs.length - 1];
        if (!leaf || leaf.type !== 'node') throw new Error('Bad item path');
        var table = leaf.table, id = leaf.id, row = leaf.row;
        var t = tableByName(table);
        if (!t) { content.innerHTML = '<div class="placeholder">Unknown entity: ' + escapeHtml(table) + '</div>'; return; }
        var d = displayFor(table);
        var bt = belongsToColumns(t);
        var rels = fsRelations(table);
        // Preload belongsTo targets so parent links can show names.
        Promise.all(bt.map(function (b) { return loadAllRows(b.rel.table); })).then(function () {
          var fields = [];
          intrinsicColumns(t).forEach(function (c) { fields.push(fsFieldHtml(table, row, c)); });
          bt.forEach(function (b) {
            var ref = (loadedTables[b.rel.table] || []).find(function (x) { return x.id === row[b.rel.foreignKey]; });
            var dd = ref
              ? '<a class="fs-link" href="#/fs/' + encodeURIComponent(b.rel.table) + '/' + encodeURIComponent(ref.id) + '">📁 ' + escapeHtml(fsDisplayName(ref)) + '</a>'
              : '<span class="fs-empty-val">—</span>';
            fields.push('<div class="fs-field"><div class="fs-field-label">' + escapeHtml(titleCase(b.relName)) +
              '</div><div class="fs-field-val">' + dd + '</div></div>');
          });
          var base = fsHref(segs);
          var folderTiles = rels.map(function (rel) {
            return '<a class="fs-tile fs-folder" href="' + base + '/' + encodeURIComponent(rel.token) + '">' +
              '<div class="fs-tile-icon">📁</div>' +
              '<div class="fs-tile-label">' + escapeHtml(rel.label) + '</div>' +
              '<div class="fs-folder-count" data-count-for="' + escapeHtml(rel.token) + '">…</div>' +
            '</a>';
          }).join('');
          content.innerHTML =
            fsBreadcrumb(segs, crumbs) +
            '<div class="view-header">' +
              '<span class="entity-icon">' + (table === 'files' ? fileEmoji(row) : d.icon) + '</span>' +
              '<h1>' + escapeHtml(fsDisplayName(row) || d.label) + '</h1>' +
            '</div>' +
            (table === 'files' ? '<div class="file-preview" id="file-preview"></div>' : '') +
            '<div class="fs-doc">' + fields.join('') + '</div>' +
            '<div class="fs-context" id="fs-context"></div>' +
            (rels.length ? '<h3 class="fs-rel-title">Inside</h3><div class="fs-grid fs-rel-folders">' + folderTiles + '</div>' : '');
          if (table === 'files') renderFilePreview(row);
          loadFsContext(table, id);
          wireFsEdit(content, table, id, t, row);
          rels.forEach(function (rel) {
            fsRelatedRows(table, row, rel).then(function (rs) {
              var el = content.querySelector('[data-count-for="' + rel.token + '"]');
              if (el) el.textContent = rs.length + (rs.length === 1 ? ' item' : ' items');
            }).catch(function () { /* count is best-effort */ });
          });
        });
      }).catch(function (err) {
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // Click-to-edit on rendered values. Reuses fieldFor() for the input and the
    // same PATCH → invalidate → refreshEntities chain as renderDetail's save.
    function wireFsEdit(content, table, id, t, row) {
      content.querySelectorAll('.fs-field-val.ce').forEach(function (cell) {
        cell.addEventListener('click', function (e) {
          if (cell.classList.contains('editing')) return;
          if (e.target && e.target.closest('a, button, input, textarea, select')) return;
          var col = cell.getAttribute('data-col');
          var current = row[col];
          cell.classList.add('editing');
          cell.innerHTML = fieldFor(col, current == null ? '' : current, t);
          var input = cell.querySelector('input, textarea, select');
          if (!input) { cell.classList.remove('editing'); cell.innerHTML = fsValInner(table, row, col); return; }
          input.focus();
          if (input.select) { try { input.select(); } catch (_) { /* ignore */ } }
          var done = false;
          function repaint() { cell.classList.remove('editing'); cell.innerHTML = fsValInner(table, row, col); }
          function finish(save) {
            if (done) return; done = true;
            if (!save) { repaint(); return; }
            var val = input.value === '' ? null : input.value;
            var before = current == null ? '' : String(current);
            if ((val == null ? '' : String(val)) === before) { repaint(); return; }
            var body = {}; body[col] = val;
            fetchJson('/api/tables/' + encodeURIComponent(table) + '/rows/' + encodeURIComponent(id), {
              method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
            }).then(function () {
              row[col] = val; invalidate(table); return refreshEntities();
            }).then(function () {
              repaint(); showToast('Updated', { undo: undoLast });
            }).catch(function (err) { showToast('Save failed: ' + err.message, {}); repaint(); });
          }
          input.addEventListener('blur', function () { finish(true); });
          input.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
            else if (ev.key === 'Enter' && input.tagName !== 'TEXTAREA') { ev.preventDefault(); finish(true); }
            else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); finish(true); }
          });
        });
      });
    }

    // ────────────────────────────────────────────────────────────
    // Settings drawer (gear icon → slide-over). Reuses the existing
    // settings render functions, one per tab, plus the Advanced toggle.
    // ────────────────────────────────────────────────────────────
    var drawerTab = 'user';
    function openSettingsDrawer(section) {
      drawerTab = section || drawerTab || 'user';
      var drawer = document.getElementById('settings-drawer');
      var backdrop = document.getElementById('drawer-backdrop');
      if (!drawer || !backdrop) return;
      backdrop.hidden = false;
      drawer.hidden = false;
      var toggle = document.getElementById('advanced-toggle');
      if (toggle) toggle.checked = advancedMode();
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
    }
    function selectDrawerTab(tab) {
      drawerTab = tab;
      document.querySelectorAll('.drawer-tab').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-tab') === tab);
      });
      var body = document.getElementById('drawer-body');
      if (!body) return;
      if (tab === 'database') renderDatabaseSettings(body);
      else if (tab === 'lattice') renderLatticeSettings(body);
      else renderUserConfig(body);
    }
    function wireSettingsDrawer() {
      var gear = document.getElementById('settings-gear');
      if (gear) gear.addEventListener('click', function () { openSettingsDrawer('user'); });
      var closeBtn = document.getElementById('drawer-close');
      if (closeBtn) closeBtn.addEventListener('click', closeSettingsDrawer);
      var backdrop = document.getElementById('drawer-backdrop');
      if (backdrop) backdrop.addEventListener('click', closeSettingsDrawer);
      document.querySelectorAll('.drawer-tab').forEach(function (b) {
        b.addEventListener('click', function () { selectDrawerTab(b.getAttribute('data-tab')); });
      });
      var toggle = document.getElementById('advanced-toggle');
      if (toggle) toggle.addEventListener('change', function () { setAdvancedMode(toggle.checked); });
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        var drawer = document.getElementById('settings-drawer');
        if (drawer && !drawer.hidden) closeSettingsDrawer();
      });
    }

    // ────────────────────────────────────────────────────────────
    // System tables (Lattice-internal — read-only browse view)
    // ────────────────────────────────────────────────────────────
    function renderSystemTable(content, tableName) {
      var entry = (state.systemTables || []).find(function (t) { return t.name === tableName; });
      if (!entry) {
        content.innerHTML = '<div class="placeholder">Unknown system table: ' + escapeHtml(tableName) + '</div>';
        return;
      }
      content.innerHTML =
        '<div class="view-header">' +
          '<span class="entity-icon">⚙</span>' +
          '<h1>' + escapeHtml(tableName) + '</h1>' +
          '<span class="count">' + entry.rowCount + ' row' + (entry.rowCount === 1 ? '' : 's') +
            ' · read-only</span>' +
        '</div>' +
        '<div class="muted" style="margin-bottom:12px;font-size:13px;">' +
          'Lattice-internal table — shown here for inspection only. The GUI does not allow editing.' +
        '</div>' +
        '<table id="system-table"><thead><tr></tr></thead><tbody></tbody></table>';

      fetchJson('/api/system-tables/' + encodeURIComponent(tableName) + '/rows').then(function (data) {
        var rows = data.rows || [];
        var cols = entry.columns;
        var thead = content.querySelector('#system-table thead tr');
        thead.innerHTML = cols.map(function (c) { return '<th>' + escapeHtml(c) + '</th>'; }).join('');
        var tbody = content.querySelector('#system-table tbody');
        if (rows.length === 0) {
          tbody.innerHTML = '<tr><td colspan="' + cols.length + '" class="muted" style="padding:24px;text-align:center;">Empty</td></tr>';
          return;
        }
        tbody.innerHTML = rows.map(function (r) {
          var tds = cols.map(function (c) {
            var v = r[c];
            if (v == null) return '<td class="muted">—</td>';
            var s = String(v);
            return '<td>' + escapeHtml(s.length > 200 ? s.slice(0, 200) + '…' : s) + '</td>';
          }).join('');
          return '<tr>' + tds + '</tr>';
        }).join('');
      }).catch(function (err) {
        content.querySelector('#system-table tbody').innerHTML =
          '<tr><td colspan="' + entry.columns.length + '" class="muted" style="padding:24px;">' +
          'Failed to load: ' + escapeHtml(err.message) + '</td></tr>';
      });
    }

    // ────────────────────────────────────────────────────────────
    // Version history page (#/settings/history)
    // ────────────────────────────────────────────────────────────
    var historyFilterTable = '';

    function renderHistory(content) {
      var firstClass = state.entities.tables
        .filter(function (t) { return !isJunction(t); })
        .map(function (t) { return t.name; });
      var options = '<option value="">All entities</option>' +
        firstClass.map(function (n) {
          var sel = n === historyFilterTable ? ' selected' : '';
          return '<option value="' + escapeHtml(n) + '"' + sel + '>' + escapeHtml(displayFor(n).label) + '</option>';
        }).join('');

      content.innerHTML =
        '<div class="view-header">' +
          '<span class="entity-icon">📜</span>' +
          '<h1>Version history</h1>' +
          '<div class="actions">' +
            '<select id="history-filter">' + options + '</select>' +
          '</div>' +
        '</div>' +
        '<div class="history-list" id="history-list"><div class="muted" style="padding:20px;">Loading…</div></div>';

      var filterEl = document.getElementById('history-filter');
      filterEl.addEventListener('change', function () {
        historyFilterTable = filterEl.value;
        renderHistory(content);
      });

      var url = '/api/history?limit=500' +
        (historyFilterTable ? '&table=' + encodeURIComponent(historyFilterTable) : '');
      fetchJson(url).then(function (data) {
        var mount = document.getElementById('history-list');
        if (!data.entries || data.entries.length === 0) {
          mount.innerHTML = '<div class="muted" style="padding:24px;">' +
            (historyFilterTable
              ? 'No history yet for ' + escapeHtml(displayFor(historyFilterTable).label) + '.'
              : 'No history yet — make a change to see it here.') +
            '</div>';
          return;
        }
        mount.innerHTML = data.entries.map(historyEntryHtml).join('');

        mount.querySelectorAll('button.history-revert').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-id');
            fetchJson('/api/history/revert/' + encodeURIComponent(id), { method: 'POST' })
              .then(afterMutation)
              .then(function () {
                renderHistory(document.getElementById('content'));
                showToast('Change reverted', {});
              })
              .catch(function (err) { showToast('Revert failed: ' + err.message, {}); });
          });
        });
      }).catch(function (err) {
        document.getElementById('history-list').innerHTML =
          '<div class="muted" style="padding:24px;">Failed to load: ' + escapeHtml(err.message) + '</div>';
      });
    }

    function isSchemaHistoryOp(op) { return String(op).indexOf('schema.') === 0; }

    /** One-line description for a schema/data-model history entry. */
    function schemaEntryLabel(e) {
      var p = (e.before_json && safeParse(e.before_json)) ||
              (e.after_json && safeParse(e.after_json)) || {};
      var t = '<span class="history-table">' + escapeHtml(e.table_name) + '</span>';
      var col = escapeHtml((p && p.column) || '');
      switch (e.operation) {
        case 'schema.create_entity': return 'Created table ' + t;
        case 'schema.delete_entity': return 'Deleted table ' + t + ' <span class="muted">(restorable)</span>';
        case 'schema.rename_entity': return 'Renamed table to ' + t;
        case 'schema.add_column': return 'Added column <span class="history-table">' + col + '</span> to ' + t;
        case 'schema.rename_column': return 'Renamed a column on ' + t;
        case 'schema.add_link': return 'Added a link to ' + t;
        case 'schema.create_junction': return 'Added a link from ' + t;
        case 'schema.delete_link': return 'Deleted a link on ' + t + ' <span class="muted">(restorable)</span>';
        case 'schema.purge': return 'Permanently purged ' + t;
        default: return 'Schema change on ' + t;
      }
    }

    function historyEntryHtml(e) {
      // Schema/data-model entries get a one-line description (no row diff). A
      // purge is permanent, so it carries no Revert button.
      if (isSchemaHistoryOp(e.operation)) {
        var sActions = e.undone
          ? '<span class="muted" style="font-size:11px;">undone</span>'
          : (e.operation === 'schema.purge'
              ? '<span class="muted" style="font-size:11px;">permanent</span>'
              : '<button class="btn danger history-revert" data-id="' + escapeHtml(e.id) + '">Revert</button>');
        return '<div class="history-entry' + (e.undone ? ' is-undone' : '') + '">' +
          '<div class="history-meta">' +
            '<div><span class="history-op op-schema">SCHEMA</span></div>' +
            '<div style="margin-top:6px;">' + escapeHtml(formatTs(e.ts)) + '</div>' +
          '</div>' +
          '<div class="history-summary">' + schemaEntryLabel(e) + '</div>' +
          '<div class="history-actions">' + sActions + '</div>' +
        '</div>';
      }
      var before = e.before_json ? safeParse(e.before_json) : null;
      var after = e.after_json ? safeParse(e.after_json) : null;
      var summary;
      var iconName = displayFor(e.table_name).label;
      switch (e.operation) {
        case 'insert': summary = 'Created in <span class="history-table">' + escapeHtml(iconName) + '</span>'; break;
        case 'update': summary = 'Updated <span class="history-table">' + escapeHtml(iconName) + '</span> row'; break;
        case 'delete': summary = 'Deleted from <span class="history-table">' + escapeHtml(iconName) + '</span>'; break;
        case 'link':   summary = 'Linked via <span class="history-table">' + escapeHtml(e.table_name) + '</span>'; break;
        case 'unlink': summary = 'Unlinked from <span class="history-table">' + escapeHtml(e.table_name) + '</span>'; break;
        default:       summary = escapeHtml(e.operation) + ' on ' + escapeHtml(e.table_name);
      }
      var diff = renderDiff(before, after);
      var actions = e.undone
        ? '<span class="muted" style="font-size:11px;">undone</span>'
        : '<button class="btn danger history-revert" data-id="' + escapeHtml(e.id) + '">Revert</button>';
      return '<div class="history-entry' + (e.undone ? ' is-undone' : '') + '">' +
        '<div class="history-meta">' +
          '<div><span class="history-op op-' + escapeHtml(e.operation) + '">' + escapeHtml(e.operation) + '</span></div>' +
          '<div style="margin-top:6px;">' + escapeHtml(formatTs(e.ts)) + '</div>' +
        '</div>' +
        '<div class="history-summary">' +
          summary +
          (diff ? '<div class="history-diff">' + diff + '</div>' : '') +
        '</div>' +
        '<div class="history-actions">' + actions + '</div>' +
      '</div>';
    }

    function safeParse(s) {
      try { return JSON.parse(s); } catch (_e) { return null; }
    }

    function formatTs(s) {
      if (!s) return '';
      try {
        var d = new Date(s);
        // Never render the literal "Invalid Date" — new Date() returns an
        // Invalid Date (not a throw) for an unparseable value.
        if (isNaN(d.getTime())) return '(no timestamp)';
        return d.toLocaleString();
      } catch (_e) { return '(no timestamp)'; }
    }

    /** Side-by-side-ish text diff. Shows changed columns only for updates. */
    function renderDiff(before, after) {
      if (!before && !after) return '';
      if (!before && after) {
        return Object.keys(after).map(function (k) {
          if (k === 'deleted_at' || after[k] == null) return '';
          return '<div class="diff-add">+ ' + escapeHtml(k) + ': ' + escapeHtml(String(after[k])) + '</div>';
        }).filter(Boolean).join('');
      }
      if (before && !after) {
        return Object.keys(before).map(function (k) {
          if (before[k] == null) return '';
          return '<div class="diff-rem">- ' + escapeHtml(k) + ': ' + escapeHtml(String(before[k])) + '</div>';
        }).filter(Boolean).join('');
      }
      var keys = new Set([].concat(Object.keys(before), Object.keys(after)));
      var lines = [];
      keys.forEach(function (k) {
        var b = before[k];
        var a = after[k];
        if (b === a || (b == null && a == null)) return;
        if (b == null) lines.push('<div class="diff-add">+ ' + escapeHtml(k) + ': ' + escapeHtml(String(a)) + '</div>');
        else if (a == null) lines.push('<div class="diff-rem">- ' + escapeHtml(k) + ': ' + escapeHtml(String(b)) + '</div>');
        else {
          lines.push('<div class="diff-rem">- ' + escapeHtml(k) + ': ' + escapeHtml(String(b)) + '</div>');
          lines.push('<div class="diff-add">+ ' + escapeHtml(k) + ': ' + escapeHtml(String(a)) + '</div>');
        }
      });
      return lines.join('');
    }

    // ────────────────────────────────────────────────────────────
    // Row context (Lattice-rendered markdown files)
    // ────────────────────────────────────────────────────────────
    function loadRowContext(tableName, id) {
      var mount = document.getElementById('row-context');
      if (!mount) return;
      fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows/' +
                encodeURIComponent(id) + '/context').then(function (data) {
        if (!data.files || data.files.length === 0) {
          mount.innerHTML = '<div class="context-block"><div class="context-empty">' +
            'No rendered context for this row — define an entityContext for "' +
            escapeHtml(tableName) + '" in lattice.config.yml or run \`lattice render\`.' +
            '</div></div>';
          return;
        }
        var blocks = data.files.map(function (f) {
          var body = f.content
            ? '<pre>' + escapeHtml(f.content) + '</pre>'
            : '<div class="context-empty">File not rendered yet (run \`lattice render\`).</div>';
          return '<div class="context-file">' +
            '<div class="context-file-head">' +
              '<span class="context-file-name">' + escapeHtml(f.name) + '</span>' +
              '<span>· ' + escapeHtml(f.path) + '</span>' +
            '</div>' + body + '</div>';
        }).join('');
        mount.innerHTML = '<div class="context-block">' + blocks + '</div>';
      }).catch(function (err) {
        mount.innerHTML = '<div class="context-block"><div class="context-empty">' +
          'Failed to load rendered context: ' + escapeHtml(err.message) + '</div></div>';
      });
    }

    // Simple (file-workspace) mode: render the row's context files as FORMATTED
    // markdown (headings/lists/bold) rather than the raw source the advanced
    // editor shows. Frontmatter is stripped; empty when nothing is rendered.
    function loadFsContext(tableName, id) {
      var mount = document.getElementById('fs-context');
      if (!mount) return;
      fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows/' +
                encodeURIComponent(id) + '/context').then(function (data) {
        var files = (data && data.files) || [];
        var blocks = files.map(function (f) {
          if (!f.content) return '';
          return '<div class="fs-context-doc"><div class="md-body">' +
            mdToHtml(stripFrontmatter(f.content)) + '</div></div>';
        }).filter(Boolean).join('');
        mount.innerHTML = blocks;
      }).catch(function () { mount.innerHTML = ''; });
    }

    // ────────────────────────────────────────────────────────────
    // Data Model — entity graph + entity editor
    // (row-level link/unlink lives on the row detail page now)
    // ────────────────────────────────────────────────────────────
    var dmActiveTable = null;

    /** Columns that are structurally part of every entity and shouldn't be
     * renamed or removed from the GUI. id is the primary key; deleted_at is
     * the soft-delete column whose semantics undo/redo depends on. */
    var LOCKED_COLUMNS = ['id', 'deleted_at'];

    /** System columns the API treats as immutable — name + type are fixed and
     * the columns editor renders them read-only (mirrors SCHEMA_SYSTEM_COLUMNS
     * on the server, which enforces it). */
    var SYSTEM_COLUMNS = ['id', 'created_at', 'updated_at', 'deleted_at'];

    /** Curated emoji set for entity icons. Click one to select. */
    var EMOJI_PALETTE = [
      '📋', '📅', '👥', '✉️', '📦', '💿', '📄', '🔐',
      '🗂️', '📁', '📓', '📕', '📗', '📘', '📙', '📒',
      '📊', '📈', '📌', '📍', '🧾', '🧰', '🧪', '🧬',
      '🛒', '💼', '💳', '💰', '🏢', '🏬', '🏛️', '🚀',
      '🎯', '🎨', '🛠️', '🔧', '⚙️', '⚡', '🌟', '🔔',
      '🔖', '🔍', '❤️', '🌐', '🌎', '🐙', '🦄', '👤',
    ];

    // Edge styling for the schema graph: a real foreign key vs a many-to-many
    // join (via a junction). Colors live here, not in CSS, because they're
    // drawn into the SVG per edge.
    var DM_FK_COLOR = '#22c55e'; // belongsTo — an enforced reference
    var DM_M2M_COLOR = '#22d3ee'; // many-to-many — a junction join

    function renderDataModelInto(host) {
      host.innerHTML =
        '<div class="dbconfig-panel" style="margin-top:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
            '<h3 style="margin:0">Data Model</h3>' +
            '<button class="btn primary" id="new-entity-btn">+ New entity</button>' +
          '</div>' +
          '<div class="dm-layout">' +
            '<div id="graph-mount"><div class="muted" style="padding:24px">Loading schema graph…</div></div>' +
            '<aside id="dm-panel" hidden></aside>' +
          '</div>' +
        '</div>';

      document.getElementById('new-entity-btn').addEventListener('click', function () {
        dmShowEntityEditor(null);
      });

      renderSchemaGraph();
    }

    // Force-directed schema graph (vanilla — no external lib). Nodes are
    // tables, sized by row count; edges are foreign keys (belongsTo) and
    // many-to-many joins (junctions surface as a single m2m edge). Drag a node
    // to reposition, scroll to zoom, drag the background to pan, click a node
    // to edit the entity.
    function renderSchemaGraph() {
      var mount = document.getElementById('graph-mount');
      if (!mount) return;
      fetchJson('/api/graph').then(function (graph) {
        var model = buildSchemaModel(graph);
        if (!model.nodes.length) {
          mount.innerHTML = '<div class="muted" style="padding:24px">No entities yet — use “+ New entity”.</div>';
          return;
        }
        forceLayout(model.nodes, model.links);
        mount.innerHTML = schemaGraphSvg(model);
        wireSchemaGraph(mount, model);
        if (dmActiveTable) {
          dmShowEntityEditor(dmActiveTable);
          highlightGraphNode(dmActiveTable);
        }
      }).catch(function (err) {
        mount.innerHTML = '<div class="muted" style="padding:24px">Failed to load schema graph: ' +
          escapeHtml(err.message) + '</div>';
      });
    }

    // Build {nodes, links} from /api/graph: table nodes (junctions already
    // collapsed into m2m edges by the server) + belongsTo/manyToMany edges.
    function buildSchemaModel(graph) {
      var byName = {};
      ((state.entities && state.entities.tables) || []).forEach(function (t) { byName[t.name] = t; });
      var nodes = [];
      var index = {};
      (graph.nodes || []).filter(function (n) { return n.type === 'table'; }).forEach(function (n) {
        var name = n.table || n.label;
        if (index[name] != null) return;
        var meta = byName[name] || {};
        var rc = (meta.rowCount != null) ? meta.rowCount : 0;
        index[name] = nodes.length;
        nodes.push({
          name: name,
          label: displayFor(name).label,
          icon: displayFor(name).icon,
          rowCount: rc,
          cols: (meta.columns || []).length,
          r: Math.max(11, Math.min(26, 11 + Math.sqrt(rc))),
          // Share status (cloud workspaces only). ownedByMe is set by the
          // server solely on cloud workspaces, so its presence flags a cloud
          // DB; on local DBs share status is N/A (no coloring).
          shared: meta.shared === true,
          cloudWorkspace: meta.ownedByMe !== undefined,
          x: 0, y: 0, vx: 0, vy: 0,
        });
      });
      var seen = {};
      var links = [];
      (graph.edges || []).forEach(function (e) {
        var kind = e.type === 'belongsTo' ? 'fk' : (e.type === 'manyToMany' ? 'm2m' : null);
        if (!kind) return;
        var s = String(e.source).replace(/^table:/, '');
        var t = String(e.target).replace(/^table:/, '');
        if (index[s] == null || index[t] == null || s === t) return;
        var key = kind + ':' + s + '|' + t;
        if (seen[key]) return;
        seen[key] = true;
        links.push({ s: s, t: t, si: index[s], ti: index[t], kind: kind, via: e.label || '' });
      });
      return { nodes: nodes, links: links, index: index };
    }

    // A small deterministic force simulation: ~500 settle ticks of pairwise
    // repulsion + link springs + center gravity. O(n²) repulsion is fine for
    // schema-scale graphs (tens of tables).
    function forceLayout(nodes, links) {
      var n = nodes.length;
      var W = 1000, H = 700, cx = W / 2, cy = H / 2;
      var ringR = Math.min(W, H) * 0.32;
      for (var i = 0; i < n; i++) {
        var a = (i / Math.max(1, n)) * 2 * Math.PI;
        nodes[i].x = cx + Math.cos(a) * ringR;
        nodes[i].y = cy + Math.sin(a) * ringR;
        nodes[i].vx = 0; nodes[i].vy = 0;
      }
      var REPULSION = 9000, SPRING_LEN = 140, SPRING_K = 0.02, GRAVITY = 0.012, DAMP = 0.85;
      for (var it = 0; it < 500; it++) {
        for (var p = 0; p < n; p++) {
          for (var q = p + 1; q < n; q++) {
            var dx = nodes[p].x - nodes[q].x, dy = nodes[p].y - nodes[q].y;
            var d2 = dx * dx + dy * dy + 0.01, d = Math.sqrt(d2);
            var rep = REPULSION / d2;
            var fx = (dx / d) * rep, fy = (dy / d) * rep;
            nodes[p].vx += fx; nodes[p].vy += fy;
            nodes[q].vx -= fx; nodes[q].vy -= fy;
          }
        }
        links.forEach(function (l) {
          var a2 = nodes[l.si], b2 = nodes[l.ti];
          var dx2 = b2.x - a2.x, dy2 = b2.y - a2.y, d3 = Math.sqrt(dx2 * dx2 + dy2 * dy2) + 0.01;
          var f = (d3 - SPRING_LEN) * SPRING_K, fx2 = (dx2 / d3) * f, fy2 = (dy2 / d3) * f;
          a2.vx += fx2; a2.vy += fy2; b2.vx -= fx2; b2.vy -= fy2;
        });
        for (var m = 0; m < n; m++) {
          nodes[m].vx += (cx - nodes[m].x) * GRAVITY;
          nodes[m].vy += (cy - nodes[m].y) * GRAVITY;
          nodes[m].vx *= DAMP; nodes[m].vy *= DAMP;
          nodes[m].x += nodes[m].vx; nodes[m].y += nodes[m].vy;
        }
      }
    }

    function schemaGraphSvg(model) {
      var nodes = model.nodes, links = model.links;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      nodes.forEach(function (nd) {
        minX = Math.min(minX, nd.x - nd.r); minY = Math.min(minY, nd.y - nd.r);
        maxX = Math.max(maxX, nd.x + nd.r); maxY = Math.max(maxY, nd.y + nd.r);
      });
      var pad = 60;
      var vb = [minX - pad, minY - pad, (maxX - minX) + 2 * pad, (maxY - minY) + 2 * pad];
      var defs =
        '<defs>' +
          '<marker id="dm-arrow-fk" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
            '<path d="M0,0 L10,5 L0,10 z" fill="' + DM_FK_COLOR + '"/></marker>' +
          '<marker id="dm-arrow-m2m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
            '<path d="M0,0 L10,5 L0,10 z" fill="' + DM_M2M_COLOR + '"/></marker>' +
        '</defs>';
      var edgeSvg = links.map(function (l, i) {
        var a = nodes[l.si], b = nodes[l.ti];
        var color = l.kind === 'fk' ? DM_FK_COLOR : DM_M2M_COLOR;
        var dash = l.kind === 'm2m' ? ' stroke-dasharray="6 4"' : '';
        var markEnd = ' marker-end="url(#dm-arrow-' + l.kind + ')"';
        var markStart = l.kind === 'm2m' ? ' marker-start="url(#dm-arrow-m2m)"' : '';
        var title = l.kind === 'fk'
          ? l.s + ' → ' + l.t + (l.via ? ' · via ' + l.via : '') + ' (foreign key)'
          : l.s + ' ↔ ' + l.t + ' (many-to-many)';
        return '<line class="dm-edge" data-edge="' + i + '" data-s="' + escapeHtml(l.s) + '" data-t="' +
          escapeHtml(l.t) + '" x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' +
          b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '" stroke="' + color + '" stroke-width="1.6"' +
          dash + markStart + markEnd + ' opacity="0.7"><title>' + escapeHtml(title) + '</title></line>';
      }).join('');
      var nodeSvg = nodes.map(function (nd) {
        // Share-status coloring applies only on cloud workspaces (G). On a
        // local DB share status is N/A, so no extra class → neutral stroke.
        var shareCls = nd.cloudWorkspace ? (nd.shared ? ' gnode-shared' : ' gnode-private') : '';
        var shareTitle = nd.cloudWorkspace ? ' · ' + (nd.shared ? 'shared' : 'private') : '';
        return '<g class="gnode' + shareCls + '" data-table="' + escapeHtml(nd.name) + '" transform="translate(' +
          nd.x.toFixed(1) + ',' + nd.y.toFixed(1) + ')">' +
          '<circle class="gnode-glow" r="' + (nd.r + 8).toFixed(1) + '"/>' +
          '<circle class="gnode-dot" r="' + nd.r.toFixed(1) + '"/>' +
          '<text class="gnode-icon" y="' + (nd.r * 0.34).toFixed(1) + '" text-anchor="middle" font-size="' +
            (nd.r * 0.95).toFixed(1) + '">' + nd.icon + '</text>' +
          '<text class="gnode-label" y="' + (nd.r + 15).toFixed(1) + '" text-anchor="middle">' +
            escapeHtml(nd.label) + '</text>' +
          '<title>' + escapeHtml(nd.label + ' · ' + nd.rowCount + ' rows · ' + nd.cols + ' columns' + shareTitle) + '</title>' +
          '</g>';
      }).join('');
      // Share legend entries only make sense on a cloud workspace (where nodes
      // carry share status). Local DBs show just the relationship key.
      var anyCloud = nodes.some(function (nd) { return nd.cloudWorkspace; });
      var shareLegend = anyCloud
        ? '<span><i class="sw sw-shared"></i><span style="color:var(--text-muted)">shared</span></span>' +
          '<span><i class="sw sw-private"></i><span style="color:var(--text-muted)">private</span></span>' +
          '<span><i class="sw sw-selected"></i><span style="color:var(--text-muted)">selected</span></span>'
        : '';
      var legend =
        '<div class="dm-legend">' +
          '<span style="color:' + DM_FK_COLOR + '"><i></i><span style="color:var(--text-muted)">foreign key</span></span>' +
          '<span style="color:' + DM_M2M_COLOR + '"><i class="dash"></i><span style="color:var(--text-muted)">many-to-many</span></span>' +
          shareLegend +
        '</div>';
      return '<svg class="dm-graph" viewBox="' + vb.join(' ') + '" preserveAspectRatio="xMidYMid meet">' +
        defs + '<g class="dm-stage">' + edgeSvg + nodeSvg + '</g></svg>' + legend;
    }

    function highlightGraphNode(tableName) {
      document.querySelectorAll('#graph-mount g.gnode').forEach(function (g) {
        g.classList.toggle('active', g.getAttribute('data-table') === tableName);
      });
    }

    // Wire interactions on the rendered schema graph: node click → editor,
    // node drag → reposition (live edge updates), background drag → pan, wheel
    // → zoom. Pan/zoom are done by mutating the SVG viewBox.
    function wireSchemaGraph(mount, model) {
      var svg = mount.querySelector('svg.dm-graph');
      if (!svg) return;
      var nodeEls = {};
      mount.querySelectorAll('g.gnode').forEach(function (g) { nodeEls[g.getAttribute('data-table')] = g; });
      var edgeEls = mount.querySelectorAll('line.dm-edge');

      function vb() { return svg.getAttribute('viewBox').split(' ').map(Number); }
      function setVb(a) { svg.setAttribute('viewBox', a.join(' ')); }
      // The initial viewBox fits all entities — that's the maximum zoom-out;
      // don't let the user zoom out past it into empty space.
      var fitVb = vb();
      function toData(ev) {
        var rect = svg.getBoundingClientRect();
        var b = vb();
        return {
          x: b[0] + ((ev.clientX - rect.left) / rect.width) * b[2],
          y: b[1] + ((ev.clientY - rect.top) / rect.height) * b[3],
        };
      }
      function nodeByName(name) {
        for (var i = 0; i < model.nodes.length; i++) if (model.nodes[i].name === name) return model.nodes[i];
        return null;
      }
      function updateNode(name) {
        var nd = nodeByName(name); var g = nodeEls[name];
        if (!nd || !g) return;
        g.setAttribute('transform', 'translate(' + nd.x.toFixed(1) + ',' + nd.y.toFixed(1) + ')');
        edgeEls.forEach(function (ln) {
          if (ln.getAttribute('data-s') === name) { ln.setAttribute('x1', nd.x.toFixed(1)); ln.setAttribute('y1', nd.y.toFixed(1)); }
          if (ln.getAttribute('data-t') === name) { ln.setAttribute('x2', nd.x.toFixed(1)); ln.setAttribute('y2', nd.y.toFixed(1)); }
        });
      }

      // Wheel zoom toward the cursor. Zooming out is capped at the fit view
      // (snap back to it) so the graph can't shrink into empty space.
      svg.addEventListener('wheel', function (ev) {
        ev.preventDefault();
        var b = vb(); var pt = toData(ev);
        var factor = ev.deltaY > 0 ? 1.12 : 0.89;
        var nw = b[2] * factor, nh = b[3] * factor;
        if (nw >= fitVb[2] || nh >= fitVb[3]) {
          setVb(fitVb.slice()); // can't zoom out past all entities
          return;
        }
        setVb([pt.x - (pt.x - b[0]) * (nw / b[2]), pt.y - (pt.y - b[1]) * (nh / b[3]), nw, nh]);
      }, { passive: false });

      // Click an edge to edit the relationship in the columns editor: an m2m
      // edge opens its junction table (its two ref columns are editable there);
      // a foreign-key edge opens the child entity that holds the FK column.
      edgeEls.forEach(function (ln) {
        ln.style.cursor = 'pointer';
        ln.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var s = ln.getAttribute('data-s'), t = ln.getAttribute('data-t');
          var edge = model.links[Number(ln.getAttribute('data-edge'))];
          if (edge && edge.kind === 'm2m') {
            var j = junctionsFor(s).find(function (x) { return x.remoteRel.table === t; }) ||
                    junctionsFor(t).find(function (x) { return x.remoteRel.table === s; });
            dmShowEntityEditor(j ? j.junction : s);
          } else {
            dmShowEntityEditor(s); // FK lives on the source (child) table
          }
        });
      });

      // Drag: a node repositions it; the background pans.
      var drag = null;
      svg.addEventListener('pointerdown', function (ev) {
        var g = ev.target.closest && ev.target.closest('g.gnode');
        if (g) {
          drag = { kind: 'node', name: g.getAttribute('data-table'), moved: false };
        } else {
          var b = vb();
          drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, vb: b };
        }
        svg.setPointerCapture(ev.pointerId);
      });
      svg.addEventListener('pointermove', function (ev) {
        if (!drag) return;
        if (drag.kind === 'node') {
          var pt = toData(ev); var nd = nodeByName(drag.name);
          if (nd) { nd.x = pt.x; nd.y = pt.y; updateNode(drag.name); drag.moved = true; }
        } else {
          var rect = svg.getBoundingClientRect();
          var b = drag.vb;
          setVb([b[0] - (ev.clientX - drag.sx) * (b[2] / rect.width),
                 b[1] - (ev.clientY - drag.sy) * (b[3] / rect.height), b[2], b[3]]);
        }
      });
      svg.addEventListener('pointerup', function (ev) {
        if (drag && drag.kind === 'node' && !drag.moved) {
          dmShowEntityEditor(drag.name);
          highlightGraphNode(drag.name);
        }
        drag = null;
        try { svg.releasePointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
      });
    }

    /**
     * Show the editor for a selected entity. Pass null to render the
     * 'create new entity' form (same controls, different submit endpoint).
     * Until the user clicks a graph node or '+ New entity', the side panel
     * stays hidden.
     */
    function dmShowEntityEditor(tableName) {
      dmActiveTable = tableName;
      var panel = document.getElementById('dm-panel');
      panel.hidden = false;
      var creating = !tableName;
      if (creating) {
        // New entities are PRIVATE by default — on a team cloud you own
        // a table you create, and sharing it with the team is a separate,
        // explicit toggle on the entity below (no auto-share-on-create).
        panel.innerHTML =
          '<h3>+ New entity</h3>' +
          '<div class="dm-edit-grid">' +
            '<label>Name</label>' +
            '<div class="dm-row-inline">' +
              '<input id="dm-create-name" placeholder="e.g. invoices" autofocus />' +
            '</div>' +
            '<label>Icon</label>' +
            '<div>' +
              emojiPickerHtml('dm-create-icon', '📋') +
            '</div>' +
            '<label></label>' +
            '<div class="dm-row-inline">' +
              '<button class="btn primary" id="dm-create-btn">Create entity</button>' +
            '</div>' +
          '</div>' +
          '<div class="muted" style="margin-top:14px;font-size:12px;">' +
            'New entities get id (uuid PK), name, and deleted_at columns. ' +
            'Add more columns once the entity exists. On a cloud workspace the ' +
            'entity is private to you until you share it.' +
          '</div>';
        wireEmojiPicker(panel, 'dm-create-icon');
        var createBtn = panel.querySelector('#dm-create-btn');
        createBtn.addEventListener('click', function () {
          var name = panel.querySelector('#dm-create-name').value.trim();
          var icon = panel.querySelector('#dm-create-icon').value.trim();
          if (!name) { panel.querySelector('#dm-create-name').focus(); return; }
          withBusy(createBtn, function () {
            return fetchJson('/api/schema/entities', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: name, icon: icon || undefined }),
            }).then(function () {
              // New node not in the current graph → rebuild it (in place, no
              // route change so the drawer scroll is preserved).
              return dmRefreshPanel(name, true);
            }).then(function () {
              showToast('Entity "' + name + '" created', {});
            }).catch(function (err) { showToast('Create failed: ' + err.message, {}); });
          });
        });
        return;
      }

      var t = tableByName(tableName);
      if (!t) {
        panel.innerHTML = '<div class="muted">Unknown entity.</div>';
        return;
      }
      var d = displayFor(tableName);
      // Team cloud: only the table's owner may edit its schema/relationships
      // (the server enforces this too). A table shared by another member is
      // shown read-only here, rather than offering controls that would 403.
      if (t.ownedByMe === false) {
        var roCols = (t.columns || []).map(function (c) {
          var tgt = belongsToColumns(t).find(function (b) { return b.rel.foreignKey === c; });
          return '<div class="dm-col-row"><div class="dm-locked">' + escapeHtml(c) +
            (tgt ? '<span class="dm-locked-label">→ ' + escapeHtml(displayFor(tgt.rel.table).label) + '</span>' : '') +
            '</div></div>';
        }).join('');
        panel.innerHTML =
          '<h3>' + d.icon + ' ' + escapeHtml(d.label) + '</h3>' +
          '<div class="muted" style="font-size:12px;margin-bottom:12px">Shared by another member — read-only. Only the table owner can edit its columns and relationships.</div>' +
          '<div class="dm-cols">' + (roCols || '<span class="muted">No columns</span>') + '</div>';
        return;
      }
      // Pre-fill the picker with the effective icon (override > built-in
      // default > generic fallback) so the dropdown reflects what's actually
      // rendered elsewhere in the GUI.
      var overrideIcon = d.icon;
      // Prefer the canonical Lattice field type (text/uuid/datetime/…) surfaced
      // on the payload; fall back to the SQL spec with modifiers stripped for
      // code-defined tables (e.g. native entities) that carry no field types.
      function dmShortType(c) {
        if (t.fieldTypes && t.fieldTypes[c]) {
          var canon = String(t.fieldTypes[c]).toLowerCase();
          return ({ int: 'integer', bool: 'boolean', float: 'real' })[canon] || canon;
        }
        var raw = (t.columnTypes && t.columnTypes[c]) || '';
        return String(raw)
          .replace(/\\s+(primary key|not null|default\\b.*)/gi, '')
          .trim()
          .toLowerCase() || 'text';
      }
      // The editor is UNIFORM for every table (links-only model — no special
      // junction branch, which is what previously exposed the table-dropping
      // "Delete relationship" button). Columns and links are different things
      // and edit differently:
      //   • system  — id/created_at/updated_at/deleted_at: name + type fixed,
      //               read-only (the server enforces this too).
      //   • link    — a foreign-key column. Created via "Add link"; can't be
      //               edited once created, only deleted individually (drops the
      //               FK column only, never a table).
      //   • scalar  — editable name + secret flag, staged behind ONE Save.
      // Whole-table deletion is a separate, typed-confirmation danger-zone
      // action below — never a side effect of editing a relationship.
      var fkByCol = {};
      belongsToColumns(t).forEach(function (b) { fkByCol[b.rel.foreignKey] = b.rel.table; });
      var systemCols = [], scalarCols = [], linkCols = [];
      (t.columns || []).forEach(function (c) {
        if (SYSTEM_COLUMNS.indexOf(c) !== -1) systemCols.push(c);
        else if (fkByCol[c]) linkCols.push(c);
        else scalarCols.push(c);
      });

      // ── Columns section (system read-only + editable scalars) ──
      var sysRows = systemCols.map(function (c) {
        return '<div class="dm-col-row">' +
          '<div class="dm-locked">' + escapeHtml(c) +
            '<span class="dm-locked-label">system</span></div>' +
          '<span class="dm-col-type">' + escapeHtml(dmShortType(c)) + '</span>' +
          '<span></span>' +
          '</div>';
      }).join('');
      var scalarRows = scalarCols.map(function (c) {
        var secret = isSecretColumn(tableName, c);
        return '<div class="dm-col-row">' +
          '<input class="dm-col-name" data-orig="' + escapeHtml(c) + '" value="' + escapeHtml(c) + '" />' +
          '<span class="dm-col-type">' + escapeHtml(dmShortType(c)) + '</span>' +
          '<label class="dm-secret-toggle" title="Mask values in the GUI">' +
            '<input type="checkbox" class="dm-col-secret" data-orig="' + escapeHtml(c) + '"' +
              ' data-was="' + (secret ? '1' : '0') + '"' + (secret ? ' checked' : '') + ' /> secret</label>' +
          '</div>';
      }).join('');
      var columnsHtml = sysRows + scalarRows;

      // ── Links section — every relationship is bidirectional and many-to-many.
      // A link between A and B is one thing: it shows in BOTH editors and
      // deleting it from either side removes it from both. "Add link" creates a
      // junction table (the M2M representation). For backward compatibility we
      // also surface legacy 1:N foreign-key columns (this entity's own, and any
      // pointing AT it) as links so they're visible and deletable from either
      // side — but new links are always M2M.
      var dmLinks = collectEntityLinks(tableName);
      var linkRows = dmLinks.map(function (lk, i) {
        return '<div class="dm-link-row">' +
          '<span class="dm-link-name">' + escapeHtml(displayFor(lk.other).label) + '</span>' +
          '<span class="dm-link-arrow' + (lk.kind === 'fk' ? ' legacy' : '') + '" ' +
            (lk.kind === 'fk' ? 'title="Legacy one-to-many link. New links are many-to-many; this is kept for back-compat and will be migrated in 2.0."' : '') +
            '>' + (lk.kind === 'fk' ? '→ one-to-many (legacy)' : '↔ many-to-many') + '</span>' +
          '<button class="btn danger dm-link-destroy" data-link="' + i +
            '" title="Delete this link — removes it from both tables">Delete link</button>' +
          '</div>';
      }).join('');
      // Add-link target picker. Excludes self, junction tables, and any entity
      // already linked (either direction) — one link per pair. Recomputed on
      // every in-place re-render so a target disappears the moment you link it.
      var linkedTargets = {};
      dmLinks.forEach(function (lk) { linkedTargets[lk.other] = 1; });
      var linkTargets = ((state.entities && state.entities.tables) || []).filter(function (rt) {
        return !isJunction(rt) && rt.name !== tableName && !linkedTargets[rt.name];
      });
      var addLinkHtml = linkTargets.length
        ? '<div class="dm-row-inline" style="margin-top:8px">' +
            '<select id="dm-newlink-target" title="Link to entity (many-to-many)">' +
              linkTargets.map(function (rt) {
                return '<option value="' + escapeHtml(rt.name) + '">↔ ' + escapeHtml(displayFor(rt.name).label) + '</option>';
              }).join('') +
            '</select>' +
            '<button class="btn primary" id="dm-newlink-btn">Add link</button>' +
          '</div>'
        : '<span class="muted" style="font-size:12px">No other entities to link to.</span>';

      // Cloud sharing row — only the owner of a table may toggle its
      // visibility (t.ownedByMe is set by the server only for cloud
      // workspaces). Tables shared to me by others, and all local-DB
      // tables, show no sharing control.
      var canShare = !!(t && t.ownedByMe === true);
      var isShared = !!(t && t.shared);
      var shareRow = canShare
        ? '<label>Cloud sharing</label>' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
            '<button class="btn' + (isShared ? '' : ' primary') + '" id="dm-share-btn">' +
              (isShared ? 'Make private' : 'Share with workspace') +
            '</button>' +
            '<span style="font-size:12px;color:var(--text-muted)">' +
              (isShared ? 'Visible to everyone on this cloud workspace.' : 'Private to you. Share to make it visible to everyone on this cloud workspace.') +
            '</span>' +
          '</div>'
        : '';
      panel.innerHTML =
        '<h3>' + d.icon + ' ' + escapeHtml(d.label) + '</h3>' +
        '<div class="dm-edit-grid">' +
          '<label>Name</label>' +
          '<div class="dm-row-inline">' +
            '<input id="dm-rename-input" value="' + escapeHtml(tableName) + '" />' +
            '<button class="btn" id="dm-rename-btn">Save</button>' +
          '</div>' +
          '<label>Icon</label>' +
          '<div>' +
            emojiPickerHtml('dm-icon-input', overrideIcon) +
            '<button class="btn" id="dm-icon-btn" style="margin-top:6px;">Save</button>' +
          '</div>' +
          shareRow +
          '<label>Columns</label>' +
          '<div>' +
            '<div class="dm-cols">' + (columnsHtml || '<span class="muted">No columns</span>') + '</div>' +
            (scalarCols.length
              ? '<button class="btn primary" id="dm-cols-save" style="margin-top:8px" disabled>Save changes</button>'
              : '') +
          '</div>' +
          '<label>Add column</label>' +
          '<div class="dm-row-inline">' +
            '<input id="dm-newcol-name" placeholder="column_name" />' +
            '<select id="dm-newcol-type">' +
              '<option value="text">text</option>' +
              '<option value="integer">integer</option>' +
              '<option value="real">real</option>' +
              '<option value="boolean">boolean</option>' +
            '</select>' +
            '<label class="dm-secret-toggle">' +
              '<input type="checkbox" id="dm-newcol-secret" /> secret' +
            '</label>' +
            '<button class="btn primary" id="dm-newcol-btn">Add</button>' +
          '</div>' +
          '<label>Links</label>' +
          '<div>' +
            '<div class="dm-links">' + (linkRows || '<span class="muted" style="font-size:12px">No links.</span>') + '</div>' +
            addLinkHtml +
          '</div>' +
          '<label>Danger zone</label>' +
          '<div class="dm-danger">' +
            '<button class="btn danger" id="dm-delete-table">Delete table</button>' +
            '<span style="font-size:12px;color:var(--text-muted)">Permanently drops this table and all its rows. ' +
              'You\\'ll be asked to type the name to confirm. Refused while other tables link to it.</span>' +
          '</div>' +
        '</div>';
      wireEmojiPicker(panel, 'dm-icon-input');
      wireEntityEditPanel(panel, tableName);
      var shareBtn = panel.querySelector('#dm-share-btn');
      if (shareBtn) shareBtn.addEventListener('click', function () {
        withBusy(shareBtn, function () {
          return fetchJson('/api/schema/entities/' + encodeURIComponent(tableName) + '/share', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ share: !isShared }),
          }).then(function () {
            // The server updated team visibility in place (no DB re-open),
            // so a light in-place refresh reflects it without a full reload.
            return dmRefreshPanel(tableName, false);
          }).then(function () {
            showToast(isShared ? 'Unshared "' + tableName + '" from workspace' : 'Shared "' + tableName + '" with workspace', {});
          }).catch(function (e) { showToast('Share update failed: ' + e.message, {}); });
        });
      });
    }

    /**
     * Render a collapsed emoji-picker: a button showing the currently selected
     * emoji (with a ▾ caret) and a hidden grid that drops down when clicked.
     * Selecting a tile updates the hidden input and the button, then closes
     * the dropdown.
     *
     * currentValue is the emoji to pre-fill (saved override OR the inherited
     * default — callers pass displayFor(table).icon so the dropdown reflects
     * what the user actually sees on the rest of the page).
     */
    function emojiPickerHtml(inputId, currentValue) {
      var current = currentValue || '📋';
      var tiles = EMOJI_PALETTE.map(function (e) {
        var active = e === current ? ' active' : '';
        return '<button type="button" class="emoji-tile' + active +
          '" data-emoji="' + escapeHtml(e) + '" aria-label="' + escapeHtml(e) + '">' + e + '</button>';
      }).join('');
      return '<div class="emoji-picker" data-input-id="' + escapeHtml(inputId) + '">' +
        '<button type="button" class="emoji-trigger" aria-haspopup="grid" aria-expanded="false">' +
          '<span class="emoji-preview">' + escapeHtml(current) + '</span>' +
          '<span class="emoji-caret">▾</span>' +
        '</button>' +
        '<div class="emoji-grid" hidden>' + tiles + '</div>' +
        '<input type="hidden" id="' + escapeHtml(inputId) + '" value="' + escapeHtml(current) + '" />' +
      '</div>';
    }

    function wireEmojiPicker(panel, inputId) {
      var picker = panel.querySelector('.emoji-picker[data-input-id="' + inputId + '"]');
      if (!picker) return;
      var input = picker.querySelector('input[type="hidden"]');
      var trigger = picker.querySelector('.emoji-trigger');
      var preview = picker.querySelector('.emoji-preview');
      var grid = picker.querySelector('.emoji-grid');

      function open() {
        grid.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
      }
      function close() {
        grid.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
      }

      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        if (grid.hidden) open(); else close();
      });

      // Click anywhere outside the picker closes it.
      document.addEventListener('click', function (e) {
        if (grid.hidden) return;
        if (!picker.contains(e.target)) close();
      });

      picker.querySelectorAll('.emoji-tile').forEach(function (tile) {
        tile.addEventListener('click', function () {
          var v = tile.getAttribute('data-emoji');
          input.value = v;
          preview.textContent = v;
          picker.querySelectorAll('.emoji-tile').forEach(function (t) {
            t.classList.toggle('active', t === tile);
          });
          close();
        });
      });
    }

    /** Wire up the edit-entity controls in the Data Model side panel. */
    function wireEntityEditPanel(panel, tableName) {
      // Rename entity — schema change, not in the audit log, so we keep
      // a confirm (the only kind of warning left in the app).
      panel.querySelector('#dm-rename-btn').addEventListener('click', function () {
        var to = panel.querySelector('#dm-rename-input').value.trim();
        if (!to || to === tableName) return;
        if (!confirm('Rename entity "' + tableName + '" to "' + to + '"? This is irreversible from the GUI.')) return;
        fetchJson('/api/schema/entities/' + encodeURIComponent(tableName) + '/rename', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ to: to }),
        }).then(function () {
          return dmRefreshPanel(to, true);
        }).then(function () {
          showToast('Entity renamed to "' + to + '"', {});
        }).catch(function (err) { showToast('Rename failed: ' + err.message, {}); });
      });
      // Edit icon
      panel.querySelector('#dm-icon-btn').addEventListener('click', function () {
        var icon = panel.querySelector('#dm-icon-input').value.trim();
        fetchJson('/api/gui-meta/' + encodeURIComponent(tableName), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ icon: icon }),
        }).then(function () {
          return dmRefreshPanel(tableName, false);
        }).then(function () {
          showToast('Icon saved', {});
        }).catch(function (err) { showToast('Icon save failed: ' + err.message, {}); });
      });
      // Add column — scalar data columns only (text/integer/real/boolean).
      // uuid is reserved for keys and relationships ("links") are created via
      // "Add link" below — neither is offered here.
      var newcolBtn = panel.querySelector('#dm-newcol-btn');
      if (newcolBtn) newcolBtn.addEventListener('click', function () {
        var name = panel.querySelector('#dm-newcol-name').value.trim();
        var type = panel.querySelector('#dm-newcol-type').value;
        var secret = !!panel.querySelector('#dm-newcol-secret').checked;
        if (!name) return;
        withBusy(newcolBtn, function () {
          return fetchJson('/api/schema/entities/' + encodeURIComponent(tableName) + '/columns', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: name, type: type }),
          }).then(function () {
            if (!secret) return;
            // Persist the secret flag for the new column.
            return fetchJson(
              '/api/gui-meta/columns/' + encodeURIComponent(tableName) + '/' + encodeURIComponent(name),
              {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ secret: true }),
              },
            );
          }).then(function () {
            return dmRefreshPanel(tableName, false);
          }).then(function () {
            showToast('Column "' + name + '" added', {});
          }).catch(function (err) { showToast('Add column failed: ' + err.message, {}); });
        });
      });
      // Save staged column changes (renames + secret flags) in ONE shot.
      // Column names and secret flags are edited inline and nothing persists
      // until "Save changes". We diff against the originals (data-orig /
      // data-was) and POST only the deltas; the server enforces the real
      // rules (no system rename, scalar types only) so a bad edit 400s loudly.
      var colsSaveBtn = panel.querySelector('#dm-cols-save');
      function colsDirty() {
        var dirty = false;
        panel.querySelectorAll('input.dm-col-name').forEach(function (inp) {
          if (inp.value.trim() !== inp.getAttribute('data-orig')) dirty = true;
        });
        panel.querySelectorAll('input.dm-col-secret').forEach(function (cb) {
          if ((cb.checked ? '1' : '0') !== cb.getAttribute('data-was')) dirty = true;
        });
        return dirty;
      }
      function refreshColsSaveState() { if (colsSaveBtn) colsSaveBtn.disabled = !colsDirty(); }
      panel.querySelectorAll('input.dm-col-name, input.dm-col-secret').forEach(function (el) {
        el.addEventListener('input', refreshColsSaveState);
        el.addEventListener('change', refreshColsSaveState);
      });
      if (colsSaveBtn) colsSaveBtn.addEventListener('click', function () {
        if (colsSaveBtn.disabled) return;
        withBusy(colsSaveBtn, function () {
          var ops = [];
          panel.querySelectorAll('input.dm-col-name').forEach(function (inp) {
            var orig = inp.getAttribute('data-orig');
            var to = inp.value.trim();
            var cb = panel.querySelector('input.dm-col-secret[data-orig="' + orig + '"]');
            var secretChanged = !!cb && (cb.checked ? '1' : '0') !== cb.getAttribute('data-was');
            ops.push({
              orig: orig,
              to: to,
              rename: !!to && to !== orig,
              secretChanged: secretChanged,
              secret: cb ? !!cb.checked : false,
            });
          });
          var chain = Promise.resolve();
          ops.forEach(function (op) {
            chain = chain.then(function () {
              if (!op.rename) return;
              return fetchJson('/api/schema/entities/' + encodeURIComponent(tableName) +
                '/columns/' + encodeURIComponent(op.orig) + '/rename', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ to: op.to }),
              });
            }).then(function () {
              if (!op.secretChanged) return;
              var name = op.rename ? op.to : op.orig;
              return fetchJson('/api/gui-meta/columns/' + encodeURIComponent(tableName) +
                '/' + encodeURIComponent(name), {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ secret: op.secret }),
              });
            });
          });
          return chain.then(function () { return dmRefreshPanel(tableName, false); })
            .then(function () {
              showToast('Column changes saved', {});
            }).catch(function (err) { showToast('Save failed: ' + err.message, {}); });
        });
      });
      // Add link — creates a many-to-many junction between this entity and the
      // chosen one. The relationship is bidirectional: it appears in both
      // editors and is deletable from either side.
      var newlinkBtn = panel.querySelector('#dm-newlink-btn');
      if (newlinkBtn) newlinkBtn.addEventListener('click', function () {
        var target = panel.querySelector('#dm-newlink-target').value;
        if (!target) return;
        withBusy(newlinkBtn, function () {
          return fetchJson('/api/schema/junctions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ left: tableName, right: target }),
          }).then(function () { return dmRefreshPanel(tableName, true); })
            .then(function () {
              showToast('Linked ' + displayFor(tableName).label + ' ↔ ' + displayFor(target).label, {});
            }).catch(function (err) { showToast('Add link failed: ' + err.message, {}); });
        });
      });
      // Delete a link — bidirectional. A many-to-many link drops its junction
      // table (removing it from both sides at once); a legacy 1:N link drops
      // its foreign-key column. Never drops a first-class entity's data. The
      // link list is recomputed here so the index matches the rendered rows.
      var dmLinksNow = collectEntityLinks(tableName);
      panel.querySelectorAll('.dm-link-destroy').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var lk = dmLinksNow[Number(btn.getAttribute('data-link'))];
          if (!lk) return;
          if (!confirm('Delete the link between "' + tableName + '" and "' + lk.other +
            '"? It is removed from both tables. This is irreversible from the GUI.')) return;
          var url = lk.kind === 'junction'
            ? '/api/schema/entities/' + encodeURIComponent(lk.delTable)
            : '/api/schema/entities/' + encodeURIComponent(lk.delTable) +
                '/links/' + encodeURIComponent(lk.delCol);
          withBusy(btn, function () {
            return fetchJson(url, { method: 'DELETE' })
              .then(function () { return dmRefreshPanel(tableName, true); })
              .then(function () {
                showToast('Link to "' + lk.other + '" deleted', {});
              }).catch(function (err) { showToast('Delete link failed: ' + err.message, {}); });
          });
        });
      });
      // Delete the whole table — the single, explicit table-drop path. Gated
      // behind a type-the-name confirmation; the server additionally refuses
      // while another table links to this one (no broken data models).
      var delTable = panel.querySelector('#dm-delete-table');
      if (delTable) delTable.addEventListener('click', function () {
        // The name is shown with text-transform:none so the user types the
        // real case; the match is case-insensitive anyway so the label's
        // uppercase styling can't trip them up.
        var nameTag = '<code style="text-transform:none;font-weight:600">' +
          escapeHtml(tableName) + '</code>';
        var matches = function (v) {
          return (v || '').trim().toLowerCase() === tableName.toLowerCase();
        };
        showModal('Delete table "' + tableName + '"',
          '<p style="margin:0 0 8px">This permanently drops the table ' + nameTag +
            ' and all its rows. This cannot be undone.</p>' +
          '<p style="margin:0 0 12px;font-size:12px;color:var(--text-muted)">' +
            'You can\\'t delete a table while another table links to it — delete those links first ' +
            '(they show in this table\\'s Links section).</p>' +
          '<div class="field"><label>Type ' + nameTag +
            ' to confirm</label><input id="dm-del-confirm" autocomplete="off" ' +
            'autocapitalize="off" autocorrect="off" spellcheck="false" /></div>',
        {
          primaryLabel: 'Delete table',
          primaryClass: 'danger',
          onBody: function (bd) {
            var ok = bd.querySelector('[data-act="ok"]');
            var inp = bd.querySelector('#dm-del-confirm');
            if (ok) ok.disabled = true;
            if (inp) {
              inp.addEventListener('input', function () {
                if (ok) ok.disabled = !matches(inp.value);
              });
              inp.focus();
            }
          },
          onSubmit: function (bd) {
            if (!matches(bd.querySelector('#dm-del-confirm').value)) {
              throw new Error('Name does not match');
            }
            return fetchJson('/api/schema/entities/' + encodeURIComponent(tableName), {
              method: 'DELETE',
            }).then(function () {
              return dmRefreshPanel(null, true);
            }).then(function () {
              showToast('Table "' + tableName + '" deleted', {});
            });
          },
        });
      });
    }

    // ────────────────────────────────────────────────────────────
    // Lattice Teams (Project Config + User Config)
    // ────────────────────────────────────────────────────────────
    /**
     * Minimal modal helper for the teams flows. Returns { close } so
     * callers can dismiss imperatively (used by the invite-token modal
     * after copy). opts.onSubmit may return a Promise — the OK button
     * stays disabled until it resolves, then the modal closes.
     */
    function showModal(title, bodyHtml, opts) {
      opts = opts || {};
      var primaryLabel = opts.primaryLabel || 'Save';
      var primaryClass = opts.primaryClass || 'primary';
      var backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML =
        '<div class="modal">' +
          '<div class="modal-head">' + escapeHtml(title) + '</div>' +
          '<div class="modal-body">' + bodyHtml + '</div>' +
          '<div class="modal-foot">' +
            '<button class="btn" data-act="cancel">Cancel</button>' +
            '<button class="btn ' + primaryClass + '" data-act="ok">' + escapeHtml(primaryLabel) + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(backdrop);
      if (opts.onBody) opts.onBody(backdrop);
      function close() { if (backdrop.parentNode) document.body.removeChild(backdrop); }
      backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
      backdrop.querySelector('[data-act="cancel"]').addEventListener('click', close);
      backdrop.querySelector('[data-act="ok"]').addEventListener('click', function () {
        var btn = backdrop.querySelector('[data-act="ok"]');
        if (btn.disabled) return;
        var label = btn.innerHTML;
        var spin = function () {
          btn.disabled = true;
          btn.classList.add('is-busy');
          btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + label;
        };
        var unspin = function () {
          btn.disabled = false;
          btn.classList.remove('is-busy');
          btn.innerHTML = label;
        };
        try {
          var result = opts.onSubmit ? opts.onSubmit(backdrop) : null;
          if (result && typeof result.then === 'function') {
            spin();
            result.then(function () { close(); }).catch(function (err) {
              unspin();
              showToast('Failed: ' + (err && err.message ? err.message : String(err)));
            });
          } else {
            close();
          }
        } catch (err) {
          showToast('Failed: ' + (err && err.message ? err.message : String(err)));
        }
      });
      return { close: close };
    }

    function refreshSettingsRoute() {
      if (location.hash === '#/settings/project-config') renderProjectConfig(document.getElementById('content'));
      else if (location.hash === '#/settings/user-config') renderUserConfig(document.getElementById('content'));
    }

    // ────────────────────────────────────────────────────────────
    // Three-step Create Database wizard. Used from the header dropdown
    // "+ New database" button and from Lattice Settings → Add new DB.
    // Step 1: name + kind (+ cloud credentials if cloud)
    // Step 2: starter entities (with share-to-cloud checkbox when cloud)
    // Step 3: review + submit
    // ────────────────────────────────────────────────────────────
    function showCreateDatabaseWizard() {
      var wizState = {
        step: 1,
        name: '',
        kind: 'local',
        cloudUrl: '',
        email: '',
        displayName: '',
        entities: [], // { name: string, share: boolean }
      };
      // Prefill identity for the cloud path so the operator doesn't
      // re-type their email + display name on every wizard run.
      fetchJson('/api/userconfig/identity').then(function (id) {
        wizState.email = id.email || '';
        wizState.displayName = id.display_name || '';
        openWizard();
      }).catch(openWizard);

      function openWizard() {
        var backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        backdrop.innerHTML =
          '<div class="modal" style="min-width:560px;max-width:640px">' +
            '<div class="modal-head" id="wiz-head">New workspace — step 1 of 3</div>' +
            '<div class="modal-body" id="wiz-body"></div>' +
            '<div class="modal-foot">' +
              '<button class="btn" data-act="cancel">Cancel</button>' +
              '<button class="btn" data-act="back">Back</button>' +
              '<button class="btn primary" data-act="next">Next</button>' +
            '</div>' +
          '</div>';
        document.body.appendChild(backdrop);
        function close() { if (backdrop.parentNode) document.body.removeChild(backdrop); }
        backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
        backdrop.querySelector('[data-act="cancel"]').addEventListener('click', close);
        backdrop.querySelector('[data-act="back"]').addEventListener('click', goBack);
        backdrop.querySelector('[data-act="next"]').addEventListener('click', goNext);
        render();

        function render() {
          var head = backdrop.querySelector('#wiz-head');
          var body = backdrop.querySelector('#wiz-body');
          var nextBtn = backdrop.querySelector('[data-act="next"]');
          var backBtn = backdrop.querySelector('[data-act="back"]');
          head.textContent = 'New workspace — step ' + wizState.step + ' of 3';
          backBtn.style.display = wizState.step === 1 ? 'none' : '';
          nextBtn.textContent = wizState.step === 3 ? 'Create' : 'Next';
          if (wizState.step === 1) body.innerHTML = renderStep1();
          else if (wizState.step === 2) body.innerHTML = renderStep2();
          else body.innerHTML = renderStep3();
          wireStepHandlers(body);
        }

        function renderStep1() {
          var kind = wizState.kind;
          // Join uses the existing invite-redeem modal (opened on Next), so no
          // name/entities steps — the DB name comes from the team you join.
          var nameField = kind === 'join' ? '' :
            '<div class="field"><label>Workspace name</label>' +
              '<input id="wiz-name" type="text" value="' + escapeHtml(wizState.name) +
              '" placeholder="e.g. my-research, design-system" maxlength="200" />' +
            '</div>';
          var cloudBlock = '';
          if (kind === 'cloud') {
            cloudBlock =
              '<div class="field"><label>Cloud URL</label>' +
                '<input id="wiz-cloud-url" type="text" value="' + escapeHtml(wizState.cloudUrl) +
                '" placeholder="postgres://postgres.&lt;ref&gt;:password@aws-x-region.pooler.supabase.com:5432/postgres" autocapitalize="off" autocorrect="off" spellcheck="false" />' +
                '<p style="font-size:11px;color:var(--text-muted);margin:4px 0 0">Use a session-mode Postgres URL. Supabase users: see the pooler docs for the right host.</p>' +
              '</div>' +
              '<div class="field"><label>Your email</label>' +
                '<input id="wiz-email" type="email" value="' + escapeHtml(wizState.email) + '" autocapitalize="off" />' +
              '</div>' +
              '<div class="field"><label>Your display name</label>' +
                '<input id="wiz-display-name" type="text" value="' + escapeHtml(wizState.displayName) + '" />' +
              '</div>';
          } else if (kind === 'join') {
            cloudBlock = '<p style="font-size:12px;color:var(--text-muted);margin:4px 0 0">Click Next to paste your cloud URL and invite token.</p>';
          }
          return '' +
            nameField +
            '<div class="field"><label>Kind</label>' +
              '<div style="display:flex;gap:16px;margin-top:4px;flex-wrap:wrap">' +
                '<label style="display:flex;align-items:center;gap:6px;font-weight:400;text-transform:none;letter-spacing:0">' +
                  '<input type="radio" name="wiz-kind" value="local"' + (kind === 'local' ? ' checked' : '') + ' /> New local (SQLite)' +
                '</label>' +
                '<label style="display:flex;align-items:center;gap:6px;font-weight:400;text-transform:none;letter-spacing:0">' +
                  '<input type="radio" name="wiz-kind" value="cloud"' + (kind === 'cloud' ? ' checked' : '') + ' /> New cloud (Postgres)' +
                '</label>' +
                '<label style="display:flex;align-items:center;gap:6px;font-weight:400;text-transform:none;letter-spacing:0">' +
                  '<input type="radio" name="wiz-kind" value="join"' + (kind === 'join' ? ' checked' : '') + ' /> Join a team (invite)' +
                '</label>' +
              '</div>' +
              '<p style="font-size:11px;color:var(--text-muted);margin:6px 0 0">' +
                'Local workspaces are single-user SQLite files on your machine. Cloud workspaces are Postgres, can be shared with invited members, and stream realtime updates. Join a team you were invited to with an invite token.' +
              '</p>' +
            '</div>' +
            cloudBlock;
        }

        function renderStep2() {
          var rows = wizState.entities.map(function (e, idx) {
            var shareCol = wizState.kind === 'cloud'
              ? '<td style="text-align:center"><input type="checkbox" data-wiz-share="' + idx + '"' + (e.share ? ' checked' : '') + ' /></td>'
              : '';
            return '<tr>' +
              '<td><input type="text" data-wiz-entity="' + idx + '" value="' + escapeHtml(e.name) + '" placeholder="entity_name" style="width:100%" /></td>' +
              shareCol +
              '<td style="text-align:right"><button class="btn" data-wiz-remove="' + idx + '" style="font-size:11px;padding:2px 8px">Remove</button></td>' +
            '</tr>';
          }).join('');
          var shareHeader = wizState.kind === 'cloud'
            ? '<th style="text-align:center;width:80px">Share with cloud</th>'
            : '';
          return '<p class="lead" style="margin:0 0 10px">Optionally add starter entities. You can skip and add them later.</p>' +
            '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
              '<thead><tr style="text-align:left"><th>Entity name</th>' + shareHeader + '<th style="width:90px"></th></tr></thead>' +
              '<tbody>' + (rows || '<tr><td colspan="3" style="padding:8px;color:var(--text-muted)">No entities yet.</td></tr>') + '</tbody>' +
            '</table>' +
            '<button class="btn" id="wiz-add-entity" style="margin-top:10px">+ Add entity</button>' +
            (wizState.kind === 'cloud'
              ? '<p style="font-size:11px;color:var(--text-muted);margin:10px 0 0">' +
                'Entities with “Share with cloud” checked are visible to everyone on the cloud workspace. Unchecked entities live on the cloud DB but stay scoped to your own row links.' +
                '</p>'
              : '');
        }

        function renderStep3() {
          var entityList = wizState.entities.length === 0
            ? '<em style="color:var(--text-muted)">(none — you can add entities after creating)</em>'
            : '<ul style="margin:4px 0 0 0;padding-left:18px">' +
                wizState.entities.map(function (e) {
                  var tag = wizState.kind === 'cloud'
                    ? (e.share ? ' <span style="font-size:10px;padding:1px 5px;border-radius:6px;background:var(--accent-soft);color:var(--accent)">shared</span>'
                              : ' <span style="font-size:10px;padding:1px 5px;border-radius:6px;background:rgba(255,255,255,0.06);color:var(--text-muted)">local only</span>')
                    : '';
                  return '<li>' + escapeHtml(e.name) + tag + '</li>';
                }).join('') +
              '</ul>';
          var cloudBlock = wizState.kind === 'cloud'
            ? '<div><strong>Cloud URL</strong>: <code>' + escapeHtml(redactUrlCredentials(wizState.cloudUrl)) + '</code></div>' +
              '<div><strong>Email</strong>: ' + escapeHtml(wizState.email) + '</div>'
            : '';
          return '<p class="lead" style="margin:0 0 10px">Review and create.</p>' +
            '<div style="display:grid;grid-template-columns:120px 1fr;gap:6px 12px;font-size:13.5px">' +
              '<div><strong>Name</strong>:</div><div>' + escapeHtml(wizState.name) + '</div>' +
              '<div><strong>Kind</strong>:</div><div>' + (wizState.kind === 'cloud' ? 'Cloud (Postgres)' : 'Local (SQLite)') + '</div>' +
            '</div>' +
            (cloudBlock ? '<div style="margin-top:10px;display:grid;grid-template-columns:120px 1fr;gap:6px 12px;font-size:13.5px">' + cloudBlock + '</div>' : '') +
            '<div style="margin-top:14px"><strong>Entities</strong>: ' + entityList + '</div>';
        }

        function wireStepHandlers(scope) {
          if (wizState.step === 1) {
            var nameInput = scope.querySelector('#wiz-name');
            if (nameInput) nameInput.addEventListener('input', function (e) { wizState.name = e.target.value; });
            scope.querySelectorAll('input[name="wiz-kind"]').forEach(function (radio) {
              radio.addEventListener('change', function () {
                wizState.name = (scope.querySelector('#wiz-name') || {}).value || wizState.name;
                wizState.kind = radio.value;
                render(); // re-render to show/hide cloud fields
              });
            });
            var cu = scope.querySelector('#wiz-cloud-url'); if (cu) cu.addEventListener('input', function (e) { wizState.cloudUrl = e.target.value; });
            var em = scope.querySelector('#wiz-email'); if (em) em.addEventListener('input', function (e) { wizState.email = e.target.value; });
            var dn = scope.querySelector('#wiz-display-name'); if (dn) dn.addEventListener('input', function (e) { wizState.displayName = e.target.value; });
          } else if (wizState.step === 2) {
            scope.querySelector('#wiz-add-entity').addEventListener('click', function () {
              wizState.entities.push({ name: '', share: wizState.kind === 'cloud' });
              render();
            });
            scope.querySelectorAll('input[data-wiz-entity]').forEach(function (input) {
              input.addEventListener('input', function () {
                var idx = parseInt(input.getAttribute('data-wiz-entity') || '0', 10);
                wizState.entities[idx].name = input.value;
              });
            });
            scope.querySelectorAll('input[data-wiz-share]').forEach(function (input) {
              input.addEventListener('change', function () {
                var idx = parseInt(input.getAttribute('data-wiz-share') || '0', 10);
                wizState.entities[idx].share = !!input.checked;
              });
            });
            scope.querySelectorAll('button[data-wiz-remove]').forEach(function (btn) {
              btn.addEventListener('click', function () {
                var idx = parseInt(btn.getAttribute('data-wiz-remove') || '0', 10);
                wizState.entities.splice(idx, 1);
                render();
              });
            });
          }
        }

        function goBack() {
          if (wizState.step > 1) { wizState.step -= 1; render(); }
        }

        function goNext() {
          if (wizState.step === 1) {
            // Join a team: hand off to the invite-redeem modal, which collects
            // the cloud URL + invite token and joins as a member.
            if (wizState.kind === 'join') { close(); showJoinTeamModal('project'); return; }
            if (!wizState.name.trim()) { showToast('Workspace name is required'); return; }
            // The display name is free-form (special characters allowed). The
            // server stores it verbatim and derives a safe directory slug from it
            // (toSafeDirName) — so the only constraint here is a sane length.
            if (wizState.name.trim().length > 200) { showToast('Workspace name must be 200 characters or fewer'); return; }
            if (wizState.kind === 'cloud') {
              if (!/^postgres(ql)?:\\/\\//i.test(wizState.cloudUrl.trim())) { showToast('Cloud URL must start with postgres://'); return; }
              if (!wizState.email.trim()) { showToast('Email is required for cloud workspaces'); return; }
              if (!wizState.displayName.trim()) { showToast('Display name is required for cloud workspaces'); return; }
            }
            wizState.step = 2;
            render();
          } else if (wizState.step === 2) {
            // Validate entity names (if any)
            for (var i = 0; i < wizState.entities.length; i += 1) {
              var nm = wizState.entities[i].name.trim();
              if (!nm) { showToast('Entity name on row ' + (i + 1) + ' is empty'); return; }
              if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(nm)) {
                showToast('Entity name "' + nm + '" is invalid (use a valid identifier).'); return;
              }
            }
            wizState.step = 3;
            render();
          } else {
            submit();
          }
        }

        function submit() {
          var nextBtn = backdrop.querySelector('[data-act="next"]');
          nextBtn.setAttribute('disabled', 'disabled');
          nextBtn.textContent = 'Creating…';
          var promise = wizState.kind === 'local' ? submitLocal() : submitCloud();
          promise.then(function () {
            close();
            return reloadEverything();
          }).then(function () {
            showToast('Workspace "' + wizState.name + '" created', {});
          }).catch(function (err) {
            nextBtn.removeAttribute('disabled');
            nextBtn.textContent = 'Create';
            showToast('Create failed: ' + (err && err.message ? err.message : String(err)));
          });
        }

        function submitLocal() {
          // Create + activate a new local workspace in the registry (the single
          // source of truth). The friendly name is the workspace display name —
          // no separate slug/config-file/rename dance.
          return fetchJson('/api/workspaces/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: wizState.name.trim() }),
          }).then(function () {
            return createStarterEntities(wizState.entities);
          });
        }

        function submitCloud() {
          return fetchJson('/api/teams-gui/connections/register-and-create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              cloud_url: wizState.cloudUrl.trim(),
              email: wizState.email.trim(),
              user_name: wizState.displayName.trim(),
              team_name: wizState.name.trim(),
            }),
          }).then(function (result) {
            var createdTeamId = result && result.team && result.team.id;
            var wsId = result && result.workspace_id;
            // Switch INTO the new cloud workspace so starter entities are
            // created there (not in the previously-active local workspace).
            var switched = wsId
              ? fetchJson('/api/workspaces/switch', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ id: wsId }),
                })
              : Promise.resolve();
            return switched.then(function () {
              return createStarterEntities(wizState.entities, createdTeamId);
            });
          });
        }

        function createStarterEntities(entities, teamId) {
          if (entities.length === 0) return Promise.resolve();
          // Sequential creates — order matters for any FK refs the user
          // adds later, and the volume is small (wizard cap is user-driven).
          return entities.reduce(function (chain, e) {
            return chain.then(function () {
              return fetchJson('/api/schema/entities', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: e.name.trim() }),
              }).then(function () {
                if (wizState.kind === 'cloud' && e.share && teamId) {
                  // Share the new entity with the cloud team. Best-effort:
                  // failure here doesn't roll back the create; the user
                  // can retry from Data Model → Share later.
                  return fetchJson('/api/teams-gui/teams/' + encodeURIComponent(teamId) + '/shared', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ table: e.name.trim() }),
                  }).catch(function () { /* swallow */ });
                }
                return null;
              });
            });
          }, Promise.resolve());
        }
      }
    }

    function showCreateTeamModal() {
      // Prefill identity from ~/.lattice/identity.json so the user only
      // enters per-DB things (cloud URL + DB name) in this modal.
      fetchJson('/api/userconfig/identity').then(function (id) {
        var bodyHtml =
          '<div class="field"><label>Cloud URL</label>' +
            '<input name="cloud_url" placeholder="postgres://postgres.&lt;ref&gt;:password@aws-x-region.pooler.supabase.com:5432/postgres" autocapitalize="off" autocorrect="off" spellcheck="false" />' +
          '</div>' +
          '<div class="field"><label>Your email</label><input name="email" value="' + escapeHtml(id.email || '') + '" autocapitalize="off" /></div>' +
          '<div class="field"><label>Your display name</label><input name="user_name" value="' + escapeHtml(id.display_name || '') + '" /></div>' +
          '<div class="field"><label>Database name</label><input name="team_name" /></div>' +
          '<p style="font-size:12px;color:var(--text-muted);margin:0">' +
          'Registers you on the cloud (bootstrap-only — must be a fresh cloud) and creates the cloud database in one step. ' +
          'Email + display name are pulled from your User Config identity; edit them below to override for this database only.' +
          '</p>';
        showModal('Create cloud database', bodyHtml, {
          primaryLabel: 'Create',
          onSubmit: function (scope) {
            var data = collectFormValues(scope);
            return fetchJson('/api/teams-gui/connections/register-and-create', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(data),
            }).then(function () { refreshSettingsRoute(); });
          },
        });
      });
    }

    function showJoinTeamModal(kind) {
      fetchJson('/api/userconfig/identity').then(function (id) {
        var bodyHtml =
          '<div class="field"><label>Cloud URL</label>' +
            '<input name="cloud_url" placeholder="postgres://postgres.&lt;ref&gt;:password@aws-x-region.pooler.supabase.com:5432/postgres" autocapitalize="off" autocorrect="off" spellcheck="false" />' +
          '</div>' +
          '<div class="field"><label>Invite token</label><textarea name="invite_token" placeholder="latinv_..." autocapitalize="off" autocorrect="off" spellcheck="false"></textarea></div>' +
          // Identity is fixed to the operator's User Settings — readonly so
          // you join as yourself (and the email matches the invite binding).
          '<div class="field"><label>Your email</label><input name="email" value="' + escapeHtml(id.email || '') + '" readonly tabindex="-1" style="opacity:0.7;cursor:not-allowed" /></div>' +
          '<div class="field"><label>Your display name</label><input name="name" value="' + escapeHtml(id.display_name || '') + '" readonly tabindex="-1" style="opacity:0.7;cursor:not-allowed" /></div>' +
          '<p style="font-size:12px;color:var(--text-muted);margin:0">' +
          'Use the same Postgres URL the inviter used (postgres://…). Your email + display name come from User Settings — change them there. The email must match the address the invitation was addressed to.' +
          '</p>';
        showModal('Join workspace', bodyHtml, {
          primaryLabel: 'Join',
          onSubmit: function (scope) {
            var data = collectFormValues(scope);
            return fetchJson('/api/teams-gui/connections/join', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(data),
            }).then(function (res) {
              // Auto-switch to the joined cloud workspace so it shows in the
              // header switcher and becomes active immediately — no manual
              // refresh. The join response carries the new workspace id.
              var wsId = res && res.workspace_id;
              if (!wsId) {
                return reloadEverything().then(function () { refreshSettingsRoute(kind); });
              }
              return fetchJson('/api/workspaces/switch', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: wsId }),
              })
                .then(function () { return reloadEverything(); })
                .then(function () { showToast('Joined "' + (res.team && res.team.name || 'workspace') + '" — switched to it', {}); });
            });
          },
        });
      });
    }

    function renderUserConfig(content) {
      content.innerHTML =
        '<div class="teams-page">' +
          '<h2>User Settings</h2>' +
          '<div id="identity-host"><div class="placeholder" style="padding:18px">Loading identity…</div></div>' +
          '<div id="assistant-host"></div>' +
          '<div id="preferences-host"></div>' +
        '</div>';
      renderIdentityPanel(document.getElementById('identity-host'));
      renderAssistantPanel(document.getElementById('assistant-host'));
      renderPreferencesPanel(document.getElementById('preferences-host'));
      // Databases catalog lives on Lattice Settings; per-database cloud/team
      // config lives on Database Settings. User Settings is identity +
      // preferences only — every config option in exactly one place.
    }


    function renderAssistantPanel(host) {
      fetchJson('/api/assistant/config').then(function (cfg) {
        cfg = cfg || {};
        function rowHtml(idBase, label, has, placeholder) {
          return '<div style="margin-bottom:12px">' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
              '<strong style="font-size:13px">' + label + '</strong>' +
              '<span class="feed-source" style="background:' + (has ? 'var(--accent-soft)' : 'var(--surface-2)') +
                ';color:' + (has ? 'var(--accent)' : 'var(--text-muted)') + '">' + (has ? 'Set' : 'Not set') + '</span>' +
            '</div>' +
            '<div style="display:flex;gap:8px;align-items:center">' +
              // data-1p-ignore / data-lpignore: this is an API-token box, not a
              // login password — tell 1Password/LastPass/Bitwarden to leave it
              // alone so pasting a key doesn't trigger their warning/fill popups.
              '<input id="' + idBase + '-key" type="password" autocomplete="off" data-1p-ignore data-lpignore="true" placeholder="' +
                (has ? '••••••••••••' : placeholder) + '" style="flex:1;background:var(--surface-2)">' +
              '<button id="' + idBase + '-save" class="btn">Save</button>' +
              (has ? '<button id="' + idBase + '-clear" class="btn">Clear</button>' : '') +
            '</div>' +
          '</div>';
        }
        // Only the selected provider's key input is shown (declutter). 'auto'
        // ("Select provider…") shows no key row until a provider is chosen.
        function voiceRowHtml(provider) {
          if (provider === 'openai') {
            return rowHtml('asst-openai', 'OpenAI Whisper key', !!cfg.hasOpenaiKey, 'sk-…');
          }
          if (provider === 'elevenlabs') {
            return rowHtml('asst-elevenlabs', 'ElevenLabs key', !!cfg.hasElevenlabsKey, 'xi-…');
          }
          return '';
        }
        host.innerHTML =
          '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<h3 style="margin:0 0 10px">Assistant</h3>' +
            '<p class="lead" style="margin:0 0 12px;font-size:12px;color:var(--text-muted)">' +
              'Keys are stored encrypted in the <code>secrets</code> table.' +
            '</p>' +
            rowHtml('asst-anthropic', 'Claude API token (chat)', !!cfg.hasAnthropicKey, 'sk-ant-…') +
            (cfg.oauthEnabled
              ? '<div style="margin:0 0 12px;font-size:12px;color:var(--text-muted)">' +
                  'Or <a href="/api/assistant/oauth/start" style="color:var(--accent)">connect your Claude subscription</a>.' +
                '</div>'
              : '') +
            '<div style="margin:6px 0 12px">' +
              '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">' +
                '<strong style="font-size:13px">Inference aggressiveness</strong>' +
                '<span id="asst-aggr-val" style="font-size:12px;color:var(--text-muted)"></span>' +
              '</div>' +
              '<input id="asst-aggr" type="range" min="0" max="1" step="0.05" ' +
                'value="' + (typeof cfg.aggressiveness === 'number' ? cfg.aggressiveness : 0.5) + '" ' +
                'style="width:100%">' +
              '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted)">' +
                '<span>Conservative</span><span>Aggressive</span>' +
              '</div>' +
              '<p class="lead" style="margin:4px 0 0;font-size:12px;color:var(--text-muted)">' +
                'How eagerly the assistant adds, enriches, and links objects (and ' +
                'auto-creates link tables) when you drop in files. Higher extrapolates more.' +
              '</p>' +
            '</div>' +
            '<div style="font-size:11px;color:var(--text-muted);margin:10px 0 8px;text-transform:uppercase;letter-spacing:0.05em">Voice — speech to text</div>' +
            '<div style="margin:6px 0 8px;display:flex;align-items:center;gap:8px">' +
              '<span style="font-size:12px;color:var(--text-muted)">Use for voice:</span>' +
              '<select id="asst-stt" style="background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:12px;padding:3px 6px">' +
                '<option value="auto">Select provider…</option>' +
                '<option value="openai">OpenAI</option>' +
                '<option value="elevenlabs">ElevenLabs</option>' +
              '</select>' +
            '</div>' +
            '<div id="asst-voice-key">' + voiceRowHtml(cfg.sttPreference || 'auto') + '</div>' +
            '<div id="assistant-msg" style="margin-top:4px;font-size:12px;color:var(--text-muted)"></div>' +
          '</div>';
        var msg = host.querySelector('#assistant-msg');
        function wire(idBase, kind) {
          var input = host.querySelector('#' + idBase + '-key');
          var saveBtn = host.querySelector('#' + idBase + '-save');
          if (saveBtn) saveBtn.addEventListener('click', function () {
            var key = (input.value || '').trim();
            if (!key) { msg.textContent = 'Enter a key first.'; return; }
            msg.textContent = 'Saving…';
            fetch('/api/assistant/key', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ kind: kind, key: key }),
            })
              .then(function (r) { if (!r.ok) throw new Error('save failed (' + r.status + ')'); return r.json(); })
              .then(function () { renderAssistantPanel(host); renderComposer(); })
              .catch(function (e) { msg.textContent = 'Failed: ' + e.message; });
          });
          var clearBtn = host.querySelector('#' + idBase + '-clear');
          if (clearBtn) clearBtn.addEventListener('click', function () {
            msg.textContent = 'Clearing…';
            fetch('/api/assistant/key?kind=' + encodeURIComponent(kind), { method: 'DELETE' })
              .then(function (r) { if (!r.ok) throw new Error('clear failed (' + r.status + ')'); return r.json(); })
              .then(function () { renderAssistantPanel(host); renderComposer(); })
              .catch(function (e) { msg.textContent = 'Failed: ' + e.message; });
          });
        }
        wire('asst-anthropic', 'anthropic');
        var sttSel = host.querySelector('#asst-stt');
        var voiceKeyHost = host.querySelector('#asst-voice-key');
        function wireVoiceKey(provider) {
          if (provider === 'openai') wire('asst-openai', 'openai');
          else if (provider === 'elevenlabs') wire('asst-elevenlabs', 'elevenlabs');
        }
        if (sttSel) {
          sttSel.value = cfg.sttPreference || 'auto';
          wireVoiceKey(sttSel.value);
          sttSel.addEventListener('change', function () {
            if (voiceKeyHost) voiceKeyHost.innerHTML = voiceRowHtml(sttSel.value);
            wireVoiceKey(sttSel.value);
            msg.textContent = 'Saving…';
            fetch('/api/assistant/stt-provider', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ provider: sttSel.value }),
            })
              .then(function (r) { if (!r.ok) throw new Error('save failed (' + r.status + ')'); return r.json(); })
              .then(function () { msg.textContent = 'Saved.'; })
              .catch(function (e) { msg.textContent = 'Failed: ' + e.message; });
          });
        }
        var aggr = host.querySelector('#asst-aggr');
        var aggrVal = host.querySelector('#asst-aggr-val');
        function aggrLabel(v) {
          if (v <= 0.25) return 'Conservative (' + v.toFixed(2) + ')';
          if (v >= 0.75) return 'Aggressive (' + v.toFixed(2) + ')';
          return 'Balanced (' + v.toFixed(2) + ')';
        }
        if (aggr) {
          if (aggrVal) aggrVal.textContent = aggrLabel(parseFloat(aggr.value));
          aggr.addEventListener('input', function () {
            if (aggrVal) aggrVal.textContent = aggrLabel(parseFloat(aggr.value));
          });
          aggr.addEventListener('change', function () {
            msg.textContent = 'Saving…';
            fetch('/api/assistant/aggressiveness', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ value: parseFloat(aggr.value) }),
            })
              .then(function (r) { if (!r.ok) throw new Error('save failed (' + r.status + ')'); return r.json(); })
              .then(function () { msg.textContent = 'Saved.'; })
              .catch(function (e) { msg.textContent = 'Failed: ' + e.message; });
          });
        }
      }).catch(function (e) {
        host.innerHTML = '<div class="dbconfig-panel" style="padding:14px;border:1px solid var(--border);border-radius:8px">' +
          '<h3 style="margin:0 0 10px">Assistant</h3><div style="font-size:12px;color:var(--warn)">Could not load: ' +
          escapeHtml(e.message) + '</div></div>';
      });
    }

    function renderPreferencesPanel(host) {
      var prefs = state.preferences || { show_system_tables: false, analytics: true };
      host.innerHTML =
        '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
          '<h3 style="margin:0 0 10px">Preferences</h3>' +
          '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
            '<input type="checkbox" id="pref-analytics"' +
              (prefs.analytics !== false ? ' checked' : '') + '>' +
            '<span>Send anonymous analytics</span>' +
          '</label>' +
          '<p class="lead" style="margin:8px 0 0;font-size:12px;color:var(--text-muted)">' +
            'Anonymous analytics will be shared with Lattice using ' +
            '<a href="https://scarf.sh" target="_blank" rel="noopener">Scarf</a>.' +
          '</p>' +
          '<div id="pref-msg" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div>' +
        '</div>';
      var msg = host.querySelector('#pref-msg');
      function savePref(body, after) {
        msg.textContent = 'Saving…';
        fetch('/api/userconfig/preferences', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (r) { return r.json(); })
          .then(function (next) {
            state.preferences = next;
            if (after) after();
            msg.textContent = 'Saved.';
          })
          .catch(function (e) { msg.textContent = 'Failed: ' + e.message; });
      }
      host.querySelector('#pref-analytics').addEventListener('change', function (e) {
        savePref({ analytics: !!e.target.checked });
      });
    }

    function renderIdentityPanel(host) {
      fetchJson('/api/userconfig/identity').then(function (id) {
        host.innerHTML =
          '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<h3 style="margin:0 0 10px">Identity</h3>' +
            '<p class="lead" style="margin:0 0 10px">Display name + email used when creating or joining cloud workspaces. Saved to ~/.lattice/identity.json and mirrored into the active Lattice.</p>' +
            '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px">' +
              '<div><label class="field-label">Display name</label><input id="id-display-name" type="text" value="' + escapeHtml(id.display_name || '') + '" style="width:100%"></div>' +
              '<div><label class="field-label">Email</label><input id="id-email" type="email" value="' + escapeHtml(id.email || '') + '" style="width:100%"></div>' +
            '</div>' +
            '<div class="team-actions" style="margin-top:10px">' +
              '<button class="btn primary" data-act="id-save">Save</button>' +
            '</div>' +
            '<div id="id-msg" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div>' +
          '</div>';
        host.querySelector('[data-act="id-save"]').addEventListener('click', function () {
          var body = {
            display_name: document.getElementById('id-display-name').value || '',
            email: document.getElementById('id-email').value || '',
          };
          var msg = document.getElementById('id-msg');
          msg.textContent = 'Saving…';
          fetch('/api/userconfig/identity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json(); })
            .then(function () { msg.textContent = 'Saved.'; })
            .catch(function (e) { msg.textContent = 'Failed: ' + e.message; });
        });
      }).catch(function (err) {
        host.innerHTML = '<div class="placeholder">Failed to load identity: ' + escapeHtml(err.message) + '</div>';
      });
    }

    function renderProjectConfig(content) {
      // Legacy entry — Track 4e renames this view to "Database Settings"
      // and adds an editable name header. The new alias is renderDatabaseSettings.
      renderDatabaseSettings(content);
    }

    function renderDatabaseSettings(content) {
      // Frame the page; the name header + Database + Teams panels each
      // populate asynchronously so a slow cloud probe doesn't block.
      // Active database only — name + connection/team config for THIS DB.
      // The all-databases list lives on Lattice Settings; adding/joining
      // databases lives in the add-database flow. Team management (invite
      // token + member list) for the active team cloud renders inline in the
      // Database panel below.
      content.innerHTML =
        '<div class="teams-page">' +
          '<h2>Workspace Settings</h2>' +
          '<div id="db-name-host"><div class="placeholder" style="padding:14px">Loading workspace name…</div></div>' +
          '<div id="dbconfig-host"><div class="placeholder" style="padding:18px">Loading database configuration…</div></div>' +
          '<div id="data-model-host"><div class="placeholder" style="padding:18px">Loading data model…</div></div>' +
          '<div id="db-danger-host"></div>' +
        '</div>';
      renderDatabaseNamePanel(document.getElementById('db-name-host'));
      renderDatabasePanel(document.getElementById('dbconfig-host'));
      renderDataModelInto(document.getElementById('data-model-host'));
      renderDatabaseDangerZone(document.getElementById('db-danger-host'));
    }

    // Confirmation modal for the irreversible delete. Gated on typing the exact
    // database name; the OK button is solid red (destructive) and disabled until
    // the name matches. onDone(result) runs after a successful delete.
    function confirmDeleteDatabase(id, label, onDone) {
      var safeLabel = (label || '').trim() || 'this workspace';
      var body =
        '<p style="margin:0 0 10px">Permanently delete <strong>' + escapeHtml(safeLabel) + '</strong>? ' +
        'This removes it from this lattice and, for a local workspace, deletes the underlying SQLite file. ' +
        'For a cloud workspace only the local connection is forgotten — the remote data is left untouched. ' +
        '<strong style="color:var(--danger)">This cannot be undone.</strong></p>' +
        '<p style="margin:0 0 6px;font-size:12px;color:var(--text-muted)">Type <strong>' + escapeHtml(safeLabel) + '</strong> to confirm:</p>' +
        '<input id="confirm-db-name" type="text" autocomplete="off" style="width:100%" />';
      showModal('Delete workspace', body, {
        primaryLabel: 'Delete workspace',
        primaryClass: 'destructive',
        onBody: function (backdrop) {
          var input = backdrop.querySelector('#confirm-db-name');
          var ok = backdrop.querySelector('[data-act="ok"]');
          ok.disabled = true;
          input.addEventListener('input', function () {
            ok.disabled = (input.value || '').trim() !== safeLabel;
          });
          setTimeout(function () { input.focus(); }, 0);
        },
        onSubmit: function (backdrop) {
          var v = (backdrop.querySelector('#confirm-db-name').value || '').trim();
          if (v !== safeLabel) return Promise.reject(new Error('Type the workspace name exactly to confirm.'));
          return fetch('/api/workspaces/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: id }),
          })
            .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
            .then(function (res) {
              if (!res.d || res.d.error) throw new Error((res.d && res.d.error) || ('HTTP ' + res.status));
              if (onDone) return onDone(res.d);
            });
        },
      });
    }

    function renderDatabaseDangerZone(host) {
      if (!host) return;
      Promise.all([
        fetchJson('/api/workspaces'),
        fetchJson('/api/dbconfig').catch(function () { return {}; }),
      ]).then(function (results) {
        var data = results[0];
        var cfg = results[1] || {};
        var currentId = (data && data.current) || null;
        var workspaces = (data && data.workspaces) || [];
        var current = workspaces.filter(function (w) { return w.id === currentId; })[0] || {};
        var label = current.label || '';
        var id = current.id || '';
        if (!id) { host.innerHTML = ''; return; }

        // After tearing down / leaving the active workspace, switch to another
        // the operator still has and navigate off the (now-gone) page.
        var switchAway = function () {
          var target = workspaces.filter(function (w) { return w.id !== currentId; })[0];
          var p = target
            ? fetchJson('/api/workspaces/switch', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: target.id }),
              }).then(function () { return reloadEverything(); })
            : reloadEverything();
          return p.then(function () { location.hash = '#/'; renderRoute(); });
        };

        if (cfg.state === 'team-cloud-creator') {
          // Owner: disconnect the database from the cloud — kicks all members.
          host.innerHTML =
            '<div class="danger-zone">' +
              '<h3>Danger zone</h3>' +
              '<p style="font-size:12px;color:var(--text-muted);margin:0 0 10px">' +
                'Disconnect this database from the cloud. This dissolves the cloud workspace and <strong>kicks all members</strong>. This cannot be undone.' +
              '</p>' +
              '<button class="btn destructive" id="db-disconnect-btn">Disconnect from cloud</button>' +
            '</div>';
          host.querySelector('#db-disconnect-btn').addEventListener('click', function () {
            if (!confirm('Disconnect "' + (cfg.teamName || label || 'this database') + '" from the cloud? This kicks all members and cannot be undone.')) return;
            var dbtn = host.querySelector('#db-disconnect-btn');
            withBusy(dbtn, function () {
              return fetchJson('/api/teams-gui/teams/' + cfg.teamId, { method: 'DELETE' })
                .then(function () { showToast('Disconnected from cloud', {}); return switchAway(); })
                .catch(function (e) { showToast('Disconnect failed: ' + e.message); });
            });
          });
          return;
        }
        if (cfg.state === 'team-cloud-member') {
          // Member: leave the team. The cloud DB keeps running for others.
          host.innerHTML =
            '<div class="danger-zone">' +
              '<h3>Danger zone</h3>' +
              '<p style="font-size:12px;color:var(--text-muted);margin:0 0 10px">' +
                'Leave this cloud workspace. It keeps running for everyone else; you simply stop being a member.' +
              '</p>' +
              '<button class="btn destructive" id="db-leave-btn">Leave workspace</button>' +
            '</div>';
          host.querySelector('#db-leave-btn').addEventListener('click', function () {
            if (!confirm('Leave "' + (cfg.teamName || label || 'this team') + '"?')) return;
            var lbtn = host.querySelector('#db-leave-btn');
            withBusy(lbtn, function () {
              return fetchJson('/api/teams-gui/teams/' + cfg.teamId + '/members/' + encodeURIComponent(cfg.myUserId), { method: 'DELETE' })
                .then(function () { showToast('Left the workspace', {}); return switchAway(); })
                .catch(function (e) { showToast('Leave failed: ' + e.message); });
            });
          });
          return;
        }
        // Local / non-team cloud workspace: delete it.
        host.innerHTML =
          '<div class="danger-zone">' +
            '<h3>Danger zone</h3>' +
            '<p style="font-size:12px;color:var(--text-muted);margin:0 0 10px">' +
              'Permanently delete this workspace. It is removed from this lattice and, for a local workspace, the underlying SQLite file is deleted. This cannot be undone.' +
            '</p>' +
            '<button class="btn destructive" id="db-delete-btn">Delete workspace</button>' +
          '</div>';
        host.querySelector('#db-delete-btn').addEventListener('click', function () {
          confirmDeleteDatabase(id, label, function () {
            // We just deleted the active workspace; the server switched to a
            // fallback. Re-render the drawer's Workspace-settings tab so it
            // reflects the NEW active workspace — previously this rendered into
            // #content behind the open drawer, leaving the user stuck on the
            // deleted workspace's settings.
            return reloadEverything().then(function () {
              var drawer = document.getElementById('settings-drawer');
              if (drawer && !drawer.hidden) selectDrawerTab('database');
              else closeSettingsDrawer();
            });
          });
        });
      }).catch(function () { host.innerHTML = ''; });
    }

    function renderDatabaseNamePanel(host) {
      // Pull the friendly name from /api/workspaces and the team role from
      // /api/dbconfig (isCreator) so a non-owner member sees the name
      // read-only — renaming a team cloud broadcasts to every member, so
      // only the owner may do it.
      Promise.all([fetchJson('/api/workspaces'), fetchJson('/api/dbconfig').catch(function () { return {}; })])
        .then(function (results) {
        var data = results[0];
        var cfg = results[1] || {};
        var currentId = (data && data.current) || null;
        var current = ((data && data.workspaces) || []).filter(function (w) { return w.id === currentId; })[0] || {};
        var name = current.label || '';
        var isCloud = current.kind === 'cloud';
        var kind = isCloud ? 'Cloud' : 'Local';
        // Members (cloud, non-creator) can't rename. Locals + creators can.
        var canRename = !isCloud || cfg.isCreator === true;
        host.innerHTML =
          '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<h3 style="margin:0 0 10px">Name</h3>' +
            '<div style="display:flex;align-items:center;gap:8px">' +
              '<input id="db-name-input" type="text" value="' + escapeHtml(name) + '" maxlength="200" style="flex:1"' + (canRename ? '' : ' disabled') + ' />' +
              '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:' +
                (isCloud ? 'var(--accent-soft)' : 'rgba(255,255,255,0.06)') +
                ';color:' + (isCloud ? 'var(--accent)' : 'var(--text-muted)') +
                ';text-transform:uppercase;letter-spacing:0.04em">' + kind + '</span>' +
              (canRename ? '<button class="btn primary" id="db-name-save">Save</button>' : '') +
            '</div>' +
            '<p style="font-size:11px;color:var(--text-muted);margin:6px 0 0">' +
              (canRename
                ? ('Friendly workspace name shown in the topbar and the dropdown. ' +
                  (isCloud
                    ? 'For cloud workspaces, the rename is broadcast to every member in realtime.'
                    : 'Saved to the workspace registry (and the config name: key).'))
                : 'Only the workspace owner can rename this cloud workspace.') +
            '</p>' +
            '<div id="db-name-msg" style="margin-top:6px;font-size:12px;color:var(--text-muted)"></div>' +
          '</div>';
        var saveBtn = host.querySelector('#db-name-save');
        if (saveBtn) saveBtn.addEventListener('click', function () {
          var v = (host.querySelector('#db-name-input').value || '').trim();
          var msg = host.querySelector('#db-name-msg');
          if (!v) { msg.textContent = 'Name cannot be empty.'; return; }
          withBusy(saveBtn, function () {
            msg.textContent = 'Saving…';
            return fetch('/api/dbconfig/rename', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: v }),
            })
              .then(function (r) { return r.json(); })
              .then(function (d) {
                if (d.error) { msg.textContent = 'Failed: ' + d.error; return; }
                msg.textContent = 'Saved.';
                // Refresh the topbar switcher so the new name shows.
                return fetchJson('/api/workspaces').then(renderWsSwitcher);
              })
              .catch(function (e) { msg.textContent = 'Failed: ' + e.message; });
          });
        });
      }).catch(function (err) {
        host.innerHTML = '<div class="placeholder">Failed to load workspace name: ' + escapeHtml(err.message) + '</div>';
      });
    }

    function renderLatticeSettings(content) {
      content.innerHTML =
        '<div class="teams-page">' +
          '<h2>Lattice Settings</h2>' +
          '<p class="lead">Every workspace this lattice can switch to. This is the same list as the header dropdown.</p>' +
          '<div id="lattice-dbs-host"><div class="placeholder" style="padding:18px">Loading workspaces…</div></div>' +
        '</div>';
      var host = document.getElementById('lattice-dbs-host');
      // Single source of truth: the workspace registry (same as the header switcher).
      fetchJson('/api/workspaces').then(function (data) {
        var currentId = (data && data.current) || null;
        var workspaces = (data && data.workspaces) || [];
        var rows = workspaces.map(function (w) {
          var isActive = w.id === currentId;
          var kind = w.kind === 'cloud' ? 'Cloud (Postgres)' : 'Local (SQLite)';
          // Rows are click-to-switch; deletion lives in Workspace Settings → Danger Zone.
          return '<tr' + (isActive ? '' : ' class="ws-row" data-switch-id="' + escapeHtml(w.id) + '"') + '>' +
            '<td>' + escapeHtml(w.label) + (isActive ? ' <span class="role-tag">active</span>' : '') + '</td>' +
            '<td>' + kind + '</td>' +
            '<td><code>' + escapeHtml(w.dir || '') + '</code></td>' +
          '</tr>';
        }).join('');
        host.innerHTML =
          '<div class="dbconfig-panel" style="padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
              '<h3 style="margin:0">Workspaces</h3>' +
              '<button class="btn primary" id="action-add-db">+ Add new workspace</button>' +
            '</div>' +
            '<table style="width:100%;border-collapse:collapse">' +
              '<thead><tr style="text-align:left"><th>Name</th><th>Kind</th><th>Location</th></tr></thead>' +
              '<tbody>' + (rows || '<tr><td colspan="3" style="padding:8px;color:var(--text-muted)">No workspaces configured.</td></tr>') + '</tbody>' +
            '</table>' +
          '</div>';
        host.querySelectorAll('tr.ws-row[data-switch-id]').forEach(function (row) {
          row.addEventListener('click', function () {
            var id = row.getAttribute('data-switch-id');
            fetch('/api/workspaces/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id }) })
              .then(function (r) { return r.json(); })
              .then(function () { return reloadEverything(); })
              .then(function () { renderLatticeSettings(document.getElementById('content')); });
          });
        });
        host.querySelector('#action-add-db').addEventListener('click', showCreateDatabaseWizard);
      }).catch(function (err) {
        host.innerHTML = '<div class="placeholder">Failed to load workspaces: ' + escapeHtml(err.message) + '</div>';
      });
    }

    // State-machine Database panel (v1.13+). Renders a different body
    // per info.state: local -> Migrate / Connect-existing wizards;
    // team-cloud-creator/member -> connection details + members. A connected
    // cloud workspace is always a member workspace (created or invited), so
    // there is no in-settings "join via invite" — that lives in the Join
    // Workspace flow only.
    function renderDatabasePanel(host) {
      fetchJson('/api/dbconfig').then(function (info) {
        var badge = renderStateBadge(info);
        var body = renderStateBody(info);
        host.innerHTML =
          '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">' +
              '<h3 style="margin:0">Database connection</h3>' +
              badge +
            '</div>' +
            body +
            '<div id="db-msg" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div>' +
          '</div>';
        wireStateActions(host, info);
      }).catch(function (err) {
        host.innerHTML = '<div class="placeholder">Failed to load database config: ' + escapeHtml(err.message) + '</div>';
      });
    }

    function renderStateBadge(info) {
      var label = '';
      var color = 'var(--text-muted)';
      switch (info.state) {
        case 'local':
          label = 'LOCAL';
          color = 'var(--text-muted)';
          break;
        case 'team-cloud-creator':
          label = '👑 CLOUD · OWNER';
          color = 'var(--accent)';
          break;
        case 'team-cloud-member':
          label = 'CLOUD · MEMBER';
          color = 'var(--accent)';
          break;
        default:
          label = String(info.state || 'UNKNOWN').toUpperCase();
      }
      return '<span style="font-family:JetBrains Mono,monospace;font-size:11px;letter-spacing:0.04em;padding:4px 10px;border-radius:999px;border:1px solid ' + color + ';color:' + color + '">' + escapeHtml(label) + '</span>';
    }

    function renderStateBody(info) {
      if (info.state === 'local') {
        return (
          '<p style="margin:0 0 12px;color:var(--text-muted);font-size:13px">' +
            'SQLite DB: <code>' + escapeHtml(info.dbFile || '(unknown)') + '</code>. ' +
            'Push this workspace to a cloud Postgres to collaborate. ' +
            '(To join a team, create a new workspace and choose “Join a team (invite)”.)' +
          '</p>' +
          '<div class="team-actions">' +
            '<button class="btn primary" data-act="open-migrate">Migrate to cloud →</button>' +
          '</div>'
        );
      }
      if (info.state === 'team-cloud-creator' || info.state === 'team-cloud-member') {
        var isOwner = info.state === 'team-cloud-creator';
        return (
          renderConnectionSummary(info) +
          '<div style="margin-top:10px;font-size:13px">' +
            '<strong>Cloud workspace:</strong> ' + escapeHtml(info.teamName || '(unnamed)') +
            (isOwner ? ' · <span style="color:var(--accent)">you are the owner</span>' : ' · <span style="color:var(--text-muted)">member</span>') +
          '</div>' +
          '<div class="team-actions" style="margin-top:10px">' +
            (isOwner ? '<button class="btn primary" data-act="open-invite">Invite member</button>' : '') +
          '</div>' +
          // Exit actions (Disconnect for the owner / Leave for a member) live
          // in the Danger Zone below — not on a member row.
          '<div id="db-members-host" style="margin-top:12px"><div style="font-size:12px;color:var(--text-muted)">Loading members…</div></div>'
        );
      }
      return '<p style="color:var(--text-muted)">Unknown database state.</p>';
    }

    function renderConnectionSummary(info) {
      var parts = [];
      if (info.label) parts.push('<strong>Label:</strong> <code>' + escapeHtml(info.label) + '</code>');
      if (info.host) parts.push('<strong>Host:</strong> ' + escapeHtml(info.host) + ':' + (info.port || 5432));
      if (info.dbname) parts.push('<strong>DB:</strong> ' + escapeHtml(info.dbname));
      if (info.user) parts.push('<strong>User:</strong> ' + escapeHtml(info.user));
      return '<p style="margin:0;color:var(--text-muted);font-size:13px;line-height:1.7">' + parts.join(' · ') + '</p>';
    }

    function wireStateActions(host, info) {
      var setMsg = function (text, ok) {
        var el = document.getElementById('db-msg');
        if (!el) return;
        el.textContent = text;
        el.style.color = ok ? 'var(--accent)' : 'var(--text-muted)';
      };
      var rerender = function () { renderDatabasePanel(document.getElementById('dbconfig-host')); };

      var migrateBtn = host.querySelector('[data-act="open-migrate"]');
      if (migrateBtn) migrateBtn.addEventListener('click', function () {
        showMigrateToCloudModal(rerender);
      });

      // team_id / my_user_id / isCreator come from /api/dbconfig (info),
      // resolved against the ACTIVE cloud DB — not a local connection row
      // (which doesn't exist when the team cloud itself is active). This
      // is what fixes "No local team connection found" for members + the
      // creator's own invite flow.
      var teamId = info.teamId;
      var myUserId = info.myUserId;
      var isCreator = !!info.isCreator;

      var inviteBtn = host.querySelector('[data-act="open-invite"]');
      if (inviteBtn) inviteBtn.addEventListener('click', function () {
        if (!teamId) { showToast('No team is active.'); return; }
        showInviteByEmailModal(teamId, info);
      });

      // Inline member list for the active team cloud. Marks "you"; your
      // own row carries Leave (member) / Destroy team (creator); other
      // rows carry Kick, shown only to the creator.
      var membersHost = host.querySelector('#db-members-host');
      if (membersHost && teamId && (info.state === 'team-cloud-creator' || info.state === 'team-cloud-member')) {
        Promise.all([
          fetchJson('/api/teams-gui/teams/' + teamId + '/members'),
          // Pending invitees (I). Resilient: an older cloud without the GET
          // invitations route shouldn't blank the whole member list.
          fetchJson('/api/teams-gui/teams/' + teamId + '/invitations').catch(function () { return { invitations: [] }; }),
        ]).then(function (results) {
          var members = (results[0] && results[0].members) || [];
          var invitations = (results[1] && results[1].invitations) || [];
          membersHost.innerHTML = renderMembersList(members, myUserId, isCreator, invitations);
          // Kick another member (creator only).
          membersHost.querySelectorAll('[data-act="kick"]').forEach(function (btn) {
            var row = btn.closest('[data-user-id]');
            var userId = row && row.getAttribute('data-user-id');
            btn.addEventListener('click', function () {
              if (!confirm('Remove this member from the workspace?')) return;
              withBusy(btn, function () {
                return fetchJson('/api/teams-gui/teams/' + teamId + '/members/' + encodeURIComponent(userId), { method: 'DELETE' })
                  .then(function () { rerender(); })
                  .catch(function (e) { setMsg('Kick failed: ' + e.message, false); });
              });
            });
          });
        }).catch(function () { membersHost.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">Members unavailable.</div>'; });
      }

    }

    // ── v1.13 wizards ─────────────────────────────────────────────

    function postgresFormHtml(prefill) {
      prefill = prefill || {};
      // autocapitalize="off" + autocorrect="off" + spellcheck="false" keep
      // mobile / macOS keyboards from "helpfully" capitalizing the first
      // letter of usernames + host fragments. Supabase tenant users
      // (postgres.<ref>) are case-sensitive and silently failed
      // authentication when iOS Safari turned the leading "p" into "P".
      var attrs = ' autocapitalize="off" autocorrect="off" spellcheck="false"';
      return (
        '<div class="grid" style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px">' +
          '<div><label class="field-label">Label</label><input type="text" id="w-label" placeholder="atlas" value="' + escapeHtml(prefill.label || '') + '" style="width:100%"' + attrs + '></div>' +
          '<div><label class="field-label">Host</label><input type="text" id="w-host" placeholder="db.example.com" value="' + escapeHtml(prefill.host || '') + '" style="width:100%"' + attrs + '></div>' +
          '<div><label class="field-label">Port</label><input type="number" id="w-port" placeholder="5432" value="' + escapeHtml(String(prefill.port || 5432)) + '" style="width:100%"></div>' +
          '<div><label class="field-label">Database name</label><input type="text" id="w-dbname" placeholder="app" value="' + escapeHtml(prefill.dbname || '') + '" style="width:100%"' + attrs + '></div>' +
          '<div><label class="field-label">User</label><input type="text" id="w-user" placeholder="lattice_user" value="' + escapeHtml(prefill.user || '') + '" style="width:100%"' + attrs + '></div>' +
          '<div><label class="field-label">Password</label><input type="password" id="w-password" placeholder="••••••••" style="width:100%"' + attrs + '></div>' +
        '</div>'
      );
    }

    function readPostgresWizardForm() {
      // Every text field is trimmed — pasted credentials frequently carry a
      // trailing newline or leading space that breaks URL construction
      // (zero-length identifier errors from the Postgres parser) or SCRAM
      // auth (silent password mismatch). Trim once, here, so every caller
      // benefits.
      var get = function (id) { return (document.getElementById(id).value || '').trim(); };
      return {
        type: 'postgres',
        label: get('w-label'),
        host: get('w-host'),
        port: Number(document.getElementById('w-port').value || 5432),
        dbname: get('w-dbname'),
        user: get('w-user'),
        password: get('w-password'),
      };
    }

    // Detect common Supabase pooler URL mistakes the form gives no hint
    // about. Returns an array of human-readable hints, or [] when the
    // form looks plausible. Conservative — only flags clear patterns.
    function detectSupabasePoolerMistakes(body) {
      var hints = [];
      var host = (body.host || '').toLowerCase();
      if (host.indexOf('pooler.supabase') !== -1) {
        // Pooler requires the tenant-prefixed user form postgres.<ref>.
        if (body.user && body.user.indexOf('.') === -1) {
          hints.push(
            'Supabase pooler hosts require a tenant-prefixed user like ' +
            '<code>postgres.&lt;project-ref&gt;</code>. You entered <code>' +
            escapeHtml(body.user) + '</code> — Supabase will reject SCRAM ' +
            'auth with a misleading "password authentication failed" error.'
          );
        }
        // Session-mode is on 5432; transaction-mode on 6543. latticesql
        // wants session-mode (transactions span multiple statements).
        if (Number(body.port) === 6543) {
          hints.push(
            'Supabase pooler port <code>6543</code> is transaction mode. ' +
            'Lattice needs session mode — use port <code>5432</code> on ' +
            'the same pooler host.'
          );
        }
      } else if (host.indexOf('.supabase.co') !== -1 && host.indexOf('pooler') === -1) {
        // Direct host form uses bare postgres user, not the tenant-
        // prefixed pooler form. Easy to mix up.
        if (body.user && body.user.indexOf('.') !== -1) {
          hints.push(
            'The direct host <code>db.&lt;project-ref&gt;.supabase.co</code> ' +
            'uses a bare <code>postgres</code> user (no tenant prefix). ' +
            'You entered <code>' + escapeHtml(body.user) + '</code> — ' +
            'Supabase will reject SCRAM auth with "password authentication ' +
            'failed".'
          );
        }
      }
      return hints;
    }

    // Probe the cloud and validate Supabase form patterns. Resolves to
    // the probe result on success; rejects with a human-readable error
    // when the form has obvious mistakes or the probe is unreachable.
    // Shared by Migrate + Connect so the credential is never saved
    // without first proving the form values can actually connect.
    function probeBeforeCredentialSave(body, msgEl) {
      var hints = detectSupabasePoolerMistakes(body);
      if (hints.length > 0) {
        // Block submit until the form is fixed. Show the hints inline.
        msgEl.innerHTML =
          '<strong style="color:var(--warn)">Connection looks wrong:</strong>' +
          '<ul style="margin:6px 0 0 18px;padding:0;color:var(--warn)">' +
          hints.map(function (h) { return '<li>' + h + '</li>'; }).join('') +
          '</ul>';
        return Promise.reject(new Error('Fix the issues above and try again.'));
      }
      msgEl.textContent = 'Testing connection…';
      return fetch('/api/dbconfig/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (r) { return r.json(); })
        .then(function (probe) {
          if (!probe.reachable) {
            throw new Error(
              'Cloud unreachable: ' + (probe.error || 'unknown error') +
              '. Double-check host, port, user, and password.'
            );
          }
          return probe;
        });
    }

    function showMigrateToCloudModal(onClose) {
      // List every non-system user-defined table so the operator can
      // opt-OUT of sharing per-table before migrating. Default: every
      // user table is checked. System tables (__lattice_*, _lattice_*)
      // are filtered out — they're always migrated and never "shared"
      // in the team sense.
      var shareableTables = ((state.entities && state.entities.tables) || [])
        .filter(function (t) { return !/^_/.test(t.name) && !isJunction(t); })
        .map(function (t) { return t.name; });
      var shareRows = shareableTables.length === 0
        ? '<p style="margin:0;color:var(--text-muted);font-size:12px">No user-defined tables to share yet.</p>'
        : shareableTables.map(function (t) {
            return '<label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-weight:400;text-transform:none;letter-spacing:0">' +
              '<input type="checkbox" class="mig-share" data-table="' + escapeHtml(t) + '" checked />' +
              '<span style="font-family:ui-monospace,monospace;font-size:12.5px">' + escapeHtml(t) + '</span>' +
            '</label>';
          }).join('');
      var bodyHtml =
        '<p style="margin:0 0 12px;font-size:13px;color:var(--text-muted)">' +
          'Enter credentials for a <strong>fresh, empty</strong> Postgres database. ' +
          'Lattice will copy every row from your local SQLite into the new DB, then ' +
          'rename the SQLite file to <code>.db.local-bak</code> and switch the project ' +
          'to read from the cloud. This action cannot be undone.' +
        '</p>' +
        postgresFormHtml({}) +
        '<div style="margin-top:14px;padding:10px;border:1px solid var(--border);border-radius:6px;background:rgba(255,255,255,0.02)">' +
          '<div style="font-size:12px;color:var(--text);text-transform:uppercase;letter-spacing:0.04em;font-weight:500;margin-bottom:6px">Share with cloud</div>' +
          '<p style="margin:0 0 8px;font-size:12px;color:var(--text-muted)">' +
            'Checked tables become visible to every member you invite. Uncheck any you want to keep ' +
            'cloud-stored but unshared. You can change this later from Data Model.' +
          '</p>' +
          shareRows +
        '</div>' +
        '<div id="w-msg" style="margin-top:10px;font-size:12px;color:var(--text-muted)"></div>';
      showModal('Migrate to cloud', bodyHtml, {
        primaryLabel: 'Migrate →',
        onSubmit: function (scope) {
          var body = readPostgresWizardForm();
          var msg = document.getElementById('w-msg');
          // Snapshot which tables the user wants shared before the
          // migrate runs — we share them after the migrate completes.
          var tablesToShare = [];
          scope.querySelectorAll('input.mig-share').forEach(function (cb) {
            if (cb.checked) tablesToShare.push(cb.getAttribute('data-table'));
          });
          // Validate Supabase URL pattern + probe the cloud before
          // persisting a credential that would just blow up on the next
          // open.
          return probeBeforeCredentialSave(body, msg).then(function (probe) {
            if (probe.teamEnabled) {
              throw new Error(
                'Target is already a cloud workspace' +
                (probe.teamName ? ' (' + probe.teamName + ')' : '') +
                '. Migrate-to-cloud only works against fresh empty targets.'
              );
            }
            msg.textContent = 'Migrating… (this may take a moment for large DBs)';
            return fetch('/api/dbconfig/migrate-to-cloud', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
            })
              .then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
              .then(function (r) {
                if (!r.body.ok) throw new Error(r.body.error || ('HTTP ' + r.status));
                // After the migrate, the active DB has been swapped to
                // the cloud. Share the checked tables — best-effort; a
                // share failure surfaces a toast but doesn't undo the
                // migration. The user can retry from Data Model later.
                if (tablesToShare.length === 0) {
                  if (onClose) onClose();
                  return;
                }
                return shareTablesPostMigrate(tablesToShare).finally(function () {
                  if (onClose) onClose();
                });
              });
          });
        },
      });
    }

    function shareTablesPostMigrate(tables) {
      // After migrate-to-cloud the user has a single team. Look it up
      // and share each requested table. Best-effort: errors surface as
      // toasts, the migrated DB is still good.
      return fetchJson('/api/teams-gui/connections').then(function (data) {
        var conns = (data && data.connections) || [];
        var teamId = conns[0] && conns[0].team_id;
        if (!teamId) return;
        return tables.reduce(function (chain, table) {
          return chain.then(function () {
            return fetchJson('/api/teams-gui/teams/' + encodeURIComponent(teamId) + '/shared', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ table: table }),
            }).catch(function (err) {
              showToast('Share "' + table + '" failed: ' + err.message, {});
            });
          });
        }, Promise.resolve());
      });
    }

    // (Removed in 1.16.3) The standalone upgrade-to-cloud-sharing modal is
    // gone; cloud workspaces initialize their member/share machinery
    // automatically (see TeamsClient.ensureCloudWorkspaceIdentity).

    function renderMembersList(members, myUserId, isCreator, invitations) {
      var rows = members.map(function (m) {
        var label = m.name || m.email || '(unknown)';
        var isSelf = m.user_id === myUserId;
        // Other rows: Kick, but only the creator may remove other members.
        // Your own exit (Disconnect for the owner / Leave for a member) lives
        // in the Danger Zone, not on a member row.
        var btn = '';
        if (!isSelf && isCreator) {
          btn = '<button class="btn danger-btn" data-act="kick">Kick</button>';
        }
        return '<div class="member-row" data-user-id="' + escapeHtml(m.user_id) + '">' +
          '<span>' + escapeHtml(label) +
            (isSelf ? ' <span style="color:var(--accent);font-size:11px">(you)</span>' : '') +
            ' <span style="color:var(--text-muted);font-size:11px">' + escapeHtml(m.email || '') + '</span>' +
            ' <span class="role-tag' + (m.role === 'creator' ? '' : ' role-member') + '">' + m.role + '</span>' +
          '</span>' +
          btn +
        '</div>';
      }).join('');
      // Pending (unredeemed) invitations — shown below active members so the
      // owner can see who's been invited but hasn't joined yet (I).
      var pending = (invitations || []).filter(function (iv) { return iv && iv.invitee_email; });
      var pendingHtml = pending.length
        ? '<h4 style="margin-top:14px">Pending invitations</h4>' +
            pending.map(function (iv) {
              return '<div class="member-row member-row-pending">' +
                '<span style="color:var(--text-muted)">' + escapeHtml(iv.invitee_email) +
                  ' <span class="role-tag' + (iv.expired ? ' role-expired' : ' role-member') + '">' +
                    (iv.expired ? 'expired' : 'invited') +
                  '</span>' +
                '</span>' +
              '</div>';
            }).join('')
        : '';
      return '<div class="members-list"><h4>Members</h4>' + rows + pendingHtml + '</div>';
    }

    function showInviteByEmailModal(teamId, info) {
      // Owner-facing: list the workspace's shareable tables, ALL CHECKED by
      // default, so inviting a member shares those tables with them in one step.
      // Uncheck any you want to keep private. Re-sharing an already-shared table
      // is idempotent, so it's safe to leave them checked.
      var shareable = ((state.entities && state.entities.tables) || [])
        .filter(function (t) { return t.name.charAt(0) !== '_' && !isJunction(t); })
        .map(function (t) { return t.name; });
      var shareRows = shareable.length === 0
        ? '<p style="margin:0;color:var(--text-muted);font-size:12px">No tables to share yet.</p>'
        : shareable.map(function (t) {
            return '<label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-weight:400;text-transform:none;letter-spacing:0">' +
              '<input type="checkbox" class="invite-share" data-table="' + escapeHtml(t) + '" checked />' +
              '<span style="font-family:ui-monospace,monospace;font-size:12.5px">' + escapeHtml(t) + '</span>' +
            '</label>';
          }).join('');
      var bodyHtml =
        '<div class="field"><label>Invitee email</label>' +
        '<input name="invitee_email" type="email" placeholder="bob@example.com" /></div>' +
        '<p style="font-size:12px;color:var(--text-muted);margin:0 0 10px">' +
        'Invitations are bound to this email — only the recipient can redeem.' +
        '</p>' +
        (shareable.length > 0
          ? '<div style="margin-top:4px;padding:10px;border:1px solid var(--border);border-radius:6px;background:rgba(255,255,255,0.02)">' +
              '<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">Share tables with this member</div>' +
              '<p style="margin:0 0 8px;font-size:12px;color:var(--text-muted)">All tables are shared by default — uncheck any you want to keep private.</p>' +
              shareRows +
            '</div>'
          : '');
      showModal('Invite member', bodyHtml, {
        primaryLabel: 'Generate invite',
        onSubmit: function (scope) {
          var data = collectFormValues(scope);
          if (!data.invitee_email) throw new Error('invitee_email is required');
          var tablesToShare = [];
          scope.querySelectorAll('input.invite-share:checked').forEach(function (cb) {
            tablesToShare.push(cb.getAttribute('data-table'));
          });
          return fetchJson('/api/teams-gui/teams/' + teamId + '/invitations', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ invitee_email: data.invitee_email }),
          }).then(function (inv) {
            // Share the checked tables, then show the invite token.
            return shareTablesForTeam(teamId, tablesToShare).then(function () {
              showInviteTokenModal(inv, info);
            });
          });
        },
      });
    }

    /** Share each table with the team sequentially (idempotent; per-table errors toast, don't abort). */
    function shareTablesForTeam(teamId, tables) {
      return (tables || []).reduce(function (chain, table) {
        return chain.then(function () {
          return fetchJson('/api/teams-gui/teams/' + encodeURIComponent(teamId) + '/shared', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ table: table }),
          }).catch(function (err) { showToast('Share "' + table + '" failed: ' + err.message, {}); });
        });
      }, Promise.resolve());
    }

    function showInviteTokenModal(inv, info) {
      info = info || {};
      // The invitee needs the cloud connection string AND the token. Show the
      // URL with the password MASKED — redeem never needs the owner's password
      // (the invitee authenticates with their own credentials).
      var connStr = info.host
        ? 'postgres://' + (info.user || 'user') + ':****@' + info.host + ':' + (info.port || 5432) + '/' + (info.dbname || '')
        : '';
      var connBlock = connStr
        ? '<h4 style="margin:14px 0 4px">Cloud connection</h4>' +
          '<div class="copy-token" id="copy-conn">' + escapeHtml(connStr) + '</div>' +
          '<p style="font-size:12px;color:var(--text-muted);margin:4px 0 0">Share this URL with the invitee (password masked). Click to copy.</p>'
        : '';
      var bodyHtml =
        '<p style="margin-top:0">Share this token with the invitee (one-time use). It expires at <code>' +
        escapeHtml(inv.expires_at || '(no expiry)') + '</code>.</p>' +
        '<div class="copy-token" id="copy-token">' + escapeHtml(inv.raw_token) + '</div>' +
        '<p style="font-size:12px;color:var(--text-muted);margin-bottom:0">Click the token to copy.</p>' +
        connBlock;
      var handle = showModal('Invitation token', bodyHtml, { primaryLabel: 'Done', onSubmit: function () {} });
      var tokenEl = document.getElementById('copy-token');
      if (tokenEl) {
        tokenEl.addEventListener('click', function () {
          navigator.clipboard.writeText(inv.raw_token).then(function () {
            tokenEl.textContent = 'Copied!';
            setTimeout(function () { tokenEl.textContent = inv.raw_token; }, 1200);
          });
        });
      }
      var connEl = document.getElementById('copy-conn');
      if (connEl) {
        connEl.addEventListener('click', function () {
          navigator.clipboard.writeText(connStr).then(function () {
            connEl.textContent = 'Copied!';
            setTimeout(function () { connEl.textContent = connStr; }, 1200);
          });
        });
      }
      // Suppress unused-var on handle
      void handle;
    }


    // ============ AI assistant rail (2.0) ============
    var feedSource = null;
    var FEED_ICONS = {
      insert: '➕', update: '✏️', delete: '🗑',
      link: '🔗', unlink: '⛓', undo: '↶', redo: '↷', schema: '🛠',
    };
    // Schema mutations reach the client in two shapes: the LIVE feed publishes the
    // coarse op:'schema', while the persisted audit log / per-thread replay carry
    // the fine-grained op:'schema.delete_entity' (etc.). Treat both as schema so
    // they collapse + pick the 🛠 icon identically (regression: backfilled schema
    // ops showed '•' and never grouped).
    function isSchemaOp(op) { var o = String(op || ''); return o === 'schema' || o.indexOf('schema.') === 0; }
    function feedIcon(op) { return isSchemaOp(op) ? FEED_ICONS.schema : (FEED_ICONS[op] || '•'); }
    // Ops whose runs collapse into one counted bubble (bulk row work spams N
    // near-identical rows otherwise). Undo/redo stay distinct.
    var GROUPABLE_OPS = { insert: 1, update: 1, delete: 1, link: 1, unlink: 1 };
    var ROW_VERB = { insert: 'Added', update: 'Updated', delete: 'Removed', link: 'Linked', unlink: 'Unlinked' };
    var ROW_PREP = { insert: 'to', update: 'in', delete: 'from', link: 'in', unlink: 'in' };
    // Schema events all arrive as op:'schema'; the specific action lives only in
    // the summary text. Map that text to a stable sub-action so a bulk run of
    // "Deleted table X" collapses into one "Deleted 19 tables" pill. Each entry
    // is [verb, singular, plural].
    var SCHEMA_GROUP = {
      'created-table':  ['Created', 'table', 'tables'],
      'deleted-table':  ['Deleted', 'table', 'tables'],
      'renamed-table':  ['Renamed', 'table', 'tables'],
      'added-column':   ['Added', 'column', 'columns'],
      'renamed-column': ['Renamed', 'column', 'columns'],
      'added-link':     ['Added', 'link', 'links'],
      'deleted-link':   ['Deleted', 'link', 'links'],
      'created-link':   ['Created', 'link table', 'link tables'],
    };
    function schemaAction(summary) {
      var s = String(summary || '');
      if (/^Created link table/.test(s)) return 'created-link';
      if (/^Created table/.test(s)) return 'created-table';
      if (/^Deleted table/.test(s)) return 'deleted-table';
      if (/^Renamed table/.test(s)) return 'renamed-table';
      if (/^Added a column/.test(s)) return 'added-column';
      if (/^Renamed a column/.test(s)) return 'renamed-column';
      if (/^Added a link/.test(s)) return 'added-link';
      if (/^Deleted a link/.test(s)) return 'deleted-link';
      return null; // unknown schema op: keep it ungrouped (stay honest)
    }
    // Group identical-TYPE events into one counted pill regardless of which
    // object they touched, so a bulk run (delete N tables, remove rows across M
    // tables) shows a single bubble instead of overflowing the rail. Keyed by
    // op+source (+schema sub-action); the table is intentionally NOT in the key.
    // A group stays "open" for FEED_GROUP_WINDOW_MS after its last hit; later
    // activity starts a fresh bubble so unrelated edits aren't merged in.
    function feedGroupKey(ev) {
      var src = String(ev.source || '');
      if (isSchemaOp(ev.op)) {
        var a = schemaAction(ev.summary);
        return a ? 'schema|' + a + '|' + src : null;
      }
      return GROUPABLE_OPS[ev.op] ? String(ev.op) + '|' + src : null;
    }
    var feedGroups = {}; // key -> { op, count, tables, tableCount, schemaKey, firstSummary, item, summaryEl, timeEl, last, startMs, endMs, turnId }
    var FEED_GROUP_WINDOW_MS = 15000;
    // Assistant-turn scope for live activity-card grouping + duration. While a
    // turn is active, its same-type events all collapse into one card (no window
    // expiry); the card's timer measures from feedTurnStartMs to the last event.
    var feedTurnId = 0;
    var feedTurnActive = false;
    var feedTurnStartMs = 0;
    function onlyKey(obj) { for (var k in obj) { if (obj.hasOwnProperty(k)) return k; } return ''; }
    function groupedRowSummary(op, count, tables, tableCount) {
      var verb = ROW_VERB[op] || String(op || '');
      var noun = count === 1 ? 'row' : 'rows';
      var where = '';
      if (tableCount > 1) { where = ' across ' + tableCount + ' tables'; }
      else { var only = onlyKey(tables); if (only) where = ' ' + (ROW_PREP[op] || 'in') + ' ' + only; }
      return verb + ' ' + count + ' ' + noun + where;
    }
    function schemaGroupSummary(schemaKey, count, firstSummary) {
      var g = SCHEMA_GROUP[schemaKey];
      if (count <= 1 || !g) return firstSummary || '';
      return g[0] + ' ' + count + ' ' + g[2];
    }
    function groupedSummary(g) {
      return isSchemaOp(g.op)
        ? schemaGroupSummary(g.schemaKey, g.count, g.firstSummary)
        : groupedRowSummary(g.op, g.count, g.tables, g.tableCount);
    }
    // While a chat turn is streaming, its typing bubble (the not-yet-arrived next
    // assistant message) must stay last; tool-driven activity cards belong ABOVE
    // it, not below — otherwise the "typing…" dots land mid-conversation. Returns
    // the .chat-msg to insert before, or null when nothing is streaming.
    function feedTypingAnchor(feedEl) {
      var typing = feedEl.querySelector('.chat-bubble[data-typing="1"]');
      var msg = typing && typing.closest ? typing.closest('.chat-msg') : null;
      return (msg && msg.parentNode === feedEl) ? msg : null;
    }
    // Build one activity card (the shared full-width pill shape). Used by BOTH
    // the live feed and the per-thread replay so they look identical. Returns the
    // element plus the summary/time nodes a group mutates in place.
    function makeFeedCard(ev) {
      var item = document.createElement('div');
      item.className = 'feed-item';
      var icon = document.createElement('div');
      icon.className = 'feed-icon';
      icon.textContent = feedIcon(ev.op);
      var body = document.createElement('div');
      body.className = 'feed-body';
      var summary = document.createElement('div');
      summary.className = 'feed-summary';
      summary.textContent = ev.summary || (String(ev.op || '') + ' ' + String(ev.table || ''));
      var meta = document.createElement('div');
      meta.className = 'feed-meta';
      var src = document.createElement('span');
      src.className = 'feed-source';
      src.textContent = ev.source === 'gui' ? 'you' : String(ev.source || '');
      meta.appendChild(src);
      body.appendChild(summary);
      body.appendChild(meta);
      var time = document.createElement('div');
      time.className = 'feed-time';
      // Duration ("4s" / "4m 2s") is filled in by the caller once the group's
      // start/end span is known — not a relative "ago".
      time.textContent = '';
      item.appendChild(icon);
      item.appendChild(body);
      item.appendChild(time);
      // Row events (insert/update/delete) carry a rowId — make the card a
      // shortcut to that object. Link/unlink and schema events have no single
      // row (rowId is null), so they stay non-clickable.
      if (ev.rowId && ev.table) {
        item.classList.add('feed-clickable');
        item.setAttribute('role', 'button');
        item.setAttribute('tabindex', '0');
        item.title = 'Open this ' + String(ev.table);
        // _rowClickOff is set when the card becomes a group — clicks no-op then.
        var openRow = function () { if (item._rowClickOff) return; openSearchHit(String(ev.table), String(ev.rowId)); };
        item.addEventListener('click', openRow);
        item.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRow(); }
        });
      }
      return { item: item, summaryEl: summary, timeEl: time };
    }
    // Fold another event into an existing group card: bump the count, track the
    // table, refresh the summary, and drop the single-row affordances (a grouped
    // card stands for many rows, so it's a status, not a clickable button).
    // The card timer shows the TASK DURATION (start → finish), not a relative
    // "ago": for a single op it's the time that op took; for a grouped run it's
    // from the first task's start to the last task's finish. startMs is anchored
    // to the assistant turn's start (so a one-event card still shows real time);
    // endMs tracks the latest event in the group.
    function setGroupTime(g) {
      if (g.timeEl) g.timeEl.textContent = formatElapsed(Math.max(0, g.endMs - g.startMs));
    }
    function applyGroupHit(g, ev, endMs) {
      g.count += 1;
      if (ev.table && !g.tables[ev.table]) { g.tables[ev.table] = 1; g.tableCount += 1; }
      if (typeof endMs === 'number' && endMs > g.endMs) g.endMs = endMs;
      g.summaryEl.textContent = groupedSummary(g);
      setGroupTime(g);
      g.item._rowClickOff = true;
      g.item.classList.remove('feed-clickable');
      g.item.removeAttribute('tabindex');
      g.item.removeAttribute('title');
      g.item.setAttribute('role', 'status');
    }
    function newGroup(ev, card, startMs, endMs) {
      var tbls = {}; var tc = 0;
      if (ev.table) { tbls[ev.table] = 1; tc = 1; }
      return {
        op: ev.op, count: 1, tables: tbls, tableCount: tc,
        schemaKey: isSchemaOp(ev.op) ? schemaAction(ev.summary) : null,
        firstSummary: ev.summary || '',
        item: card.item, summaryEl: card.summaryEl, timeEl: card.timeEl,
        startMs: startMs, endMs: endMs,
      };
    }
    function renderFeedItem(ev) {
      var feedEl = document.getElementById('rail-feed');
      if (!feedEl) return;
      var empty = document.getElementById('rail-empty');
      if (empty) empty.remove();
      // Coalesce same-TYPE events into one counted card within a recency window —
      // even across different objects (op+source key, table excluded), so a bulk
      // run collapses to one card ("Removed 49 rows across 9 tables") instead of
      // spamming the rail. Distinct tables touched are tracked so a single-table
      // run still reads "… from <table>".
      var groupKey = feedGroupKey(ev);
      var nowMs = Date.now();
      if (groupKey) {
        var g = feedGroups[groupKey];
        // A group stays open to merge while: (a) we're inside the SAME assistant
        // turn that opened it — no time limit, so a slow bulk run (deleting many
        // tables against a remote DB) stays one card instead of splitting when a
        // 15s window lapses mid-run; or (b) outside a turn (manual edits / another
        // client), within the rolling window. Cross-turn events never merge.
        var open = g && g.item.parentNode === feedEl && (
          feedTurnActive ? (g.turnId === feedTurnId) : ((nowMs - g.last) < FEED_GROUP_WINDOW_MS)
        );
        if (open) {
          applyGroupHit(g, ev, nowMs);
          g.last = nowMs;
          feedEl.scrollTop = feedEl.scrollHeight;
          return;
        }
      }
      var card = makeFeedCard(ev);
      // Keep a streaming chat turn's typing bubble pinned to the bottom: insert
      // this card above it rather than appending below (the dots are the next
      // message, not done yet). No active turn → append as usual.
      var anchor = feedTypingAnchor(feedEl);
      if (anchor) feedEl.insertBefore(card.item, anchor); else feedEl.appendChild(card.item);
      feedEl.scrollTop = feedEl.scrollHeight;
      // Anchor the card's duration to the turn start (so even a single-op card
      // shows how long the task took); fall back to now for non-turn activity.
      var startMs = (feedTurnActive && feedTurnStartMs) ? feedTurnStartMs : nowMs;
      if (groupKey) {
        var grp = newGroup(ev, card, startMs, nowMs);
        grp.turnId = feedTurnId;
        grp.last = nowMs;
        feedGroups[groupKey] = grp;
        setGroupTime(grp);
      } else {
        card.timeEl.textContent = formatElapsed(Math.max(0, nowMs - startMs));
      }
    }
    // Replay a persisted assistant turn's data-change events as collapsed activity
    // cards. Grouping is PER-TURN (self-contained, independent of the live feed's
    // rolling window) so each turn's bulk run shows one card and stays tied to the
    // turn that produced it. Reads aren't persisted as events, so only mutations
    // appear. Appends in order; the caller positions them after the turn's text.
    function renderTurnEventCards(feedEl, events, startedMs) {
      if (!feedEl || !events || !events.length) return;
      var groups = {};
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var evMs = ev.ts ? new Date(ev.ts).getTime() : startedMs;
        if (typeof evMs !== 'number' || isNaN(evMs)) evMs = startedMs;
        var startMs = (typeof startedMs === 'number' && !isNaN(startedMs)) ? startedMs : evMs;
        var key = feedGroupKey(ev);
        if (key && groups[key]) { applyGroupHit(groups[key], ev, evMs); continue; }
        var card = makeFeedCard(ev);
        feedEl.appendChild(card.item);
        if (key) { var g = newGroup(ev, card, startMs, evMs); groups[key] = g; setGroupTime(g); }
        else { card.timeEl.textContent = formatElapsed(Math.max(0, evMs - startMs)); }
      }
    }
    function startFeed() {
      if (feedSource) {
        try { feedSource.close(); } catch (_) { /* ignore */ }
        feedSource = null;
      }
      if (typeof EventSource === 'undefined') return;
      feedSource = new EventSource('/api/feed/stream');
      feedSource.addEventListener('feed', function (ev) {
        var data;
        try { data = JSON.parse(ev.data); } catch (_) { return; /* ignore malformed */ }
        try { renderFeedItem(data); } catch (_) { /* render best-effort */ }
        // Refresh on ANY data mutation, not just schema/new-table events. The
        // local feed bus delivers every insert/update/delete/link even when
        // there's no realtime broker (SQLite/local), so this is what makes the
        // home dashboard counts AND the open entity view live-update without a
        // manual reload (previously only schema ops or brand-new tables did).
        // scheduleRealtimeRefresh is debounced (200ms) so a burst from one
        // ingest still coalesces into a single refetch — and on Postgres/cloud
        // it shares that debounce with the realtime 'change' handler (no double
        // fetch). See Rule 28: /api/entities uses batched counts, not N queries.
        if (data && (data.table || data.op === 'schema')) {
          scheduleRealtimeRefresh();
        }
      });
      // EventSource auto-reconnects on error; no extra handling needed.
    }

    // ────────────────────────────────────────────────────────────
    // Assistant rail resize — drag the left edge, clamp, persist.
    // ────────────────────────────────────────────────────────────
    var RAIL_MIN = 320, RAIL_MAX = 640, RAIL_KEY = 'lattice-rail-width';
    function applyRailWidth(px) {
      var w = Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(px)));
      document.documentElement.style.setProperty('--sidebar-width', w + 'px');
      return w;
    }
    function initRailResize() {
      var saved = parseInt(window.localStorage.getItem(RAIL_KEY) || '', 10);
      if (!isNaN(saved)) applyRailWidth(saved);
      var handle = document.getElementById('rail-resize');
      if (!handle) return;
      handle.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        var startX = e.clientX;
        var rail = document.getElementById('assistant-rail');
        var startW = rail ? rail.getBoundingClientRect().width : 380;
        handle.classList.add('dragging');
        function move(ev) {
          // Rail sits on the right; dragging left (smaller clientX) widens it.
          applyRailWidth(startW - (ev.clientX - startX));
        }
        function up() {
          handle.classList.remove('dragging');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          var cur = parseInt(
            getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'),
            10,
          );
          if (!isNaN(cur)) window.localStorage.setItem(RAIL_KEY, String(cur));
        }
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    }

    // ────────────────────────────────────────────────────────────
    // Assistant chat composer — POST /api/chat, parse SSE, render
    // bubbles + tool pills into the same rail feed (interleaved with
    // activity events). Gated on a configured Claude token.
    // ────────────────────────────────────────────────────────────
    var chatHistory = [];
    var chatBusy = false;
    var COMPOSER_MAX_H = 160; // px — textarea auto-grow ceiling (then it scrolls)
    function railFeedEl() { return document.getElementById('rail-feed'); }
    function railEmptyGone() { var e = document.getElementById('rail-empty'); if (e) e.remove(); }
    var currentThreadId = null;
    var loadThreadSeq = 0; // discards a stale loadThread response when a newer load supersedes it
    function clearChat() {
      chatHistory = [];
      var feedEl = railFeedEl();
      if (!feedEl) return;
      // The rail is conversation-scoped: clearing or switching a conversation
      // drops both its chat bubbles AND its activity cards (each conversation
      // replays its own data-change cards from the persisted per-turn events).
      // Reset the grouping anchors so a freshly loaded thread starts clean.
      var nodes = feedEl.querySelectorAll('.chat-msg, .feed-item');
      for (var i = 0; i < nodes.length; i++) nodes[i].remove();
      feedGroups = {};
      // Restore the empty hint only when the rail is now completely empty.
      if (!feedEl.firstElementChild) {
        feedEl.innerHTML = '<div class="rail-empty" id="rail-empty">No activity yet. Changes you make will appear here.</div>';
      }
    }
    // Drop the activity cards (e.g. when switching to another workspace, whose
    // events are a different set). Resets the grouping anchor too.
    function clearActivityFeed() {
      var feedEl = railFeedEl();
      if (!feedEl) return;
      var items = feedEl.querySelectorAll('.feed-item');
      for (var i = 0; i < items.length; i++) items[i].remove();
      feedGroups = {};
    }
    function newChat() {
      currentThreadId = null;
      clearChat();
      var sel = document.getElementById('rail-threads');
      if (sel) sel.value = '';
    }
    // Populate the conversation dropdown from the ACTIVE workspace's threads
    // (chat_threads lives in the workspace DB, so switching workspaces changes
    // the list). When autoSelect is set and nothing is open yet, load the most
    // recent thread so a page refresh / workspace switch restores the
    // conversation instead of starting blank.
    function refreshThreadList(autoSelect) {
      var sel = document.getElementById('rail-threads'); if (!sel) return Promise.resolve();
      return fetchJson('/api/chat/threads').then(function (d) {
        var threads = (d && d.threads) || [];
        var opts = '<option value="">＋ New conversation</option>';
        threads.forEach(function (t) {
          opts += '<option value="' + escapeHtml(t.id) + '">' + escapeHtml(t.title || 'Chat') + '</option>';
        });
        sel.innerHTML = opts;
        if (autoSelect && !currentThreadId && threads.length > 0) {
          loadThread(threads[0].id); // threads are newest-first
        } else {
          sel.value = currentThreadId || '';
        }
      }).catch(function () { /* ignore */ });
    }
    function loadThread(id) {
      var seq = ++loadThreadSeq;
      fetchJson('/api/chat/threads/' + encodeURIComponent(id) + '/messages').then(function (d) {
        if (seq !== loadThreadSeq) return; // a newer loadThread() superseded this one
        var msgs = (d && d.messages) || [];
        clearChat();
        currentThreadId = id;
        var sel = document.getElementById('rail-threads'); if (sel) sel.value = id;
        msgs.forEach(function (m) {
          if (m.role === 'user') { appendUserBubble(m.text); chatHistory.push({ role: 'user', text: m.text }); }
          else if (m.role === 'assistant') {
            // Rich replay: the saved per-turn structure (text + the data-change
            // activity cards it produced), matching the live stream. Falls back to
            // a plain text bubble for messages saved before turns were persisted.
            if (Array.isArray(m.turns) && m.turns.length > 0) {
              m.turns.forEach(function (t) { appendAssistantTurn(t, m.created_at, m.startedAt); });
            } else { var c = newAssistantBubble(); setBubbleText(c, m.text); }
            chatHistory.push({ role: 'assistant', text: m.text });
          }
        });
      }).catch(function (e) { showToast('Could not load conversation: ' + e.message, {}); });
    }
    function initThreadControls() {
      var sel = document.getElementById('rail-threads');
      var btn = document.getElementById('rail-newchat');
      if (btn) btn.addEventListener('click', newChat);
      if (sel) sel.addEventListener('change', function () { if (sel.value) loadThread(sel.value); else newChat(); });
      refreshThreadList(true); // restore the most recent conversation on load
    }
    function appendUserBubble(text) {
      railEmptyGone();
      var feedEl = railFeedEl(); if (!feedEl) return;
      var msg = document.createElement('div'); msg.className = 'chat-msg user';
      var b = document.createElement('div'); b.className = 'chat-bubble user'; b.textContent = text;
      msg.appendChild(b); feedEl.appendChild(msg); feedEl.scrollTop = feedEl.scrollHeight;
    }
    function newAssistantBubble() {
      railEmptyGone();
      var feedEl = railFeedEl();
      var msg = document.createElement('div'); msg.className = 'chat-msg assistant';
      var b = document.createElement('div'); b.className = 'chat-bubble assistant';
      // Show an animated typing indicator until the first text delta arrives.
      b.innerHTML = '<span class="chat-typing"><i></i><i></i><i></i></span>';
      b.setAttribute('data-typing', '1');
      msg.appendChild(b); feedEl.appendChild(msg); feedEl.scrollTop = feedEl.scrollHeight;
      return { bubble: b, msg: msg };
    }
    /** Set an assistant bubble's text, clearing the typing indicator. */
    // Turn [label](lattice://table/id) object references the assistant emits into
    // clickable pills that open the row (mode-aware, via openSearchHit). The
    // links are pulled out into placeholders BEFORE markdown rendering and the
    // pill HTML is swapped back in AFTER — so it's independent of mdToHtml's own
    // link handling and survives HTML-escaping. Labels/ids are re-escaped.
    function renderAssistantHtml(text) {
      var pills = [];
      // U+0002 sentinel survives mdToHtml's escape + inline passes untouched.
      // Use a unicode-escape string literal for insertion and a REGEX LITERAL for
      // the swap (one escaping level each) — a new RegExp('(\\d+)') here would be
      // double-collapsed by the template literal into a literal "d", silently
      // breaking the swap (the pill rendered as a bare index).
      var pre = String(text == null ? '' : text).replace(
        /\\[([^\\]]+)\\]\\(lattice:\\/\\/([a-zA-Z0-9_]+)\\/([^)\\s]+)\\)/g,
        function (_, label, table, id) {
          pills.push({ label: label, table: table, id: id });
          return '\\u0002' + (pills.length - 1) + '\\u0002';
        }
      );
      var html = mdToHtml(pre);
      return html.replace(/\\u0002([0-9]+)\\u0002/g, function (_, n) {
        var p = pills[Number(n)];
        return '<a class="chip chip-link lattice-ref" data-table="' + escapeHtml(p.table) +
          '" data-id="' + escapeHtml(p.id) + '" title="Open this ' + escapeHtml(p.table) + '">🔗 ' +
          escapeHtml(p.label) + '</a>';
      });
    }
    // One delegated click handler on the rail feed: a lattice-ref pill opens its
    // object through the same mode-aware navigator the activity feed uses.
    var _latticeRefWired = false;
    function ensureLatticeRefHandler() {
      if (_latticeRefWired) return;
      var feedEl = document.getElementById('rail-feed');
      if (!feedEl) return;
      feedEl.addEventListener('click', function (e) {
        var a = e.target && e.target.closest ? e.target.closest('.lattice-ref') : null;
        if (!a) return;
        e.preventDefault();
        openSearchHit(a.getAttribute('data-table'), a.getAttribute('data-id'));
      });
      _latticeRefWired = true;
    }
    function setBubbleText(ctx, text) {
      if (!ctx || !ctx.bubble) return; // bubble may have been finalized/removed
      ctx.bubble.removeAttribute('data-typing');
      // Assistant turns are Markdown; render (input is HTML-escaped inside
      // mdToHtml first, so this is injection-safe) + linkify object references.
      ctx.bubble.innerHTML = renderAssistantHtml(text);
      ensureLatticeRefHandler();
    }
    /**
     * A turn ended still showing the typing indicator (no text streamed) — drop
     * the empty bubble. The turn's data-change activity cards live in the rail
     * feed independently (not inside the message), so they remain.
     */
    function finalizeBubble(ctx) {
      if (!ctx || !ctx.bubble || !ctx.bubble.getAttribute('data-typing')) return;
      if (ctx.msg) ctx.msg.remove();
    }
    /** Replay one persisted assistant turn: its text bubble + the data-change
     *  activity cards it produced (collapsed, per-turn). Reads aren't persisted
     *  as events, so a read-only turn with no text renders nothing. createdAt
     *  stamps the cards' relative time (events carry no ts of their own). */
    function appendAssistantTurn(turn, createdAt, startedAt) {
      var ctx = newAssistantBubble();
      if (turn.text) setBubbleText(ctx, turn.text);
      else finalizeBubble(ctx); // no text → drop the empty typing bubble
      var events = (turn.events || []).map(function (e) {
        return e.ts ? e : { op: e.op, table: e.table, rowId: e.rowId, summary: e.summary, source: e.source || 'ai', ts: createdAt };
      });
      // Task start for the duration timer: the persisted turn-start, else the
      // message time. Per-event ts (above) gives the run's finish.
      var startedMs = new Date(startedAt || createdAt || 0).getTime();
      renderTurnEventCards(railFeedEl(), events, startedMs);
    }
    function parseSse(buffer, onEvent) {
      var sep;
      while ((sep = buffer.indexOf('\\n\\n')) >= 0) {
        var frame = buffer.slice(0, sep); buffer = buffer.slice(sep + 2);
        var line = frame.split('\\n').find(function (l) { return l.indexOf('data:') === 0; });
        if (!line) continue;
        var json = line.slice(5).trim(); if (!json) continue;
        try { onEvent(JSON.parse(json)); } catch (_) { /* drop malformed */ }
      }
      return buffer;
    }
    function sendChat(text) {
      if (chatBusy || !text) return;
      chatBusy = true;
      // Open a fresh turn scope: this turn's activity cards group together (no
      // window expiry) and their timers measure from now.
      feedTurnId += 1;
      feedTurnStartMs = Date.now();
      feedTurnActive = true;
      appendUserBubble(text);
      var historyToSend = chatHistory.slice();
      chatHistory.push({ role: 'user', text: text });
      var input = document.getElementById('chat-input');
      var sendBtn = document.getElementById('chat-send');
      // Clear + collapse the textarea back to one line (reuse its auto-grow so
      // the reset matches the grow logic instead of leaving a bare 'auto').
      if (input) { input.value = ''; if (input._autoGrow) input._autoGrow(); else input.style.height = 'auto'; }
      if (sendBtn) sendBtn.disabled = true;
      var actx = null; var assembled = '';
      fetch('/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, history: historyToSend, threadId: currentThreadId })
      }).then(function (r) {
        if (!r.ok || !r.body) {
          return r.json().then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); });
        }
        var tid = r.headers.get('x-thread-id'); if (tid) currentThreadId = tid;
        var reader = r.body.getReader(); var dec = new TextDecoder(); var buf = '';
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) return;
            buf += dec.decode(res.value, { stream: true });
            buf = parseSse(buf, function (ev) {
              if (ev.type === 'assistant_message_start') { finalizeBubble(actx); actx = newAssistantBubble(); assembled = ''; }
              else if (ev.type === 'text_delta' && actx) { assembled += ev.delta; setBubbleText(actx, assembled); railFeedEl().scrollTop = railFeedEl().scrollHeight; }
              // tool_use / tool_result are no longer painted as inline pills — the
              // assistant's data changes stream in as activity cards over the feed
              // SSE (renderFeedItem), which sit above the typing bubble. Reads emit
              // no card by design (only data changes show).
              else if (ev.type === 'warn') { finalizeBubble(actx); var wb = newAssistantBubble(); setBubbleText(wb, '⚠ ' + ev.message); actx = null; }
              else if (ev.type === 'error') { if (!actx) actx = newAssistantBubble(); setBubbleText(actx, (assembled ? assembled + '\\n' : '') + '⚠ ' + ev.message); }
            });
            return pump();
          });
        }
        return pump();
      }).then(function () {
        finalizeBubble(actx); // drop a trailing empty "typing…" bubble
        if (assembled) chatHistory.push({ role: 'assistant', text: assembled });
        refreshThreadList();
      }).catch(function (e) {
        finalizeBubble(actx);
        var c = newAssistantBubble(); setBubbleText(c, '⚠ ' + e.message);
      }).finally(function () {
        chatBusy = false;
        // Close the turn scope: later activity starts fresh cards (the next turn,
        // or manual edits via the rolling window).
        feedTurnActive = false;
        var sb = document.getElementById('chat-send'); if (sb) sb.disabled = false;
        var inp = document.getElementById('chat-input'); if (inp) inp.focus();
      });
    }
    var recState = 'idle';
    var mediaRecorder = null;
    var audioChunks = [];
    function setMicState(btn, state) {
      recState = state;
      // Mirror the recording lifecycle onto the composer. While recording or
      // transcribing, the textarea is read-only (it shows a status placeholder,
      // not editable text) and the Send button is disabled — you can't send a
      // half-captured voice note. Returning to idle restores both, then the
      // transcript is dropped in (see rec.onstop).
      var inp = document.getElementById('chat-input');
      var snd = document.getElementById('chat-send');
      var busy = state === 'recording' || state === 'transcribing';
      if (inp) {
        if (busy) {
          if (inp._restorePlaceholder == null) {
            inp._restorePlaceholder = inp.getAttribute('placeholder') || '';
          }
          inp.setAttribute('readonly', 'readonly');
          inp.classList.add('recording');
          inp.setAttribute('placeholder', state === 'recording' ? 'Listening…' : 'Transcribing…');
        } else {
          inp.removeAttribute('readonly');
          inp.classList.remove('recording');
          if (inp._restorePlaceholder != null) {
            inp.setAttribute('placeholder', inp._restorePlaceholder);
            inp._restorePlaceholder = null;
          }
        }
      }
      if (snd) snd.disabled = busy;
      if (!btn) return;
      btn.classList.remove('recording', 'transcribing');
      if (state === 'recording') { btn.classList.add('recording'); btn.textContent = '⏹'; btn.title = 'Stop recording'; btn.disabled = false; }
      else if (state === 'transcribing') { btn.classList.add('transcribing'); btn.textContent = '…'; btn.title = 'Transcribing…'; btn.disabled = true; }
      else { btn.textContent = '🎙'; btn.title = 'Record voice'; btn.disabled = false; }
    }
    // Fade + tooltip the mic button when no microphone is available, and make a
    // click a no-op (so it never pops a "Microphone unavailable" dialog). Kept
    // NON-disabled on purpose: browsers suppress the title tooltip on a disabled
    // button, and the ask is a hover tooltip explaining why it's unusable.
    function markMicUnavailable(btn) {
      if (!btn) return;
      btn.classList.add('composer-mic-unavailable');
      btn.title = 'No microphone available';
      btn.setAttribute('aria-disabled', 'true');
    }
    function markMicAvailable(btn) {
      if (!btn) return;
      btn.classList.remove('composer-mic-unavailable');
      btn.title = 'Record voice';
      btn.removeAttribute('aria-disabled');
    }
    // Reflect microphone presence on the button. enumerateDevices lists an
    // audioinput entry whenever mic hardware exists (even before permission is
    // granted), so zero such entries means "no mic" → fade + tooltip.
    function refreshMicAvailability(btn) {
      if (!btn) return;
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        markMicUnavailable(btn); return;
      }
      navigator.mediaDevices.enumerateDevices().then(function (devices) {
        var hasMic = devices.some(function (d) { return d.kind === 'audioinput'; });
        if (hasMic) markMicAvailable(btn); else markMicUnavailable(btn);
      }).catch(function () { /* enumeration blocked — leave as-is */ });
    }
    function startRecording(btn, input) {
      if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
        showToast('Voice recording is not supported in this browser.'); return;
      }
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        var rec = new MediaRecorder(stream);
        audioChunks = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size) audioChunks.push(e.data); };
        rec.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          var blob = new Blob(audioChunks, { type: rec.mimeType || 'audio/webm' });
          setMicState(btn, 'transcribing');
          fetch('/api/assistant/transcribe', { method: 'POST', headers: { 'content-type': blob.type }, body: blob })
            .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
            .then(function (j) {
              if (input && j.text) {
                input.value = (input.value ? input.value + ' ' : '') + j.text;
                input.dispatchEvent(new Event('input'));
                input.focus();
              }
            })
            .catch(function (e) { showToast('Transcription failed: ' + e.message); })
            .finally(function () { setMicState(btn, 'idle'); });
        };
        rec.start();
        mediaRecorder = rec;
        setMicState(btn, 'recording');
      }).catch(function (e) {
        // Degrade gracefully instead of popping an error dialog. A genuinely
        // missing device fades the button + tooltips it; permission/other errors
        // surface as a toast (the device is there, so don't mark it unavailable).
        var name = (e && e.name) || '';
        if (/NotFound|DevicesNotFound|OverConstrained/i.test(name)) {
          markMicUnavailable(btn);
          showToast('No microphone available', {});
        } else if (/NotAllowed|Permission|Security/i.test(name)) {
          showToast('Microphone permission denied — allow it in your browser settings.', {});
        } else {
          showToast('Microphone unavailable: ' + ((e && e.message) || name), {});
        }
      });
    }
    function toggleRecording(btn, input) {
      if (recState === 'recording' && mediaRecorder) { mediaRecorder.stop(); mediaRecorder = null; }
      else if (recState === 'idle') { startRecording(btn, input); }
    }

    // ────────────────────────────────────────────────────────────
    // File ingest — drag a file onto the rail or use the paperclip.
    // Browsers can't expose the local path, so we POST the bytes; the
    // server extracts + summarizes, then discards them (path stays null).
    // ────────────────────────────────────────────────────────────
    // Append a transient "Analyzing <file>…" row to the feed so the user sees
    // the ingest is processing in the background; returns a disposer. The real
    // create/link feed events stream in over SSE as the server materializes them.
    function pendingIngestItem(label) {
      railEmptyGone();
      var feedEl = document.getElementById('rail-feed');
      if (!feedEl) return function () {};
      var item = document.createElement('div');
      item.className = 'feed-item feed-pending';
      item.innerHTML =
        '<div class="feed-icon"><span class="feed-spinner"></span></div>' +
        '<div class="feed-body"><div class="feed-summary">Analyzing ' + escapeHtml(label) + '…</div></div>' +
        '<div class="feed-time">0s</div>';
      // Same bottom-pin rule as renderFeedItem: don't bury a streaming chat
      // turn's typing bubble beneath this card.
      var anchor = feedTypingAnchor(feedEl);
      if (anchor) feedEl.insertBefore(item, anchor); else feedEl.appendChild(item);
      feedEl.scrollTop = feedEl.scrollHeight;
      // Live elapsed-time counter while the upload + server-side extraction run.
      // Previously the time element was left empty (rendered as a stuck "0s")
      // because nothing tracked or updated it. Tick once a second; the cleanup
      // returned below clears the interval (and self-clears if the node is gone).
      var started = Date.now();
      var timeEl = item.querySelector('.feed-time');
      var tick = setInterval(function () {
        if (!item.parentNode || !timeEl) { clearInterval(tick); return; }
        timeEl.textContent = formatElapsed(Date.now() - started);
      }, 1000);
      return function () {
        clearInterval(tick);
        if (item.parentNode) item.parentNode.removeChild(item);
      };
    }
    function uploadFile(file) {
      var done = pendingIngestItem(file.name || 'file');
      return fetch('/api/ingest/upload', {
        method: 'POST',
        // Percent-encode the filename: HTTP header values must be ISO-8859-1,
        // so a Unicode filename (emoji, smart quote, accent, em-dash) would
        // otherwise make fetch() throw "String contains non ISO-8859-1 code
        // point". The server decodeURIComponent()s it back.
        headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name || 'file') },
        body: file,
      })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
        .catch(function (e) { showToast('Ingest failed: ' + e.message, {}); })
        .finally(function () { done(); });
    }
    function uploadFiles(files) {
      if (!files) return;
      for (var i = 0; i < files.length; i++) uploadFile(files[i]);
    }
    // Mobile: tapping the handle expands/collapses the bottom drawer.
    function initRailDrawer() {
      var handle = document.getElementById('rail-handle');
      var rail = document.getElementById('assistant-rail');
      if (handle && rail) handle.addEventListener('click', function () { rail.classList.toggle('expanded'); });
    }
    function initRailDragDrop() {
      var rail = document.getElementById('assistant-rail'); if (!rail) return;
      rail.addEventListener('dragover', function (e) { e.preventDefault(); rail.classList.add('dragging-file'); });
      rail.addEventListener('dragleave', function (e) { if (e.target === rail) rail.classList.remove('dragging-file'); });
      rail.addEventListener('drop', function (e) {
        e.preventDefault();
        rail.classList.remove('dragging-file');
        if (e.dataTransfer && e.dataTransfer.files) uploadFiles(e.dataTransfer.files);
      });
    }

    // Surface a notice when files/secrets aren't bound as native objects — the
    // assistant key storage + ingest need them. Normally they auto-create on
    // open; this only shows in the edge case where a pre-existing plaintext
    // secrets table was skipped (the adopt flow won't silently encrypt it).
    function checkNativeSetup() {
      fetchJson('/api/native-entities').then(function (d) {
        var bound = {};
        ((d && d.bindings) || []).forEach(function (b) { if (b.origin !== 'skipped') bound[b.entity] = true; });
        var missing = ['files', 'secrets'].filter(function (e) { return !bound[e]; });
        if (missing.length === 0) return;
        var feedEl = railFeedEl(); if (!feedEl) return;
        railEmptyGone();
        var card = document.createElement('div');
        card.className = 'feed-item';
        var note = 'Set up native ' + missing.join(' + ') + ' to enable the assistant’s key storage and file ingest.';
        if (missing.indexOf('secrets') >= 0) {
          note += ' A pre-existing plaintext “secrets” table is left untouched — move its rows to an encrypted native secrets store to use it here.';
        }
        card.innerHTML = '<div class="feed-icon">⚠️</div><div class="feed-body"><div class="feed-summary">' +
          escapeHtml(note) + '</div></div>';
        feedEl.insertBefore(card, feedEl.firstChild);
      }).catch(function () { /* ignore */ });
    }

    function renderComposer() {
      var host = document.getElementById('rail-composer'); if (!host) return;
      fetchJson('/api/assistant/config').then(function (cfg) {
        if (cfg && cfg.hasClaudeAuth) {
          var micHtml = cfg.hasVoiceKey
            ? '<button class="composer-mic" id="chat-mic" title="Record voice">🎙</button>'
            : '';
          host.innerHTML =
            '<div class="composer-row">' +
              '<button class="composer-clip" id="chat-clip" title="Attach a file">📎</button>' +
              micHtml +
              '<textarea id="chat-input" rows="1" placeholder="Ask or instruct… (Enter to send)"></textarea>' +
              '<button class="composer-send" id="chat-send">Send</button>' +
            '</div>' +
            '<input type="file" id="chat-file" multiple style="display:none">';
          var input = document.getElementById('chat-input');
          var sendBtn = document.getElementById('chat-send');
          var clipBtn = document.getElementById('chat-clip');
          var fileInput = document.getElementById('chat-file');
          if (clipBtn && fileInput) {
            clipBtn.addEventListener('click', function () { fileInput.click(); });
            fileInput.addEventListener('change', function () { uploadFiles(fileInput.files); fileInput.value = ''; });
          }
          // Grow the textarea to fit its content (wrapped lines included), capped
          // so it never swallows the feed. Recompute on input AND whenever the
          // textarea's width changes (rail resize / mobile drawer) — re-wrapping
          // at a new width changes how many lines the same text needs.
          function autoGrowInput() {
            input.style.height = 'auto';
            input.style.height = Math.min(COMPOSER_MAX_H, input.scrollHeight) + 'px';
          }
          input._autoGrow = autoGrowInput;
          input.addEventListener('input', autoGrowInput);
          if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(function () { autoGrowInput(); }).observe(input);
          }
          autoGrowInput(); // fit the initial height
          input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(input.value.trim()); }
          });
          sendBtn.addEventListener('click', function () { sendChat(input.value.trim()); });
          var micBtn = document.getElementById('chat-mic');
          if (micBtn) {
            micBtn.addEventListener('click', function () {
              // Faded/unavailable mic → clicking is a no-op (no error dialog).
              if (micBtn.classList.contains('composer-mic-unavailable')) return;
              toggleRecording(micBtn, input);
            });
            refreshMicAvailability(micBtn);
          }
        } else {
          host.innerHTML = '<div class="composer-setup">Set a Claude API token in ' +
            '<a href="#/settings/user-config">User Settings → Assistant</a> to chat.</div>';
        }
      }).catch(function () {
        host.innerHTML = '<div class="composer-setup">Assistant unavailable.</div>';
      });
    }

    /** Reload column meta after a secret-flag change. */
    function refreshColumnMeta() {
      return fetchJson('/api/gui-meta/columns').then(function (d) {
        state.columnMeta = d || {};
      });
    }


    init();
  })();
  `;
