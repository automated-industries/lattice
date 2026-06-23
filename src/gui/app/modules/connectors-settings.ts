// Auto-composed segment of the GUI client script (see modules/index.ts). Defines
// renderConnectorsPanel(host) — the Settings → Connectors tab: set the Composio
// API key, then connect / refresh / disconnect external sources (Jira, …). It is
// a thin client over the route-tested /api/connectors endpoints.
export const connectorsSettingsJs = `
    function renderConnectorsPanel(host) {
      if (!host) return;
      fetchJson('/api/connectors').then(function (data) {
        data = data || {};
        var apiKeySet = !!data.apiKeySet;
        var toolkits = data.toolkits || [];
        var connectors = data.connectors || [];
        function byToolkit(tk) {
          for (var i = 0; i < connectors.length; i++) {
            if (connectors[i].toolkit === tk) return connectors[i];
          }
          return null;
        }
        function keyPanel() {
          return '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<h3 style="margin:0 0 10px">Connectors</h3>' +
            '<p class="lead" style="margin:0 0 12px;font-size:12px;color:var(--text-muted)">' +
              'Sync external sources into Lattice as connected data types. Requires a Composio API key.' +
            '</p>' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
              '<strong style="font-size:13px">Composio API key</strong>' +
              '<span class="feed-source" style="background:' + (apiKeySet ? 'var(--accent-soft)' : 'var(--surface-2)') +
                ';color:' + (apiKeySet ? 'var(--accent)' : 'var(--text-muted)') + '">' + (apiKeySet ? 'Set' : 'Not set') + '</span>' +
            '</div>' +
            '<div style="display:flex;gap:8px;align-items:center">' +
              '<input id="composio-key" type="password" autocomplete="off" data-1p-ignore data-lpignore="true" placeholder="' +
                (apiKeySet ? '••••••••••••' : 'paste Composio API key…') + '" style="flex:1;background:var(--surface-2)">' +
              '<button id="composio-key-save" class="btn">Save</button>' +
              (apiKeySet ? '<button id="composio-key-clear" class="btn">Clear</button>' : '') +
            '</div>' +
            '<div id="connectors-msg" style="margin-top:6px;font-size:12px;color:var(--text-muted)"></div>' +
          '</div>';
        }
        function statusChip(c) {
          var color = c.status === 'connected' ? 'var(--accent)'
            : (c.status === 'error' ? 'var(--danger, #c0392b)' : 'var(--text-muted)');
          return '<span class="feed-source" style="color:' + color + '">' + escapeHtml(c.status) + '</span>';
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
            inner = '<button class="btn" data-act="connect" data-tk="' + escapeHtml(tk) + '"' + (apiKeySet ? '' : ' disabled') + '>Connect</button>' +
              (apiKeySet ? '' : '<span style="margin-left:8px;font-size:12px;color:var(--text-muted)">Set the Composio API key first</span>') +
              '<div id="connect-' + escapeHtml(tk) + '-finish"></div>';
          }
          return '<div class="dbconfig-panel" style="margin-bottom:12px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<h4 style="margin:0 0 8px">' + escapeHtml(title) + '</h4>' + inner + '</div>';
        }
        host.innerHTML = keyPanel() + toolkits.map(toolkitCard).join('');
        var msg = host.querySelector('#connectors-msg');
        function setMsg(t) { if (msg) msg.textContent = t; }
        function reload() { renderConnectorsPanel(host); }
        function postJson(url, body) {
          return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
            .then(function (r) { return r.json(); });
        }
        var saveBtn = host.querySelector('#composio-key-save');
        if (saveBtn) saveBtn.addEventListener('click', function () {
          var input = host.querySelector('#composio-key');
          var key = (input && input.value ? input.value : '').trim();
          if (!key) { setMsg('Enter a key first.'); return; }
          setMsg('Saving…');
          fetch('/api/connectors/composio-key', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: key }) })
            .then(function (r) { if (!r.ok) throw new Error('save failed (' + r.status + ')'); return r.json(); })
            .then(reload).catch(function (e) { setMsg('Failed: ' + e.message); });
        });
        var clearBtn = host.querySelector('#composio-key-clear');
        if (clearBtn) clearBtn.addEventListener('click', function () {
          setMsg('Clearing…');
          fetch('/api/connectors/composio-key', { method: 'DELETE' })
            .then(function (r) { if (!r.ok) throw new Error('clear failed (' + r.status + ')'); return r.json(); })
            .then(reload).catch(function (e) { setMsg('Failed: ' + e.message); });
        });
        host.querySelectorAll('button[data-act]').forEach(function (b) {
          b.addEventListener('click', function () {
            var act = b.getAttribute('data-act');
            var tk = b.getAttribute('data-tk');
            if (act === 'connect') {
              setMsg('Opening authorization…');
              postJson('/api/connectors/' + encodeURIComponent(tk) + '/authorize').then(function (d) {
                if (d.error) { setMsg('Failed: ' + d.error); return; }
                if (d.redirectUrl) window.open(d.redirectUrl, '_blank', 'noopener');
                var slot = host.querySelector('#connect-' + tk + '-finish');
                if (slot) {
                  slot.innerHTML = '<p class="lead" style="margin:8px 0 6px;font-size:12px;color:var(--text-muted)">After you approve in the new tab, click Finish.</p>' +
                    '<button class="btn" id="finish-' + tk + '">Finish connecting</button>';
                  var fb = host.querySelector('#finish-' + tk);
                  if (fb) fb.addEventListener('click', function () {
                    setMsg('Connecting + syncing…');
                    postJson('/api/connectors/' + encodeURIComponent(tk) + '/finalize').then(function (d2) {
                      if (d2.error) { setMsg('Failed: ' + d2.error); return; }
                      reload();
                    }).catch(function (e) { setMsg('Failed: ' + e.message); });
                  });
                }
              }).catch(function (e) { setMsg('Failed: ' + e.message); });
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
