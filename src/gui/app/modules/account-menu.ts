// Auto-composed segment of the GUI client script (see modules/index.ts). The
// header account control has two modes, keyed on managed-model-auth:
//   • Normal install: the connected model account + a Disconnect action (connect
//     itself happens at the first-run wall, connect-wall.ts). Shown once connected.
//   • Managed/hosted deployment: the signed-in identity + a Log out action (the
//     operator owns the model credential, so there is nothing to disconnect).
export const accountMenuJs = `    // ── Header account menu ────────────────────
    function initAccountMenu() {
      var wrap = document.getElementById('account');
      var btn = document.getElementById('account-btn');
      var menu = document.getElementById('account-menu');
      var head = document.getElementById('account-menu-head');
      var disconnect = document.getElementById('account-disconnect');
      var logout = document.getElementById('account-logout');
      if (!wrap || !btn || !menu || !head || !disconnect || !logout) return;
      fetchJson('/api/assistant/config').then(function (cfg) {
        if (cfg && cfg.managedModelAuth === true) {
          // Managed/hosted: show the signed-in identity + Log out, not connect state.
          disconnect.hidden = true;
          fetchJson('/api/userconfig/identity').then(function (id) {
            var name = id && id.display_name ? id.display_name : '';
            var email = id && id.email ? id.email : '';
            head.textContent = name && email ? ('Logged in as ' + name + ' (' + email + ')')
              : email ? ('Logged in as ' + email)
              : name ? ('Logged in as ' + name)
              : 'Logged in';
          }).catch(function () { head.textContent = 'Logged in'; });
          if (cfg.logoutUrl) {
            logout.hidden = false;
            logout.addEventListener('click', function () { window.location.assign(cfg.logoutUrl); });
          } else {
            logout.hidden = true; // identity-only; no dead action without a target
          }
          wrap.hidden = false;
        } else {
          // Normal install: connected model account + Disconnect. Show once connected.
          logout.hidden = true;
          disconnect.hidden = false;
          head.textContent = 'Connected with Claude';
          wrap.hidden = !(cfg && cfg.connected);
        }
      }).catch(function () {});
      function closeMenu() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
      function openMenu() { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (menu.hidden) openMenu(); else closeMenu();
      });
      document.addEventListener('click', function (e) {
        if (!menu.hidden && !wrap.contains(e.target)) closeMenu();
      });
      disconnect.addEventListener('click', function () {
        closeMenu();
        if (!window.confirm('Disconnect Claude? You will not be able to use Lattice while Claude is disconnected.')) return;
        fetchJson('/api/assistant/oauth', { method: 'DELETE' }).then(function () {
          wrap.hidden = true;
          // Back to the wall — and a clean reboot once reconnected.
          showConnectWall(function () { location.reload(); });
        }).catch(function (err) {
          if (typeof showToast === 'function') showToast('Disconnect failed: ' + (err && err.message ? err.message : 'try again'), { type: 'error' });
        });
      });
    }
`;
