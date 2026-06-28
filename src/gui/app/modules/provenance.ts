// Data-provenance views (object-type page + single-row panel). For an object,
// show WHERE its data came from across the raw / computed / observation tiers,
// as a force-directed graph or a table. The graph reuses the shared, out-of-band
// force-graph renderer (loaded like the brain graph via /gui-assets); when that
// renderer isn't available the view degrades gracefully to the table form.
// Vocabulary is generic (object / raw / computed / observation) — no domain
// coupling to any particular dataset.
export const provenanceJs = `
    var provenanceView = {};   // per-table 'graph' | 'table' (default graph)
    var _provGraphModule;      // cached dynamic import of the renderer
    var provGraphHandle = null;

    function loadProvGraphRenderer() {
      if (!_provGraphModule) _provGraphModule = import('/gui-assets/force-graph.mjs');
      return _provGraphModule;
    }

    var PROV_TIER_META = {
      object: { icon: '\\u25C9', radius: 26 },
      raw: { icon: '\\u{1F4E5}', radius: 18 },
      computed: { icon: '\\u2699', radius: 18 },
      observation: { icon: '\\u2728', radius: 13 },
    };
    function provTierMeta(type) { return PROV_TIER_META[type] || PROV_TIER_META.observation; }

    // Map the /api/provenance payload to the generic force-graph node/edge shape.
    function buildProvenanceModel(payload) {
      var src = (payload && payload.nodes) ? payload.nodes : [];
      var nodes = src.map(function (n) {
        var m = provTierMeta(n.type);
        return {
          id: n.id,
          label: n.label,
          icon: m.icon,
          radius: m.radius,
          cls: 'pvnode-' + n.type,
          title: n.label + (n.count != null ? ' \\u00B7 ' + n.count : ''),
          type: n.type, kind: n.kind, table: n.table, rowId: n.rowId, count: n.count,
        };
      });
      var ids = {};
      nodes.forEach(function (n) { ids[n.id] = true; });
      var edges = ((payload && payload.edges) ? payload.edges : [])
        .filter(function (e) { return ids[e.source] && ids[e.target]; })
        .map(function (e) {
          return {
            source: e.source, target: e.target, cls: 'pv-edge', marker: 'fk',
            title: String(e.relation || '').replace(/_/g, ' '),
          };
        });
      return { nodes: nodes, edges: edges };
    }

    function provenanceLegendHtml() {
      return '<div class="dm-legend pv-legend">' +
        '<span class="pv-sw pvnode-raw"></span>Raw' +
        '<span class="pv-sw pvnode-computed"></span>Computed' +
        '<span class="pv-sw pvnode-observation"></span>AI observation' +
        '<span class="pv-sw pvnode-object"></span>Object' +
        '</div>';
    }

    var PROV_TIERS = [
      { type: 'raw', label: 'Raw sources' },
      { type: 'computed', label: 'Computed' },
      { type: 'observation', label: 'AI observations' },
    ];
    function provenanceTableHtml(payload) {
      var nodes = (payload && payload.nodes) ? payload.nodes : [];
      var edges = (payload && payload.edges) ? payload.edges : [];
      var relBySource = {};
      edges.forEach(function (e) { relBySource[e.source] = e.relation; });
      var sections = PROV_TIERS.map(function (t) {
        var rows = nodes.filter(function (n) { return n.type === t.type; });
        if (!rows.length) return '';
        var body = rows.map(function (n) {
          var href = (n.table && n.rowId)
            ? '#/fs/' + encodeURIComponent(n.table) + '/' + encodeURIComponent(n.rowId)
            : (n.table ? '#/fs/' + encodeURIComponent(n.table) : '');
          var name = href ? '<a href="' + href + '">' + escapeHtml(n.label) + '</a>' : escapeHtml(n.label);
          var rel = String(relBySource[n.id] || '').replace(/_/g, ' ');
          return '<tr><td>' + name + '</td>' +
            '<td><span class="pvchip pvchip-' + n.type + '">' + escapeHtml(t.label) + '</span></td>' +
            '<td>' + escapeHtml(n.kind || '') + '</td>' +
            '<td>' + escapeHtml(rel) + '</td>' +
            '<td class="num">' + (n.count != null ? n.count : '\\u2014') + '</td></tr>';
        }).join('');
        return '<tr class="pv-tier-row"><th colspan="5">' + escapeHtml(t.label) + '</th></tr>' + body;
      }).join('');
      if (!sections) return '<div class="fs-empty">No sources recorded yet for this object.</div>';
      return '<table class="pv-table"><thead><tr>' +
        '<th>Source</th><th>Tier</th><th>Kind</th><th>Relationship</th><th class="num">Count</th>' +
        '</tr></thead><tbody>' + sections + '</tbody></table>';
    }

    function renderProvenanceGraph(mount, payload) {
      var model = buildProvenanceModel(payload);
      if (!model.nodes.length) {
        mount.innerHTML = '<div class="fs-empty">No sources recorded yet for this object.</div>';
        return;
      }
      loadProvGraphRenderer().then(function (mod) {
        if (!document.body.contains(mount)) return; // navigated away while loading
        if (provGraphHandle) { try { provGraphHandle.stop(); } catch (e) {} provGraphHandle = null; }
        mount.innerHTML = '';
        provGraphHandle = mod.createForceGraph(mount, {
          nodes: model.nodes,
          edges: model.edges,
          reducedMotion: (typeof graphReducedMotion === 'function') ? graphReducedMotion() : false,
          onNode: function (node) {
            if (node.table && node.rowId) {
              location.hash = '#/fs/' + encodeURIComponent(node.table) + '/' + encodeURIComponent(node.rowId);
            } else if (node.table) {
              location.hash = '#/fs/' + encodeURIComponent(node.table);
            }
          },
        });
      }).catch(function () {
        // Renderer not available (e.g. assets not built) — fall back to the table.
        mount.innerHTML =
          '<div class="prov-fallback muted">Interactive graph unavailable \\u2014 showing sources as a table.</div>' +
          provenanceTableHtml(payload);
      });
    }

    // Object-type page: provenance-centric (graph default, with a graph/table
    // toggle and a "List view" escape hatch to the row tile grid).
    function renderProvenance(content, table, mode) {
      var myGen = renderGen;
      // Files are a SOURCE layer, not a provenance object — their page is the
      // on-disk folder hierarchy.
      if (table === 'files') { renderFilesRootView(content); return; }
      if (!tableByName(table)) {
        setContent(content, myGen, '<div class="placeholder">Unknown entity: ' + escapeHtml(table) + '</div>');
        return;
      }
      mode = (mode === 'table') ? 'table' : 'graph';
      provenanceView[table] = mode;
      if (provGraphHandle) { try { provGraphHandle.stop(); } catch (e) {} provGraphHandle = null; }
      var d = displayFor(table);
      fetchJson('/api/provenance?table=' + encodeURIComponent(table)).then(function (payload) {
        if (myGen !== renderGen) return; // superseded by a newer navigation
        var count = ((payload && payload.nodes) ? payload.nodes : [])
          .filter(function (n) { return n.type !== 'object'; }).length;
        content.innerHTML =
          '<a class="breadcrumb" href="#/graph">\\u2190 Brain Graph</a>' +
          '<div class="view-header">' +
            '<span class="entity-icon">' + d.icon + '</span>' +
            '<h1>' + escapeHtml(d.label) + '</h1>' +
            '<span class="count">' + count + ' source' + (count === 1 ? '' : 's') + '</span>' +
            '<div class="actions">' +
              '<a class="btn primary" href="' + fsHref([table, 'new']) + '">New ' + escapeHtml(d.label) + '</a>' +
              '<button class="btn' + (mode === 'graph' ? ' pv-active' : '') + '" id="pv-view-graph" type="button">Graph</button>' +
              '<button class="btn' + (mode === 'table' ? ' pv-active' : '') + '" id="pv-view-table" type="button">Table</button>' +
              '<button class="btn" id="pv-view-list" type="button">List view</button>' +
            '</div>' +
          '</div>' +
          (mode === 'graph' ? provenanceLegendHtml() : '') +
          '<div id="prov-mount" class="prov-mount' + (mode === 'table' ? ' prov-mount-table' : '') + '"></div>';
        var mount = content.querySelector('#prov-mount');
        if (mode === 'table') mount.innerHTML = provenanceTableHtml(payload);
        else renderProvenanceGraph(mount, payload);
        var bg = content.querySelector('#pv-view-graph');
        var bt = content.querySelector('#pv-view-table');
        var bl = content.querySelector('#pv-view-list');
        if (bg) bg.addEventListener('click', function () { renderProvenance(content, table, 'graph'); });
        if (bt) bt.addEventListener('click', function () { renderProvenance(content, table, 'table'); });
        if (bl) bl.addEventListener('click', function () { fsObjectView[table] = 'list'; renderFsCollection(content, [table]); });
      }).catch(function (err) {
        if (myGen !== renderGen) return;
        setContent(content, myGen, '<div class="placeholder"><h2>Failed</h2>' +
          escapeHtml(err && err.message ? err.message : String(err)) + '</div>');
      });
    }

    // Single-row detail: a collapsed "Data provenance" section, lazy-loaded on
    // first open (zero extra egress on the initial row paint).
    function renderProvenancePanel(host, table, id) {
      if (!host) return;
      host.innerHTML =
        '<details class="prov-panel"><summary>Data provenance</summary>' +
        '<div class="prov-panel-body" data-loaded="0"></div></details>';
      var det = host.querySelector('details');
      var body = host.querySelector('.prov-panel-body');
      if (!det || !body) return;
      det.addEventListener('toggle', function () {
        if (!det.open || body.getAttribute('data-loaded') === '1') return;
        body.setAttribute('data-loaded', '1');
        body.innerHTML = '<div class="muted" style="padding:8px">Loading\\u2026</div>';
        fetchJson('/api/provenance/row?table=' + encodeURIComponent(table) + '&id=' + encodeURIComponent(id))
          .then(function (payload) { body.innerHTML = provenanceTableHtml(payload); })
          .catch(function (err) {
            body.innerHTML = '<div class="muted" style="padding:8px">Failed to load provenance: ' +
              escapeHtml(err && err.message ? err.message : String(err)) + '</div>';
          });
      });
    }
`;
