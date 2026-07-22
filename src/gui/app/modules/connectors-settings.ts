// Auto-composed segment of the GUI client script (see modules/index.ts). The
// MCP Connectors panel, rendered INSIDE the Configure drawer's "MCP Connectors"
// tab (there is no separate dialog): connected servers render full-width as a
// multi-column table (name, server URL, items synced, status, last synced,
// actions) with Refresh / Disconnect / Reconnect, and the add-by-URL form lives
// in its own mount below so a background refresh never wipes it. Fully
// data-driven off GET /api/connectors. OAuth runs in the system browser against
// the server's own authorization server; tokens are stored encrypted on this
// machine and no connector data touches any Lattice-hosted service. When a
// provider supports neither a client-ID metadata document nor dynamic
// registration, the server answers 422 `client_registration_unsupported` and
// the form reveals pre-registered client-ID fields.
export const connectorsSettingsJs = `
    // The toolkit id the routes are addressed by (a single generic 'mcp'), the
    // reconnect target in flight (so a manual-client 422 resubmits against the
    // SAME row), and a token guarding out-of-order reconnect polls.
    var mcpToolkit = 'mcp';
    var mcpReconnectId = null;
    // The prefab catalog card in flight, so a manual-client 422 resubmits by the
    // SAME catalog id (its pinned URL + curated scopes stay server-authoritative).
    var mcpCatalogId = null;

    function mcpConnStatusChip(status) {
      var color = status === 'connected' ? 'var(--accent)'
        : (status === 'error' ? 'var(--danger, #c0392b)' : 'var(--text-muted)');
      return '<span class="db-status"><span class="db-status-dot" style="background:' + color +
        '"></span>' + escapeHtml(status || 'unknown') + '</span>';
    }
    // Compact "when" (shared shape with the Databases tab): relative, then a date.
    function mcpWhen(iso) {
      if (!iso) return '—';
      var t = Date.parse(iso);
      if (isNaN(t)) return String(iso);
      var secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
      if (secs < 60) return 'just now';
      if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
      if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
      return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    // Refresh ONLY the connected-servers table (safe to call repeatedly — never
    // touches the add-form mount, so a half-typed URL survives).
    function renderConnectorsTable() {
      var host = document.getElementById('mcp-connectors-list');
      if (!host) return;
      fetchJson('/api/connectors')
        .then(function (data) { paintConnectorsTable(host, (data && data.connectors) || []); })
        .catch(function (err) {
          host.innerHTML = '<div class="conn-err">Failed to load connectors: ' +
            escapeHtml(err && err.message ? err.message : String(err)) + '</div>';
        });
    }

    function paintConnectorsTable(host, connectors) {
      function rowHtml(c) {
        var items = (c.itemCount || 0) + ' ' + (c.itemCount === 1 ? 'item' : 'items');
        var actions = c.status === 'disconnected'
          ? '<button class="btn btn-sm primary" data-conn-act="reconnect" data-id="' + escapeHtml(c.id) + '">Reconnect</button>'
          : '<button class="btn btn-sm" data-conn-act="refresh" data-id="' + escapeHtml(c.id) + '">Refresh</button>' +
            '<button class="btn btn-sm" data-conn-act="disconnect" data-id="' + escapeHtml(c.id) + '">Disconnect</button>';
        var err = c.lastError
          ? '<tr class="db-err-row"><td colspan="6"><div class="conn-err">' + escapeHtml(c.lastError) + '</div></td></tr>'
          : '';
        return '<tr class="db-row">' +
          '<td class="db-name">' + escapeHtml(c.displayName || 'MCP server') + '</td>' +
          '<td class="db-mono">' + escapeHtml(c.serverUrl || '—') + '</td>' +
          '<td class="db-num">' + escapeHtml(items) + '</td>' +
          '<td>' + mcpConnStatusChip(c.status) + '</td>' +
          '<td class="db-muted">' + escapeHtml(mcpWhen(c.lastSyncAt)) + '</td>' +
          '<td class="db-actions">' + actions + '</td></tr>' + err;
      }
      host.innerHTML = connectors.length
        ? '<div class="db-table-wrap"><table class="db-table"><thead><tr>' +
            '<th>Name</th><th>Server</th><th>Items</th><th>Status</th><th>Last synced</th><th></th>' +
            '</tr></thead><tbody>' + connectors.map(rowHtml).join('') + '</tbody></table></div>'
        : '<div class="db-empty">No MCP servers connected yet.</div>';
      host.querySelectorAll('button[data-conn-act]').forEach(function (b) {
        b.addEventListener('click', function () {
          var act = b.getAttribute('data-conn-act');
          var id = b.getAttribute('data-id');
          if (act === 'refresh') {
            setConnMsg('Refreshing…');
            connPostJson('/api/connectors/' + encodeURIComponent(mcpToolkit) + '/refresh', { connectorId: id })
              .then(function (d) { if (d.error) { setConnMsg('Failed: ' + d.error); return; } setConnMsg(''); renderConnectorsTable(); })
              .catch(function (e) { setConnMsg('Failed: ' + e.message); });
          } else if (act === 'disconnect') {
            setConnMsg('Disconnecting…');
            fetch('/api/connectors/' + encodeURIComponent(mcpToolkit), {
              method: 'DELETE', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ connectorId: id }),
            })
              .then(function (r) { return r.json(); })
              .then(function (d) { if (d.error) { setConnMsg('Failed: ' + d.error); return; } setConnMsg(''); renderConnectorsTable(); })
              .catch(function (e) { setConnMsg('Failed: ' + e.message); });
          } else if (act === 'reconnect') {
            // Re-authorize the existing row (server resolves the stored URL). A
            // 422 flips the form into pre-registered-client mode, still this row.
            mcpReconnectId = id;
            submitConnect({ connectorId: id });
          }
        });
      });
    }

    function setConnMsg(t) {
      var m = document.getElementById('mcp-conn-msg');
      if (m) m.textContent = t;
    }
    function connPostJson(url, body) {
      return fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json(); });
    }

    // The add form (its own mount). Rendered on tab open + after a successful
    // connect; a background table refresh never rebuilds it.
    function renderConnectorsAddForm() {
      var mount = document.getElementById('mcp-connectors-form');
      if (!mount) return;
      mount.innerHTML =
        '<div class="conn-card db-form-card"><div class="conn-card-head"><span class="conn-card-title">' +
          'Add an MCP connector</span></div>' +
        '<div class="conn-form">' +
          '<label class="conn-field">MCP server URL' +
            '<input id="mcp-add-url" type="text" autocomplete="off" data-1p-ignore data-lpignore="true" ' +
              'placeholder="https://mcp.example.com"></label>' +
          '<div id="mcp-client-fields" hidden>' +
            '<label class="conn-field">OAuth client ID' +
              '<input id="mcp-add-client-id" type="text" autocomplete="off" data-1p-ignore data-lpignore="true"></label>' +
            '<label class="conn-field">OAuth client secret (optional)' +
              '<input id="mcp-add-client-secret" type="password" autocomplete="off" data-1p-ignore data-lpignore="true"></label>' +
          '</div>' +
        '</div>' +
        '<div id="mcp-conn-msg" class="conn-msg"></div>' +
        '<div class="conn-form-actions"><button class="btn primary" data-conn-act="connect">Connect</button></div>' +
        '</div>';
      var connectBtn = mount.querySelector('button[data-conn-act="connect"]');
      if (connectBtn) connectBtn.addEventListener('click', function () {
        var urlEl = document.getElementById('mcp-add-url');
        var urlV = urlEl && urlEl.value ? urlEl.value.trim() : '';
        // A typed URL is always a FRESH connection — never fold it onto a row
        // left targeted by an earlier, abandoned Reconnect.
        if (urlV) { mcpReconnectId = null; mcpCatalogId = null; }
        if (!urlV && !mcpReconnectId && !mcpCatalogId) { setConnMsg('Enter the MCP server URL.'); return; }
        var body = {};
        if (urlV) body.serverUrl = urlV;
        if (mcpReconnectId) body.connectorId = mcpReconnectId;
        if (mcpCatalogId) body.catalogId = mcpCatalogId;
        var fieldsEl = document.getElementById('mcp-client-fields');
        if (fieldsEl && !fieldsEl.hidden) {
          var cidEl = document.getElementById('mcp-add-client-id');
          var cid = cidEl && cidEl.value ? cidEl.value.trim() : '';
          if (!cid) { setConnMsg('Enter the OAuth client ID.'); return; }
          body.clientId = cid;
          var csecEl = document.getElementById('mcp-add-client-secret');
          var csec = csecEl && csecEl.value ? csecEl.value.trim() : '';
          if (csec) body.clientSecret = csec;
        }
        submitConnect(body);
      });
    }

    function submitConnect(body) {
      setConnMsg('Connecting…');
      connPostJson('/api/connectors/' + encodeURIComponent(mcpToolkit) + '/connect', body)
        .then(function (d) {
          if (d && d.code === 'client_registration_unsupported') {
            var el = document.getElementById('mcp-client-fields');
            if (el) el.hidden = false;
            setConnMsg(d.error || 'This server needs a pre-registered OAuth client.');
            return;
          }
          if (d.error) { setConnMsg('Failed: ' + d.error); return; }
          if (d.redirectUrl) { openConnAuthRedirect(d.redirectUrl); return; }
          finishConnectSuccess();
        })
        .catch(function (e) { setConnMsg('Failed: ' + e.message); });
    }

    function finishConnectSuccess() {
      mcpReconnectId = null;
      mcpCatalogId = null;
      renderConnectorsAddForm(); // clear the URL / client fields
      renderToolkitCatalog(); // a newly-connected service drops off the grid
      renderConnectorsTable();
      // Newly-synced connector data should appear in the sidebar tables too.
      if (typeof refreshEntities === 'function') refreshEntities().catch(function () {});
      if (typeof renderSidebar === 'function') renderSidebar();
    }

    // MCP OAuth: open the provider's sign-in in the browser (the desktop app
    // routes window.open for external origins to the system browser), then poll
    // until the loopback callback lands. Completion = a NEW connector id, or a
    // known id whose status CHANGED (a reconnect repoints the same row).
    function openConnAuthRedirect(u) {
      setConnMsg('Finish signing in in your browser, then return here…');
      var before = {};
      fetchJson('/api/connectors').then(function (d0) {
        ((d0 && d0.connectors) || []).forEach(function (c) { before[c.id] = c.status; });
      }).catch(function () {});
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
          if (done) { window.clearInterval(iv); setConnMsg(''); finishConnectSuccess(); return; }
          if (tries > 40) {
            window.clearInterval(iv);
            setConnMsg("Sign-in didn't complete — try Connect again.");
            renderConnectorsTable();
          }
        }).catch(function () {});
      }, 3000);
    }

    // The prefab catalog grid (#mcp-catalog): curated flagship services + a
    // "browse more" set from the public MCP registry. A card connects by id — the
    // server resolves its pinned URL + curated scopes (authoritative). OAuth cards
    // need a loopback callback, unavailable in a hosted session, so they disable there.
    function renderToolkitCatalog() {
      var host = document.getElementById('mcp-catalog');
      if (!host) return;
      fetchJson('/api/connectors')
        .then(function (data) {
          var oauthOk = !data || data.oauthLoopbackAvailable !== false;
          paintToolkitCatalog(host, (data && data.catalog) || [], oauthOk);
        })
        .catch(function () { host.innerHTML = ''; });
    }

    function catCardHtml(e, oauthOk) {
      var icon = e.icon
        ? '<img class="conn-cat-icon" src="' + escapeHtml(e.icon) + '" alt="" onerror="this.remove()">'
        : '';
      var hint = e.authHint ? '<span class="conn-cat-hint">' + escapeHtml(e.authHint) + '</span>' : '';
      return '<button type="button" class="conn-cat-card" data-cat-id="' + escapeHtml(e.id) + '"' +
        (oauthOk ? '' : ' disabled') + '>' + icon +
        '<span class="conn-cat-label">' + escapeHtml(e.label) + '</span>' + hint + '</button>';
    }

    function paintToolkitCatalog(host, catalog, oauthOk) {
      if (!catalog.length) { host.innerHTML = ''; return; }
      var curated = catalog.filter(function (e) { return e.source === 'curated'; });
      var registry = catalog.filter(function (e) { return e.source !== 'curated'; });
      var html = '';
      if (curated.length) {
        html += '<div class="conn-cat-sec"><div class="conn-cat-head">Popular services</div>' +
          '<div class="conn-cat-grid">' +
          curated.map(function (e) { return catCardHtml(e, oauthOk); }).join('') + '</div></div>';
      }
      if (registry.length) {
        html += '<details class="conn-cat-more"><summary>Browse more (public registry)</summary>' +
          '<div class="conn-cat-grid">' +
          registry.map(function (e) { return catCardHtml(e, oauthOk); }).join('') + '</div></details>';
      }
      if (!oauthOk) {
        html += '<div class="conn-cat-note">Guided sign-in needs the desktop or local app to complete.</div>';
      }
      host.innerHTML = html;
      var index = {};
      catalog.forEach(function (e) { index[e.id] = e; });
      host.querySelectorAll('button[data-cat-id]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (b.disabled) return;
          catalogConnect(index[b.getAttribute('data-cat-id')]);
        });
      });
    }

    // Connect by catalog id: the server resolves the pinned URL + curated scopes.
    // A 422 (provider needs a pre-registered client) reveals the client-id fields;
    // the resubmit carries the SAME catalogId so URL/scope stay authoritative.
    function catalogConnect(entry) {
      if (!entry) return;
      mcpReconnectId = null;
      mcpCatalogId = entry.id;
      var el = document.getElementById('mcp-client-fields');
      if (el) el.hidden = true;
      submitConnect({ catalogId: entry.id });
    }

    // Render all three sections when the tab opens (called by renderConnectorsTab).
    function renderConnectorsPanel() {
      mcpReconnectId = null;
      mcpCatalogId = null;
      renderToolkitCatalog();
      renderConnectorsTable();
      renderConnectorsAddForm();
    }
`;
