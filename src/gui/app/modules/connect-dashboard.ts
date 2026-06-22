// Auto-composed segment of the GUI client script. The "Connect dashboard"
// top-bar button opens a self-contained modal panel (no dependency on the
// settings-drawer internals) that points Lattice at the user's own dashboard on
// disk. Reuses the shared globals defined earlier in the composed script:
// escapeHtml, fetchJson, withBusy. Like every segment this is ONE template
// literal — no raw backticks or ${...} inside (they would break the literal);
// HTML is built with single-quoted string concatenation.
export const connectDashboardJs = `
    // ── Connect a dashboard (modal panel) ──
    function cdCloseModal() {
      var b = document.getElementById('cd-modal-backdrop');
      if (b) b.parentNode && b.parentNode.removeChild(b);
    }
    function cdOpenModal(titleText) {
      cdCloseModal();
      var backdrop = document.createElement('div');
      backdrop.className = 'cd-modal-backdrop';
      backdrop.id = 'cd-modal-backdrop';
      var modal = document.createElement('div');
      modal.className = 'cd-modal';
      var head = document.createElement('div');
      head.className = 'cd-modal-head';
      var h = document.createElement('span');
      h.className = 'cd-modal-title';
      h.textContent = titleText;
      var x = document.createElement('button');
      x.className = 'cd-modal-close';
      x.textContent = '✕';
      x.title = 'Close';
      x.addEventListener('click', cdCloseModal);
      head.appendChild(h);
      head.appendChild(x);
      var body = document.createElement('div');
      body.className = 'cd-modal-body';
      modal.appendChild(head);
      modal.appendChild(body);
      backdrop.appendChild(modal);
      backdrop.addEventListener('click', function (e) { if (e.target === backdrop) cdCloseModal(); });
      document.body.appendChild(backdrop);
      return body;
    }

    // Connect-a-dashboard panel. Points Lattice at the user's own dashboard on
    // disk (file or folder), including a copyable prompt that asks Claude to find
    // the path. Connecting POSTs to /api/connect/dashboard (served at /, built-in
    // view at /lattice).
    function renderConnectDashboard(body) {
      function promptFor(desc) {
        var d = (desc || '').trim();
        var intro = d
          ? 'I have a dashboard on this computer that I would describe as: "' + d + '". It is a website made of one or more HTML files (you may have helped me build it). I want to connect it to a local tool, and it needs the dashboard location on disk.'
          : 'I have a dashboard on this computer — a website made of one or more HTML files (you may have helped me build it). I want to connect it to a local tool, and it needs the dashboard location on disk.';
        return [
          intro,
          '',
          'Please reply with:',
          '1) The absolute path to the dashboard. If it is a folder, give the folder that directly contains index.html. If it is a single file, give the full path to that .html file.',
          '2) Whether it is a folder or a single file.',
          '',
          'If you are not sure where it is, search my common locations — Desktop, Documents, Downloads, and any project folders — for index.html or other .html files, and list each candidate with its full absolute path.',
          '',
          'Use forward slashes in the path, and keep the answer short.',
        ].join('\\n');
      }
      function currentPrompt() {
        var el = document.getElementById('cd-desc');
        return promptFor(el ? el.value : '');
      }
      body.innerHTML =
        '<div class="cd-step">' +
          '<p>Lattice can serve <strong>your own</strong> dashboard at this address, with your data behind it. Point it at your dashboard on this computer — the files stay where they are, and your edits show up on refresh.</p>' +
        '</div>' +
        '<div class="cd-step">' +
          '<h4>1 &middot; Folder or single file?</h4>' +
          '<p>If your dashboard is a <strong>folder</strong> (an <code>index.html</code> plus other files), you will give the folder path. If it is a single <code>.html</code> file, give that file path.</p>' +
        '</div>' +
        '<div class="cd-step">' +
          '<h4>2 &middot; Not sure where it lives? Ask Claude</h4>' +
          '<p>Describe your dashboard or type its name, then copy the prompt and paste it into Claude to find the exact path on your computer.</p>' +
          '<textarea class="cd-desc" id="cd-desc" placeholder="e.g. my fund track record dashboard"></textarea>' +
          '<p class="cd-sub">Prompt to copy (this is what Claude will see):</p>' +
          '<textarea class="cd-prompt" id="cd-prompt" readonly aria-label="Prompt to paste into Claude"></textarea>' +
          '<div class="cd-row"><button class="cd-btn" id="cd-copy" type="button">Copy prompt</button></div>' +
        '</div>' +
        '<div class="cd-step">' +
          '<h4>3 &middot; Paste the path and connect</h4>' +
          '<div class="cd-row">' +
            '<input class="cd-path" id="cd-path" type="text" placeholder="e.g. C:/Users/you/my-dashboard" aria-label="Dashboard path" />' +
            '<button class="cd-btn cd-primary" id="cd-connect" type="button">Connect</button>' +
          '</div>' +
        '</div>' +
        '<div class="cd-status" id="cd-status"></div>';

      var statusEl = document.getElementById('cd-status');
      function showStatus(cls, html) {
        if (!statusEl) return;
        statusEl.className = 'cd-status ' + cls;
        statusEl.innerHTML = html;
      }
      var liveLinks =
        ' <a href="/" target="_blank" rel="noopener">open it</a>' +
        ' (the built-in Lattice view is at <a href="/lattice" target="_blank" rel="noopener">/lattice</a>).';

      var descEl = document.getElementById('cd-desc');
      var promptEl = document.getElementById('cd-prompt');
      function refreshPrompt() { if (promptEl) promptEl.value = currentPrompt(); }
      if (descEl) descEl.addEventListener('input', refreshPrompt);
      refreshPrompt();

      var copyBtn = document.getElementById('cd-copy');
      if (copyBtn) copyBtn.addEventListener('click', function () {
        var text = currentPrompt();
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function () {
            copyBtn.textContent = 'Copied!';
            window.setTimeout(function () { copyBtn.textContent = 'Copy prompt'; }, 1500);
          });
        } else if (promptEl) {
          promptEl.focus();
          promptEl.select();
        }
      });

      var connectBtn = document.getElementById('cd-connect');
      if (connectBtn) connectBtn.addEventListener('click', function () {
        var input = document.getElementById('cd-path');
        var path = input ? input.value.trim() : '';
        if (!path) { showStatus('err', 'Enter the path to your dashboard first.'); return; }
        withBusy(connectBtn, function () {
          return fetchJson('/api/connect/dashboard', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: path }),
          }).then(function (d) {
            showStatus('ok', 'Connected ' + (d.mode === 'dir' ? 'folder' : 'file') + ' — opening your dashboard…');
            window.setTimeout(function () { window.location.href = '/'; window.location.reload(); }, 350);
          }).catch(function (err) {
            showStatus('err', escapeHtml(err.message || 'Could not connect that path.'));
          });
        });
      });

      fetchJson('/api/connect/dashboard').then(function (d) {
        if (d && d.path) {
          showStatus('ok', 'Currently connected: <code>' + escapeHtml(d.path) + '</code> (' + (d.mode === 'dir' ? 'folder' : 'file') + ') —' + liveLinks);
          var input = document.getElementById('cd-path');
          if (input && !input.value) input.value = d.path;
          cdSetDashboardConnected(true);
        }
      }).catch(function () { /* no connection yet */ });
    }

    // The top-bar dashboard button is state-aware: "Connect dashboard" opens the
    // connect panel; once a dashboard is connected it becomes "Go to Dashboard"
    // and opens the served dashboard (/) in a new tab.
    var cdDashboardConnected = false;
    function cdApplyConnectButton() {
      var btn = document.getElementById('connect-dash-btn');
      if (!btn) return;
      var label = btn.querySelector('.connect-dash-label');
      if (cdDashboardConnected) {
        if (label) label.textContent = 'Go to Dashboard';
        btn.title = 'Open your dashboard in a new tab';
      } else {
        if (label) label.textContent = 'Connect dashboard';
        btn.title = 'Connect your own dashboard';
      }
    }
    function cdSetDashboardConnected(connected) {
      cdDashboardConnected = !!connected;
      cdApplyConnectButton();
    }
    function cdRefreshConnectButton() {
      fetchJson('/api/connect/dashboard')
        .then(function (d) { cdSetDashboardConnected(d && d.path); })
        .catch(function () { /* leave the button as-is on error */ });
    }
    function cdOpenConnectModal() { renderConnectDashboard(cdOpenModal('Connect a dashboard')); }

    (function cdWireButtons() {
      var connectBtn = document.getElementById('connect-dash-btn');
      if (connectBtn) connectBtn.addEventListener('click', function () {
        if (cdDashboardConnected) window.open('/', '_blank', 'noopener');
        else cdOpenConnectModal();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') cdCloseModal();
      });
      cdRefreshConnectButton();
    })();
`;
