// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const activityHelpersJs = `    // ────────────────────────────────────────────────────────────
    // Toast banner (with optional one-click undo)
    // ────────────────────────────────────────────────────────────
    var activeToast = null;
    var toastDismissTimer = null;
    function showToast(message, opts) {
      opts = opts || {};
      if (activeToast) activeToast.remove();
      if (toastDismissTimer) clearTimeout(toastDismissTimer);
      var toast = document.createElement('div');
      toast.className = 'toast';
      var undoBtn = opts.undo ? '<button class="undo-link" type="button">Undo</button>' : '';
      toast.innerHTML =
        '<span>' + escapeHtml(message) + '</span>' +
        undoBtn +
        '<button class="toast-dismiss" type="button" title="Dismiss">×</button>';
      document.body.appendChild(toast);
      activeToast = toast;

      function close() {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
        if (activeToast === toast) activeToast = null;
      }
      toast.querySelector('.toast-dismiss').addEventListener('click', close);
      if (opts.undo) {
        toast.querySelector('.undo-link').addEventListener('click', function () {
          close();
          if (toastDismissTimer) clearTimeout(toastDismissTimer);
          opts.undo();
        });
      }
      toastDismissTimer = setTimeout(close, opts.duration || 6000);
    }

    /** Standard undo: hit /api/history/undo and refresh views. */
    function undoLast() {
      gaTrack('history_action', { action: 'undo' });
      return fetchJson('/api/history/undo', { method: 'POST' })
        .then(afterMutation)
        .catch(function (err) { showToast('Undo failed: ' + err.message, {}); });
    }

`;
