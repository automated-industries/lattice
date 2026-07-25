// Auto-composed segment of the GUI client script (see modules/index.ts). The
// activity-menu-anchored BACKGROUND-TASK tracker: one place for every long-running
// background job — ingestion, file processing, linkage/merge — rendered as rows
// (with a progress bar when determinate) at the top of the activity popover, plus
// a running indicator on the activity pill. Generalizes the status-indicator
// registry to a LIST (many concurrent tasks). Producers call bgTask(id, {...}) and
// drive the returned {update, done, fail} handle. Must stay INSIDE the client IIFE;
// inserted after activityHeaderJs (it renders into the activity block).
export const bgTasksJs = `
    var bgTasks = {};
    var bgTaskSeq = 0;

    function renderBgTasks() {
      var pill = document.getElementById('activity-running');
      var ids = Object.keys(bgTasks);
      var running = 0;
      for (var i = 0; i < ids.length; i++) { if (bgTasks[ids[i]].state === 'running') running++; }
      // Pill: a running dot while any task is active (count when >1).
      if (pill) {
        if (running > 0) { pill.hidden = false; pill.textContent = running > 1 ? String(running) : ''; }
        else { pill.hidden = true; pill.textContent = ''; }
      }
      var host = document.getElementById('bg-tasks');
      if (!host) return;
      if (ids.length === 0) { host.hidden = true; host.innerHTML = ''; return; }
      // Running tasks pinned above resolved ones; newest first within each group.
      ids.sort(function (a, b) {
        var ra = bgTasks[a].state === 'running' ? 1 : 0;
        var rb = bgTasks[b].state === 'running' ? 1 : 0;
        if (ra !== rb) return rb - ra;
        return bgTasks[b].seq - bgTasks[a].seq;
      });
      host.hidden = false;
      host.innerHTML = ids
        .map(function (id) {
          var t = bgTasks[id];
          var done = t.done || 0;
          var hasBar = t.state === 'running' && typeof t.total === 'number' && t.total > 0;
          var pct = hasBar ? Math.max(0, Math.min(100, Math.round((done / t.total) * 100))) : 0;
          var icon =
            t.state === 'running'
              ? '<span class="lat-spinner bg-task-spin" aria-hidden="true"></span>'
              : t.state === 'failed'
                ? '<span class="bg-task-ic bg-task-fail" aria-hidden="true">!</span>'
                : '<span class="bg-task-ic bg-task-ok" aria-hidden="true">✓</span>';
          var bar = hasBar
            ? '<span class="bg-task-track"><span class="bg-task-fill" style="width:' + pct + '%"></span></span>'
            : '';
          var count = hasBar ? '<span class="bg-task-count">' + done + '/' + t.total + '</span>' : '';
          return (
            '<div class="bg-task bg-task-' + t.state + '">' +
            '<div class="bg-task-row">' + icon +
            '<span class="bg-task-label">' + escapeHtml(t.label || '') + '</span>' + count +
            '</div>' + bar + '</div>'
          );
        })
        .join('');
    }

    function bgTaskRemoveLater(id, ms) {
      var t = bgTasks[id];
      if (!t) return;
      if (t.timer) clearTimeout(t.timer);
      t.timer = setTimeout(function () {
        delete bgTasks[id];
        renderBgTasks();
      }, ms);
    }

    /** Register / resume a background task. opts: {label?, total?, done?}. Returns
     *  {update(done,total), done(label?), fail(msg?)}. Terminal states linger
     *  briefly then auto-remove so the section self-cleans. */
    function bgTask(id, opts) {
      opts = opts || {};
      var t = bgTasks[id];
      if (!t) t = bgTasks[id] = { id: id, seq: ++bgTaskSeq, done: 0 };
      if (t.timer) { clearTimeout(t.timer); t.timer = null; }
      if (opts.label != null) t.label = opts.label;
      else if (t.label == null) t.label = 'Working…';
      if (opts.total != null) t.total = opts.total;
      if (opts.done != null) t.done = opts.done;
      t.state = 'running';
      renderBgTasks();
      return {
        update: function (done, total) {
          var x = bgTasks[id];
          if (!x) return;
          if (done != null) x.done = done;
          if (total != null) x.total = total;
          x.state = 'running';
          renderBgTasks();
        },
        done: function (label) {
          var x = bgTasks[id];
          if (!x) return;
          if (label != null) x.label = label;
          x.state = 'done';
          renderBgTasks();
          bgTaskRemoveLater(id, 2500);
        },
        fail: function (msg) {
          var x = bgTasks[id];
          if (!x) return;
          if (msg != null) x.label = msg;
          x.state = 'failed';
          renderBgTasks();
          bgTaskRemoveLater(id, 6000);
        },
      };
    }

    /** Remove one task immediately (e.g. a workspace switch invalidates it). */
    function clearBgTask(id) {
      var t = bgTasks[id];
      if (!t) return;
      if (t.timer) clearTimeout(t.timer);
      delete bgTasks[id];
      renderBgTasks();
    }

    /** Tear down all tasks (workspace / thread switch). */
    function clearBgTasks() {
      Object.keys(bgTasks).forEach(function (id) {
        if (bgTasks[id].timer) clearTimeout(bgTasks[id].timer);
      });
      bgTasks = {};
      renderBgTasks();
    }
`;
