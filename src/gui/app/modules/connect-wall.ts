// Auto-composed segment of the GUI client script (see modules/index.ts). The
// first-run connect wall is now a short WIZARD: choose a backend (Claude account or any
// OpenAI-compatible endpoint) → enter its details (Connect stays faded until the required
// fields are filled) → a "Testing your AI" step runs a real model call. On success the app
// proceeds to Analytics; on failure it returns to the setup screen with the error. Boot
// gates on this (boot.ts) BEFORE any workspace loads, and it is suppressed for a managed
// deployment. One codebase serves both the desktop app and terminal `lattice gui` (the
// OAuth anchor is surface-agnostic — the desktop link-interceptor opens it in the system
// browser and keeps the PKCE cookie on the webview), so this wall is NOT forked per surface.
export const connectWallJs = `    // ── First-run connect wall (wizard) ─────────────────────
    // The Claude "sunburst" mark for the black Connect-with-Claude button. Drawn with
    // currentColor so it inherits the button styling (Claude orange via .connect-claude-btn).
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
      wall.setAttribute('aria-label', 'Connect a model to use Lattice');
      document.body.appendChild(wall);

      // step: 'choose' | 'claude' | 'other' | 'testing'. method remembers which setup
      // screen to return to when the AI test fails. error is shown on that screen.
      var state = { step: 'choose', method: null, error: '' };

      function go(step) { state.error = ''; state.step = step; render(); }

      function setStatus(msg, isError) {
        var el = document.getElementById('cw-status');
        if (el) { el.textContent = msg || ''; el.className = 'connect-wall-status' + (isError ? ' cw-error' : ''); }
      }

      function actionsHtml() {
        return '<div class="cw-actions">' +
          '<button type="button" class="cw-back" id="cw-back">\\u2190 Back</button>' +
          '<button type="button" class="cw-connect" id="cw-connect" disabled>Connect \\u2192</button>' +
        '</div>';
      }
      function wireBack() {
        var b = document.getElementById('cw-back');
        if (b) b.addEventListener('click', function () { go('choose'); });
      }

      // A model call succeeded — land on Analytics and resume boot.
      function proceed() {
        try { if (location.hash.indexOf('#/analytics') !== 0) location.hash = '#/analytics'; } catch (e) {}
        hideConnectWall();
        if (typeof onConnected === 'function') onConnected();
      }
      // Test the configured model; on pass proceed, on fail return to the setup screen.
      function runTest() {
        fetchJson('/api/assistant/test', { method: 'POST' })
          .then(function (r) {
            if (r && r.ok) { proceed(); return; }
            state.error = 'AI test failed: ' + ((r && r.error) || 'the model did not respond') + '. Check your details and try again.';
            state.step = state.method || 'choose';
            render();
          })
          .catch(function (err) {
            state.error = 'AI test failed: ' + ((err && err.message) || 'could not reach the model') + '. Check your details and try again.';
            state.step = state.method || 'choose';
            render();
          });
      }

      function renderChoose() {
        wall.innerHTML =
          '<div class="connect-wall-card cw-wide">' +
            '<div class="connect-wall-mark" aria-hidden="true">' + BRAND_SVG + '</div>' +
            '<h1>Welcome to Lattice</h1>' +
            '<p class="cw-tagline">Your AI Company Insights Platform</p>' +
            '<p class="cw-lead">Choose which model to use to power Lattice (you can change this later):</p>' +
            '<div class="cw-choices">' +
              '<button type="button" class="cw-choice" data-method="claude"><strong>Claude Account</strong><span>Max, Pro, etc</span></button>' +
              '<button type="button" class="cw-choice" data-method="other"><strong>Other AI Endpoint</strong><span>OpenAI, Copilot, Custom</span></button>' +
            '</div>' +
            '<p class="cw-security">Security note: your data lives on your system, your cloud if you create one, or within the confines of the AI service agreement with your chosen provider. <strong>Lattice does not collect or retain your data.</strong></p>' +
          '</div>';
        var choices = wall.querySelectorAll('.cw-choice');
        for (var i = 0; i < choices.length; i++) {
          choices[i].addEventListener('click', function () { state.method = this.getAttribute('data-method'); go(state.method); });
        }
      }

      function renderClaude() {
        wall.innerHTML =
          '<div class="connect-wall-card">' +
            '<h1>Connect to Claude</h1>' +
            '<p class="cw-lead">Click below to open and sign in to your Claude account in your browser. After you click Authorize you will be given a code \\u2014 paste it below to connect.</p>' +
            '<a href="/api/assistant/oauth/start" target="_blank" rel="noopener" class="connect-claude-btn" id="cw-claude-start">' + CLAUDE_LOGO_SVG + '<span>Connect with Claude</span></a>' +
            '<input type="text" id="cw-claude-code" class="cw-input" placeholder="Paste Claude token" autocomplete="off" spellcheck="false" />' +
            '<div class="connect-wall-status" id="cw-status" role="status" aria-live="polite"></div>' +
            actionsHtml() +
          '</div>';
        wireBack();
        if (state.error) setStatus(state.error, true);
        var code = document.getElementById('cw-claude-code');
        var connect = document.getElementById('cw-connect');
        function sync() { if (connect) connect.disabled = !(((code && code.value) || '').trim()); }
        if (code) code.addEventListener('input', sync);
        sync();
        function submit() {
          var v = ((code && code.value) || '').trim();
          if (!v) return;
          setStatus('Connecting\\u2026');
          if (connect) connect.disabled = true;
          fetchJson('/api/assistant/oauth/exchange', { method: 'POST', body: JSON.stringify({ code: v }) })
            .then(function () { return fetchJson('/api/assistant/config').catch(function () { return {}; }); })
            .then(function (cfg) {
              if (cfg && cfg.connected) { state.step = 'testing'; render(); runTest(); }
              else { setStatus('That code did not connect an account \\u2014 use Connect with Claude and try again.', true); sync(); }
            })
            .catch(function (err) { setStatus('Connect failed: ' + ((err && err.message) || 'try again'), true); sync(); });
        }
        if (connect) connect.addEventListener('click', submit);
        if (code) code.addEventListener('keydown', function (e) { if (e.key === 'Enter' && connect && !connect.disabled) { e.preventDefault(); submit(); } });
      }

      function renderOther() {
        wall.innerHTML =
          '<div class="connect-wall-card">' +
            '<h1>Other AI Endpoint</h1>' +
            '<p class="cw-lead">Lattice supports OpenAI, Copilot, or any other custom endpoint. You will need the Base URL, the API Key, and the Model you want to use.</p>' +
            '<input type="text" id="cw-base" class="cw-input" placeholder="Base URL (e.g. https://api.openai.com/v1)" autocomplete="off" spellcheck="false" />' +
            '<input type="password" id="cw-key" class="cw-input" placeholder="API key (blank for a keyless local server)" autocomplete="off" spellcheck="false" />' +
            '<input type="text" id="cw-model" class="cw-input" placeholder="Model (e.g. gpt-4o)" autocomplete="off" spellcheck="false" />' +
            '<div class="connect-wall-status" id="cw-status" role="status" aria-live="polite"></div>' +
            actionsHtml() +
          '</div>';
        wireBack();
        if (state.error) setStatus(state.error, true);
        var base = document.getElementById('cw-base');
        var key = document.getElementById('cw-key');
        var model = document.getElementById('cw-model');
        var connect = document.getElementById('cw-connect');
        function val(el) { return ((el && el.value) || '').trim(); }
        function sync() { if (connect) connect.disabled = !(val(base) && val(model)); }
        [base, key, model].forEach(function (el) { if (el) el.addEventListener('input', sync); });
        sync();
        function submit() {
          if (!val(base) || !val(model)) return;
          setStatus('Connecting\\u2026');
          if (connect) connect.disabled = true;
          fetchJson('/api/assistant/provider/openai-compat', { method: 'POST', body: JSON.stringify({ baseUrl: val(base), apiKey: val(key), model: val(model) }) })
            .then(function () { return fetchJson('/api/assistant/config').catch(function () { return {}; }); })
            .then(function (cfg) {
              if (cfg && cfg.connected) { state.step = 'testing'; render(); runTest(); }
              else { setStatus('Could not save that endpoint \\u2014 check the URL, key, and model.', true); sync(); }
            })
            .catch(function (err) { setStatus('Connect failed: ' + ((err && err.message) || 'try again'), true); sync(); });
        }
        if (connect) connect.addEventListener('click', submit);
      }

      function renderTesting() {
        wall.innerHTML =
          '<div class="connect-wall-card">' +
            '<div class="cw-spinner" aria-hidden="true"></div>' +
            '<h1>Testing your AI\\u2026</h1>' +
            '<p class="cw-lead">Making sure Lattice can reach your model. This takes a moment.</p>' +
            '<div class="connect-wall-status" id="cw-status" role="status" aria-live="polite"></div>' +
          '</div>';
      }

      function render() {
        if (state.step === 'claude') renderClaude();
        else if (state.step === 'other') renderOther();
        else if (state.step === 'testing') renderTesting();
        else renderChoose();
      }
      render();
    }

    function hideConnectWall() {
      var wall = document.getElementById('connect-wall');
      if (wall && wall.parentNode) wall.parentNode.removeChild(wall);
    }

    // Re-show the onboarding wall when the AI stops working at runtime (a provider/auth
    // failure, not a settings edit). Called by the chat error path. onConnected resumes the
    // app; a reload is the safe default.
    function reonboardOnAiFailure() {
      if (document.getElementById('connect-wall')) return;
      showConnectWall(function () { try { location.reload(); } catch (e) {} });
    }

    // ── Usage-limit banner ──────────────────────────────────
    // The single "you've hit your usage limit" signal, shown app-wide (Analytics AND
    // Configure) whenever the server's shared limit state is active — so file ingestion +
    // other AI features read the same block, not just the chat. Reads /api/assistant/config
    // (which surfaces limitState); the chat's limit SSE frame also calls this.
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
          el.textContent = '\\u23F3 ' + (cfg.limitState.message || 'You have hit your usage limit.');
        } else if (el && el.parentNode) {
          el.parentNode.removeChild(el);
        }
      }).catch(function () {});
    }
`;
