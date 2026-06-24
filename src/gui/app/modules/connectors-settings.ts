// Auto-composed segment of the GUI client script (see modules/index.ts). Defines
// renderConnectorsPanel(host) — the Settings → Connectors tab: connect external
// sources with your own account credentials (Jira: site URL + email + API token),
// then refresh / disconnect. A thin client over the route-tested /api/connectors
// endpoints; credentials are validated server-side on connect and stored encrypted.
export const connectorsSettingsJs = `
    function renderConnectorsPanel(host) {
      if (!host) return;
      fetchJson('/api/connectors').then(function (data) {
        data = data || {};
        var toolkits = data.toolkits || [];
        var connectors = data.connectors || [];
        function byToolkit(tk) {
          for (var i = 0; i < connectors.length; i++) {
            if (connectors[i].toolkit === tk) return connectors[i];
          }
          return null;
        }
        function header() {
          return '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<h3 style="margin:0 0 10px">Connectors</h3>' +
            '<p class="lead" style="margin:0 0 4px;font-size:12px;color:var(--text-muted)">' +
              'Sync external sources into Lattice as connected data types. Connect with your own ' +
              'account credentials — your API token is validated on connect and stored encrypted ' +
              'on this machine; it never leaves it except to call the source API directly.' +
            '</p>' +
            '<div id="connectors-msg" style="margin-top:6px;font-size:12px;color:var(--text-muted)"></div>' +
          '</div>';
        }
        function statusChip(c) {
          var color = c.status === 'connected' ? 'var(--accent)'
            : (c.status === 'error' ? 'var(--danger, #c0392b)' : 'var(--text-muted)');
          return '<span class="feed-source" style="color:' + color + '">' + escapeHtml(c.status) + '</span>';
        }
        function field(label, id, type, placeholder) {
          return '<label style="display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--text-muted)">' + escapeHtml(label) +
            '<input id="' + id + '" type="' + type + '" autocomplete="off" data-1p-ignore data-lpignore="true" ' +
              'placeholder="' + escapeHtml(placeholder) + '" style="background:var(--surface-2)"></label>';
        }
        function jiraForm() {
          return '<div style="display:flex;flex-direction:column;gap:8px">' +
              field('Site URL', 'jira-site', 'text', 'https://your-domain.atlassian.net') +
              field('Account email', 'jira-email', 'text', 'you@example.com') +
              field('API token', 'jira-token', 'password', 'paste your Atlassian API token…') +
              '<div style="display:flex;align-items:center;gap:10px;margin-top:2px">' +
                '<button class="btn" data-act="connect" data-tk="jira">Connect</button>' +
                '<a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener" ' +
                  'style="font-size:12px;color:var(--text-muted)">Create an API token \\u2197</a>' +
              '</div>' +
            '</div>';
        }
        function toolkitCard(tk) {
          var c = byToolkit(tk);
          var title = tk.charAt(0).toUpperCase() + tk.slice(1);
          var inner;
          if (c) {
            inner = '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
                statusChip(c) +
                (c.lastSyncAt ? '<span style="font-size:12px;color:var(--text-muted)">last synced ' + escapeHtml(c.lastSyncAt) + '</span>' : '') +
                '<button class="btn" data-act="refresh" data-tk="' + escapeHtml(tk) + '">Refresh</button>' +
                '<button class="btn" data-act="disconnect" data-tk="' + escapeHtml(tk) + '">Disconnect</button>' +
              '</div>' +
              (c.lastError ? '<div style="margin-top:6px;font-size:12px;color:var(--danger,#c0392b)">' + escapeHtml(c.lastError) + '</div>' : '');
          } else {
            inner = (tk === 'jira')
              ? jiraForm()
              : '<button class="btn" data-act="connect" data-tk="' + escapeHtml(tk) + '">Connect</button>';
          }
          return '<div class="dbconfig-panel" style="margin-bottom:12px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<h4 style="margin:0 0 8px">' + escapeHtml(title) + '</h4>' + inner + '</div>';
        }
        host.innerHTML = header() + toolkits.map(toolkitCard).join('');
        var msg = host.querySelector('#connectors-msg');
        function setMsg(t) { if (msg) msg.textContent = t; }
        function reload() { renderConnectorsPanel(host); }
        function postJson(url, body) {
          return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
            .then(function (r) { return r.json(); });
        }
        host.querySelectorAll('button[data-act]').forEach(function (b) {
          b.addEventListener('click', function () {
            var act = b.getAttribute('data-act');
            var tk = b.getAttribute('data-tk');
            if (act === 'connect') {
              if (tk === 'jira') {
                var siteEl = host.querySelector('#jira-site');
                var emailEl = host.querySelector('#jira-email');
                var tokenEl = host.querySelector('#jira-token');
                var site = (siteEl && siteEl.value ? siteEl.value : '').trim();
                var email = (emailEl && emailEl.value ? emailEl.value : '').trim();
                var token = (tokenEl && tokenEl.value ? tokenEl.value : '').trim();
                if (!site || !email || !token) { setMsg('Enter the site URL, email, and API token.'); return; }
                setMsg('Validating credentials + syncing…');
                postJson('/api/connectors/jira/connect', { site: site, email: email, token: token })
                  .then(function (d) {
                    if (d.error) { setMsg('Failed: ' + d.error); return; }
                    reload();
                  }).catch(function (e) { setMsg('Failed: ' + e.message); });
              } else {
                setMsg('Connecting…');
                postJson('/api/connectors/' + encodeURIComponent(tk) + '/connect').then(function (d) {
                  if (d.error) { setMsg('Failed: ' + d.error); return; }
                  reload();
                }).catch(function (e) { setMsg('Failed: ' + e.message); });
              }
            } else if (act === 'refresh') {
              setMsg('Refreshing…');
              postJson('/api/connectors/' + encodeURIComponent(tk) + '/refresh').then(function (d) {
                if (d.error) { setMsg('Failed: ' + d.error); return; }
                reload();
              }).catch(function (e) { setMsg('Failed: ' + e.message); });
            } else if (act === 'disconnect') {
              setMsg('Disconnecting…');
              fetch('/api/connectors/' + encodeURIComponent(tk), { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })
                .then(function (r) { return r.json(); })
                .then(function (d) { if (d.error) { setMsg('Failed: ' + d.error); return; } reload(); })
                .catch(function (e) { setMsg('Failed: ' + e.message); });
            }
          });
        });
      }).catch(function (err) {
        if (host) {
          host.innerHTML = '<div class="dbconfig-panel"><div class="context-empty">Failed to load connectors: ' +
            escapeHtml(err && err.message ? err.message : String(err)) + '</div></div>';
        }
      });
    }
`;
