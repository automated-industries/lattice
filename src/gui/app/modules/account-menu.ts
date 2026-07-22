// Auto-composed segment of the GUI client script (see modules/index.ts). The
// header account control is one status line + ONE action, keyed on managed-model-auth:
//   • Normal install: "Connected with Claude" + a Disconnect action (connect itself
//     happens at the first-run wall, connect-wall.ts). Shown once connected.
//   • Managed/hosted deployment: the signed-in identity + an "Account settings"
//     action that opens the operator's account page (where balance / billing /
//     sign-out live). The operator owns the model credential — there is nothing to
//     disconnect, so Disconnect is never shown here.
export const accountMenuJs = `    // ── Header account menu ────────────────────
    function initAccountMenu() {
      var wrap = document.getElementById('account');
      var btn = document.getElementById('account-btn');
      var menu = document.getElementById('account-menu');
      var head = document.getElementById('account-menu-head');
      var action = document.getElementById('account-action');
      if (!wrap || !btn || !menu || !head || !action) return;
      function closeMenu() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
      function openMenu() { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
      var onAction = function () {};
      fetchJson('/api/assistant/config').then(function (cfg) {
        if (cfg && cfg.managedModelAuth === true) {
          // Managed/hosted: identity + "Account settings" (→ operator account page).
          fetchJson('/api/userconfig/identity').then(function (id) {
            var name = id && id.display_name ? id.display_name : '';
            var email = id && id.email ? id.email : '';
            head.textContent = name && email ? ('Logged in as ' + name + ' (' + email + ')')
              : email ? ('Logged in as ' + email)
              : name ? ('Logged in as ' + name)
              : 'Logged in with your Lattice account';
          }).catch(function () { head.textContent = 'Logged in with your Lattice account'; });
          // Prepaid token balance + a quick top-up link (managed deployment only).
          if (typeof cfg.balanceCents === 'number') {
            var bal = document.getElementById('account-menu-balance');
            if (!bal) {
              bal = document.createElement('div');
              bal.id = 'account-menu-balance';
              bal.style.cssText = 'padding:6px 12px;font-size:12px;color:var(--muted,#8a8a97);border-top:1px solid var(--border,#2a2a35)';
              if (head.parentNode) head.parentNode.insertBefore(bal, action);
            }
            var amt = '$' + (cfg.balanceCents / 100).toFixed(2);
            var topUrl = cfg.topUpUrl || cfg.accountUrl || '';
            bal.innerHTML = 'Lattice tokens: <strong>' + amt + '</strong>' +
              (topUrl ? ' · <a href="#" id="account-menu-topup">Add tokens</a>' : '');
            if (topUrl) {
              var tu = document.getElementById('account-menu-topup');
              if (tu) tu.addEventListener('click', function (e) { e.preventDefault(); window.location.assign(topUrl); });
            }
          }
          action.textContent = 'Account settings';
          action.classList.remove('danger');
          onAction = function () { if (cfg.accountUrl) window.location.assign(cfg.accountUrl); };
          wrap.hidden = false;
        } else {
          // Normal install: label + Disconnect reflect the ACTIVE backend — a Claude
          // subscription or a connected OpenAI-compatible endpoint. Shown once connected.
          var oai = cfg && cfg.openaiCompat;
          var onOpenai = cfg && cfg.activeProvider === 'openai_compat' && oai && oai.configured;
          head.textContent = onOpenai ? ('Connected to ' + (oai.model || 'your model')) : 'Connected with Claude';
          action.textContent = onOpenai ? 'Disconnect model' : 'Disconnect Claude';
          action.classList.add('danger');
          onAction = function () {
            var label = onOpenai ? 'this model' : 'Claude';
            if (!window.confirm('Disconnect ' + label + '? You will not be able to use Lattice until a model is connected.')) return;
            var endpoint = onOpenai ? '/api/assistant/provider/openai-compat' : '/api/assistant/oauth';
            fetchJson(endpoint, { method: 'DELETE' }).then(function () {
              wrap.hidden = true;
              // Back to the wall — and a clean reboot once reconnected.
              showConnectWall(function () { location.reload(); });
            }).catch(function (err) {
              if (typeof showToast === 'function') showToast('Disconnect failed: ' + (err && err.message ? err.message : 'try again'), { type: 'error' });
            });
          };
          wrap.hidden = !(cfg && cfg.connected);
        }
      }).catch(function () {});
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (menu.hidden) openMenu(); else closeMenu();
      });
      document.addEventListener('click', function (e) {
        if (!menu.hidden && !wrap.contains(e.target)) closeMenu();
      });
      action.addEventListener('click', function () { closeMenu(); onAction(); });
    }
`;
