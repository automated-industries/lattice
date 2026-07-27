// Auto-composed segment of the GUI client script (see modules/index.ts). The
// header account control is one status line + ONE action, keyed on managed-model-auth:
//   • Normal install: the ACTIVE model source ("Connected with Claude", the cloud
//     account, or the connected endpoint's model) + a Disconnect action for that
//     same source (connect itself happens at the first-run wall, connect-wall.ts).
//     The cloud account additionally shows its remaining balance, or says the
//     balance could not be read — never a zero standing in for an unknown.
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
      // A manual "Check for updates" row — the background poll is periodic, so a user who
      // knows a release is out can pull it now instead of waiting (or restarting).
      var chk = document.getElementById('account-menu-check-updates');
      if (!chk) {
        chk = document.createElement('a');
        chk.id = 'account-menu-check-updates';
        chk.href = '#';
        chk.textContent = 'Check for updates';
        chk.style.cssText = 'display:block;padding:6px 12px;font-size:13px;color:var(--accent,#3b82f6);text-decoration:none;border-top:1px solid var(--border,#2a2a35)';
        if (head.parentNode) head.parentNode.insertBefore(chk, action);
        chk.addEventListener('click', function (e) {
          e.preventDefault();
          closeMenu();
          if (typeof forceUpdateCheck === 'function') forceUpdateCheck('manual');
        });
      }
      var onAction = function () {};
      // Prepaid token balance + a quick top-up link. Used by the managed deployment
      // and by a per-user cloud account. Honest by construction: a balance we could
      // not read is shown as unavailable, never as $0.00 — "we do not know" and
      // "you are out of tokens" send the user to different places.
      function renderBalanceRow(cfg) {
        var known = typeof cfg.balanceCents === 'number';
        if (!known && cfg.balanceUnavailable !== true) return;
        var bal = document.getElementById('account-menu-balance');
        if (!bal) {
          bal = document.createElement('div');
          bal.id = 'account-menu-balance';
          bal.style.cssText = 'padding:6px 12px;font-size:12px;color:var(--muted,#8a8a97);border-top:1px solid var(--border,#2a2a35)';
          if (head.parentNode) head.parentNode.insertBefore(bal, action);
        }
        var topUrl = cfg.topUpUrl || cfg.accountUrl || '';
        var amount = known ? '$' + (cfg.balanceCents / 100).toFixed(2) : 'Balance unavailable';
        bal.innerHTML = 'Lattice tokens: <strong>' + amount + '</strong>' +
          (topUrl ? ' · <a href="#" id="account-menu-topup">Add tokens</a>' : '');
        if (topUrl) {
          var tu = document.getElementById('account-menu-topup');
          if (tu) tu.addEventListener('click', function (e) { e.preventDefault(); window.location.assign(topUrl); });
        }
      }
      // After anything that can remove the active model backend (a disconnect, a
      // sign-out that took the cloud credential with it): re-read the truth from
      // the server and send the user back to the wall when nothing is connected,
      // rather than leaving them in an app where every turn would fail.
      function reflectModelDisconnect() {
        return fetchJson('/api/assistant/config').then(function (c) {
          if (c && c.connected) return;
          wrap.hidden = true;
          showConnectWall(function () { location.reload(); });
        }).catch(function (err) {
          if (typeof showToast === 'function') showToast(connectErrorText(err, 'Could not re-check your model connection \\u2014 reload the page.'), { type: 'error' });
        });
      }
      // ── Workspace-identity sign-in (local launchers only) ──
      // When an identity service is reachable and this is NOT a hosted session
      // (which already carries a verified identity), the menu offers Sign in /
      // signed-in-as + Sign out. Signing in links the hosted account: invited
      // and owned cloud workspaces then appear in the switcher on their own.
      function initIdentityRow(cfg) {
        if (cfg && cfg.managedModelAuth === true) return; // hosted session — identity is injected
        fetchJson('/api/identity/status').then(function (st) {
          if (!st || (st.serviceAvailable !== true && st.linked !== true)) return;
          var row = document.getElementById('account-menu-identity');
          if (!row) {
            row = document.createElement('a');
            row.id = 'account-menu-identity';
            row.href = '#';
            row.style.cssText = 'display:block;padding:6px 12px;font-size:13px;color:var(--accent,#3b82f6);text-decoration:none;border-top:1px solid var(--border,#2a2a35)';
            if (head.parentNode) head.parentNode.insertBefore(row, action);
          }
          function renderRow(status) {
            row.textContent = status.linked
              ? 'Signed in as ' + (status.email || 'your account') + ' — Sign out'
              : 'Sign in to your Lattice account';
            row.onclick = function (e) {
              e.preventDefault();
              closeMenu();
              if (status.linked) {
                // Signing this device out also revokes the model credential minted
                // from the session. The server reports whether the account side
                // actually confirmed that; an unconfirmed revocation is shown as
                // the error it is, because a spendable token may still be live.
                fetchJson('/api/identity/signout', { method: 'POST' }).then(function (r) {
                  renderRow({ linked: false });
                  if (r && r.modelAccess !== 'revoked') {
                    if (typeof showToast === 'function') showToast(r.error || "Signed out on this device, but the account service did not confirm that this device's access was revoked.", { type: 'error' });
                  } else if (typeof showToast === 'function') {
                    showToast('Signed out \\u2014 this device can no longer spend your account tokens.');
                  }
                  return reflectModelDisconnect();
                }).catch(function (err) {
                  if (typeof showToast === 'function') showToast(connectErrorText(err, 'Sign-out did not complete. Try again.'), { type: 'error' });
                });
                return;
              }
              fetchJson('/api/identity/signin/start', { method: 'POST' }).then(function (r) {
                if (!r || !r.verifyUrl) throw new Error('Sign-in did not return a sign-in link. Try again shortly.');
                // Desktop webviews have no tabs — the server-side bridge opens the
                // system browser; a plain browser tab just opens the URL.
                window.open(r.verifyUrl, '_blank');
                showIdentityCodePrompt();
              }).catch(function (err) {
                // The server humanizes this (cause + failing step, no status code);
                // connectErrorText is the backstop for a transport-level rejection.
                if (typeof showToast === 'function') showToast(connectErrorText(err, 'Sign-in did not complete. Try again shortly.'), { type: 'error' });
              });
            };
          }
          renderRow(st);
          // The loopback hand-back completes sign-in without a paste — poll the
          // status briefly after a start so the row flips to signed-in on its own.
          function showIdentityCodePrompt() {
            var code = window.prompt(
              'Finish signing in from your browser. If it shows a code, paste it here — otherwise leave this empty and press OK once the browser says you are signed in.'
            );
            var done = function () {
              fetchJson('/api/identity/status').then(function (st2) {
                renderRow(st2 || { linked: false });
                if (st2 && st2.linked) {
                  if (typeof showToast === 'function') showToast('Signed in as ' + (st2.email || 'your account') + ' — syncing your workspaces…');
                  fetchJson('/api/identity/sync', { method: 'POST' }).then(function (syncRes) {
                    if (syncRes && syncRes.added && syncRes.added.length && typeof showToast === 'function') {
                      showToast(String(syncRes.added.length) + ' cloud workspace' + (syncRes.added.length > 1 ? 's' : '') + ' added — check the switcher.');
                    }
                  }).catch(function () {});
                }
              });
            };
            if (code && code.trim()) {
              fetchJson('/api/identity/signin/complete', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ code: code.trim() }),
              }).then(done).catch(function (err) {
                if (typeof showToast === 'function') showToast(connectErrorText(err, 'That sign-in code was not accepted \\u2014 start the sign-in again.'), { type: 'error' });
              });
            } else {
              done();
            }
          }
        }).catch(function () {});
      }
      fetchJson('/api/assistant/config').then(function (cfg) {
        initIdentityRow(cfg);
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
          renderBalanceRow(cfg);
          action.textContent = 'Account settings';
          action.classList.remove('danger');
          onAction = function () { if (cfg.accountUrl) window.location.assign(cfg.accountUrl); };
          wrap.hidden = false;
        } else {
          // Normal install: label + Disconnect reflect the ACTIVE backend — the
          // account's cloud tokens, a Claude subscription, or a connected
          // OpenAI-compatible endpoint. Shown once one of them is connected.
          var oai = cfg && cfg.openaiCompat;
          var onOpenai = cfg && cfg.activeProvider === 'openai_compat' && oai && oai.configured;
          var cloud = cfg && cfg.latticeCloud;
          var onCloud = cfg && cfg.activeProvider === 'lattice_cloud' && cloud && cloud.configured;
          head.textContent = onCloud ? 'Connected with your Lattice Cloud account'
            : onOpenai ? ('Connected to ' + (oai.model || 'your model'))
            : 'Connected with Claude';
          // The cloud account is the only source that spends a balance, so it is the
          // only one with a balance to report.
          if (onCloud) renderBalanceRow(cfg);
          action.textContent = onCloud ? 'Disconnect Lattice Cloud'
            : onOpenai ? 'Disconnect model'
            : 'Disconnect Claude';
          action.classList.add('danger');
          onAction = function () {
            var label = onCloud ? 'your Lattice Cloud account' : onOpenai ? 'this model' : 'Claude';
            if (!window.confirm('Disconnect ' + label + '? You will not be able to use Lattice until a model is connected.')) return;
            var endpoint = onCloud ? '/api/assistant/provider/lattice-cloud'
              : onOpenai ? '/api/assistant/provider/openai-compat'
              : '/api/assistant/oauth';
            fetchJson(endpoint, { method: 'DELETE' }).then(function () {
              wrap.hidden = true;
              // Back to the wall — and a clean reboot once reconnected.
              showConnectWall(function () { location.reload(); });
            }).catch(function (err) {
              if (typeof showToast === 'function') showToast('Disconnect failed: ' + connectErrorText(err, 'try again'), { type: 'error' });
            });
          };
          // A signed-in cloud account that has spent its balance reports
          // connected:false — and this menu is where its balance and top-up link
          // live, so keep it reachable instead of hiding the way out.
          wrap.hidden = !(cfg && (cfg.connected || (cfg.latticeCloud && cfg.latticeCloud.configured)));
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
