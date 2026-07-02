// Auto-composed segment of the GUI client script (see modules/index.ts). The
// connectors UI: a LEFT-sliding "Add a connector" dialog (opened from the Sources
// sidebar) listing each toolkit as a card with its logo. Fully data-driven off
// GET /api/connectors — every connector declares its label, icon, and credential
// fields, so adding a connector needs no GUI change. A thin client over the
// route-tested /api/connectors endpoints; credentials are validated server-side
// on connect and stored encrypted on this machine.
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
        var byToolkit = {};
        connectors.forEach(function (c) { byToolkit[c.toolkit] = c; });

        function statusChip(c) {
          var color = c.status === 'connected' ? 'var(--accent)'
            : (c.status === 'error' ? 'var(--danger, #c0392b)' : 'var(--text-muted)');
          return '<span class="conn-status" style="color:' + color + '">' + escapeHtml(c.status) + '</span>';
        }
        function credForm(tk) {
          var fields = tk.credentialFields || [];
          var rows = fields.map(function (f) {
            return '<label class="conn-field">' + escapeHtml(f.label) +
              '<input id="cred-' + escapeHtml(tk.toolkit) + '-' + escapeHtml(f.key) + '" type="' +
                (f.type === 'password' ? 'password' : 'text') + '" autocomplete="off" data-1p-ignore ' +
                'data-lpignore="true" placeholder="' + escapeHtml(f.placeholder || '') + '"></label>';
          }).join('');
          var help = tk.helpUrl
            ? '<a class="conn-help" href="' + escapeHtml(tk.helpUrl) + '" target="_blank" rel="noopener">Where do I find these? ↗</a>'
            : '';
          return '<div class="conn-form">' + rows +
            '<div class="conn-form-actions"><button class="btn primary" data-act="connect" data-tk="' +
              escapeHtml(tk.toolkit) + '">Connect</button>' + help + '</div></div>';
        }
        function mcpUrlForm(tk) {
          return '<div class="conn-form">' +
            '<label class="conn-field">MCP server URL' +
              '<input id="mcp-url-' + escapeHtml(tk.toolkit) + '" type="text" autocomplete="off" ' +
                'data-1p-ignore data-lpignore="true" placeholder="https://your-mcp-server/sse"></label>' +
            '<div class="conn-form-actions"><button class="btn primary" data-act="connect" data-tk="' +
              escapeHtml(tk.toolkit) + '">Connect</button></div></div>';
        }
        function card(tk) {
          var c = byToolkit[tk.toolkit];
          var inner;
          if (c) {
            inner = '<div class="conn-connected">' + statusChip(c) +
                (c.lastSyncAt ? '<span class="conn-sub">last synced ' + escapeHtml(c.lastSyncAt) + '</span>' : '') +
                '<button class="btn" data-act="refresh" data-tk="' + escapeHtml(tk.toolkit) + '">Refresh</button>' +
                '<button class="btn" data-act="disconnect" data-tk="' + escapeHtml(tk.toolkit) + '">Disconnect</button>' +
              '</div>' +
              (c.lastError ? '<div class="conn-err">' + escapeHtml(c.lastError) + '</div>' : '');
          } else if (tk.connectVia === 'mcp' && tk.needsServerUrl) {
            inner = mcpUrlForm(tk);
          } else {
            inner = (tk.credentialFields && tk.credentialFields.length)
              ? credForm(tk)
              : '<button class="btn primary" data-act="connect" data-tk="' + escapeHtml(tk.toolkit) + '">Connect</button>';
          }
          return '<div class="conn-card">' +
            '<div class="conn-card-head">' + connectorIconHtml(tk) +
              '<span class="conn-card-title">' + escapeHtml(tk.label || tk.toolkit) + '</span></div>' +
            inner + '</div>';
        }
        host.innerHTML =
          '<p class="conn-lead">Sync an external source into Lattice as connected data types. ' +
          'Your credentials are validated on connect and stored encrypted on this machine.</p>' +
          '<div id="connectors-msg" class="conn-msg"></div>' +
          (toolkits.length ? toolkits.map(card).join('') : '<div class="conn-sub">No connectors available.</div>');
        var msg = host.querySelector('#connectors-msg');
        function setMsg(t) { if (msg) msg.textContent = t; }
        function reload() { renderConnectorsPanel(host); }
        // MCP OAuth: open the provider's sign-in in the browser (the desktop app
        // routes window.open for external origins to the system browser), then poll
        // until the loopback callback records the connection and re-render.
        function openAuthRedirect(u, tkName) {
          setMsg('Finish signing in in your browser, then return here…');
          try { window.open(u, '_blank', 'noopener'); } catch (e) {}
          var tries = 0;
          var iv = window.setInterval(function () {
            tries++;
            fetchJson('/api/connectors').then(function (d) {
              var cs = (d && d.connectors) || [];
              var found = false;
              for (var i = 0; i < cs.length; i++) if (cs[i].toolkit === tkName) { found = true; break; }
              if (found || tries > 40) { window.clearInterval(iv); reload(); }
            }).catch(function () {});
          }, 3000);
        }
        function postJson(url, body) {
          return fetch(url, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
          }).then(function (r) { return r.json(); });
        }
        host.querySelectorAll('button[data-act]').forEach(function (b) {
          b.addEventListener('click', function () {
            var act = b.getAttribute('data-act');
            var tkName = b.getAttribute('data-tk');
            var tk = null;
            for (var i = 0; i < toolkits.length; i++) if (toolkits[i].toolkit === tkName) { tk = toolkits[i]; break; }
            if (act === 'connect') {
              var fields = (tk && tk.credentialFields) || [];
              var body = {};
              var missing = false;
              fields.forEach(function (f) {
                var el = host.querySelector('#cred-' + tkName + '-' + f.key);
                var v = el && el.value ? el.value.trim() : '';
                if (f.required !== false && !v) missing = true;
                body[f.key] = v;
              });
              if (missing) { setMsg('Fill in every field.'); return; }
              if (tk && tk.connectVia === 'mcp' && tk.needsServerUrl) {
                var urlEl = host.querySelector('#mcp-url-' + tkName);
                var urlV = urlEl && urlEl.value ? urlEl.value.trim() : '';
                if (!urlV) { setMsg('Enter the MCP server URL.'); return; }
                body.serverUrl = urlV;
              }
              setMsg(tk && tk.connectVia === 'mcp' ? 'Connecting…' : 'Validating + syncing…');
              postJson('/api/connectors/' + encodeURIComponent(tkName) + '/connect', body)
                .then(function (d) {
                  if (d.error) { setMsg('Failed: ' + d.error); return; }
                  if (d.redirectUrl) { openAuthRedirect(d.redirectUrl, tkName); return; }
                  reload();
                })
                .catch(function (e) { setMsg('Failed: ' + e.message); });
            } else if (act === 'refresh') {
              setMsg('Refreshing…');
              postJson('/api/connectors/' + encodeURIComponent(tkName) + '/refresh')
                .then(function (d) { if (d.error) { setMsg('Failed: ' + d.error); return; } reload(); })
                .catch(function (e) { setMsg('Failed: ' + e.message); });
            } else if (act === 'disconnect') {
              setMsg('Disconnecting…');
              fetch('/api/connectors/' + encodeURIComponent(tkName), {
                method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}',
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

    // The connectors panel opens in a LEFT-sliding dialog from the Sources sidebar
    // ("+ Add a Connector" / clicking a connected source), not the Settings drawer.
    function openConnectorsDialog() {
      var dlg = document.getElementById('connectors-dialog');
      var back = document.getElementById('connectors-backdrop');
      if (!dlg || !back) return;
      back.hidden = false;
      dlg.hidden = false;
      window.requestAnimationFrame(function () { dlg.classList.add('open'); back.classList.add('open'); });
      wireConnectorsDialog();
      renderConnectorsPanel(document.getElementById('connectors-dialog-body'));
    }
    function closeConnectorsDialog() {
      var dlg = document.getElementById('connectors-dialog');
      var back = document.getElementById('connectors-backdrop');
      if (!dlg || !back) return;
      dlg.classList.remove('open');
      back.classList.remove('open');
      window.setTimeout(function () { dlg.hidden = true; back.hidden = true; }, 220);
    }
    var connectorsDialogWired = false;
    function wireConnectorsDialog() {
      if (connectorsDialogWired) return;
      connectorsDialogWired = true;
      var closeBtn = document.getElementById('connectors-dialog-close');
      if (closeBtn) closeBtn.addEventListener('click', closeConnectorsDialog);
      var back = document.getElementById('connectors-backdrop');
      if (back) back.addEventListener('click', closeConnectorsDialog);
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        var dlg = document.getElementById('connectors-dialog');
        if (dlg && !dlg.hidden) closeConnectorsDialog();
      });
    }
`;
