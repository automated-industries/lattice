// Auto-composed segment of the GUI client script (see modules/index.ts). A single
// top-right status indicator: independent producers (workspace switch, app update,
// offline queue, ingest, background render) register a status by id, and exactly
// ONE shows at a time — highest priority, ties → most recent. Because every status
// stays registered until cleared, a lower-priority status that is still active
// auto-resumes when a higher one clears (a queue, not a stack). Mounts into the
// header status slot (falls back to the topbar). Must stay INSIDE the client IIFE;
// inserted after realtimeFeedJs.
export const statusIndicatorJs = `
    var appStatuses = {};
    var appStatusSeq = 0;

    // Resolve (creating once) the #app-status node, re-homing it into the header
    // status slot (where the version used to sit) if a re-render replaced its
    // container. Falls back to the topbar.
    function appStatusHost() {
      var slot = document.getElementById('header-status-slot') ||
        document.querySelector('header.topbar');
      if (!slot) return null;
      var el = document.getElementById('app-status');
      if (!el) {
        el = document.createElement('span');
        el.id = 'app-status';
        el.className = 'app-status';
        el.hidden = true;
        slot.appendChild(el);
      } else if (el.parentNode !== slot) {
        slot.appendChild(el);
      }
      return el;
    }

    function pickActiveStatus() {
      var best = null;
      Object.keys(appStatuses).forEach(function (id) {
        var s = appStatuses[id];
        if (!best || s.priority > best.priority || (s.priority === best.priority && s.seq > best.seq)) {
          best = s;
        }
      });
      return best;
    }

    function renderAppStatus() {
      var el = appStatusHost();
      if (!el) return;
      var s = pickActiveStatus();
      if (!s) { el.hidden = true; el.innerHTML = ''; return; }
      // A determinate progress value (0..1) renders a small bar in place of the
      // spinner — real feedback for a long operation (e.g. an update download),
      // never an endless spinner. Indeterminate (null) keeps the spinner.
      var hasBar = typeof s.progress === 'number' && isFinite(s.progress);
      var spin = (s.spinner && !hasBar) ? '<span class="spinner" aria-hidden="true"></span>' : '';
      var pct = hasBar ? Math.max(0, Math.min(100, Math.round(s.progress * 100))) : 0;
      var bar = hasBar
        ? '<span class="app-status-bar"><span class="app-status-bar-fill" style="width:' + pct + '%"></span></span>'
        : '';
      el.className = 'app-status' + (s.kind ? ' app-status-' + s.kind : '');
      el.innerHTML = spin + '<span class="app-status-text">' + escapeHtml(s.text || '') + '</span>' + bar;
      el.hidden = false;
    }

    /** Register / update a status. {id, text, kind?, priority?, sticky?, spinner?, ttl?, progress?}.
     *  A non-sticky status auto-clears after ttl (default 4s) so a transient note
     *  can never get stuck on screen. \`progress\` (0..1) draws a determinate bar. */
    function setStatus(opts) {
      if (!opts || !opts.id) return;
      var prev = appStatuses[opts.id];
      if (prev && prev.timer) clearTimeout(prev.timer);
      var s = {
        id: opts.id,
        kind: opts.kind || 'info',
        text: opts.text || '',
        priority: opts.priority != null ? opts.priority : 10,
        sticky: !!opts.sticky,
        spinner: opts.spinner !== false,
        progress: (opts.progress != null && isFinite(opts.progress)) ? opts.progress : null,
        seq: ++appStatusSeq,
        timer: null,
      };
      appStatuses[opts.id] = s;
      if (!s.sticky) {
        s.timer = setTimeout(function () { clearStatus(opts.id); }, opts.ttl || 4000);
      }
      renderAppStatus();
    }

    function clearStatus(id) {
      var s = appStatuses[id];
      if (s && s.timer) clearTimeout(s.timer);
      delete appStatuses[id];
      renderAppStatus();
    }
`;
