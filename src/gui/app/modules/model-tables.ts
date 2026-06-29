// Auto-composed segment of the GUI client script (see modules/index.ts). The Model
// "Tables" view — a tiered schema explorer (Source · inputs / Model · entities /
// Derived · AI loop / Surface · app) with an Entity/Field toggle, tier-visibility
// chips, and a click-to-open detail panel (fields + caveats). Built from the data
// already loaded at boot (state.entities); no extra fetch. Must stay INSIDE the
// client IIFE (uses state/displayFor/isJunction/escapeHtml); inserted before
// createDatabaseWizardJs. renderModelTables(host) is called from the Model view's
// Graph|Tables toggle (system-tables segment).
export const modelTablesJs = `
    // The four tiers, source → surface (mirrors the data-model layering).
    var MT_LAYERS = [
      { id: 'source', name: 'Source \\u00b7 inputs', short: 'Source' },
      { id: 'model', name: 'Model \\u00b7 entities', short: 'Model' },
      { id: 'derived', name: 'Derived \\u00b7 AI loop', short: 'Derived' },
      { id: 'surface', name: 'Surface \\u00b7 app', short: 'Surface' },
    ];
    // Field-tint concept → colour class (CSS .mt-c-<class>).
    var MT_CONCEPTS = {
      pk: 'key', fk: 'key', label: 'identity',
      contact_info: 'contact', location: 'contact',
      narrative: 'content', payload: 'content',
      metric: 'measure', status: 'state', flag: 'state',
      timestamp: 'time', credential: 'secret',
    };
    var MT_DERIVED_RE = /(^|_)(embeddings?|vectors?|proposals?|learnings?|observations?|insights?|predictions?|scores?)(_|$)/i;
    var MT_SURFACE_RE = /(^|_)(settings?|config|auth|oauth|tokens?|sessions?|chat|threads?|messages?|todos?|notifications?|app)(_|$)/i;
    var MT_VECTOR_COL_RE = /(^|_)(embedding|vector)(_|$)/i;

    // MIRROR of src/gui/tier-classify.ts \`classifyTier\` — keep the two in sync (the
    // TS file is the unit-tested source of truth; this is its client copy).
    function mtClassifyTier(t) {
      var name = String((t && t.name) || '').toLowerCase();
      var cols = (t && t.columns) || [];
      if (t && t.connectorToolkit) return 'source';
      if (name === 'files') return 'source';
      if (cols.indexOf('_source_connector_id') !== -1) return 'source';
      if (MT_DERIVED_RE.test(name)) return 'derived';
      for (var i = 0; i < cols.length; i++) { if (MT_VECTOR_COL_RE.test(cols[i])) return 'derived'; }
      if (name === 'secrets') return 'surface';
      if (MT_SURFACE_RE.test(name)) return 'surface';
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

    // Build the tiered model from the entities already loaded at boot. Junctions are
    // excluded (they're relationship edges, not first-class tables) to mirror the
    // brain graph's node set.
    function mtBuildModel() {
      var tables = ((state.entities && state.entities.tables) || []).filter(function (t) {
        return !isJunction(t);
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
        if (ed.type === 'belongsTo') {
          upstream[s].push({ table: t, field: via });
          downstream[t].push({ table: s, field: via });
        } else if (ed.type === 'manyToMany') {
          downstream[s].push({ table: t, field: via });
          downstream[t].push({ table: s, field: via });
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

    // Generic, computed-not-hardcoded caveats (each names the tables it affects).
    function mtCaveats(entities) {
      var out = [];
      var derived = entities.filter(function (e) { return e.tier === 'derived'; }).map(function (e) { return e.name; });
      if (derived.length) out.push({ id: 'ai', label: 'AI-derived tables', detail: 'These populate only when an assistant (Claude) is connected.', affects: derived });
      var secret = entities.filter(function (e) { return e.neverShare || e.name === 'secrets'; }).map(function (e) { return e.name; });
      if (secret.length) out.push({ id: 'secret', label: 'Secret-bearing tables', detail: 'Their values are redacted in chat and rendered context (the shape is shown, not the data).', affects: secret });
      var empty = entities.filter(function (e) { return e.rowCount === 0; }).map(function (e) { return e.name; });
      if (empty.length) out.push({ id: 'empty', label: 'Empty tables', detail: 'Tables with no rows are hidden from the brain graph until they have data.', affects: empty });
      return out;
    }

    // ── persisted view state ──────────────────────────────────────────────
    function mtLevel() {
      try { return window.localStorage.getItem('lattice.modeltables.level') === 'field' ? 'field' : 'entity'; }
      catch (e) { return 'entity'; }
    }
    function mtSetLevel(v) { try { window.localStorage.setItem('lattice.modeltables.level', v); } catch (e) {} }

    // Cache the (tiny, schema-only) graph edges across re-renders so toggling the
    // Entity/Field view doesn't refetch. Cleared implicitly on workspace switch
    // because the whole view is rebuilt.
    var mtEdgesCache = null;
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
      var caveats = mtCaveats(entities);
      var lineage = mtLineage(entities, edges);
      var level = mtLevel();

      if (!entities.length) {
        host.innerHTML = '<div class="mt"><div class="muted" style="padding:24px">No tables yet. Add files, connect a source, or connect a database to populate the model.</div></div>';
        return;
      }

      var tiers = MT_LAYERS.map(function (l) {
        var ents = entities.filter(function (e) { return e.tier === l.id; });
        var cards = ents.length
          ? ents.map(function (e) { return mtCardHtml(e, level); }).join('')
          : '<div class="mt-tier-empty">\\u2014</div>';
        return '<div class="mt-tier mt-tier-' + l.id + '">' +
          '<div class="mt-tier-head">' + escapeHtml(l.name) + ' <span class="mt-tier-count">' + ents.length + '</span></div>' +
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
            '<button type="button" class="mt-wire" id="mt-wire-btn" title="Add or edit relationships between tables">+ Wire</button>' +
          '</div>' +
          '<div class="mt-main">' +
            '<div class="mt-tiers">' + tiers + '</div>' +
            '<aside class="mt-detail" id="mt-detail" hidden></aside>' +
          '</div>' +
        '</div>';

      host.querySelectorAll('.mt-seg-btn').forEach(function (b) {
        b.addEventListener('click', function () { mtSetLevel(b.getAttribute('data-mt-level')); renderModelTables(host); });
      });
      // "+ Wire" opens the relationship editor (Settings → Data Model). A button +
      // JS nav (not a static href) so the data-model editor stays drawer-reached.
      var wireBtn = host.querySelector('#mt-wire-btn');
      if (wireBtn) wireBtn.addEventListener('click', function () { location.hash = '#/settings/data-model'; });
      host.querySelectorAll('.mt-card').forEach(function (b) {
        b.addEventListener('click', function () { mtOpenDetail(b.getAttribute('data-table'), null, entities, caveats, lineage); });
      });
      // Field view: clicking a field row traces THAT field's lineage.
      host.querySelectorAll('.mt-field[data-field]').forEach(function (b) {
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          mtOpenDetail(b.getAttribute('data-table'), b.getAttribute('data-field'), entities, caveats, lineage);
        });
      });
    }

    function mtCardHtml(e, level) {
      var head =
        '<button type="button" class="mt-card" data-table="' + escapeHtml(e.name) + '">' +
          '<span class="mt-card-ic">' + e.icon + '</span>' +
          '<span class="mt-card-label">' + escapeHtml(e.label) + '</span>' +
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
    function mtOpenDetail(name, focusField, entities, caveats, lineage) {
      var panel = document.getElementById('mt-detail');
      if (!panel) return;
      var e = lineage.byName[name];
      if (!e) { panel.hidden = true; return; }
      mtHighlight(name, lineage);
      var mine = (caveats || []).filter(function (c) { return c.affects.indexOf(name) !== -1; });
      var fields = e.fields.map(function (f) {
        var on = focusField && f.name === focusField ? ' mt-field-focus' : '';
        return '<div class="mt-detail-field mt-c-' + f.cls + on + '"><span class="mt-field-name">' + escapeHtml(f.name) + '</span>' +
          (f.type ? '<span class="mt-field-type">' + escapeHtml(f.type) + '</span>' : '') + '</div>';
      }).join('');

      var up = lineage.upstream[name] || [];
      var down = lineage.downstream[name] || [];
      function labOf(t) { var d = lineage.byName[t]; return d ? d.label : t; }
      function icOf(t) { var d = lineage.byName[t]; return d ? d.icon : '\\ud83d\\udce6'; }
      function linChip(x) {
        return '<button type="button" class="mt-lin-chip" data-lin="' + escapeHtml(x.table) + '">' +
          '<span class="mt-card-ic">' + icOf(x.table) + '</span>' + escapeHtml(labOf(x.table)) +
          ' <span class="mt-lin-via">' + escapeHtml(x.field) + '</span></button>';
      }
      var upHtml = up.length ? '<div class="mt-detail-sec"><h4>Upstream \\u00b7 sources</h4><div class="mt-lin">' + up.map(linChip).join('') + '</div></div>' : '';
      var downHtml = down.length ? '<div class="mt-detail-sec"><h4>Downstream \\u00b7 consumers</h4><div class="mt-lin">' + down.map(linChip).join('') + '</div></div>' : '';

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

      var caveatHtml = mine.length
        ? '<div class="mt-detail-sec mt-caveats"><h4>Caveats</h4>' + mine.map(function (c) {
            return '<div class="mt-caveat"><div class="mt-caveat-label">' + escapeHtml(c.label) + '</div>' +
              '<div class="mt-caveat-detail">' + escapeHtml(c.detail) + '</div></div>';
          }).join('') + '</div>'
        : '';
      var rows = e.rowCount === null ? '\\u2014' : String(e.rowCount);
      panel.innerHTML =
        '<div class="mt-detail-head"><span class="mt-card-ic">' + e.icon + '</span>' +
          '<span class="mt-detail-title">' + escapeHtml(e.label) + '</span>' +
          '<button type="button" class="mt-detail-close" id="mt-detail-close" aria-label="Close">\\u2715</button></div>' +
        '<div class="mt-detail-sub">table \\u00b7 ' + e.fields.length + ' fields \\u00b7 ' + rows + ' rows</div>' +
        flHtml + upHtml + downHtml +
        '<div class="mt-detail-sec"><h4>Fields</h4>' + fields + '</div>' +
        caveatHtml +
        '<a class="mt-detail-open" href="#/fs/' + encodeURIComponent(e.name) + '">Open object \\u2192</a>';
      panel.hidden = false;
      var close = document.getElementById('mt-detail-close');
      if (close) close.addEventListener('click', function () { panel.hidden = true; mtHighlight(null, lineage); });
      // Lineage chips navigate the detail panel to the linked table.
      panel.querySelectorAll('.mt-lin-chip').forEach(function (b) {
        b.addEventListener('click', function () { mtOpenDetail(b.getAttribute('data-lin'), null, entities, caveats, lineage); });
      });
    }
`;
