// Auto-composed segment of the GUI client script (see modules/index.ts). A single
// top-right status indicator: independent producers (workspace switch, app update,
// offline queue, ingest, background render) register a status by id, and exactly
// ONE shows at a time — highest priority, ties → most recent. Because every status
// stays registered until cleared, a lower-priority status that is still active
// auto-resumes when a higher one clears (a queue, not a stack). Mounts into the tab
// strip's #tabstrip-status slot (falls back to the topbar). Must stay INSIDE the
// client IIFE; inserted after realtimeFeedJs.
export const statusIndicatorJs = `
    var appStatuses = {};
    var appStatusSeq = 0;

    // Resolve (creating once) the #app-status node, re-homing it into the tab
    // strip's status slot if a tab re-render replaced its container.
    function appStatusHost() {
      var slot = document.getElementById('tabstrip-status') || document.querySelector('header.topbar');
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
      var spin = s.spinner ? '<span class="spinner" aria-hidden="true"></span>' : '';
      el.className = 'app-status' + (s.kind ? ' app-status-' + s.kind : '');
      el.innerHTML = spin + '<span class="app-status-text">' + escapeHtml(s.text || '') + '</span>';
      el.hidden = false;
    }

    /** Register / update a status. {id, text, kind?, priority?, sticky?, spinner?, ttl?}.
     *  A non-sticky status auto-clears after ttl (default 4s) so a transient note
     *  can never get stuck on screen. */
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
