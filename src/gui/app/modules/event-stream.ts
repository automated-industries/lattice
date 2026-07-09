// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const eventStreamJs = `    // ────────────────────────────────────────────────────────────
    // Background-render progress — render events arrive over the multiplexed
    // /api/stream WebSocket (render-snapshot + render-progress). The per-table
    // display lives in the MARKDOWN column tree: while a render runs, table
    // nodes not yet rendered this pass FADE; the node currently rendering shows
    // an in-node progress bar (determinate when per-entity counts exist);
    // table-done un-fades that node in place. Row COUNTS come only from
    // /api/entities — render events drive the overlay + ONE reconciling refetch
    // on completion (never per table: that refetch storm was the flashing-div
    // bug). The aggregate "Rendering N%" pill stays in the header — it is the
    // only feedback when the Markdown column is hidden.
    // ────────────────────────────────────────────────────────────
    // { [table]: { pct, rendered, total, done, error } } — the live render state,
    // re-applied to tree nodes after every tree rebuild (renderOutputsMarkdown
    // wipes the DOM overlays but not this map).
    var renderProgress = {};
    // Whether a workspace render is currently in flight. Drives the fade: a
    // table with NO entry in renderProgress while running is "not rendered yet"
    // — unchanged tables may emit ZERO events (deferred progress), and a
    // skipped-fresh open emits only the single terminal done, so fades must
    // derive from phase + map absence, never from waiting on per-table events.
    var renderPhaseRunning = false;
    function treeNodeRow(table) {
      var sel = '.mdt-node[data-table="' + (window.CSS && CSS.escape ? CSS.escape(table) : table) + '"] > .mdt-row';
      return document.querySelector(sel);
    }
    function applyNodeProgress(table) {
      var row = treeNodeRow(table);
      if (!row) return;
      var st = renderProgress[table];
      row.classList.remove('mdt-render-pending');
      if (st && st.error) {
        row.classList.remove('is-rendering');
        row.classList.add('is-render-error');
        return;
      }
      row.classList.remove('is-render-error');
      row.classList.add('is-rendering');
      var fill = row.querySelector('.mdt-render-fill');
      if (!fill) {
        fill = document.createElement('div');
        fill.className = 'mdt-render-fill';
        row.appendChild(fill);
      }
      var determinate = st && st.total > 0;
      fill.classList.toggle('indet', !determinate);
      if (determinate) fill.style.width = Math.max(0, Math.min(100, Math.round(st.pct || 0))) + '%';
    }
    function clearNodeProgress(table) {
      var row = treeNodeRow(table);
      if (!row) return;
      row.classList.remove('is-rendering', 'is-render-error', 'mdt-render-pending');
      var fill = row.querySelector('.mdt-render-fill');
      if (fill) fill.remove();
    }
    // Repaint the whole tree from the render state: fades for not-yet-rendered
    // nodes, bars for in-flight ones, nothing for finished ones. Called on every
    // render event AND at the end of renderOutputsMarkdown so overlays survive a
    // tree rebuild. No-op when nothing is rendering.
    function reapplyTreeProgress() {
      var nodes = document.querySelectorAll('#nav-md-tree .mdt-node[data-table]');
      nodes.forEach(function (node) {
        var table = node.getAttribute('data-table');
        var row = node.querySelector(':scope > .mdt-row');
        if (!row) return;
        var st = renderProgress[table];
        if (!renderPhaseRunning) {
          row.classList.remove('mdt-render-pending', 'is-rendering', 'is-render-error');
          var f0 = row.querySelector('.mdt-render-fill');
          if (f0) f0.remove();
          return;
        }
        if (!st) {
          // Running, no events for this table yet → not rendered this pass.
          row.classList.add('mdt-render-pending');
          return;
        }
        if (st.done && !st.error) { clearNodeProgress(table); return; }
        applyNodeProgress(table);
      });
    }
    // Fold one render event into the renderProgress map + repaint the tree.
    function onRenderEvent(e) {
      if (!e) return;
      if (e.kind === 'error') {
        renderPhaseRunning = false;
        var t = e.table;
        if (t) {
          renderProgress[t] = { pct: e.pct || 0, rendered: 0, total: 0, done: false, error: true };
        }
        reapplyTreeProgress();
        return;
      }
      if (e.kind === 'done') {
        // Whole-render completion: un-fade EVERYTHING unconditionally (the only
        // guaranteed terminal — an abort emits no per-table events at all),
        // refresh the tree data (nodes that went empty→populated re-query), and
        // do the single reconciling refetch.
        renderPhaseRunning = false;
        Object.keys(renderProgress).forEach(function (table) {
          var s = renderProgress[table];
          if (s) s.done = true;
        });
        reapplyTreeProgress();
        if (typeof renderOutputs === 'function') renderOutputs();
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
      // Per-table events repaint DOM ONLY — no refetches (a 23-table render must
      // not fire 23 reconciles; the single terminal done does the one refresh).
      reapplyTreeProgress();
    }
    // Paint from a full snapshot (initial connect / status fetch): the snapshot
    // carries { phase, tables: { [t]: { pct, entitiesRendered, entitiesTotal,
    // done } } }. Fold each table in and repaint.
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
      reapplyTreeProgress();
    }
    // Aggregate the per-table render progress into the single top-right status:
    // "Rendering N%…" while any table is mid-render, cleared once all are done.
    // (Header-level feedback; the per-node display lives in the Markdown tree.)
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
