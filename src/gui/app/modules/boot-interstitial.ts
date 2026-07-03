// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const bootInterstitialJs = `    // ────────────────────────────────────────────────────────────
    // Realtime / feed / render-progress all arrive over ONE multiplexed
    // WebSocket (/api/stream) — see startEventStream() below. A single
    // connection per tab (instead of three SSE streams) keeps the browser's
    // tiny per-host HTTP connection budget free for data requests, so clicking
    // objects and switching workspaces stay responsive no matter how many tabs
    // are open. 'change' events mark the current view dirty and refetch via
    // afterMutation() (debounced); 'state' events drive the topbar pill.
    // ────────────────────────────────────────────────────────────
    var realtimePending = null;
    // Tables changed during the current debounce window, so scoped cache
    // invalidation drops ONLY those (not the whole cache) when the refresh fires.
    // 'ALL' (sticky) means an unknown/schema change → full wipe.
    var realtimeDirtyTables = null;
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
    // The record the user is currently viewing — the deepest table/id pair in the
    // route (a file/row detail). Returned to the chat as activeContext so "this
    // file"/"this row" resolves to it. null when just browsing a list / dashboard.
    function activeElement() {
      var hash = location.hash || '#/';
      var segs = (typeof fsParse === 'function') ? fsParse(hash) : null;
      if (segs && segs.length >= 2) {
        // segments alternate table,id,table,id… — take the last complete pair.
        var lastId = (segs.length % 2 === 0) ? segs.length - 1 : segs.length - 2;
        if (lastId >= 1) return { table: segs[lastId - 1], id: segs[lastId] };
      }
      var m = /^#\\/objects\\/([^/]+)\\/([^/]+)/.exec(hash);
      if (m) return { table: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]) };
      return null;
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
      // The NOTIFY envelope carries owner_role (the editor's login role) +
      // created_at — NOT owner_user_id / client_ts (which were never emitted, so
      // "last edited by" always showed nothing). #4.2
      lastEditedByPk[leKey(p.table_name, p.pk)] = {
        userId: p.owner_role || null,
        at: p.created_at || '',
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
    // A keyed wrapper so the last-edited refresh can replace the element in place.
    function lastEditedLineEl(table, pk) {
      var inner = lastEditedHtml(table, pk);
      return '<div id="last-edited" data-table="' + escapeHtml(table) + '" data-pk="' +
        escapeHtml(pk) + '">' + inner + '</div>';
    }
`;
