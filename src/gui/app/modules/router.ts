// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const routerJs = `    // ────────────────────────────────────────────────────────────
    // Table view
    // ────────────────────────────────────────────────────────────
    function intrinsicColumns(table) {
      // Drop id + foreign-key columns (rendered as belongsTo relations instead).
      var fkCols = new Set();
      Object.values(table.relations || {}).forEach(function (r) {
        if (r.type === 'belongsTo') fkCols.add(r.foreignKey);
      });
      return table.columns.filter(function (c) { return c !== 'id' && !fkCols.has(c); });
    }

    function belongsToColumns(table) {
      return Object.entries(table.relations || {})
        .filter(function (kv) { return kv[1].type === 'belongsTo'; })
        .map(function (kv) { return { relName: kv[0], rel: kv[1] }; });
    }

    function junctionsFor(tableName) {
      // Junctions where the LEFT side is this table.
      var out = [];
      state.entities.tables.forEach(function (t) {
        if (!isJunction(t)) return;
        var rels = Object.values(t.relations);
        var here = rels.find(function (r) { return r.table === tableName; });
        var other = rels.find(function (r) { return r.table !== tableName; });
        if (here && other) out.push({ junction: t.name, localFk: here.foreignKey, remoteRel: other });
      });
      return out;
    }

    /**
     * Every relationship for an entity, as a uniform bidirectional link. A link
     * between A and B is one thing — it appears in both editors and deleting it
     * from either side removes it from both. Each entry:
     *   { other, kind: 'junction' | 'fk', delTable, delCol? }
     *   • junction — a many-to-many junction table; delete drops that table.
     *   • fk — a legacy 1:N foreign-key column (this entity's own, or one on
     *     another table pointing here); delete drops that column.
     * New links are always junctions (M2M); fk entries exist only for tables
     * created before the M2M-only model.
     */
    function collectEntityLinks(name) {
      var links = [];
      var t = tableByName(name);
      // Many-to-many via junction tables (found on either side).
      junctionsFor(name).forEach(function (j) {
        links.push({ other: j.remoteRel.table, kind: 'junction', delTable: j.junction });
      });
      // This entity's own outgoing FK columns (legacy 1:N).
      if (t) {
        belongsToColumns(t).forEach(function (b) {
          links.push({ other: b.rel.table, kind: 'fk', delTable: name, delCol: b.rel.foreignKey });
        });
      }
      // Incoming FK columns on other (non-junction) tables pointing here (legacy).
      ((state.entities && state.entities.tables) || []).forEach(function (ot) {
        if (ot.name === name || isJunction(ot)) return;
        belongsToColumns(ot).forEach(function (b) {
          if (b.rel.table === name) {
            links.push({ other: ot.name, kind: 'fk', delTable: ot.name, delCol: b.rel.foreignKey });
          }
        });
      });
      return links;
    }

    function displayNameFor(row) {
      if (!row) return '';
      return row.name || row.title || row.url || row.id || '';
    }

    /**
     * Render a clickable chip linking to the detail page of a row in another
     * table. Used for belongsTo cells and junction-derived cells so the user
     * can navigate to the related object with one click.
     */
    function chipLink(table, row) {
      if (!row) return '<span class="muted">—</span>';
      return '<a class="chip chip-link" href="#/objects/' + encodeURIComponent(table) +
        '/' + encodeURIComponent(row.id) + '">' + escapeHtml(displayNameFor(row)) + '</a>';
    }

    var loadedTables = {};
    function loadAllRows(tableName) {
      if (loadedTables[tableName]) return Promise.resolve(loadedTables[tableName]);
      return fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows').then(function (d) {
        loadedTables[tableName] = d.rows;
        return d.rows;
      });
    }

    /** Force a fresh fetch — used for views that need to opt in/out of soft-delete filtering. */
    function fetchRows(tableName, deletedMode) {
      var url = '/api/tables/' + encodeURIComponent(tableName) + '/rows';
      if (deletedMode) url += '?deleted=' + encodeURIComponent(deletedMode);
      return fetchJson(url).then(function (d) { return d.rows; });
    }

    /**
     * Invalidate cached rows for one or more tables. Call after any mutation
     * so the next renderTable / renderDetail re-fetches from the server.
     */
    function invalidate(tableNames) {
      (Array.isArray(tableNames) ? tableNames : [tableNames]).forEach(function (n) {
        delete loadedTables[n];
      });
    }

    /**
     * Refresh /api/entities (dashboard row counts) AND the undo/redo button
     * state after a mutation. Called by every CRUD handler.
     */
    function refreshEntities() {
      return Promise.all([
        fetchJson('/api/entities').then(function (d) { state.entities = d; }),
        refreshHistoryState(),
      ]);
    }

    function fieldFor(col, value, table) {
      // Render an input element for a column. belongsTo FK columns become a
      // <select> over the referenced table's rows (must already be cached).
      var belongsTo = belongsToColumns(table).find(function (b) { return b.rel.foreignKey === col; });
      if (belongsTo) {
        var rows = loadedTables[belongsTo.rel.table] || [];
        var options = '<option value="">(none)</option>' + rows.map(function (r) {
          var sel = (r.id === value) ? ' selected' : '';
          return '<option value="' + escapeHtml(r.id) + '"' + sel + '>' + escapeHtml(displayNameFor(r)) + '</option>';
        }).join('');
        return '<select name="' + escapeHtml(col) + '">' + options + '</select>';
      }
      // Secret columns: use a password input so the value is masked while editing.
      if (isSecretColumn(table.name, col)) {
        return '<input type="password" name="' + escapeHtml(col) + '" value="' +
          escapeHtml(value || '') + '" autocomplete="off" data-1p-ignore data-lpignore="true" />';
      }
      // Multiline for ALL long-form fields (matches FS_LONGFORM, the same set
      // fsValInner renders as markdown) AND any value that already contains a
      // newline. A single-line <input> normalizes/strips newlines, so a
      // multi-line markdown value put in one would be silently corrupted on the
      // next blur (a spurious PATCH) and then re-rendered as mangled markdown
      // ("huge text"). A <textarea> round-trips the exact text.
      if (FS_LONGFORM.indexOf(col) >= 0 || (value != null && String(value).indexOf('\\n') >= 0)) {
        return '<textarea name="' + escapeHtml(col) + '">' + escapeHtml(value || '') + '</textarea>';
      }
      return '<input type="text" name="' + escapeHtml(col) + '" value="' + escapeHtml(value || '') + '" />';
    }

    function collectFormValues(scope) {
      var out = {};
      scope.querySelectorAll('[name]').forEach(function (el) {
        var v = el.value;
        out[el.getAttribute('name')] = v === '' ? null : v;
      });
      return out;
    }

    // Per-table view state: 'live' (default) or 'trash' (soft-deleted rows).
    var tableViewMode = {};

    function renderTable(content, tableName) {
      var myGen = renderGen;
      clearUnseen(tableName);
      var t = tableByName(tableName);
      if (!t) {
        // Conversation-storage tables (chat_messages/chat_threads) and other
        // Lattice internals aren't in the Objects list, but are browsable
        // read-only under "System". If something routed here for one of them,
        // fall back to the system-table view instead of "Unknown entity".
        if ((state.systemTables || []).some(function (s) { return s.name === tableName; })) {
          renderSystemTable(content, tableName);
          return;
        }
        content.innerHTML = '<div class="placeholder">Unknown entity: ' + escapeHtml(tableName) + '</div>';
        return;
      }
      var d = displayFor(tableName);
      var intrinsic = intrinsicColumns(t);
      var belongsTo = belongsToColumns(t);
      var junctions = junctionsFor(tableName);
      var supportsSoftDelete = (t.columns || []).indexOf('deleted_at') !== -1;
      var viewMode = tableViewMode[tableName] || 'live';
      // Fetch this entity's rows fresh (mode-aware), plus relation tables (live only) for chips.
      var fetches = [fetchRows(tableName, viewMode === 'trash' ? 'only' : '')];
      belongsTo.forEach(function (b) { fetches.push(loadAllRows(b.rel.table)); });
      junctions.forEach(function (j) {
        fetches.push(loadAllRows(j.junction));
        fetches.push(loadAllRows(j.remoteRel.table));
      });

      Promise.all(fetches).then(function (results) {
        if (myGen !== renderGen) return; // superseded by a newer navigation
        var rows = results[0];
        var headers = intrinsic.map(function (c) {
          return '<th' + titleAttr(colDesc(tableName, c)) + '>' + escapeHtml(fieldLabel(c)) + '</th>';
        })
          .concat(belongsTo.map(function (b) {
            return '<th' + titleAttr(tableDesc(b.rel.table)) + '>' + escapeHtml(titleCase(b.relName)) + '</th>';
          }))
          .concat(junctions.map(function (j) {
            return '<th' + titleAttr(tableDesc(j.remoteRel.table)) + '>' + escapeHtml(titleCase(j.remoteRel.table)) + '</th>';
          }))
          .join('');
        headers += '<th class="row-actions"></th>';

        // Per-row visibility indicator (2.2 row-level permissions). Reads the
        // server-attached _access summary (team clouds only); absent yields ''.
        // U+25C9 = everyone (yellow) / private (red, by colour); U+25CE =
        // custom (shared with specific people). Owner = interactive toggle;
        // non-owner = faded + inert status.
        function rowVisMarkup(tbl, r) {
          var a = r._access;
          if (!a) return '';
          var vis = effectiveVisibility(a);
          var glyph = vis === 'custom' ? '◎' : '◉';
          if (!a.ownedByMe) {
            var seen = vis === 'custom' ? 'Shared with you' : 'Visible to everyone';
            return '<span class="row-vis row-vis-disabled" title="' + escapeHtml(seen) + '">' + glyph + '</span>';
          }
          if (vis === 'custom') {
            return '<a class="row-vis" href="#/objects/' + encodeURIComponent(tbl) + '/' + encodeURIComponent(r.id) +
              '" title="Shared with specific people — open to manage">' + glyph + '</a>';
          }
          var cls = vis === 'private' ? 'row-vis row-vis-private' : 'row-vis';
          var title = vis === 'everyone'
            ? 'Visible to everyone — click to make private'
            : 'Private to you — click to share with everyone';
          return '<button class="' + cls + '" data-vis-toggle="' + escapeHtml(r.id) +
            '" data-vis-cur="' + vis + '" title="' + escapeHtml(title) + '">' + glyph + '</button>';
        }
        var bodyRows;
        if (rows.length === 0) {
          bodyRows = '';
        } else {
          bodyRows = rows.map(function (r) {
            var tds = intrinsic.map(function (c) {
              if ((isSecretColumn(tableName, c) || looksEncrypted(r[c])) && r[c] != null && r[c] !== '') {
                return '<td class="muted">' + SECRET_MASK + '</td>';
              }
              return '<td><div class="cell-clip">' + escapeHtml(truncate(r[c], 120)) + '</div></td>';
            });
            belongsTo.forEach(function (b) {
              var ref = (loadedTables[b.rel.table] || []).find(function (x) { return x.id === r[b.rel.foreignKey]; });
              tds.push('<td><div class="cell-clip">' + chipLink(b.rel.table, ref) + '</div></td>');
            });
            junctions.forEach(function (j) {
              var matches = (loadedTables[j.junction] || []).filter(function (jr) { return jr[j.localFk] === r.id; });
              var remoteFkCol = j.remoteRel.foreignKey;
              var chips = matches.map(function (jr) {
                var ref = (loadedTables[j.remoteRel.table] || []).find(function (x) { return x.id === jr[remoteFkCol]; });
                return ref ? chipLink(j.remoteRel.table, ref) : '';
              }).join('');
              tds.push('<td><div class="cell-clip">' + (chips || '<span class="muted">—</span>') + '</div></td>');
            });
            if (viewMode === 'trash') {
              tds.push('<td class="row-actions">' +
                '<button class="row-restore" title="Restore" data-restore="' + escapeHtml(r.id) + '">↺</button>' +
                '<button class="row-delete" title="Delete permanently" data-hard-del="' + escapeHtml(r.id) + '">✕</button>' +
                '</td>');
            } else {
              tds.push('<td class="row-actions">' + rowVisMarkup(tableName, r) +
                '<button class="row-delete" title="Delete" data-del="' + escapeHtml(r.id) + '">✕</button></td>');
            }
            return '<tr data-id="' + escapeHtml(r.id) + '"' + (viewMode === 'trash' ? ' class="row-deleted"' : '') + '>' + tds.join('') + '</tr>';
          }).join('');
        }

        // Inline "+ new" row at the bottom of the table. Intrinsic + belongsTo
        // columns become inputs; junctions show a dim placeholder (links happen
        // via the Data Model page); the last cell is the create control.
        var createCells = intrinsic.map(function (c) {
          return '<td>' + fieldFor(c, '', t) + '</td>';
        });
        belongsTo.forEach(function (b) {
          createCells.push('<td>' + fieldFor(b.rel.foreignKey, '', t) + '</td>');
        });
        junctions.forEach(function () {
          createCells.push('<td><span class="muted">add after create</span></td>');
        });
        createCells.push('<td class="row-actions"><button class="btn primary" id="inline-create" title="Create">+</button></td>');
        var createRow = '<tr class="create-row">' + createCells.join('') + '</tr>';

        var trashToggle = supportsSoftDelete
          ? '<div class="actions"><button class="btn ghost" id="toggle-trash">' +
              (viewMode === 'trash' ? '← Back to live' : 'Show trash') +
            '</button></div>'
          : '';

        content.innerHTML =
          '<div class="view-header">' +
            '<span class="entity-icon">' + d.icon + '</span>' +
            '<h1>' + escapeHtml(d.label) + (viewMode === 'trash' ? ' · Trash' : '') + '</h1>' +
            '<span class="count">' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + '</span>' +
            trashToggle +
          '</div>' +
          '<table>' +
            '<thead><tr>' + headers + '</tr></thead>' +
            '<tbody>' + bodyRows + (viewMode === 'trash' ? '' : createRow) + '</tbody>' +
          '</table>';

        if (supportsSoftDelete) {
          document.getElementById('toggle-trash').addEventListener('click', function () {
            tableViewMode[tableName] = viewMode === 'trash' ? 'live' : 'trash';
            renderTable(content, tableName);
          });
        }

        if (viewMode === 'live') document.getElementById('inline-create').addEventListener('click', function () {
          var values = collectFormValues(content.querySelector('tr.create-row'));
          // Strip empty optional fields so they're left to DB defaults.
          Object.keys(values).forEach(function (k) {
            if (values[k] === null || values[k] === '') delete values[k];
          });
          rowWrite('POST', '/api/tables/' + encodeURIComponent(tableName) + '/rows', values).then(function (r) {
            if (r && r.queued) return; // saved offline; the queued toast already fired
            invalidate(tableName);
            return refreshEntities().then(function () {
              renderTable(content, tableName);
              showToast(d.label.replace(/s$/, '') + ' created', { undo: undoLast });
            });
          }).catch(function (err) {
            showToast('Create failed: ' + err.message, {});
          });
        });

        content.querySelectorAll('button.row-delete').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var softId = btn.getAttribute('data-del');
            var hardId = btn.getAttribute('data-hard-del');
            var id = softId || hardId;
            var hard = !!hardId;
            var url = '/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id);
            if (hard) url += '?hard=true';
            rowWrite('DELETE', url, null).then(function (r) {
              if (r && r.queued) return;
              invalidate(tableName);
              return refreshEntities().then(function () {
                renderTable(content, tableName);
                var msg = hard
                  ? d.label.replace(/s$/, '') + ' permanently deleted'
                  : d.label.replace(/s$/, '') + ' deleted';
                showToast(msg, { undo: undoLast });
              });
            }).catch(function (err) {
              showToast('Delete failed: ' + err.message, {});
            });
          });
        });

        content.querySelectorAll('button.row-restore').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var id = btn.getAttribute('data-restore');
            fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id), {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ deleted_at: null }),
            }).then(function () {
              invalidate(tableName);
              return refreshEntities();
            }).then(function () {
              renderTable(content, tableName);
              showToast(d.label.replace(/s$/, '') + ' restored', { undo: undoLast });
            }).catch(function (err) {
              showToast('Restore failed: ' + err.message, {});
            });
          });
        });

        content.querySelectorAll('button[data-vis-toggle]').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var id = btn.getAttribute('data-vis-toggle');
            var cur = btn.getAttribute('data-vis-cur');
            var next = cur === 'everyone' ? 'private' : 'everyone';
            withBusy(btn, function () {
              return fetchJson('/api/cloud/share', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ table: tableName, pk: id, visibility: next }),
              }).then(function () {
                invalidate(tableName);
                return refreshEntities();
              }).then(function () {
                renderTable(content, tableName);
                showToast(next === 'everyone' ? 'Row shared with everyone' : 'Row made private', {});
              }).catch(function (err) {
                showToast('Visibility update failed: ' + err.message, {});
              });
            });
          });
        });

        content.querySelectorAll('tr[data-id]').forEach(function (tr) {
          tr.addEventListener('click', function (e) {
            // Let chip-link anchors and the delete button handle their own click.
            if (e.target && e.target.closest('a, button')) return;
            location.hash = '#/objects/' + tableName + '/' + tr.getAttribute('data-id');
          });
        });
      }).catch(function (err) {
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

`;
