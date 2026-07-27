// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const renderProgressJs = `    // ────────────────────────────────────────────────────────────
    // Shared activity helpers — the operation-icon map and relative-time
    // formatter, used by Version History and the dashboard activity list. The
    // standalone Activity rail was removed in 1.16.1 (redundant with Version
    // History); multiplayer realtime convergence runs on the realtime-change
    // messages of the multiplexed event stream (startEventStream), not on this.
    // ────────────────────────────────────────────────────────────
    var FEED_ICONS = {
      insert: '➕', update: '✏️', delete: '🗑',
      link: '🔗', unlink: '⛓', undo: '↶', redo: '↷', schema: '🛠',
    };
    function relTime(iso) {
      try {
        var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
        if (s < 60) return s + 's ago';
        if (s < 3600) return Math.round(s / 60) + 'm ago';
        if (s < 86400) return Math.round(s / 3600) + 'h ago';
        // Day+ ranges are always relative (no absolute date): days → weeks →
        // months → years, whichever unit the elapsed time first fits.
        var days = Math.floor(s / 86400);
        if (days < 7) return days + (days === 1 ? ' day ago' : ' days ago');
        if (days < 30) { var w = Math.floor(days / 7); return w + (w === 1 ? ' week ago' : ' weeks ago'); }
        if (days < 365) { var mo = Math.floor(days / 30); return mo + (mo === 1 ? ' month ago' : ' months ago'); }
        var y = Math.floor(days / 365); return y + (y === 1 ? ' year ago' : ' years ago');
      } catch (_) { return ''; }
    }

    // ── Live relative timestamps ────────────────────────────────────────────
    // relTime() is a pure formatter, so a label written once is frozen at the value
    // it had when the node was created — which is why an open conversation used to
    // read "0s ago" on every message no matter how long it had been sitting there.
    // Stamping the ISO on the node makes the label RECOMPUTABLE, and one shared
    // interval rewrites every stamped node. One timer for the whole page, not one
    // per bubble: the count of stamped nodes grows with the conversation.
    var REL_TIME_TICK_MS = 30000;
    var relTimeTimer = null;
    // Write a relative-time label AND the machine-readable instant it came from, so
    // the ticker can recompute it later. Always use this instead of assigning
    // textContent directly — an unstamped label can never be refreshed.
    function stampRelTime(el, iso) {
      if (!el) return;
      var when = iso || new Date().toISOString();
      el.setAttribute('data-ts', when);
      el.textContent = relTime(when);
      try { el.title = new Date(when).toLocaleString(); } catch (_) { /* invalid date → no title */ }
    }
    // Recompute every stamped label on the page. Returns how many nodes were
    // refreshed (the tests assert on it; nothing in the app reads it).
    function tickRelTimes() {
      var nodes = document.querySelectorAll('[data-ts]');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var iso = el.getAttribute('data-ts');
        if (!iso) continue;
        var next = relTime(iso);
        if (next && el.textContent !== next) el.textContent = next;
      }
      return nodes.length;
    }
    // Start the one shared ticker. Idempotent — calling it again is a no-op, so a
    // re-boot (workspace switch) can call it without stacking timers.
    function startRelTimeTicker() {
      if (relTimeTimer) return;
      relTimeTimer = setInterval(tickRelTimes, REL_TIME_TICK_MS);
    }

    // Elapsed duration since a start timestamp (ms), for in-progress work like a
    // running upload — no "ago" suffix. Mirrors relTime's unit thresholds.
    function formatElapsed(ms) {
      var s = Math.max(0, Math.floor(ms / 1000));
      if (s < 60) return s + 's';
      if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
      return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    }

`;
