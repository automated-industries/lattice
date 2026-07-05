// Auto-composed segment of the GUI client script (see modules/index.ts). The
// header account control: shows the connected Claude account with a Disconnect
// action. Connect happens at the first-run wall (connect-wall.ts), never here, so
// this is disconnect-only. Hidden until a subscription is connected and in a
// managed deployment (the operator owns the credential, so there is nothing for
// the user to disconnect).
export const accountMenuJs = `    // ── Header account menu (disconnect) ────────────────────
    function initAccountMenu() {
      var wrap = document.getElementById('account');
      var btn = document.getElementById('account-btn');
      var menu = document.getElementById('account-menu');
      var disconnect = document.getElementById('account-disconnect');
      if (!wrap || !btn || !menu || !disconnect) return;
      // Show the control only for a connected, non-managed install.
      fetchJson('/api/assistant/config').then(function (cfg) {
        wrap.hidden = !(cfg && cfg.connected && cfg.managedModelAuth !== true);
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
