// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const eventStreamJs = `    // ────────────────────────────────────────────────────────────
    // Background-render progress — render events arrive over the multiplexed
    // /api/stream WebSocket (render-snapshot + render-progress). Per-table state is
    // folded into the renderProgress map, which drives the aggregate "Rendering N%…"
    // pill in the header (the feedback surface). Row COUNTS come only from
    // /api/entities — the terminal 'done' event does ONE reconciling refetch (never
    // per table: that refetch storm was the flashing-div bug).
    // ────────────────────────────────────────────────────────────
    // { [table]: { pct, rendered, total, done, error } } — the live render state.
    var renderProgress = {};
    // Whether a workspace render is currently in flight.
    var renderPhaseRunning = false;
    // Fold one render event into the renderProgress map.
    function onRenderEvent(e) {
      if (!e) return;
      if (e.kind === 'error') {
        renderPhaseRunning = false;
        var t = e.table;
        if (t) {
          renderProgress[t] = { pct: e.pct || 0, rendered: 0, total: 0, done: false, error: true };
        }
        return;
      }
      if (e.kind === 'done') {
        // Whole-render completion: mark everything done, then do the single
        // reconciling refetch (the only guaranteed terminal — an abort emits no
        // per-table events at all).
        renderPhaseRunning = false;
        Object.keys(renderProgress).forEach(function (table) {
          var s = renderProgress[table];
          if (s) s.done = true;
        });
        if (realtimePending) { clearTimeout(realtimePending); realtimePending = null; }
        afterMutation().catch(function () { /* swallow — next action retries */ });
        return;
      }
      if (!e.table) return;
      renderPhaseRunning = true;
      var done = e.kind === 'table-done';
      renderProgress[e.table] = {
        pct: e.pct,
        rendered: e.entitiesRendered,
        total: e.entitiesTotal,
        done: done,
        error: false,
      };
    }
    // Paint from a full snapshot (initial connect / status fetch): the snapshot
    // carries { phase, tables: { [t]: { pct, entitiesRendered, entitiesTotal,
    // done } } }. Fold each table into the map.
    function applyRenderSnapshot(snap) {
      if (!snap) return;
      renderPhaseRunning = snap.phase === 'running';
      Object.keys(snap.tables || {}).forEach(function (table) {
        var s = snap.tables[table];
        if (!s) return;
        renderProgress[table] = {
          pct: s.pct,
          rendered: s.entitiesRendered,
          total: s.entitiesTotal,
          done: !!s.done,
          error: false,
        };
      });
      if (snap.phase === 'error' && snap.currentTable) {
        renderProgress[snap.currentTable] = renderProgress[snap.currentTable] || { pct: 0 };
        renderProgress[snap.currentTable].error = true;
      }
    }
    // Aggregate the per-table render progress into the single top-right status:
    // "Rendering N%…" while any table is mid-render, cleared once all are done.
    function updateRenderStatus() {
      var active = Object.keys(renderProgress).filter(function (t) {
        var s = renderProgress[t];
        return s && !s.done && !s.error;
      });
      if (!active.length) { clearStatus('render'); return; }
      var sum = 0;
      active.forEach(function (t) { sum += (renderProgress[t].pct || 0); });
      setStatus({
        id: 'render',
        kind: 'accent',
        text: 'Rendering ' + Math.round(sum / active.length) + '%…',
        priority: 20,
        sticky: true,
      });
    }

    // Render snapshot + progress are applied from the multiplexed /api/stream
    // WebSocket: the server replays a render-snapshot on connect (so a tab that
    // connects mid- or post-render paints correctly) and streams render-progress
    // events thereafter. See dispatchStreamMessage / startEventStream.

`;
