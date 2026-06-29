// Data-provenance: the single-ROW "Data provenance" panel (where one record's
// data came from, across the raw / computed / observation tiers) + the shared
// provenanceTableHtml renderer. The full-page object provenance view was removed
// — an object page now shows the table's rows. Vocabulary is generic (raw /
// computed / observation) — no domain coupling to any dataset.
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

    // (The full-page object provenance view was removed — the object page is now
    // the table's ROWS, rendered by renderFsCollection. Per-ROW provenance is still
    // available via renderProvenancePanel in the record view below.)

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
