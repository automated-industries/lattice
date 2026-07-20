// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const markdownJs = `    // ────────────────────────────────────────────────────────────
    // Version history page (#/settings/history)
    // ────────────────────────────────────────────────────────────
    var historyFilterTable = '';

    function renderHistory(content) {
      var firstClass = state.entities.tables
        .filter(function (t) { return !isJunction(t); })
        .map(function (t) { return t.name; })
        .sort(function (a, b) { return displayFor(a).label.toLowerCase().localeCompare(displayFor(b).label.toLowerCase()); });
      var options = '<option value="">All entities</option>' +
        firstClass.map(function (n) {
          var sel = n === historyFilterTable ? ' selected' : '';
          return '<option value="' + escapeHtml(n) + '"' + sel + '>' + escapeHtml(displayFor(n).label) + '</option>';
        }).join('');

      // No page title here — the takeover's own header already reads "Version
      // history". Just a compact subheader holding the entity filter.
      content.innerHTML =
        '<div class="history-subhead">' +
          '<label class="history-filter-label" for="history-filter">Entity</label>' +
          '<select id="history-filter">' + options + '</select>' +
        '</div>' +
        '<div class="history-list" id="history-list"><div class="muted" style="padding:20px;">Loading…</div></div>';

      var filterEl = document.getElementById('history-filter');
      filterEl.addEventListener('change', function () {
        historyFilterTable = filterEl.value;
        renderHistory(content);
      });

      var url = '/api/history?limit=500' +
        (historyFilterTable ? '&table=' + encodeURIComponent(historyFilterTable) : '');
      fetchJson(url).then(function (data) {
        var mount = document.getElementById('history-list');
        if (!data.entries || data.entries.length === 0) {
          mount.innerHTML = '<div class="muted" style="padding:24px;">' +
            (historyFilterTable
              ? 'No history yet for ' + escapeHtml(displayFor(historyFilterTable).label) + '.'
              : 'No history yet — make a change to see it here.') +
            '</div>';
          return;
        }
        mount.innerHTML = data.entries.map(historyEntryHtml).join('');

        mount.querySelectorAll('button.history-revert').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-id');
            gaTrack('history_action', { action: 'revert' });
            fetchJson('/api/history/revert/' + encodeURIComponent(id), { method: 'POST' })
              .then(afterMutation)
              .then(function () {
                renderHistory(document.getElementById('content'));
                showToast('Change reverted', {});
              })
              .catch(function (err) { showToast('Revert failed: ' + err.message, {}); });
          });
        });
      }).catch(function (err) {
        document.getElementById('history-list').innerHTML =
          '<div class="muted" style="padding:24px;">Failed to load: ' + escapeHtml(err.message) + '</div>';
      });
    }

    function isSchemaHistoryOp(op) { return String(op).indexOf('schema.') === 0; }

    /** One-line description for a schema/data-model history entry. */
    function schemaEntryLabel(e) {
      var p = (e.before_json && safeParse(e.before_json)) ||
              (e.after_json && safeParse(e.after_json)) || {};
      var t = '<span class="history-table">' + escapeHtml(e.table_name) + '</span>';
      var col = escapeHtml((p && p.column) || '');
      switch (e.operation) {
        case 'schema.create_entity': return 'Created table ' + t;
        case 'schema.delete_entity': return 'Deleted table ' + t + ' <span class="muted">(restorable)</span>';
        case 'schema.rename_entity': return 'Renamed table to ' + t;
        case 'schema.add_column': return 'Added column <span class="history-table">' + col + '</span> to ' + t;
        case 'schema.rename_column': return 'Renamed a column on ' + t;
        case 'schema.add_link': return 'Added a link to ' + t;
        case 'schema.create_junction': return 'Added a link from ' + t;
        case 'schema.delete_link': return 'Deleted a link on ' + t + ' <span class="muted">(restorable)</span>';
        case 'schema.create_computed': return 'Created computed table ' + t;
        case 'schema.update_computed': return 'Updated computed table ' + t;
        case 'schema.delete_computed': return 'Deleted computed table ' + t + ' <span class="muted">(restorable)</span>';
        case 'schema.refresh_computed': return 'Refreshed computed table ' + t;
        case 'schema.purge': return 'Permanently purged ' + t;
        default: return 'Schema change on ' + t;
      }
    }

    function historyEntryHtml(e) {
      // Schema/data-model entries get a one-line description (no row diff). A
      // purge is permanent, and a computed-table refresh only fills AI cells
      // (nothing to restore) — neither carries a Revert button.
      if (isSchemaHistoryOp(e.operation)) {
        var sActions = e.undone
          ? '<span class="hint-xs">undone</span>'
          : (e.operation === 'schema.purge' || e.operation === 'schema.refresh_computed'
              ? '<span class="hint-xs">' + (e.operation === 'schema.purge' ? 'permanent' : 'not revertible') + '</span>'
              : '<button class="btn danger history-revert" data-id="' + escapeHtml(e.id) + '">Revert</button>');
        return '<div class="history-entry' + (e.undone ? ' is-undone' : '') + '">' +
          '<div class="history-meta">' +
            '<div><span class="history-op op-schema">SCHEMA</span></div>' +
            '<div class="u-mt-2">' + escapeHtml(formatTs(e.ts)) + '</div>' +
          '</div>' +
          '<div class="history-summary">' + schemaEntryLabel(e) + '</div>' +
          '<div class="history-actions">' + sActions + '</div>' +
        '</div>';
      }
      var before = e.before_json ? safeParse(e.before_json) : null;
      var after = e.after_json ? safeParse(e.after_json) : null;
      var summary;
      var iconName = displayFor(e.table_name).label;
      switch (e.operation) {
        case 'insert': summary = 'Created in <span class="history-table">' + escapeHtml(iconName) + '</span>'; break;
        case 'update': summary = 'Updated <span class="history-table">' + escapeHtml(iconName) + '</span> row'; break;
        case 'delete': summary = 'Deleted from <span class="history-table">' + escapeHtml(iconName) + '</span>'; break;
        case 'link':   summary = 'Linked via <span class="history-table">' + escapeHtml(e.table_name) + '</span>'; break;
        case 'unlink': summary = 'Unlinked from <span class="history-table">' + escapeHtml(e.table_name) + '</span>'; break;
        default:       summary = escapeHtml(e.operation) + ' on ' + escapeHtml(e.table_name);
      }
      var diff = renderDiff(before, after);
      var actions = e.undone
        ? '<span class="hint-xs">undone</span>'
        : '<button class="btn danger history-revert" data-id="' + escapeHtml(e.id) + '">Revert</button>';
      return '<div class="history-entry' + (e.undone ? ' is-undone' : '') + '">' +
        '<div class="history-meta">' +
          '<div><span class="history-op op-' + escapeHtml(e.operation) + '">' + escapeHtml(e.operation) + '</span></div>' +
          '<div class="u-mt-2">' + escapeHtml(formatTs(e.ts)) + '</div>' +
        '</div>' +
        '<div class="history-summary">' +
          summary +
          (diff ? '<div class="history-diff">' + diff + '</div>' : '') +
        '</div>' +
        '<div class="history-actions">' + actions + '</div>' +
      '</div>';
    }

    function safeParse(s) {
      try { return JSON.parse(s); } catch (_e) { return null; }
    }

    function formatTs(s) {
      if (!s) return '';
      try {
        var d = new Date(s);
        // Never render the literal "Invalid Date" — new Date() returns an
        // Invalid Date (not a throw) for an unparseable value.
        if (isNaN(d.getTime())) return '(no timestamp)';
        return d.toLocaleString();
      } catch (_e) { return '(no timestamp)'; }
    }

    /** Side-by-side-ish text diff. Shows changed columns only for updates. */
    function renderDiff(before, after) {
      if (!before && !after) return '';
      if (!before && after) {
        return Object.keys(after).map(function (k) {
          if (k === 'deleted_at' || after[k] == null) return '';
          return '<div class="diff-add">+ ' + escapeHtml(k) + ': ' + escapeHtml(String(after[k])) + '</div>';
        }).filter(Boolean).join('');
      }
      if (before && !after) {
        return Object.keys(before).map(function (k) {
          if (before[k] == null) return '';
          return '<div class="diff-rem">- ' + escapeHtml(k) + ': ' + escapeHtml(String(before[k])) + '</div>';
        }).filter(Boolean).join('');
      }
      var keys = new Set([].concat(Object.keys(before), Object.keys(after)));
      var lines = [];
      keys.forEach(function (k) {
        var b = before[k];
        var a = after[k];
        if (b === a || (b == null && a == null)) return;
        if (b == null) lines.push('<div class="diff-add">+ ' + escapeHtml(k) + ': ' + escapeHtml(String(a)) + '</div>');
        else if (a == null) lines.push('<div class="diff-rem">- ' + escapeHtml(k) + ': ' + escapeHtml(String(b)) + '</div>');
        else {
          lines.push('<div class="diff-rem">- ' + escapeHtml(k) + ': ' + escapeHtml(String(b)) + '</div>');
          lines.push('<div class="diff-add">+ ' + escapeHtml(k) + ': ' + escapeHtml(String(a)) + '</div>');
        }
      });
      return lines.join('');
    }

`;
