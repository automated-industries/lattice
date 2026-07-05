// Auto-composed segment of the GUI client script (see modules/index.ts). The
// first-run connect wall: Claude is mandatory, so when no subscription is
// connected the whole app is covered by an un-skippable overlay that walks the
// user through the OAuth connect. Boot gates on this (boot.ts) BEFORE any
// workspace loads. Suppressed for a managed deployment (the operator supplies the
// credential). One codebase serves both the desktop app and terminal `lattice
// gui` (the OAuth anchor is surface-agnostic — the desktop link-interceptor opens
// it in the system browser and keeps the PKCE cookie on the webview), so this
// wall is NOT forked per surface.
export const connectWallJs = `    // ── First-run connect wall ──────────────────────────────
    function showConnectWall(onConnected) {
      if (document.getElementById('connect-wall')) return;
      var wall = document.createElement('div');
      wall.id = 'connect-wall';
      wall.className = 'connect-wall';
      wall.setAttribute('role', 'dialog');
      wall.setAttribute('aria-modal', 'true');
      wall.setAttribute('aria-label', 'Connect Claude to use Lattice');
      wall.innerHTML =
        '<div class="connect-wall-card">' +
          '<div class="connect-wall-mark" aria-hidden="true">👵🏻</div>' +
          '<h1>Connect Claude to use Lattice</h1>' +
          '<p>Lattice runs on your Claude subscription. Connect your Claude account to continue — there is nothing to skip.</p>' +
          '<a href="/api/assistant/oauth/start" target="_blank" rel="noopener" class="btn primary connect-wall-btn" id="connect-wall-start">Connect with Claude</a>' +
          '<div class="connect-wall-paste">' +
            '<label for="connect-wall-code">Paste the code Claude gives you</label>' +
            '<div class="connect-wall-row">' +
              '<input type="text" id="connect-wall-code" placeholder="code#state" autocomplete="off" spellcheck="false" />' +
              '<button type="button" class="btn primary" id="connect-wall-finish">Finish</button>' +
            '</div>' +
            '<div class="connect-wall-status" id="connect-wall-status" role="status" aria-live="polite"></div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(wall);
      var codeEl = document.getElementById('connect-wall-code');
      var statusEl = document.getElementById('connect-wall-status');
      function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }
      function doExchange() {
        var code = ((codeEl && codeEl.value) || '').trim();
        if (!code) { setStatus('Paste the code from the Claude tab first.'); return; }
        setStatus('Connecting…');
        fetchJson('/api/assistant/oauth/exchange', { method: 'POST', body: JSON.stringify({ code: code }) })
          .then(function () { return fetchJson('/api/assistant/config').catch(function () { return {}; }); })
          .then(function (cfg) {
            if (cfg && cfg.connected) {
              hideConnectWall();
              if (typeof onConnected === 'function') onConnected();
            } else {
              setStatus('That code did not connect an account — use Connect with Claude and try again.');
            }
          })
          .catch(function (err) {
            setStatus('Connect failed: ' + (err && err.message ? err.message : 'try again'));
          });
      }
      var finishBtn = document.getElementById('connect-wall-finish');
      if (finishBtn) finishBtn.addEventListener('click', doExchange);
      if (codeEl) codeEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doExchange(); } });
    }

    function hideConnectWall() {
      var wall = document.getElementById('connect-wall');
      if (wall && wall.parentNode) wall.parentNode.removeChild(wall);
    }

    // ── Usage-limit banner ──────────────────────────────────
    // The single "you've hit your Claude limit" signal, shown app-wide (Analytics
    // AND Configure) whenever the server's shared limit state is active — so file
    // ingestion + other AI features read the same block, not just the chat. Reads
    // /api/assistant/config (which surfaces limitState); the chat's limit SSE frame
    // also calls this so the banner appears the instant a limit is hit.
    function refreshLimitBlock() {
      fetchJson('/api/assistant/config').then(function (cfg) {
        var limited = cfg && cfg.limitState;
        var el = document.getElementById('limit-banner');
        if (limited) {
          if (!el) {
            el = document.createElement('div');
            el.id = 'limit-banner';
            el.className = 'limit-banner';
            el.setAttribute('role', 'status');
            document.body.appendChild(el);
          }
          el.textContent = '\\u23F3 ' + (cfg.limitState.message || 'You have hit your Claude usage limit.');
        } else if (el && el.parentNode) {
          el.parentNode.removeChild(el);
        }
      }).catch(function () {});
    }
`;
