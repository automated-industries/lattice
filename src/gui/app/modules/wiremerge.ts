// Auto-composed segment of the GUI client script (see modules/index.ts). Global
// Wire / Merge — link two objects (many-to-many) or merge one into another, from
// ANY view. Drag one object onto another to LINK; hold Shift to MERGE. The Wire /
// Merge buttons above the tab line toggle a click-to-pick alternative (click a
// source, then a target) — this is what works on the Graph, where the nodes have
// their own drag. Operates on any element carrying `data-table` (Folders tiles,
// Tables cards, Graph nodes), skipping `data-kind="file"` (rows aren't objects).
// Called from boot() (initWireMerge), so it must stay INSIDE the main client IIFE.
export const wireMergeJs = `
    var wmMode = null;   // null | 'wire' | 'merge' (button-driven click flow)
    var wmPick = null;   // first-picked object in the click flow
    var wmSuppressClick = false;

    // A floating clone of the dragged object that follows the cursor.
    var _wmGhost = null, _wmGhostDX = 0, _wmGhostDY = 0;
    function wmMakeGhost(el, x, y) {
      wmRemoveGhost();
      var r = el.getBoundingClientRect();
      var g = el.cloneNode(true);
      // Append to document.body — NOT the grid. position:fixed is only viewport-
      // relative when no ancestor is a containing block (a transform/filter/etc.);
      // appending under body guarantees that, so the ghost anchors to the cursor
      // instead of being offset by an ancestor's position. Keeps the tile's own
      // classes for its look; explicit width/height below preserve its size.
      g.classList.add('wm-ghost');
      g.removeAttribute('id');
      g.style.width = r.width + 'px';
      g.style.height = r.height + 'px';
      _wmGhostDX = x - r.left; _wmGhostDY = y - r.top;
      document.body.appendChild(g);
      _wmGhost = g;
      wmMoveGhost(x, y);
    }
    function wmMoveGhost(x, y) {
      if (_wmGhost) { _wmGhost.style.left = (x - _wmGhostDX) + 'px'; _wmGhost.style.top = (y - _wmGhostDY) + 'px'; }
    }
    function wmRemoveGhost() { if (_wmGhost && _wmGhost.parentNode) _wmGhost.parentNode.removeChild(_wmGhost); _wmGhost = null; }

    function wmIsJunction(table) {
      var ents = (state.entities && state.entities.tables) || [];
      for (var i = 0; i < ents.length; i++) if (ents[i].name === table) return isJunction(ents[i]);
      return false;
    }
    function wmValidTarget(source, target) {
      return !!source && !!target && source !== target && !wmIsJunction(source) && !wmIsJunction(target);
    }
    function wmToast(msg, err) { if (typeof showToast === 'function') showToast(msg, err ? { type: 'error' } : {}); }
    function wmAfterAct() {
      var done = function () { if (typeof renderRoute === 'function') renderRoute(); };
      if (typeof refreshEntities === 'function') refreshEntities().then(done, done); else done();
    }

    // Link: create a many-to-many junction between the two objects.
    function wmLink(a, b) {
      fetch('/api/schema/junctions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ left: a, right: b }),
      }).then(function (r) { return r.json().then(function (bd) { return { ok: r.ok, body: bd }; }); })
        .then(function (res) {
          if (!res.ok) {
            // "already linked" is not a failure worth surfacing — the desired end
            // state (a link exists between the two) already holds. Fail silently;
            // only toast a genuine error.
            var e = (res.body && res.body.error) || '';
            if (!/already linked/i.test(e)) wmToast('Link failed: ' + (e || 'could not link'), true);
            return;
          }
          wmToast('Linked ' + displayFor(a).label + ' \\u2194 ' + displayFor(b).label);
          wmAfterAct();
        }).catch(function () { wmToast('Link failed', true); });
    }
    // Merge: move a's rows into b, then remove a (reversible; carries links across).
    function wmMerge(a, b) {
      fetch('/api/schema/entities/' + encodeURIComponent(a) + '/merge', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: b }),
      }).then(function (r) { return r.json().then(function (bd) { return { ok: r.ok, body: bd }; }); })
        .then(function (res) {
          if (!res.ok) { wmToast('Merge failed: ' + ((res.body && res.body.error) || 'could not merge'), true); return; }
          var moved = (res.body && res.body.movedRows) || 0;
          wmToast('Merged ' + displayFor(a).label + ' into ' + displayFor(b).label + ' (' + moved + (moved === 1 ? ' row' : ' rows') + ') \\u00b7 undo from history');
          // If we merged away the object we're viewing, follow it to the target.
          if (location.hash === '#/folders/' + encodeURIComponent(a) || location.hash.indexOf('#/fs/' + encodeURIComponent(a) + '/') === 0) {
            location.hash = '#/folders/' + encodeURIComponent(b);
          }
          wmAfterAct();
        }).catch(function () { wmToast('Merge failed', true); });
    }
    function wmAct(source, target, merge) {
      if (!wmValidTarget(source, target)) return;
      if (merge) wmMerge(source, target); else wmLink(source, target);
    }

    // Click-to-pick flow (only while a mode button is on). Returns true if handled.
    function wmModeClick(table) {
      if (!wmMode || !table) return false;
      if (!wmPick) { wmPick = table; wmPaintPicked(); wmRenderButtons(); return true; }
      if (wmPick === table) { wmPick = null; wmPaintPicked(); wmRenderButtons(); return true; } // cancel
      var src = wmPick, mode = wmMode; wmPick = null; wmMode = null;
      document.body.classList.remove('wm-active'); wmPaintPicked(); wmRenderButtons();
      wmAct(src, table, mode === 'merge');
      return true;
    }
    function wmPaintPicked() {
      document.querySelectorAll('.wm-picked').forEach(function (el) { el.classList.remove('wm-picked'); });
      if (wmPick) document.querySelectorAll('[data-table="' + wmPick + '"]').forEach(function (el) { el.classList.add('wm-picked'); });
    }

    // Drag flow (always on): drag one object onto another → link; Shift → merge.
    // onDrop (optional) overrides what a completed drop does: called as
    // onDrop(source, targetTable, ev, merge). The Folders view passes a NEST drop
    // (belongsTo one-to-many) here so a folder drag nests instead of m2m-linking,
    // while other views keep the default link/merge. onDropOut (optional) fires
    // when a drag ends OUTSIDE any valid object (empty space / breadcrumb) — the
    // Folders view uses it to un-nest a dragged child folder.
    function wmAttachDrag(el, onDrop, onDropOut) {
      el.addEventListener('pointerdown', function (ev) {
        if (ev.button !== undefined && ev.button !== 0) return;
        var source = el.getAttribute('data-table');
        if (!source) return;
        // Capture the pointer to this tile so the whole drag streams pointermove to
        // us even if the cursor leaves the tile or the webview would otherwise route
        // the gesture to a native scroll/selection. Chrome works without it; some
        // webviews freeze the ghost (pointermove stops) unless we own the pointer.
        if (ev.pointerId != null && el.setPointerCapture) { try { el.setPointerCapture(ev.pointerId); } catch (e) {} }
        var startX = ev.clientX, startY = ev.clientY, dragging = false, hovered = null;
        function clearHover() { if (hovered) { hovered.classList.remove('wm-drop-target'); hovered = null; } }
        function teardown() {
          document.removeEventListener('pointermove', onMove, true);
          document.removeEventListener('pointerup', onUp, true);
          document.removeEventListener('pointercancel', onCancel, true);
          el.classList.remove('wm-drag-active');
          document.body.classList.remove('wm-dragging', 'wm-drag-merge');
          wmRemoveGhost();
          clearHover();
        }
        function targetAt(x, y) {
          // Hide the floating ghost during the hit-test so elementFromPoint returns
          // the tile UNDER the cursor, not the ghost itself (a clone of the source,
          // so it would resolve to source and fail source!==target). The ghost has
          // pointer-events:none, but not every webview honors that for
          // elementFromPoint — hiding it is the robust, engine-agnostic guarantee.
          var ghostDisp = _wmGhost ? _wmGhost.style.display : null;
          if (_wmGhost) _wmGhost.style.display = 'none';
          var t = document.elementFromPoint(x, y);
          if (_wmGhost) _wmGhost.style.display = ghostDisp || '';
          var c = t && t.closest ? t.closest('[data-table]') : null;
          if (!c || c === el) return null;
          if (c.getAttribute('data-kind') === 'file') return null;
          return wmValidTarget(source, c.getAttribute('data-table')) ? c : null;
        }
        function onMove(mv) {
          if (!dragging) {
            if (Math.abs(mv.clientX - startX) + Math.abs(mv.clientY - startY) < 6) return;
            dragging = true; el.classList.add('wm-drag-active'); document.body.classList.add('wm-dragging');
            wmMakeGhost(el, mv.clientX, mv.clientY); // the dragged object follows the cursor
          }
          wmMoveGhost(mv.clientX, mv.clientY);
          var c = targetAt(mv.clientX, mv.clientY);
          if (c !== hovered) { clearHover(); hovered = c; if (c) c.classList.add('wm-drop-target'); }
          document.body.classList.toggle('wm-drag-merge', !!mv.shiftKey);
        }
        function onCancel() { teardown(); }
        function onUp(up) {
          var wasDragging = dragging, c = wasDragging ? targetAt(up.clientX, up.clientY) : null, merge = !!up.shiftKey;
          teardown();
          if (!wasDragging) return;
          wmSuppressClick = true; window.setTimeout(function () { wmSuppressClick = false; }, 0);
          if (c) { if (onDrop) onDrop(source, c.getAttribute('data-table'), up, merge); else wmAct(source, c.getAttribute('data-table'), merge); }
          else if (onDropOut) onDropOut(source, up);
        }
        document.addEventListener('pointermove', onMove, true);
        document.addEventListener('pointerup', onUp, true);
        document.addEventListener('pointercancel', onCancel, true);
      });
    }

    // Make every wireable [data-table] object in a container draggable + pickable.
    // Rows ("files") are skipped — they're not link/merge objects. onDrop/onDropOut
    // (optional) customize what a drop does (the Folders view nests instead of
    // linking); omitted → default link/merge.
    function wmWire(container, onDrop, onDropOut) {
      if (!container) return;
      container.querySelectorAll('[data-table]').forEach(function (el) {
        if (el.getAttribute('data-kind') === 'file' || el.__wmWired) return;
        el.__wmWired = true;
        wmAttachDrag(el, onDrop, onDropOut);
        el.addEventListener('click', function (e) {
          if (wmSuppressClick) { e.preventDefault(); e.stopPropagation(); return; }
          if (wmMode) { e.preventDefault(); e.stopPropagation(); wmModeClick(el.getAttribute('data-table')); }
        }, true); // capture so a mode pick pre-empts the object's own click
      });
    }

    // The Wire / Merge buttons above the tab line.
    function wmSetMode(mode) {
      wmMode = (wmMode === mode) ? null : mode; wmPick = null;
      document.body.classList.toggle('wm-active', !!wmMode);
      wmPaintPicked(); wmRenderButtons();
    }
    function wmRenderButtons() {
      var w = document.getElementById('wm-wire-btn'), m = document.getElementById('wm-merge-btn');
      if (w) { w.classList.toggle('on', wmMode === 'wire'); w.textContent = wmMode === 'wire' ? (wmPick ? 'Pick target\\u2026' : 'Pick source\\u2026') : 'Link'; }
      if (m) { m.classList.toggle('on', wmMode === 'merge'); m.textContent = wmMode === 'merge' ? (wmPick ? 'Pick target\\u2026' : 'Pick source\\u2026') : 'Merge'; }
    }
    function initWireMerge() {
      var w = document.getElementById('wm-wire-btn'), m = document.getElementById('wm-merge-btn');
      if (w) w.addEventListener('click', function () { wmSetMode('wire'); });
      if (m) m.addEventListener('click', function () { wmSetMode('merge'); });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && wmMode) { wmMode = null; wmPick = null; document.body.classList.remove('wm-active'); wmPaintPicked(); wmRenderButtons(); }
      });
      wmRenderButtons();
    }
`;
