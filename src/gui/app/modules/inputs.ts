// Auto-composed segment of the GUI client script (see modules/index.ts). The
// Inputs > Databases section: connect an external Postgres database (AWS RDS,
// Supabase, or generic Postgres) and import its tables. renderInputsDatabases() is
// called from renderSources() so the section refreshes alongside Files/Connectors.
// Must stay INSIDE the client IIFE (uses fetchJson/escapeHtml/showToast +
// refreshEntities/renderSources/renderRoute), inserted right after sourcesJs.
export const inputsJs = `
    function renderInputsDatabases() {
      var host = document.getElementById('src-databases-list');
      if (host) {
        fetchJson('/api/db-sources')
          .then(function (data) {
            var sources = (data && data.sources) || [];
            if (!sources.length) {
              host.innerHTML = '<div class="src-empty">No databases connected.</div>';
              return;
            }
            host.innerHTML = '<ul class="src-tree">' + sources.map(function (s) {
              var color = s.status === 'connected' ? 'var(--accent)'
                : (s.status === 'error' ? 'var(--danger, #c0392b)' : 'var(--text-muted)');
              var tip = (s.tableCount || 0) + (s.tableCount === 1 ? ' table' : ' tables') +
                (s.lastError ? ' \\u00b7 ' + s.lastError : '');
              return '<li class="src-node src-db"><div class="src-row" style="padding-left:14px">' +
                '<span class="src-dot" style="background:' + color + '"></span>' +
                '<span class="src-name" title="' + escapeHtml(tip) + '">' +
                  escapeHtml(s.displayName || 'Database') + '</span>' +
                '<button class="src-db-edit" data-id="' + escapeHtml(s.id) +
                  '" type="button" title="Edit connection" aria-label="Edit connection">\\u270e</button>' +
                '<button class="src-db-x" data-id="' + escapeHtml(s.id) +
                  '" type="button" title="Disconnect" aria-label="Disconnect">\\u2715</button>' +
                '</div></li>';
            }).join('') + '</ul>';
            host.querySelectorAll('.src-db-edit').forEach(function (b) {
              b.addEventListener('click', function (e) {
                e.stopPropagation();
                openDbEditDrawer(b.getAttribute('data-id'));
              });
            });
            host.querySelectorAll('.src-db-x').forEach(function (b) {
              b.addEventListener('click', function (e) {
                e.stopPropagation();
                disconnectDbSource(b.getAttribute('data-id'), b.parentNode);
              });
            });
          })
          .catch(function () { host.innerHTML = '<div class="src-empty">No databases connected.</div>'; });
      }
      wireInputsDatabasesButton();
    }

    function wireInputsDatabasesButton() {
      var add = document.getElementById('src-add-database');
      if (add && !add.__wired) {
        add.__wired = true;
        // Wrap so the click event isn't passed as the (edit) argument.
        add.addEventListener('click', function () { openDbConnectDrawer(); });
      }
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

    function disconnectDbSource(id, rowEl) {
      if (!id) return;
      if (!window.confirm('Disconnect this database? Its imported tables will be removed.')) return;
      if (rowEl) rowEl.style.opacity = '0.5';
      fetch('/api/db-sources/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
        .then(function (res) {
          if (!res.ok) { showToast('Disconnect failed: ' + (res.body.error || 'unknown'), {}); if (rowEl) rowEl.style.opacity = ''; return; }
          showToast('Database disconnected.', {});
          refreshAfterDbImport();
        })
        .catch(function (e) { showToast('Disconnect failed: ' + (e && e.message ? e.message : e), {}); if (rowEl) rowEl.style.opacity = ''; });
    }

    // Connect-a-database — the SAME left side-drawer + form styling as Add a
    // Connector (the connector dialog chrome + .conn-form/.conn-field classes), so
    // the two dialogs look identical. Host/port/user/password/database fields only
    // (no raw connection string) — the connection is read-only by contract.
    var dbDrawerWired = false;
    function closeDbConnectDrawer() {
      var dlg = document.getElementById('db-connect-dialog');
      var back = document.getElementById('db-connect-backdrop');
      if (!dlg || !back) return;
      dlg.classList.remove('open');
      back.classList.remove('open');
      window.setTimeout(function () { dlg.hidden = true; back.hidden = true; }, 220);
    }
    // Load the (non-secret) connection parts for a connected database, then open
    // the drawer in edit mode. The password is never returned by the server, so
    // the field starts blank ("leave blank to keep current").
    function openDbEditDrawer(id) {
      if (!id) return;
      fetchJson('/api/db-sources/' + encodeURIComponent(id) + '/connection')
        .then(function (d) { openDbConnectDrawer({ id: id, prefill: (d && d.connection) || {} }); })
        .catch(function (e) { showToast('Could not load connection: ' + (e && e.message ? e.message : e), {}); });
    }

    // Connect a new database, OR edit an existing one when edit = { id, prefill }
    // is passed. Edit mode reuses the same drawer/form, pre-fills the parts, keeps
    // the password unless retyped, and saves via /<id>/reconnect (same tables).
    function openDbConnectDrawer(edit) {
      var isEdit = !!(edit && edit.id);
      var pf = (edit && edit.prefill) || {};
      var dlg = document.getElementById('db-connect-dialog');
      var back = document.getElementById('db-connect-backdrop');
      var body = document.getElementById('db-connect-body');
      if (!dlg || !back || !body) return;
      function field(label, id, type, ph, value) {
        return '<label class="conn-field">' + escapeHtml(label) +
          '<input type="' + type + '" id="' + id + '"' +
          (value ? ' value="' + escapeHtml(value) + '"' : '') +
          (ph ? ' placeholder="' + escapeHtml(ph) + '"' : '') +
          ' autocapitalize="off" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true"></label>';
      }
      var lead = isEdit
        ? 'Update this database\\u2019s connection details. Leave the password blank to keep the current one \\u2014 ' +
          'the imported tables keep their names and rows re-sync in place.'
        : 'Connect an external Postgres database (AWS RDS, Supabase, or generic Postgres). ' +
          'Its tables are imported as a READ-ONLY data source \\u2014 Lattice never writes to it. ' +
          'Use a read-only database user where possible.';
      body.innerHTML =
        '<div class="conn-lead">' + lead + '</div>' +
        '<div class="conn-card"><div class="conn-form">' +
          field('Host', 'db-host', 'text', 'db.example.com', pf.host) +
          field('Port', 'db-port', 'text', '5432', pf.port) +
          field('User', 'db-user', 'text', '', pf.user) +
          field('Password', 'db-pass', 'password', isEdit ? 'leave blank to keep current' : '') +
          field('Database', 'db-name', 'text', '', pf.database) +
          field('Schema (optional)', 'db-schema', 'text', 'public', pf.schema) +
          '<div id="db-msg" class="conn-msg"></div>' +
          '<div class="conn-form-actions">' +
            '<button class="btn" id="db-cancel">Cancel</button>' +
            '<button class="btn primary" id="db-ok">' + (isEdit ? 'Save' : 'Connect') + '</button>' +
          '</div>' +
        '</div></div>';
      back.hidden = false;
      dlg.hidden = false;
      window.requestAnimationFrame(function () { dlg.classList.add('open'); back.classList.add('open'); });
      if (!dbDrawerWired) {
        dbDrawerWired = true;
        var closeBtn = document.getElementById('db-connect-close');
        if (closeBtn) closeBtn.addEventListener('click', closeDbConnectDrawer);
        back.addEventListener('click', closeDbConnectDrawer);
        document.addEventListener('keydown', function (e) {
          if (e.key !== 'Escape') return;
          var d = document.getElementById('db-connect-dialog');
          if (d && !d.hidden) closeDbConnectDrawer();
        });
      }
      document.getElementById('db-cancel').addEventListener('click', closeDbConnectDrawer);
      var okBtn = document.getElementById('db-ok');
      function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
      function setMsg(t) { var m = document.getElementById('db-msg'); if (m) m.textContent = t; }
      okBtn.addEventListener('click', function () {
        var payload = {
          host: val('db-host'), port: val('db-port'), user: val('db-user'),
          password: val('db-pass'), database: val('db-name'), schema: val('db-schema'),
        };
        if (!(payload.host && payload.user && payload.database)) {
          setMsg('Enter host + user + database.');
          return;
        }
        okBtn.disabled = true;
        setMsg(isEdit ? 'Saving + re-syncing…' : 'Connecting + importing…');
        var url = isEdit
          ? '/api/db-sources/' + encodeURIComponent(edit.id) + '/reconnect'
          : '/api/db-sources/connect';
        fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        })
          .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
          .then(function (res) {
            okBtn.disabled = false;
            if (!res.ok) { setMsg('Failed: ' + (res.body.error || 'could not connect')); return; }
            closeDbConnectDrawer();
            showToast(isEdit
              ? 'Connection updated — tables re-synced.'
              : ('Connected ' + (res.body.displayName || 'database') + ' — tables imported.'), {});
            refreshAfterDbImport();
          })
          .catch(function (e) { okBtn.disabled = false; setMsg('Failed: ' + (e && e.message ? e.message : e)); });
      });
    }
`;
