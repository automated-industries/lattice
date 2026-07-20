// Auto-composed segment of the GUI client script (see modules/index.ts). The
// Databases Configure tab: connect external Postgres databases (AWS RDS,
// Supabase, or generic Postgres) and import their tables. Everything is inline
// and full-width in the tab — a professional multi-column table of connected
// databases plus an add/edit form (no left-sliding drawer).
//
// The connected-databases TABLE and the add/edit FORM live in separate mounts on
// purpose: renderInputsDatabases() refreshes only the table and is safe to call
// from renderSources() (which fires on every realtime sidebar tick); the form
// (#db-form-host) is rendered on tab-open and only re-rendered on an explicit
// user action, so a half-typed connection is never wiped by a background
// re-render. Must stay INSIDE the client IIFE (uses fetchJson/escapeHtml/showToast
// + refreshEntities/renderSources/renderRoute).
export const inputsJs = `
    // Which connected database (if any) the inline form is currently EDITING, its
    // pre-filled parts, and a monotonic token so an out-of-order /connection fetch
    // can't make a stale row win over the row the user last clicked.
    var dbEditId = null;
    var dbEditPrefill = {};
    var dbEditSeq = 0;

    // Refresh ONLY the connected-databases table (safe on every realtime tick —
    // never touches the form mount, so typing/editing is preserved).
    function renderInputsDatabases() {
      var host = document.getElementById('src-databases-list');
      if (!host) return;
      fetchJson('/api/db-sources')
        .then(function (data) { renderDatabasesTable(host, (data && data.sources) || []); })
        .catch(function () { renderDatabasesTable(host, []); });
    }

    function dbStatusChip(status) {
      var color = status === 'connected' ? 'var(--accent)'
        : (status === 'error' ? 'var(--danger, #c0392b)' : 'var(--text-muted)');
      return '<span class="db-status"><span class="db-status-dot" style="background:' + color +
        '"></span>' + escapeHtml(status || 'unknown') + '</span>';
    }

    // Compact "when" for the Last synced column: relative for recent, else a date.
    // Returns a PLAIN string (the caller escapes) for every branch.
    function dbWhen(iso) {
      if (!iso) return '—';
      var t = Date.parse(iso);
      if (isNaN(t)) return String(iso);
      var secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
      if (secs < 60) return 'just now';
      if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
      if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
      var d = new Date(t);
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function renderDatabasesTable(host, sources) {
      function rowHtml(s) {
        var tables = (s.tableCount || 0) + ' ' + (s.tableCount === 1 ? 'table' : 'tables');
        var err = s.lastError
          ? '<tr class="db-err-row"><td colspan="7"><div class="conn-err">' + escapeHtml(s.lastError) + '</div></td></tr>'
          : '';
        return '<tr class="db-row">' +
          '<td class="db-name">' + escapeHtml(s.displayName || 'Database') + '</td>' +
          '<td class="db-mono">' + escapeHtml(s.host || '—') + '</td>' +
          '<td class="db-mono">' + escapeHtml(s.database || '—') + '</td>' +
          '<td class="db-num">' + escapeHtml(tables) + '</td>' +
          '<td>' + dbStatusChip(s.status) + '</td>' +
          '<td class="db-muted">' + escapeHtml(dbWhen(s.lastSyncAt)) + '</td>' +
          '<td class="db-actions">' +
            '<button class="btn btn-sm" data-db-act="edit" data-id="' + escapeHtml(s.id) + '">Edit</button>' +
            '<button class="btn btn-sm" data-db-act="disconnect" data-id="' + escapeHtml(s.id) + '">Disconnect</button>' +
          '</td></tr>' + err;
      }
      host.innerHTML = sources.length
        ? '<div class="db-table-wrap"><table class="db-table"><thead><tr>' +
            '<th>Name</th><th>Host</th><th>Database</th><th>Tables</th><th>Status</th>' +
            '<th>Last synced</th><th></th></tr></thead><tbody>' +
            sources.map(rowHtml).join('') + '</tbody></table></div>'
        : '<div class="db-empty">No databases connected yet.</div>';
      host.querySelectorAll('button[data-db-act]').forEach(function (b) {
        b.addEventListener('click', function () {
          var act = b.getAttribute('data-db-act');
          var id = b.getAttribute('data-id');
          if (act === 'disconnect') { disconnectDbSource(id); return; }
          if (act === 'edit') {
            // Optimistically target the clicked row, and stamp a token so a
            // slower /connection response for a PREVIOUSLY-clicked row can't win.
            var seq = ++dbEditSeq;
            dbEditId = id;
            fetchJson('/api/db-sources/' + encodeURIComponent(id) + '/connection')
              .then(function (d) {
                if (seq !== dbEditSeq) return; // a newer edit click supersedes this one
                dbEditPrefill = (d && d.connection) || {};
                renderDbForm();
                var f = document.getElementById('db-host');
                if (f) { f.scrollIntoView({ block: 'nearest' }); f.focus(); }
              })
              .catch(function (e) {
                showToast('Could not load connection: ' + (e && e.message ? e.message : e), {});
              });
          }
        });
      });
    }

    // The inline add/edit form, rendered into its OWN mount (#db-form-host) so a
    // realtime table refresh never clobbers in-progress input. In edit mode it
    // pre-fills the row's (non-secret) connection parts, keeps the password unless
    // retyped, saves via /<id>/reconnect (same tables re-sync in place), and
    // offers Cancel to return to add mode.
    function renderDbForm() {
      var mount = document.getElementById('db-form-host');
      if (!mount) return;
      var isEdit = !!dbEditId;
      var pf = dbEditPrefill || {};
      function field(label, id, type, ph, value) {
        return '<label class="conn-field">' + escapeHtml(label) +
          '<input type="' + type + '" id="' + id + '"' +
          (value ? ' value="' + escapeHtml(value) + '"' : '') +
          (ph ? ' placeholder="' + escapeHtml(ph) + '"' : '') +
          ' autocapitalize="off" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true"></label>';
      }
      mount.innerHTML =
        '<div class="conn-card db-form-card"><div class="conn-card-head"><span class="conn-card-title">' +
          (isEdit ? 'Edit database connection' : 'Add a database') + '</span></div>' +
        '<div class="conn-form db-form-grid">' +
          field('Host', 'db-host', 'text', 'db.example.com', pf.host) +
          field('Port', 'db-port', 'text', '5432', pf.port) +
          field('User', 'db-user', 'text', '', pf.user) +
          field('Password', 'db-pass', 'password', isEdit ? 'leave blank to keep current' : '') +
          field('Database', 'db-name', 'text', '', pf.database) +
          field('Schema (optional)', 'db-schema', 'text', 'public', pf.schema) +
        '</div>' +
        '<div id="db-msg" class="conn-msg"></div>' +
        '<div class="conn-form-actions">' +
          (isEdit ? '<button class="btn" id="db-cancel">Cancel</button>' : '') +
          '<button class="btn primary" id="db-ok">' + (isEdit ? 'Save' : 'Connect') + '</button>' +
        '</div></div>';
      function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
      function setMsg(t) { var m = document.getElementById('db-msg'); if (m) m.textContent = t; }
      function resetToAdd() { dbEditId = null; dbEditPrefill = {}; ++dbEditSeq; renderDbForm(); }
      var cancel = document.getElementById('db-cancel');
      if (cancel) cancel.addEventListener('click', resetToAdd);
      var okBtn = document.getElementById('db-ok');
      okBtn.addEventListener('click', function () {
        var payload = {
          host: val('db-host'), port: val('db-port'), user: val('db-user'),
          password: val('db-pass'), database: val('db-name'), schema: val('db-schema'),
        };
        if (!(payload.host && payload.user && payload.database)) {
          setMsg('Enter host + user + database.');
          return;
        }
        var editing = isEdit; // capture — dbEditId may be reset before the response
        okBtn.disabled = true;
        setMsg(editing ? 'Saving + re-syncing…' : 'Connecting + importing…');
        var url = editing
          ? '/api/db-sources/' + encodeURIComponent(dbEditId) + '/reconnect'
          : '/api/db-sources/connect';
        fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        })
          .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
          .then(function (res) {
            okBtn.disabled = false;
            if (!res.ok) { setMsg('Failed: ' + (res.body.error || 'could not connect')); return; }
            showToast(editing
              ? 'Connection updated — tables re-synced.'
              : ('Connected ' + (res.body.displayName || 'database') + ' — tables imported.'), {});
            resetToAdd(); // clear the form (edit → add, or a fresh add)
            refreshAfterDbImport();
          })
          .catch(function (e) { okBtn.disabled = false; setMsg('Failed: ' + (e && e.message ? e.message : e)); });
      });
    }

    // Render both halves when the Databases tab opens (called by renderDatabasesTab).
    function renderDatabasesPanel() {
      dbEditId = null;
      dbEditPrefill = {};
      ++dbEditSeq;
      renderInputsDatabases();
      renderDbForm();
    }

    // After an import, refresh the entities + the dependent views so the new
    // SOURCE tables appear in the graph / Model Tables / Outputs mirror.
    function refreshAfterDbImport() {
      var done = function () {
        renderSources();
        if (typeof renderRoute === 'function') renderRoute({ soft: true });
      };
      if (typeof refreshEntities === 'function') refreshEntities().then(done).catch(done);
      else done();
    }

    function disconnectDbSource(id) {
      if (!id) return;
      if (!window.confirm('Disconnect this database? Its imported tables will be removed.')) return;
      fetch('/api/db-sources/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
        .then(function (res) {
          if (!res.ok) { showToast('Disconnect failed: ' + (res.body.error || 'unknown'), {}); return; }
          showToast('Database disconnected.', {});
          // If the row being edited was just removed, drop back to add mode.
          if (dbEditId === id) { dbEditId = null; dbEditPrefill = {}; ++dbEditSeq; renderDbForm(); }
          refreshAfterDbImport();
        })
        .catch(function (e) { showToast('Disconnect failed: ' + (e && e.message ? e.message : e), {}); });
    }
`;
