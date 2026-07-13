// Auto-composed segment of the GUI client script (see modules/index.ts). The
// MCP Connectors panel, rendered INSIDE the Configure drawer's "MCP Connectors"
// tab (there is no separate dialog): every connected MCP server as a card with
// status + Refresh/Disconnect/Reconnect, plus an inline add-by-URL form. Fully
// data-driven off GET /api/connectors. OAuth runs in the system browser against
// the server's own authorization server; tokens are stored encrypted on this
// machine and no connector data touches any Lattice-hosted service. When a
// provider supports neither a client-ID metadata document nor dynamic
// registration, the server answers 422 `client_registration_unsupported` and
// the form reveals pre-registered client-ID fields.
export const connectorsSettingsJs = `
    function connectorIconHtml(pres) {
      if (pres && pres.icon) return '<img class="connector-icon" src="' + escapeHtml(pres.icon) + '" alt="">';
      return '<span class="connector-icon connector-icon-fallback">🔌</span>';
    }
    function renderConnectorsPanel(host) {
      if (!host) return;
      fetchJson('/api/connectors').then(function (data) {
        data = data || {};
        var toolkits = data.toolkits || [];
        var connectors = data.connectors || [];
        var tk = toolkits[0] || { toolkit: 'mcp', label: 'MCP server' };
        var tkName = tk.toolkit || 'mcp';
        // Set when a Reconnect is in flight so the manual-client fields (revealed
        // on a 422) resubmit against the SAME registry row, not a new one.
        var reconnectId = null;

        function statusChip(c) {
          var color = c.status === 'connected' ? 'var(--accent)'
            : (c.status === 'error' ? 'var(--danger, #c0392b)' : 'var(--text-muted)');
          return '<span class="conn-status" style="color:' + color + '">' + escapeHtml(c.status) + '</span>';
        }
        function serverCard(c) {
          var actions = c.status === 'disconnected'
            ? '<button class="btn primary" data-act="reconnect" data-id="' + escapeHtml(c.id) + '">Reconnect</button>'
            : '<button class="btn" data-act="refresh" data-id="' + escapeHtml(c.id) + '">Refresh</button>' +
              '<button class="btn" data-act="disconnect" data-id="' + escapeHtml(c.id) + '">Disconnect</button>';
          return '<div class="conn-card">' +
            '<div class="conn-card-head">' + connectorIconHtml(tk) +
              '<span class="conn-card-title">' + escapeHtml(c.displayName || 'MCP server') + '</span>' +
              statusChip(c) + '</div>' +
            (c.serverUrl ? '<div class="conn-sub">' + escapeHtml(c.serverUrl) + '</div>' : '') +
            '<div class="conn-connected">' +
              (c.lastSyncAt ? '<span class="conn-sub">last synced ' + escapeHtml(c.lastSyncAt) + '</span>' : '') +
              actions + '</div>' +
            (c.lastError ? '<div class="conn-err">' + escapeHtml(c.lastError) + '</div>' : '') +
            '</div>';
        }
        function addForm() {
          return '<div class="conn-card">' +
            '<div class="conn-card-head"><span class="conn-card-title">Add an MCP connector</span></div>' +
            '<div class="conn-form">' +
              '<label class="conn-field">MCP server URL' +
                '<input id="mcp-add-url" type="text" autocomplete="off" data-1p-ignore ' +
                  'data-lpignore="true" placeholder="https://mcp.example.com"></label>' +
              '<div id="mcp-client-fields" hidden>' +
                '<label class="conn-field">OAuth client ID' +
                  '<input id="mcp-add-client-id" type="text" autocomplete="off" data-1p-ignore data-lpignore="true"></label>' +
                '<label class="conn-field">OAuth client secret (optional)' +
                  '<input id="mcp-add-client-secret" type="password" autocomplete="off" data-1p-ignore data-lpignore="true"></label>' +
              '</div>' +
              '<div class="conn-form-actions">' +
                '<button class="btn primary" data-act="connect">Connect</button></div>' +
            '</div></div>';
        }
        host.innerHTML =
          '<p class="conn-lead">Connect any MCP server by URL. You authorize each server directly ' +
          'with its own sign-in; tokens are stored encrypted on this machine and synced data stays local.</p>' +
          '<div id="connectors-msg" class="conn-msg"></div>' +
          (connectors.length ? connectors.map(serverCard).join('') : '<div class="conn-sub">No MCP servers connected yet.</div>') +
          addForm();
        var msg = host.querySelector('#connectors-msg');
        function setMsg(t) { if (msg) msg.textContent = t; }
        function reload() { renderConnectorsPanel(host); }
        function showClientFields() {
          var el = host.querySelector('#mcp-client-fields');
          if (el) el.hidden = false;
        }
        // MCP OAuth: open the provider's sign-in in the browser (the desktop app
        // routes window.open for external origins to the system browser), then
        // poll until the loopback callback lands. Completion = a connector id we
        // did not have before, or a known id whose status CHANGED (a reconnect
        // repoints an existing row: its id is unchanged and it ends 'connected',
        // but its status still changes from disconnected/error). A toolkit-name
        // check cannot work with several servers on one toolkit.
        function openAuthRedirect(u) {
          setMsg('Finish signing in in your browser, then return here…');
          var before = {};
          connectors.forEach(function (c) { before[c.id] = c.status; });
          try { window.open(u, '_blank', 'noopener'); } catch (e) {}
          var tries = 0;
          var iv = window.setInterval(function () {
            tries++;
            fetchJson('/api/connectors').then(function (d) {
              var cs = (d && d.connectors) || [];
              var done = false;
              for (var i = 0; i < cs.length; i++) {
                var known = Object.prototype.hasOwnProperty.call(before, cs[i].id);
                if (!known || cs[i].status !== before[cs[i].id]) { done = true; break; }
              }
              if (done) { window.clearInterval(iv); reload(); return; }
              if (tries > 40) {
                // Give up polling but resync with server state either way, so a
                // late-completing sign-in isn't left invisible behind a stale view.
                window.clearInterval(iv);
                setMsg("Sign-in didn't complete — try Connect again.");
                reload();
              }
            }).catch(function () {});
          }, 3000);
        }
        function postJson(url, body) {
          return fetch(url, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
          }).then(function (r) { return r.json(); });
        }
        function submitConnect(body) {
          setMsg('Connecting…');
          postJson('/api/connectors/' + encodeURIComponent(tkName) + '/connect', body)
            .then(function (d) {
              if (d && d.code === 'client_registration_unsupported') {
                showClientFields();
                setMsg(d.error || 'This server needs a pre-registered OAuth client.');
                return;
              }
              if (d.error) { setMsg('Failed: ' + d.error); return; }
              if (d.redirectUrl) { openAuthRedirect(d.redirectUrl); return; }
              reload();
            })
            .catch(function (e) { setMsg('Failed: ' + e.message); });
        }
        host.querySelectorAll('button[data-act]').forEach(function (b) {
          b.addEventListener('click', function () {
            var act = b.getAttribute('data-act');
            var id = b.getAttribute('data-id');
            if (act === 'connect') {
              var urlEl = host.querySelector('#mcp-add-url');
              var urlV = urlEl && urlEl.value ? urlEl.value.trim() : '';
              // A typed URL is always a FRESH connection — never fold it onto a
              // row left targeted by an earlier, abandoned Reconnect. Only a bare
              // Connect (no URL) continues a reconnect (the manual-client 422
              // resubmit path), where the server resolves the stored URL.
              if (urlV) reconnectId = null;
              if (!urlV && !reconnectId) { setMsg('Enter the MCP server URL.'); return; }
              var body = {};
              if (urlV) body.serverUrl = urlV;
              if (reconnectId) body.connectorId = reconnectId;
              var cidEl = host.querySelector('#mcp-add-client-id');
              var csecEl = host.querySelector('#mcp-add-client-secret');
              var fieldsEl = host.querySelector('#mcp-client-fields');
              if (fieldsEl && !fieldsEl.hidden) {
                var cid = cidEl && cidEl.value ? cidEl.value.trim() : '';
                if (!cid) { setMsg('Enter the OAuth client ID.'); return; }
                body.clientId = cid;
                var csec = csecEl && csecEl.value ? csecEl.value.trim() : '';
                if (csec) body.clientSecret = csec;
              }
              submitConnect(body);
            } else if (act === 'reconnect') {
              reconnectId = id;
              // The server resolves the stored URL for this row; a 422 flips the
              // form into pre-registered-client mode, still targeting this row.
              submitConnect({ connectorId: id });
            } else if (act === 'refresh') {
              setMsg('Refreshing…');
              postJson('/api/connectors/' + encodeURIComponent(tkName) + '/refresh', { connectorId: id })
                .then(function (d) { if (d.error) { setMsg('Failed: ' + d.error); return; } reload(); })
                .catch(function (e) { setMsg('Failed: ' + e.message); });
            } else if (act === 'disconnect') {
              setMsg('Disconnecting…');
              fetch('/api/connectors/' + encodeURIComponent(tkName), {
                method: 'DELETE', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ connectorId: id }),
              })
                .then(function (r) { return r.json(); })
                .then(function (d) { if (d.error) { setMsg('Failed: ' + d.error); return; } reload(); })
                .catch(function (e) { setMsg('Failed: ' + e.message); });
            }
          });
        });
      }).catch(function (err) {
        if (host) {
          host.innerHTML = '<div class="conn-err">Failed to load connectors: ' +
            escapeHtml(err && err.message ? err.message : String(err)) + '</div>';
        }
      });
    }
`;
