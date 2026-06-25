// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const eventStreamJs = `    // ────────────────────────────────────────────────────────────
    // Background-render progress — render events arrive over the multiplexed
    // /api/stream WebSocket (render-snapshot + render-progress). A workspace
    // opens/switches instantly and renders its context tree in the background;
    // this paints a per-table % overlay on the dashboard cards (bottom-edge bar +
    // ⟳ pill) and dims the row count until each table completes. Row COUNTS come
    // only from /api/entities — the render events drive only the transient overlay
    // and one reconciling refetch on completion.
    // ────────────────────────────────────────────────────────────
    // { [table]: { pct, rendered, total, done, error } } — the live render state,
    // re-applied to cards after every dashboard rebuild (drawDashboard wipes the
    // DOM overlays but not this map).
    var renderProgress = {};
    // Apply one table's render % to its matching card only (no full rebuild).
    function applyCardProgress(table, pct) {
      if (!table) return;
      var sel = '.card[data-table="' + (window.CSS && CSS.escape ? CSS.escape(table) : table) + '"]';
      var card = document.querySelector(sel);
      if (!card) return;
      var st = renderProgress[table];
      if (st && st.error) {
        card.classList.remove('is-rendering');
        card.classList.add('is-render-error');
        var perr = card.querySelector('.card-render-pct');
        if (perr) perr.textContent = 'error';
        return;
      }
      card.classList.remove('is-render-error');
      var clamped = Math.max(0, Math.min(100, Math.round(pct || 0)));
      card.classList.add('is-rendering');
      var fill = card.querySelector('.card-render-fill');
      if (fill) fill.style.width = clamped + '%';
      var pctEl = card.querySelector('.card-render-pct');
      if (pctEl) pctEl.textContent = 'Rendering ' + clamped + '%...';
    }
    // Clear the overlay for a finished/aborted table.
    function clearCardProgress(table) {
      if (!table) return;
      var sel = '.card[data-table="' + (window.CSS && CSS.escape ? CSS.escape(table) : table) + '"]';
      var card = document.querySelector(sel);
      if (!card) return;
      card.classList.remove('is-rendering', 'is-render-error');
    }
    // Repaint every still-in-flight card from the renderProgress map. Called at
    // the end of drawDashboard so overlays survive a feed-triggered rebuild.
    function reapplyRenderOverlays() {
      Object.keys(renderProgress).forEach(function (table) {
        var st = renderProgress[table];
        if (!st) return;
        if (st.done && !st.error) { clearCardProgress(table); return; }
        applyCardProgress(table, st.pct);
      });
    }
    // Fold one render event into the renderProgress map + paint the card.
    function onRenderEvent(e) {
      if (!e) return;
      if (e.kind === 'error') {
        var t = e.table;
        if (t) {
          renderProgress[t] = { pct: e.pct || 0, rendered: 0, total: 0, done: false, error: true };
          applyCardProgress(t, e.pct || 0);
        }
        return;
      }
      if (e.kind === 'done') {
        // Whole-render completion: clear every overlay and refetch so counts +
        // the open record's rendered context snap to their real values.
        Object.keys(renderProgress).forEach(function (table) {
          var s = renderProgress[table];
          if (s) s.done = true;
          clearCardProgress(table);
        });
        // Force the refresh now that the render is COMPLETE — the rendered context
        // files are fresh on disk. Bypass scheduleRealtimeRefresh's leading-edge
        // coalescing: the originating change's feed event already fired a refresh
        // BEFORE the render finished, which would otherwise leave an open card's
        // rendered-context panel showing the pre-change markdown until a manual
        // reload (the "card context updated only after I refreshed" bug).
        if (realtimePending) { clearTimeout(realtimePending); realtimePending = null; }
        afterMutation().catch(function () { /* swallow — next action retries */ });
        return;
      }
      if (!e.table) return;
      var done = e.kind === 'table-done';
      renderProgress[e.table] = {
        pct: e.pct,
        rendered: e.entitiesRendered,
        total: e.entitiesTotal,
        done: done,
        error: false,
      };
      if (done) {
        // This table finished: clear its overlay IN PLACE. Do NOT reconcile the
        // whole view here — a 23-table render fired ~23 refetch+re-renders of the
        // middle pane (one per table-done), which is the flashing-div symptom the
        // user saw. The single whole-render done event below does one reconcile to
        // snap every count; until then the per-card overlay communicates progress.
        clearCardProgress(e.table);
      } else {
        applyCardProgress(e.table, e.pct);
      }
    }
    // Paint from a full snapshot (initial connect / status fetch): the snapshot
    // carries { phase, tables: { [t]: { pct, entitiesRendered, entitiesTotal,
    // done } } }. Fold each table in and paint.
    function applyRenderSnapshot(snap) {
      if (!snap || !snap.tables) return;
      Object.keys(snap.tables).forEach(function (table) {
        var s = snap.tables[table];
        if (!s) return;
        renderProgress[table] = {
          pct: s.pct,
          rendered: s.entitiesRendered,
          total: s.entitiesTotal,
          done: !!s.done,
          error: false,
        };
        if (s.done) clearCardProgress(table);
        else applyCardProgress(table, s.pct);
      });
      if (snap.phase === 'error') {
        // A whole-render failure with no table attribution still surfaces on the
        // currently-rendering card if we know one.
        if (snap.currentTable) {
          renderProgress[snap.currentTable] = renderProgress[snap.currentTable] || { pct: 0 };
          renderProgress[snap.currentTable].error = true;
          applyCardProgress(snap.currentTable, renderProgress[snap.currentTable].pct);
        }
      }
    }
    // Aggregate the per-table render progress into the single top-right status:
    // "Rendering N%…" while any table is mid-render, cleared once all are done.
    // The per-card progress bars stay (card-scoped, complementary).
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
