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
    // The Claude "sunburst" mark for the black Connect-with-Claude button. Drawn
    // with currentColor so it inherits the button styling (Claude orange via
    // .connect-claude-btn .claude-logo).
    var CLAUDE_LOGO_SVG = (function () {
      var rays = '';
      for (var a = 0; a < 360; a += 30) {
        var r = (a * Math.PI) / 180;
        var x = (12 + 8.5 * Math.cos(r)).toFixed(2);
        var y = (12 + 8.5 * Math.sin(r)).toFixed(2);
        rays += '<line x1="12" y1="12" x2="' + x + '" y2="' + y + '"/>';
      }
      return '<svg class="claude-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.6" stroke-linecap="round" aria-hidden="true">' + rays + '</svg>';
    })();

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
          '<div class="connect-wall-mark" aria-hidden="true">' + BRAND_SVG + '</div>' +
          '<h1>Connect Claude to use Lattice</h1>' +
          '<p>Lattice runs on your Claude subscription. Connect your Claude account plan (Max, Pro, etc) to continue.</p>' +
          '<a href="/api/assistant/oauth/start" target="_blank" rel="noopener" class="connect-claude-btn" id="connect-wall-start">' +
            CLAUDE_LOGO_SVG + '<span>Connect with Claude</span></a>' +
          '<div class="connect-wall-paste">' +
            '<div class="connect-wall-row">' +
              '<input type="text" id="connect-wall-code" placeholder="Paste Authentication Code here" autocomplete="off" spellcheck="false" />' +
              '<button type="button" class="btn primary" id="connect-wall-finish">Connect</button>' +
            '</div>' +
            '<div class="connect-wall-status" id="connect-wall-status" role="status" aria-live="polite"></div>' +
          '</div>' +
          // Alternative backend: any OpenAI-compatible endpoint (OpenAI, Azure,
          // OpenRouter, a local server, your own gateway). No provider-specific auth
          // is shipped — you supply the base URL, key, and model.
          '<div class="connect-wall-alt">' +
            '<button type="button" class="connect-wall-alt-toggle" id="connect-wall-alt-toggle" aria-expanded="false">or connect an OpenAI-compatible model</button>' +
            '<div class="connect-wall-alt-form" id="connect-wall-alt-form" hidden>' +
              '<input type="text" id="oai-base" placeholder="Base URL (e.g. https://api.openai.com/v1)" autocomplete="off" spellcheck="false" />' +
              '<input type="password" id="oai-key" placeholder="API key (blank for a keyless local server)" autocomplete="off" spellcheck="false" />' +
              '<input type="text" id="oai-model" placeholder="Model (e.g. gpt-4o)" autocomplete="off" spellcheck="false" />' +
              '<button type="button" class="btn primary" id="oai-connect">Use this model</button>' +
              '<div class="connect-wall-status" id="oai-status" role="status" aria-live="polite"></div>' +
            '</div>' +
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

      // ── OpenAI-compatible endpoint (alternative backend) ──
      var altToggle = document.getElementById('connect-wall-alt-toggle');
      var altForm = document.getElementById('connect-wall-alt-form');
      if (altToggle && altForm) {
        altToggle.addEventListener('click', function () {
          var open = altForm.hidden;
          altForm.hidden = !open;
          altToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
      }
      var oaiStatusEl = document.getElementById('oai-status');
      function setOaiStatus(msg) { if (oaiStatusEl) oaiStatusEl.textContent = msg; }
      function doOaiConnect() {
        var baseEl = document.getElementById('oai-base');
        var keyEl = document.getElementById('oai-key');
        var modelEl = document.getElementById('oai-model');
        var base = ((baseEl && baseEl.value) || '').trim();
        var key = ((keyEl && keyEl.value) || '').trim();
        var model = ((modelEl && modelEl.value) || '').trim();
        if (!base || !model) { setOaiStatus('Base URL and model are required.'); return; }
        setOaiStatus('Connecting…');
        fetchJson('/api/assistant/provider/openai-compat', { method: 'POST', body: JSON.stringify({ baseUrl: base, apiKey: key, model: model }) })
          .then(function () { return fetchJson('/api/assistant/config').catch(function () { return {}; }); })
          .then(function (cfg) {
            if (cfg && cfg.connected) {
              hideConnectWall();
              if (typeof onConnected === 'function') onConnected();
            } else {
              setOaiStatus('Could not connect that endpoint — check the URL, key, and model.');
            }
          })
          .catch(function (err) {
            setOaiStatus('Connect failed: ' + (err && err.message ? err.message : 'try again'));
          });
      }
      var oaiBtn = document.getElementById('oai-connect');
      if (oaiBtn) oaiBtn.addEventListener('click', doOaiConnect);
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
