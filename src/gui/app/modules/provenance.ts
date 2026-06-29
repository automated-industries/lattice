// Data-provenance views (object-type page + single-row panel). For an object,
// show WHERE its data came from across the raw / computed / observation tiers,
// as a TABLE (the single object view — no graph toggle). Vocabulary is generic
// (object / raw / computed / observation) — no domain coupling to any dataset.
export const provenanceJs = `
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

    // Object-type page: the SINGLE object view — the provenance table (where the
    // object's data comes from). No graph/table toggle; reached from the Tables
    // explorer ("Open object" / a tier card) or a brain-graph node, so it belongs
    // to the Tables tab and its back breadcrumb returns to Tables. Nested relation
    // paths still use the row tile grid (renderFsCollection).
    function renderProvenance(content, table) {
      var myGen = renderGen;
      // Files are a SOURCE layer, not a provenance object — their page is the
      // on-disk folder hierarchy.
      if (table === 'files') { renderFilesRootView(content); return; }
      if (!tableByName(table)) {
        setContent(content, myGen, '<div class="placeholder">Unknown entity: ' + escapeHtml(table) + '</div>');
        return;
      }
      var d = displayFor(table);
      fetchJson('/api/provenance?table=' + encodeURIComponent(table)).then(function (payload) {
        if (myGen !== renderGen) return; // superseded by a newer navigation
        // Count the source rows the table actually lists (raw/computed/observation)
        // so the header never disagrees with the body; omit the chip when there are
        // none (no more bare "0 sources").
        var nodes = (payload && payload.nodes) ? payload.nodes : [];
        var count = nodes.filter(function (n) {
          return n.type === 'raw' || n.type === 'computed' || n.type === 'observation';
        }).length;
        content.innerHTML =
          '<a class="breadcrumb" href="#/tables">\\u2190 Tables</a>' +
          '<div class="view-header">' +
            '<span class="entity-icon">' + d.icon + '</span>' +
            '<h1>' + escapeHtml(d.label) + '</h1>' +
            (count ? '<span class="count">' + count + ' source' + (count === 1 ? '' : 's') + '</span>' : '') +
          '</div>' +
          '<div id="prov-mount" class="prov-mount prov-mount-table"></div>';
        content.querySelector('#prov-mount').innerHTML = provenanceTableHtml(payload);
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
