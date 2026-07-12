// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const detailViewJs = `    // ────────────────────────────────────────────────────────────
    // System tables (Lattice-internal — read-only browse view)
    // ────────────────────────────────────────────────────────────
    function renderSystemTable(content, tableName) {
      var entry = (state.systemTables || []).find(function (t) { return t.name === tableName; });
      if (!entry) {
        content.innerHTML = '<div class="placeholder">Unknown system table: ' + escapeHtml(tableName) + '</div>';
        return;
      }
      content.innerHTML =
        '<div class="view-header">' +
          '<span class="entity-icon">⚙</span>' +
          '<h1>' + escapeHtml(tableName) + '</h1>' +
          '<span class="count">' + (entry.rowCount == null ? 'no access' : (entry.rowCount + ' row' + (entry.rowCount === 1 ? '' : 's'))) +
            ' · read-only</span>' +
        '</div>' +
        '<div class="dialog-lead">' +
          'Lattice-internal table — shown here for inspection only. The GUI does not allow editing.' +
        '</div>' +
        '<table id="system-table"><thead><tr></tr></thead><tbody></tbody></table>';

      fetchJson('/api/system-tables/' + encodeURIComponent(tableName) + '/rows').then(function (data) {
        var rows = data.rows || [];
        var cols = entry.columns;
        var thead = content.querySelector('#system-table thead tr');
        thead.innerHTML = cols.map(function (c) { return '<th>' + escapeHtml(c) + '</th>'; }).join('');
        var tbody = content.querySelector('#system-table tbody');
        if (rows.length === 0) {
          tbody.innerHTML = '<tr><td colspan="' + cols.length + '" class="empty-state">Empty</td></tr>';
          return;
        }
        tbody.innerHTML = rows.map(function (r) {
          var tds = cols.map(function (c) {
            var v = r[c];
            if (v == null) return '<td class="muted">—</td>';
            var s = String(v);
            return '<td>' + escapeHtml(s.length > 200 ? s.slice(0, 200) + '…' : s) + '</td>';
          }).join('');
          return '<tr>' + tds + '</tr>';
        }).join('');
      }).catch(function (err) {
        content.querySelector('#system-table tbody').innerHTML =
          '<tr><td colspan="' + entry.columns.length + '" class="muted" style="padding:24px;">' +
          'Failed to load: ' + escapeHtml(err.message) + '</td></tr>';
      });
    }

`;
