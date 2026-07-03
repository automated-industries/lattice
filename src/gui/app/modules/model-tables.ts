// Auto-composed segment of the GUI client script (see modules/index.ts). The Model
// "Tables" view — a tiered schema explorer (Inputs / Derived Tables / Computed
// Tables) with an Entity/Field toggle and a click-to-open
// detail panel (fields + table/field lineage). Built from state.entities + the
// server graph edges (/api/graph?schema=1). Must stay INSIDE the
// client IIFE (uses state/displayFor/isJunction/escapeHtml); inserted before
// createDatabaseWizardJs. renderModelTables(host) is called from the Model view's
// Graph|Tables toggle (system-tables segment).
export const modelTablesJs = `
    // The three tiers: Inputs (ingested/connected) → Derived Tables (materialized/
    // authored) → Computed Tables (live read-only projections; empty until the
    // computed-tables feature lands).
    var MT_LAYERS = [
      { id: 'source', name: 'Inputs', short: 'Inputs' },
      { id: 'model', name: 'Derived Tables', short: 'Derived' },
      { id: 'computed', name: 'Computed Tables', short: 'Computed' },
    ];
    // Field-tint concept → colour class (CSS .mt-c-<class>).
    var MT_CONCEPTS = {
      pk: 'key', fk: 'key', label: 'identity',
      contact_info: 'contact', location: 'contact',
      narrative: 'content', payload: 'content',
      metric: 'measure', status: 'state', flag: 'state',
      timestamp: 'time', credential: 'secret',
    };
    // MIRROR of src/gui/tier-classify.ts \`classifyTier\` — keep the two in sync
    // (the TS file is the unit-tested source of truth; this is its client copy).
    // Same checks, same order: computed (authoritative — a projection may surface
    // provenance columns from its base) → source (explicit provenance) → model.
    function mtClassifyTier(t) {
      var name = String((t && t.name) || '').toLowerCase();
      var cols = (t && t.columns) || [];
      if (t && t.computedTable) return 'computed';
      if (t && t.origin === 'source') return 'source';
      if (t && t.connectorToolkit) return 'source';
      if (name === 'files') return 'source';
      if (cols.indexOf('_source_connector_id') !== -1) return 'source';
      return 'model';
    }

    // Classify a column → concept (cosmetic field tint), by name. A mis-tinted new
    // column still renders fine; this only drives colour grouping.
    function mtConceptFor(col) {
      var c = String(col || '').toLowerCase();
      if (c === 'id') return 'pk';
      if (c.slice(-3) === '_id') return 'fk';
      if (c.slice(-3) === '_at' || c.slice(-5) === '_date') return 'timestamp';
      if (c.slice(-5) === '_json' || c === 'metadata') return 'payload';
      if (/(token|secret|password|api_key|credential)/.test(c)) return 'credential';
      if (/(email|phone|url|link|address)/.test(c)) return 'contact_info';
      if (/(city|country|location|region|latitude|longitude)/.test(c)) return 'location';
      if (/(count|total|amount|quantity|size|weight|score|seq|rank|price)/.test(c)) return 'metric';
      if (/(^is_|_flag$|enabled|active|done|pinned|archived)/.test(c)) return 'flag';
      if (/(note|description|content|body|summary|narrative|comment)/.test(c)) return 'narrative';
      if (c === 'name' || c === 'title' || c === 'label' || c === 'slug') return 'label';
      return 'status';
    }

    // Build the tiered model from the entities already loaded at boot. Junctions
    // are excluded (they're relationship edges, not first-class tables) to mirror
    // the brain graph's node set, and so is the native \`secrets\` table (a
    // credentials store, not user data).
    function mtBuildModel() {
      var tables = ((state.entities && state.entities.tables) || []).filter(function (t) {
        return !isJunction(t) && t.name !== 'secrets';
      });
      return tables.map(function (t) {
        var d = displayFor(t.name);
        var cols = t.columns || [];
        return {
          name: t.name,
          tier: mtClassifyTier(t),
          label: d.label,
          icon: d.icon,
          rowCount: typeof t.rowCount === 'number' ? t.rowCount : null,
          neverShare: !!t.neverShare,
          computedTable: !!t.computedTable,
          fields: cols.map(function (col) {
            var concept = mtConceptFor(col);
            var ftype = (t.fieldTypes && t.fieldTypes[col]) || (t.columnTypes && t.columnTypes[col]) || '';
            return { name: col, cls: MT_CONCEPTS[concept] || 'state', type: ftype };
          }),
        };
      });
    }

    // ── Lineage (ported pattern: adjacency + up/down-stream traversal) ───────
    // Built from the SAME server-computed edges the graph uses (/api/graph?schema=1)
    // — NOT the client's entity.relations, which a cloud member never receives
    // (relations live in the owner's config). A belongsTo edge is source(child,
    // FK holder) → target(parent), so the parent is UPSTREAM (a source) of the
    // child and the child is DOWNSTREAM (a consumer) of the parent. many-to-many
    // is a symmetric peer link, shown on both sides.
    function mtLineage(entities, edges) {
      var byName = {};
      entities.forEach(function (e) { byName[e.name] = e; });
      var upstream = {}; // name → [{ table, field }] it references (its sources)
      var downstream = {}; // name → [{ table, field }] that reference it (its consumers)
      entities.forEach(function (e) { upstream[e.name] = []; downstream[e.name] = []; });
      (edges || []).forEach(function (ed) {
        var s = String(ed.source).replace(/^table:/, '');
        var t = String(ed.target).replace(/^table:/, '');
        var via = ed.label || '';
        if (!byName[s] || !byName[t] || s === t) return;
        // Each edge carries what it takes to REMOVE it (the chip's ✕): a belongsTo
        // is a FK column on the child (drop via DELETE .../links/<fk>); a m2m is a
        // junction table (drop via DELETE .../entities/<junction>). via is the FK
        // column for belongsTo and the junction table name for m2m (graph label).
        if (ed.type === 'belongsTo') {
          upstream[s].push({ table: t, field: via, kind: 'belongsTo', childTable: s, fk: via });
          downstream[t].push({ table: s, field: via, kind: 'belongsTo', childTable: s, fk: via });
        } else if (ed.type === 'manyToMany') {
          downstream[s].push({ table: t, field: via, kind: 'manyToMany', junction: via });
          downstream[t].push({ table: s, field: via, kind: 'manyToMany', junction: via });
        } else if (ed.type === 'computes') {
          // base → computed view: the base is the view's (upstream) source, the
          // view is the base's (downstream) consumer. Not removable from a chip —
          // the projection is edited/deleted through the computed-table builder.
          upstream[t].push({ table: s, field: via, kind: 'computes' });
          downstream[s].push({ table: t, field: via, kind: 'computes' });
        }
      });
      return { upstream: upstream, downstream: downstream, byName: byName };
    }

    // Highlight the selected card + its directly connected cards in the tier
    // columns (the "see how tables are connected" affordance, without a fragile
    // absolute-positioned edge overlay). Re-applied on every selection.
    function mtHighlight(name, lineage) {
      var up = {}, down = {};
      (lineage.upstream[name] || []).forEach(function (x) { up[x.table] = 1; });
      (lineage.downstream[name] || []).forEach(function (x) { down[x.table] = 1; });
      document.querySelectorAll('.mt-card').forEach(function (c) {
        var t = c.getAttribute('data-table');
        c.classList.remove('mt-sel', 'mt-up', 'mt-down');
        if (t === name) c.classList.add('mt-sel');
        else if (up[t]) c.classList.add('mt-up');
        else if (down[t]) c.classList.add('mt-down');
      });
    }

    // ── persisted view state ──────────────────────────────────────────────
    function mtLevel() {
      try { return window.localStorage.getItem('lattice.modeltables.level') === 'field' ? 'field' : 'entity'; }
      catch (e) { return 'entity'; }
    }
    function mtSetLevel(v) { try { window.localStorage.setItem('lattice.modeltables.level', v); } catch (e) {} }

    // Cache the (tiny, schema-only) graph edges across re-renders so toggling the
    // Entity/Field view doesn't refetch. This lives in the client IIFE for the
    // SPA's lifetime and is NOT cleared by a re-render, so a workspace switch must
    // reset it (mtResetState, from reloadEverything) or the explorer draws the
    // previous workspace's edges + lineage.
    var mtEdgesCache = null;
    // Schema-editing modes (ported from the schema-explorer pattern). Two toggles:
    //   • "+ Wire" → pick/drag a SOURCE table onto a TARGET to LINK them (a
    //     many-to-many relationship) via POST /api/schema/junctions.
    //   • "Merge"  → pick/drag a SOURCE table onto a TARGET to MERGE source into
    //     target (move the rows in, then remove the emptied source) via
    //     POST /api/schema/entities/:source/merge — reversible from history.
    // Either mode works by CLICK (source, then target) or by DRAG (source onto
    // target). While a source is chosen, invalid targets are greyed out. The
    // relationship edges themselves are drawn as SVG connectors over the columns.
    var mtMode = null; // null | 'wire' | 'merge'
    var mtPickFrom = null; // source table chosen by the first click (click flow)
    var mtDragFrom = null; // source table while a drag is in progress (drag flow)
    var mtSuppressClick = false; // swallow the click a completed drag may emit
    // Reset all cross-render Tables-explorer state. Called on a workspace switch
    // (reloadEverything) — these module-scope vars otherwise persist the PREVIOUS
    // workspace's edges + an in-flight wire/merge selection into the new one.
    function mtResetState() {
      mtEdgesCache = null;
      mtMode = null;
      mtPickFrom = null;
      mtDragFrom = null;
      mtSuppressClick = false;
    }
    function renderModelTables(host) {
      if (!host) return;
      if (mtEdgesCache) { mtRenderTables(host, mtEdgesCache); return; }
      fetchJson('/api/graph?schema=1')
        .then(function (g) { mtEdgesCache = (g && g.edges) || []; mtRenderTables(host, mtEdgesCache); })
        .catch(function () { mtRenderTables(host, []); });
    }

    function mtRenderTables(host, edges) {
      // Re-resolve the live mount by id: the edges fetch is async, and a route
      // re-render in the meantime can replace #model-tables-host — filling the
      // passed (now-detached) node would silently render into nothing.
      var live = document.getElementById('model-tables-host');
      if (live) host = live;
      if (!host) return;
      var entities = mtBuildModel();
      var lineage = mtLineage(entities, edges);
      var level = mtLevel();

      if (!entities.length) {
        host.innerHTML = '<div class="mt"><div class="muted" style="padding:24px">No tables yet. Add files, connect a source, or connect a database to populate the model.</div></div>';
        return;
      }

      var tiers = MT_LAYERS.map(function (l) {
        var ents = entities.filter(function (e) { return e.tier === l.id; });
        // NESTED (belongsTo) tables render INDENTED under their parent — depth
        // per nesting level, parent-first, cycle-safe. A table whose belongsTo
        // parent is outside this tier (or graph-hidden) stays a root. Link LINES
        // are for many-to-many only (mtDrawEdges); nesting shows containment.
        var inTier = {};
        ents.forEach(function (e) { inTier[e.name] = e; });
        var childrenIn = {};
        var isChild = {};
        ents.forEach(function (e) {
          (lineage.upstream[e.name] || []).forEach(function (u) {
            if (u.kind === 'belongsTo' && inTier[u.table] && u.table !== e.name) {
              (childrenIn[u.table] = childrenIn[u.table] || []).push(e.name);
              isChild[e.name] = 1;
            }
          });
        });
        var seenNest = {};
        var ordered = [];
        function mtWalk(name, depth) {
          if (seenNest[name]) return; // first parent wins; cycles terminate
          seenNest[name] = 1;
          ordered.push({ e: inTier[name], depth: depth });
          (childrenIn[name] || []).sort().forEach(function (c) { mtWalk(c, depth + 1); });
        }
        ents.forEach(function (e) { if (!isChild[e.name]) mtWalk(e.name, 0); });
        ents.forEach(function (e) { if (!seenNest[e.name]) mtWalk(e.name, 0); }); // pure-cycle leftovers
        var cards = ordered.length
          ? ordered.map(function (o) {
              var html = mtCardHtml(o.e, level);
              return o.depth > 0
                ? '<div class="mt-nest" style="margin-left:' + (o.depth * 16) + 'px">' + html + '</div>'
                : html;
            }).join('')
          : '<div class="mt-tier-empty">\\u2014</div>';
        // The Computed Tables tier header carries the "+ New" entry point to
        // the computed-table builder (computed views are created there, not
        // through the entity wizard).
        var newBtn = l.id === 'computed'
          ? '<button type="button" class="mt-tier-new" id="mt-computed-new" title="New computed view">+ New</button>'
          : '';
        return '<div class="mt-tier mt-tier-' + l.id + '">' +
          '<div class="mt-tier-head">' + escapeHtml(l.name) + ' <span class="mt-tier-count">' + ents.length + '</span>' + newBtn + '</div>' +
          '<div class="mt-tier-body">' + cards + '</div></div>';
      }).join('');

      host.innerHTML =
        '<div class="mt">' +
          '<div class="mt-bar">' +
            '<span class="mt-bar-label">View</span>' +
            '<div class="mt-seg">' +
              '<button type="button" class="mt-seg-btn' + (level === 'entity' ? ' on' : '') + '" data-mt-level="entity">Entity</button>' +
              '<button type="button" class="mt-seg-btn' + (level === 'field' ? ' on' : '') + '" data-mt-level="field">Field</button>' +
            '</div>' +
          '</div>' +
          '<div class="mt-main">' +
            '<div class="mt-tiers">' + tiers + '</div>' +
            '<aside class="mt-detail" id="mt-detail" hidden></aside>' +
          '</div>' +
        '</div>';

      host.querySelectorAll('.mt-seg-btn').forEach(function (b) {
        b.addEventListener('click', function () { mtSetLevel(b.getAttribute('data-mt-level')); renderModelTables(host); });
      });
      var newComputed = document.getElementById('mt-computed-new');
      if (newComputed) newComputed.addEventListener('click', function () { location.hash = '#/computed/new'; });
      host.querySelectorAll('.mt-card').forEach(function (b) {
        b.addEventListener('click', function () {
          if (wmSuppressClick) return; // a wire/merge drag just completed — ignore the trailing click
          mtOpenDetail(b.getAttribute('data-table'), null, entities, lineage);
        });
      });
      // Field view: clicking a field row traces THAT field's lineage.
      host.querySelectorAll('.mt-field[data-field]').forEach(function (b) {
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          mtOpenDetail(b.getAttribute('data-table'), b.getAttribute('data-field'), entities, lineage);
        });
      });
      // Table cards are wire/merge objects, driven by the global Wire/Merge buttons
      // above the tab line: drag one card onto another to link, Shift-drag to merge.
      if (typeof wmWire === 'function') wmWire(host);
      // Draw the relationship connectors over the tier columns + keep them in sync.
      mtSetupEdges();
    }

    // ── Wire / Merge interaction (click flow + drag flow + grey-out) ─────────
    // A target is INVALID while a source is held if it is the source itself, a
    // junction (not normally rendered as a card), a computed table (a read-only
    // projection — it can be neither linked nor merged into), or — in WIRE mode —
    // already linked to the source (an existing many-to-many edge, mirroring the
    // server's duplicate-junction guard). MERGE accepts any other non-junction
    // table; the server still enforces row caps / inbound-FK and reports them.
    function mtInvalidTarget(source, table) {
      if (table === source) return true;
      var ents = (state.entities && state.entities.tables) || [];
      for (var i = 0; i < ents.length; i++) {
        if (ents[i].name === table && (isJunction(ents[i]) || ents[i].computedTable)) return true;
      }
      if (mtMode === 'wire') {
        // Invalid when the pair is ALREADY connected — by a many-to-many OR a
        // belongsTo nesting (either direction): the two are mutually exclusive.
        var already = (mtEdgesCache || []).some(function (e) {
          if (e.type !== 'manyToMany' && e.type !== 'belongsTo') return false;
          var s = String(e.source).replace(/^table:/, '');
          var t = String(e.target).replace(/^table:/, '');
          return (s === source && t === table) || (s === table && t === source);
        });
        if (already) return true;
      }
      return false;
    }
    // Grey out (and, via CSS pointer-events:none, make undroppable) every invalid
    // target while a source is held. The source keeps its pointer events so a
    // re-click cancels; it is highlighted separately (.mt-wire-from).
    function mtMarkInvalidTargets(host, source) {
      host.querySelectorAll('.mt-card').forEach(function (c) {
        var t = c.getAttribute('data-table');
        if (t !== source && mtInvalidTarget(source, t)) c.classList.add('mt-card-disabled');
        else c.classList.remove('mt-card-disabled');
      });
    }
    function mtClearInvalidTargets(host) {
      host.querySelectorAll('.mt-card.mt-card-disabled').forEach(function (c) {
        c.classList.remove('mt-card-disabled');
      });
    }

    // Click flow in a mode: first click picks the source (re-render highlights it
    // + greys invalid targets); re-clicking it cancels; clicking a different valid
    // card performs the action (wire or merge).
    function mtModeClick(host, table) {
      if (!mtPickFrom) { mtPickFrom = table; renderModelTables(host); return; }
      if (mtPickFrom === table) { mtPickFrom = null; renderModelTables(host); return; } // re-click source → cancel
      if (mtInvalidTarget(mtPickFrom, table)) return; // greyed/invalid target — ignore
      mtModeAct(host, mtPickFrom, table);
    }

    // Run the active mode's action on source→target, then leave the mode.
    function mtModeAct(host, source, target) {
      var mode = mtMode;
      mtMode = null; mtPickFrom = null; mtDragFrom = null;
      if (mode === 'merge') mtMergeEntities(host, source, target);
      else mtCreateJunction(host, source, target);
    }

    // Wire: POST a many-to-many junction linking the two tables, then refresh.
    function mtCreateJunction(host, left, right) {
      var toast = typeof showToast === 'function' ? showToast : function () {};
      fetch('/api/schema/junctions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ left: left, right: right }),
      })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
        .then(function (res) {
          if (!res.ok) { toast('Link failed: ' + ((res.body && res.body.error) || 'could not link'), {}); renderModelTables(host); return; }
          mtEdgesCache = null; // a new junction edge exists → re-fetch the graph edges
          toast('Linked ' + displayFor(left).label + ' \\u2194 ' + displayFor(right).label, {});
          var done = function () { renderModelTables(host); };
          if (typeof refreshEntities === 'function') refreshEntities().then(done, done); else done();
        })
        .catch(function () { toast('Link failed', {}); renderModelTables(host); });
    }

    // Merge: POST source→target; the server moves the rows then removes the
    // emptied source (reversible from history). Refresh entities + edges after.
    function mtMergeEntities(host, source, target) {
      var toast = typeof showToast === 'function' ? showToast : function () {};
      fetch('/api/schema/entities/' + encodeURIComponent(source) + '/merge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: target }),
      })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
        .then(function (res) {
          if (!res.ok) { toast('Merge failed: ' + ((res.body && res.body.error) || 'could not merge'), {}); renderModelTables(host); return; }
          mtEdgesCache = null; // the source table is gone → re-fetch the graph edges
          var moved = (res.body && res.body.movedRows) || 0;
          toast('Merged ' + displayFor(source).label + ' into ' + displayFor(target).label + ' (' + moved + (moved === 1 ? ' row' : ' rows') + ') \\u00b7 undo from history', {});
          var done = function () { renderModelTables(host); };
          if (typeof refreshEntities === 'function') refreshEntities().then(done, done); else done();
        })
        .catch(function () { toast('Merge failed', {}); renderModelTables(host); });
    }

    // Drag flow: press on a card, drag it onto another, release to act. Only
    // initiates in a mode; a plain click (no movement past the threshold) falls
    // through to the card's click handler (pick/cancel). Uses Pointer Events
    // (mouse + touch); the drop target is resolved via elementFromPoint, so a
    // pointer-events:none (greyed/invalid) card can never receive a drop. A
    // completed drag sets mtSuppressClick so the synthetic click is swallowed.
    function mtAttachDrag(host, card) {
      card.addEventListener('pointerdown', function (ev) {
        if (!mtMode) return; // dragging only initiates a wire/merge in a mode
        if (ev.button !== undefined && ev.button !== 0) return; // primary button only
        var source = card.getAttribute('data-table');
        var startX = ev.clientX, startY = ev.clientY;
        var dragging = false;
        // Single teardown for EVERY end-of-gesture (drop, cancel, gesture takeover):
        // remove all three document listeners + clear drag state. Without a
        // pointercancel path a touch-scroll / OS gesture leaks listeners and leaves
        // the board stuck greyed-out with .mt-drag-active on the card.
        function teardown() {
          document.removeEventListener('pointermove', onMove, true);
          document.removeEventListener('pointerup', onUp, true);
          document.removeEventListener('pointercancel', onCancel, true);
          card.classList.remove('mt-drag-active');
          mtDragFrom = null;
        }
        function onMove(mv) {
          if (dragging) return;
          if (Math.abs(mv.clientX - startX) + Math.abs(mv.clientY - startY) < 6) return;
          dragging = true;
          mtDragFrom = source;
          card.classList.add('mt-drag-active');
          mtMarkInvalidTargets(host, source);
        }
        function onCancel() {
          if (dragging) mtClearInvalidTargets(host); // undo the grey-out; act on nothing
          teardown();
        }
        function onUp(up) {
          var wasDragging = dragging;
          teardown();
          if (!wasDragging) return; // a click, not a drag — let onclick handle it
          mtSuppressClick = true; // swallow the click this drag emits…
          window.setTimeout(function () { mtSuppressClick = false; }, 0); // …then re-enable
          var el = document.elementFromPoint(up.clientX, up.clientY);
          var targetCard = el && el.closest ? el.closest('.mt-card[data-table]') : null;
          var target = targetCard && targetCard.getAttribute('data-table');
          if (target && target !== source && !mtInvalidTarget(source, target)) {
            mtModeAct(host, source, target);
          } else {
            mtClearInvalidTargets(host); // cancelled / invalid drop — undo the grey-out
          }
        }
        document.addEventListener('pointermove', onMove, true);
        document.addEventListener('pointerup', onUp, true);
        document.addEventListener('pointercancel', onCancel, true);
      });
    }

    // Draw the relationship edges as SVG bezier connectors between the tier-column
    // cards (measured from the live DOM, like the schema-explorer pattern), and
    // redraw on layout changes (detail panel open, resize).
    var mtEdgeRO = null;
    function mtSetupEdges() {
      // Live-query the tiers each time (robust to a re-render replacing the node),
      // and draw after layout + on a short fallback + on resize.
      window.requestAnimationFrame(mtDrawEdges);
      window.setTimeout(mtDrawEdges, 160);
      var host = document.getElementById('model-tables-host');
      var tiers = host && host.querySelector('.mt-tiers');
      if (tiers && typeof ResizeObserver !== 'undefined') {
        // Disconnect the prior observer so they don't accumulate across re-renders
        // (every Entity/Field toggle, wire action, or workspace switch re-renders).
        if (mtEdgeRO) { try { mtEdgeRO.disconnect(); } catch (e) { /* ignore */ } }
        mtEdgeRO = new ResizeObserver(mtDrawEdges);
        mtEdgeRO.observe(tiers);
      }
    }
    function mtDrawEdges() {
      var host = document.getElementById('model-tables-host');
      var tiers = host && host.querySelector('.mt-tiers');
      if (!tiers) return;
      var SVGNS = 'http://www.w3.org/2000/svg';
      var svg = tiers.querySelector('svg.mt-edges');
      if (!svg) {
        svg = document.createElementNS(SVGNS, 'svg');
        svg.setAttribute('class', 'mt-edges');
        tiers.insertBefore(svg, tiers.firstChild);
      }
      while (svg.firstChild) svg.removeChild(svg.firstChild); // SVG nodes built via
      // createElementNS (NOT innerHTML, which parses in the HTML namespace → paths
      // that never render).
      var gr = tiers.getBoundingClientRect();
      var W = tiers.scrollWidth, H = tiers.scrollHeight;
      svg.setAttribute('width', String(W));
      svg.setAttribute('height', String(H));
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      var sx = tiers.scrollLeft, sy = tiers.scrollTop;
      (mtEdgesCache || []).forEach(function (e) {
        // Connector LINES are for many-to-many links plus computed-table
        // projections (drawn dashed) — a belongsTo (1:N) shows as
        // nesting/indentation in the tier list, not a line.
        if (e.type !== 'manyToMany' && e.type !== 'computes') return;
        var s = String(e.source).replace(/^table:/, '');
        var t = String(e.target).replace(/^table:/, '');
        if (s === t) return;
        var a = tiers.querySelector('.mt-card[data-table="' + s + '"]');
        var b = tiers.querySelector('.mt-card[data-table="' + t + '"]');
        if (!a || !b) return;
        var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        var ay = ra.top - gr.top + sy + ra.height / 2;
        var by = rb.top - gr.top + sy + rb.height / 2;
        var d;
        // Same-column cards (their x-ranges overlap) would have a straight link
        // run hidden behind the stacked cards. Loop it out into a side gutter
        // where it reads clearly; the bow scales with the vertical gap. Cards in
        // different columns keep the horizontal S-curve across the gap between them.
        var overlapX = Math.max(ra.left, rb.left) < Math.min(ra.right, rb.right);
        if (overlapX) {
          // The tiers grid wraps to fewer/narrower columns when the Model pane is
          // narrow, so a card's right edge can sit flush against the container's
          // right edge. .mt-tiers is overflow:auto, so a bow past the content box
          // is CLIPPED — the link vanishes even though it's drawn (the "linked but
          // no line in table view" bug). Bow toward whichever side has more room
          // and clamp the control point inside [pad, W-pad] so it can never be
          // clipped; the bow depth still scales with the vertical gap.
          var pad = 4;
          var ax = ra.right - gr.left + sx;
          var bx = rb.right - gr.left + sx;
          var lax = ra.left - gr.left + sx;
          var lbx = rb.left - gr.left + sx;
          var bow = Math.max(44, Math.abs(by - ay) * 0.6);
          var rightAnchor = Math.max(ax, bx);
          var leftAnchor = Math.min(lax, lbx);
          if (W - rightAnchor >= leftAnchor) {
            var gr2 = Math.min(rightAnchor + bow, W - pad);
            d = 'M ' + ax + ' ' + ay + ' C ' + gr2 + ' ' + ay + ', ' + gr2 + ' ' + by + ', ' + bx + ' ' + by;
          } else {
            var gl = Math.max(leftAnchor - bow, pad);
            d = 'M ' + lax + ' ' + ay + ' C ' + gl + ' ' + ay + ', ' + gl + ' ' + by + ', ' + lbx + ' ' + by;
          }
        } else {
          var x1 = ra.right - gr.left + sx, x2 = rb.left - gr.left + sx;
          if (x2 < x1) { x1 = ra.left - gr.left + sx; x2 = rb.right - gr.left + sx; } // target is left of source
          var dx = Math.max(36, Math.abs(x2 - x1) * 0.45);
          d = 'M ' + x1 + ' ' + ay + ' C ' + (x1 + dx) + ' ' + ay + ', ' + (x2 - dx) + ' ' + by + ', ' + x2 + ' ' + by;
        }
        var path = document.createElementNS(SVGNS, 'path');
        path.setAttribute('d', d);
        path.setAttribute('class', e.type === 'computes' ? 'mt-edge mt-edge-computes' : 'mt-edge mt-edge-m2m');
        svg.appendChild(path);
      });
    }

    function mtCardHtml(e, level) {
      var head =
        '<button type="button" class="mt-card" data-table="' + escapeHtml(e.name) + '">' +
          '<span class="mt-card-ic">' + e.icon + '</span>' +
          '<span class="mt-card-label">' + escapeHtml(e.label) + '</span>' +
          // Computed tables (live read-only projections) carry a small \\u0192 flag.
          (e.computedTable ? '<span class="mt-card-flag" title="Computed">\\u0192</span>' : '') +
          '<span class="mt-card-meta">' + e.fields.length + (e.fields.length === 1 ? ' field' : ' fields') + '</span>' +
        '</button>';
      if (level !== 'field') return head;
      var rows = e.fields.map(function (f) {
        return '<li class="mt-field mt-c-' + f.cls + '" data-table="' + escapeHtml(e.name) + '" data-field="' + escapeHtml(f.name) +
          '"><span class="mt-field-name">' + escapeHtml(f.name) + '</span>' +
          (f.type ? '<span class="mt-field-type">' + escapeHtml(f.type) + '</span>' : '') + '</li>';
      }).join('');
      return head + '<ul class="mt-fields">' + rows + '</ul>';
    }

    // Detail panel: fields, table lineage (upstream sources / downstream
    // consumers), and field-level lineage (each FK edge at column granularity).
    // focusField (optional) highlights one field + narrows the field lineage to
    // the edges that touch it — tracing the lineage of an individual field.
    function mtOpenDetail(name, focusField, entities, lineage) {
      var panel = document.getElementById('mt-detail');
      if (!panel) return;
      var e = lineage.byName[name];
      if (!e) { panel.hidden = true; return; }
      mtHighlight(name, lineage);
      var fields = e.fields.map(function (f) {
        var on = focusField && f.name === focusField ? ' mt-field-focus' : '';
        return '<div class="mt-detail-field mt-c-' + f.cls + on + '"><span class="mt-field-name">' + escapeHtml(f.name) + '</span>' +
          (f.type ? '<span class="mt-field-type">' + escapeHtml(f.type) + '</span>' : '') + '</div>';
      }).join('');

      var up = lineage.upstream[name] || [];
      var down = lineage.downstream[name] || [];
      function labOf(t) { var d = lineage.byName[t]; return d ? d.label : t; }
      function icOf(t) { var d = lineage.byName[t]; return d ? d.icon : '\\ud83d\\udce6'; }
      function linChip(x, removable) {
        var rm = removable
          ? '<span class="mt-lin-x" role="button" tabindex="0" title="Remove this link"' +
              ' data-rm-kind="' + escapeHtml(x.kind || '') + '"' +
              ' data-rm-child="' + escapeHtml(x.childTable || '') + '"' +
              ' data-rm-fk="' + escapeHtml(x.fk || '') + '"' +
              ' data-rm-junction="' + escapeHtml(x.junction || '') + '">\\u2715</span>'
          : '';
        return '<span class="mt-lin-chip-wrap">' +
          '<button type="button" class="mt-lin-chip" data-lin="' + escapeHtml(x.table) + '">' +
            '<span class="mt-card-ic">' + icOf(x.table) + '</span>' + escapeHtml(labOf(x.table)) +
            ' <span class="mt-lin-via">' + escapeHtml(x.field) + '</span></button>' +
          rm + '</span>';
      }
      var upHtml = up.length ? '<div class="mt-detail-sec"><h4>Upstream \\u00b7 sources</h4><div class="mt-lin">' + up.map(function (x) { return linChip(x, false); }).join('') + '</div></div>' : '';
      // A computes chip has no ✕ — the projection is edited or deleted through
      // the computed-table builder, not unlinked like a relationship.
      var downHtml = down.length ? '<div class="mt-detail-sec"><h4>Downstream \\u00b7 consumers</h4><div class="mt-lin">' + down.map(function (x) { return linChip(x, x.kind !== 'computes'); }).join('') + '</div></div>' : '';

      // Field-level lineage edges (this.<fk> → parent.id ; child.<fk> → this.id).
      var fl = [];
      up.forEach(function (x) {
        if (focusField && x.field !== focusField) return;
        fl.push('<div class="mt-fl"><span class="mt-fl-f">' + escapeHtml(x.field) + '</span> \\u2192 <span class="mt-fl-t">' + escapeHtml(labOf(x.table)) + '</span>.id</div>');
      });
      down.forEach(function (x) {
        if (focusField && focusField !== 'id') return;
        fl.push('<div class="mt-fl"><span class="mt-fl-t">' + escapeHtml(labOf(x.table)) + '</span>.' + escapeHtml(x.field) + ' \\u2192 <span class="mt-fl-f">id</span></div>');
      });
      var flHtml = fl.length
        ? '<div class="mt-detail-sec"><h4>Field lineage' + (focusField ? ' \\u00b7 ' + escapeHtml(focusField) : '') + '</h4>' + fl.join('') + '</div>'
        : (focusField ? '<div class="mt-detail-sec"><h4>Field lineage \\u00b7 ' + escapeHtml(focusField) + '</h4><div class="mt-fl mt-fl-none">No upstream/downstream links for this field.</div></div>' : '');

      var rows = e.rowCount === null ? '\\u2014' : String(e.rowCount);
      // Computed entities: a builder-specific sub-line + actions (edit the
      // definition, run the AI refresh, inspect the compiled SQL lazily).
      var sub = e.computedTable
        ? 'computed view \\u00b7 ' + e.fields.length + (e.fields.length === 1 ? ' field' : ' fields')
        : 'table \\u00b7 ' + e.fields.length + ' fields \\u00b7 ' + rows + ' rows';
      var computedHtml = e.computedTable
        ? '<div class="mt-detail-sec mt-computed-sec">' +
            '<a class="mt-detail-open" href="#/computed/' + encodeURIComponent(e.name) + '">Edit definition \\u2192</a>' +
            '<div class="mt-computed-refresh-row">' +
              '<button type="button" class="btn" id="mt-computed-refresh">Refresh</button>' +
              '<span class="mt-computed-refresh-status" id="mt-computed-refresh-status" aria-live="polite"></span>' +
            '</div>' +
            '<details id="mt-computed-sql"><summary>Definition (SQL)</summary><pre class="mt-computed-sqlpre" id="mt-computed-sqlpre"></pre></details>' +
          '</div>'
        : '';
      panel.innerHTML =
        '<div class="mt-detail-head"><span class="mt-card-ic">' + e.icon + '</span>' +
          '<span class="mt-detail-title">' + escapeHtml(e.label) + '</span>' +
          '<button type="button" class="mt-detail-close" id="mt-detail-close" aria-label="Close">\\u2715</button></div>' +
        '<div class="mt-detail-sub">' + sub + '</div>' +
        computedHtml +
        flHtml + upHtml + downHtml +
        '<div class="mt-detail-sec"><h4>Fields</h4>' + fields + '</div>' +
        '<a class="mt-detail-open" href="#/tables/' + encodeURIComponent(e.name) + '">Open object \\u2192</a>';
      panel.hidden = false;
      if (e.computedTable) mtWireComputedDetail(e.name);
      var close = document.getElementById('mt-detail-close');
      if (close) close.addEventListener('click', function () { panel.hidden = true; mtHighlight(null, lineage); });
      // Lineage chips navigate the detail panel to the linked table.
      panel.querySelectorAll('.mt-lin-chip').forEach(function (b) {
        b.addEventListener('click', function () { mtOpenDetail(b.getAttribute('data-lin'), null, entities, lineage); });
      });
      // The ✕ on a consumer chip removes that link (drop the child's FK, or
      // delete the m2m junction). Both are owner-gated soft-deletes on the server,
      // so they're undoable from history.
      panel.querySelectorAll('.mt-lin-x').forEach(function (x) {
        function go(ev) { ev.preventDefault(); ev.stopPropagation(); mtRemoveLink(x, name); }
        x.addEventListener('click', go);
        x.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') go(ev); });
      });
    }

    // Remove a relationship from a consumer chip's ✕. A belongsTo link drops the
    // child's FK column (DELETE .../entities/<child>/links/<fk>); a many-to-many
    // link deletes the junction table (DELETE .../entities/<junction>). Server
    // soft-deletes both (undoable). On success, drop the edge cache and re-render.
    function mtRemoveLink(x, fromTable) {
      var kind = x.getAttribute('data-rm-kind');
      var url;
      if (kind === 'manyToMany') {
        var j = x.getAttribute('data-rm-junction');
        if (!j) return;
        url = '/api/schema/entities/' + encodeURIComponent(j);
      } else {
        var child = x.getAttribute('data-rm-child');
        var fk = x.getAttribute('data-rm-fk');
        if (!child || !fk) return;
        url = '/api/schema/entities/' + encodeURIComponent(child) + '/links/' + encodeURIComponent(fk);
      }
      x.classList.add('mt-lin-x-busy');
      fetch(url, { method: 'DELETE' }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not remove link');
          if (typeof showToast === 'function') showToast('Link removed', {});
          mtEdgesCache = null; // relationship set changed — refetch edges
          var host = document.getElementById('model-tables-host');
          if (host) renderModelTables(host);
        });
      }).catch(function (err) {
        x.classList.remove('mt-lin-x-busy');
        if (typeof showToast === 'function') showToast(err.message, { type: 'error' });
      });
    }

    // Detail-panel wiring for a computed entity: "Refresh" streams the AI fill's
    // per-field NDJSON progress into the one-line status, and the "Definition
    // (SQL)" details block fetches the compiled SELECT lazily on first open.
    function mtWireComputedDetail(name) {
      var btn = document.getElementById('mt-computed-refresh');
      var status = document.getElementById('mt-computed-refresh-status');
      if (btn && status) btn.addEventListener('click', function () {
        btn.disabled = true;
        status.textContent = 'Refreshing\\u2026';
        iiStreamNdjson('/api/computed-tables/' + encodeURIComponent(name) + '/refresh', {}, function (evt) {
          if (evt.phase === 'field') status.textContent = evt.message || ('Filling ' + evt.field + '\\u2026');
          else if (evt.phase === 'field-done') {
            status.textContent = evt.error
              ? evt.field + ' failed \\u2014 ' + evt.error
              : evt.field + ': filled ' + (evt.filled || 0);
          } else if (evt.phase === 'error') {
            status.textContent = 'Refresh failed: ' + (evt.message || 'error');
            btn.disabled = false;
          } else if (evt.done) {
            status.textContent = 'Refreshed';
            btn.disabled = false;
          }
        });
      });
      var details = document.getElementById('mt-computed-sql');
      var pre = document.getElementById('mt-computed-sqlpre');
      var sqlLoaded = false;
      if (details && pre) details.addEventListener('toggle', function () {
        if (!details.open || sqlLoaded) return;
        sqlLoaded = true;
        pre.textContent = 'Loading\\u2026';
        fetchJson('/api/computed-tables/' + encodeURIComponent(name))
          .then(function (d) { pre.textContent = (d && d.sql) || 'No compiled SQL \\u2014 the definition may have failed to register.'; })
          .catch(function (err) {
            sqlLoaded = false; // allow a retry on the next open
            pre.textContent = 'Failed to load: ' + err.message;
          });
      });
    }
`;
