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
                '<button class="src-db-x" data-id="' + escapeHtml(s.id) +
                  '" type="button" title="Disconnect" aria-label="Disconnect">\\u2715</button>' +
                '</div></li>';
            }).join('') + '</ul>';
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
        add.addEventListener('click', openDbConnectModal);
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

    // Connect modal — connection string OR host/user/password. Reuses the shared
    // .modal-backdrop / .modal chrome.
    function openDbConnectModal() {
      var backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      document.body.appendChild(backdrop);
      function close() { if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop); }
      function field(label, id, type, ph) {
        return '<label class="field-label">' + escapeHtml(label) + '</label>' +
          '<input type="' + type + '" id="' + id + '"' + (ph ? ' placeholder="' + escapeHtml(ph) + '"' : '') +
          ' autocapitalize="off" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true" style="width:100%;margin-bottom:8px">';
      }
      backdrop.innerHTML =
        '<div class="modal">' +
          '<div class="modal-head">Connect a database</div>' +
          '<div class="modal-body">' +
            '<p style="margin:0 0 12px;font-size:13px;color:var(--text-muted)">Connect an external Postgres database (AWS RDS, Supabase, or generic Postgres). Its tables are imported as a data source.</p>' +
            field('Connection string', 'db-cs', 'password', 'postgres://user:pass@host:5432/db') +
            '<div style="text-align:center;color:var(--text-muted);font-size:12px;margin:6px 0">— or —</div>' +
            field('Host', 'db-host', 'text', 'db.example.com') +
            field('Port', 'db-port', 'text', '5432') +
            field('User', 'db-user', 'text', '') +
            field('Password', 'db-pass', 'password', '') +
            field('Database', 'db-name', 'text', '') +
            field('Schema (optional)', 'db-schema', 'text', 'public') +
            '<div id="db-msg" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div>' +
          '</div>' +
          '<div class="modal-foot">' +
            '<button class="btn" data-act="cancel">Cancel</button>' +
            '<button class="btn primary" data-act="ok">Connect</button>' +
          '</div>' +
        '</div>';
      backdrop.querySelector('[data-act="cancel"]').addEventListener('click', close);
      var okBtn = backdrop.querySelector('[data-act="ok"]');
      function val(id) { var el = backdrop.querySelector('#' + id); return el ? el.value.trim() : ''; }
      function setMsg(t) { var m = backdrop.querySelector('#db-msg'); if (m) m.textContent = t; }
      okBtn.addEventListener('click', function () {
        var payload = {
          connectionString: val('db-cs'),
          host: val('db-host'), port: val('db-port'), user: val('db-user'),
          password: val('db-pass'), database: val('db-name'), schema: val('db-schema'),
        };
        if (!payload.connectionString && !(payload.host && payload.user && payload.database)) {
          setMsg('Enter a connection string, or host + user + database.');
          return;
        }
        okBtn.disabled = true;
        setMsg('Connecting + importing…');
        fetch('/api/db-sources/connect', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        })
          .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
          .then(function (res) {
            okBtn.disabled = false;
            if (!res.ok) { setMsg('Failed: ' + (res.body.error || 'could not connect')); return; }
            close();
            showToast('Connected ' + (res.body.displayName || 'database') + ' — tables imported.', {});
            refreshAfterDbImport();
          })
          .catch(function (e) { okBtn.disabled = false; setMsg('Failed: ' + (e && e.message ? e.message : e)); });
      });
    }
`;
