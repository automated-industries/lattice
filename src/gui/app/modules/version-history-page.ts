// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const versionHistoryPageJs = `    // ────────────────────────────────────────────────────────────
    // Lattice Teams (Project Config + User Config)
    // ────────────────────────────────────────────────────────────
    /**
     * Minimal modal helper for the teams flows. Returns { close } so
     * callers can dismiss imperatively (used by the invite-token modal
     * after copy). opts.onSubmit may return a Promise — the OK button
     * stays disabled until it resolves, then the modal closes.
     */
    function showModal(title, bodyHtml, opts) {
      opts = opts || {};
      var primaryLabel = opts.primaryLabel || 'Save';
      var primaryClass = opts.primaryClass || 'primary';
      var backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML =
        '<div class="modal">' +
          '<div class="modal-head">' + escapeHtml(title) + '</div>' +
          '<div class="modal-body">' + bodyHtml + '</div>' +
          '<div class="modal-foot">' +
            '<button class="btn" data-act="cancel">Cancel</button>' +
            '<button class="btn ' + primaryClass + '" data-act="ok">' + escapeHtml(primaryLabel) + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(backdrop);
      if (opts.onBody) opts.onBody(backdrop);
      function close() { if (backdrop.parentNode) document.body.removeChild(backdrop); }
      backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
      backdrop.querySelector('[data-act="cancel"]').addEventListener('click', close);
      backdrop.querySelector('[data-act="ok"]').addEventListener('click', function () {
        var btn = backdrop.querySelector('[data-act="ok"]');
        if (btn.disabled) return;
        var label = btn.innerHTML;
        var spin = function () {
          btn.disabled = true;
          btn.classList.add('is-busy');
          btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + label;
        };
        var unspin = function () {
          btn.disabled = false;
          btn.classList.remove('is-busy');
          btn.innerHTML = label;
        };
        try {
          var result = opts.onSubmit ? opts.onSubmit(backdrop) : null;
          if (result && typeof result.then === 'function') {
            spin();
            result.then(function () { close(); }).catch(function (err) {
              unspin();
              showToast('Failed: ' + (err && err.message ? err.message : String(err)));
            });
          } else {
            close();
          }
        } catch (err) {
          showToast('Failed: ' + (err && err.message ? err.message : String(err)));
        }
      });
      return { close: close };
    }

    function refreshSettingsRoute() {
      if (location.hash === '#/settings/project-config') renderProjectConfig(document.getElementById('content'));
      else if (location.hash === '#/settings/user-config') renderUserConfig(document.getElementById('content'));
    }

`;
