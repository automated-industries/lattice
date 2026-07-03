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

    var loadedTables = {};
    // loadAllRows only feeds RELATION-CHIP resolution (id + display label + FK
    // columns) — the viewed entity itself uses fetchRows. So skip heavy content
    // columns a chip never shows (files.extracted_text is up to ~200 KB/row).
    // exclude (not an id/name include) keeps the FK columns junction chips need.
    var RELATION_CHIP_EXCLUDE = 'extracted_text';
    function loadAllRows(tableName) {
      if (loadedTables[tableName]) return Promise.resolve(loadedTables[tableName]);
      return fetchJson(
        '/api/tables/' + encodeURIComponent(tableName) + '/rows?exclude=' + RELATION_CHIP_EXCLUDE,
      ).then(function (d) {
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
     * One PAGE of rows plus the pagination envelope: { rows, approxTotal,
     * totalIsCapped }. approxTotal is the server's bounded (approximate) total so a
     * caller can render an "N–M of T" / "T+" pager. This is the ONLY caller that
     * asks for the total (?withTotal=1) — the whole-list callers (loadAllRows, the
     * Sources sidebar) omit it so the server skips the extra count. opts:
     * { deletedMode, artifactType, limit, offset, exclude }.
     */
    function fetchRowsPage(tableName, opts) {
      opts = opts || {};
      var url = '/api/tables/' + encodeURIComponent(tableName) + '/rows';
      var qs = ['withTotal=1'];
      if (opts.deletedMode) qs.push('deleted=' + encodeURIComponent(opts.deletedMode));
      if (opts.artifactType) qs.push('artifactType=' + encodeURIComponent(opts.artifactType));
      if (opts.limit != null) qs.push('limit=' + encodeURIComponent(opts.limit));
      if (opts.offset != null) qs.push('offset=' + encodeURIComponent(opts.offset));
      if (opts.exclude) qs.push('exclude=' + encodeURIComponent(opts.exclude));
      url += '?' + qs.join('&');
      return fetchJson(url).then(function (d) {
        var rows = (d && d.rows) || [];
        return {
          rows: rows,
          approxTotal: typeof (d && d.approxTotal) === 'number' ? d.approxTotal : rows.length,
          totalIsCapped: !!(d && d.totalIsCapped),
        };
      });
    }

    /**
     * Invalidate cached rows for one or more tables. Call after any mutation
     * so the next collection/record render re-fetches from the server.
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
        fetchJson('/api/entities-summary').then(function (d) { state.entities = d; }),
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

    // The (table, pk) of the per-row "Manage access" grants panel that is
    // currently open, or null when none is. A soft re-render (a concurrent edit
    // by another client fires pg_notify → realtime refresh → renderRoute({soft})
    // → renderFsItem repaint) would otherwise re-create the detail
    // view with the panel collapsed, dropping a staged multi-select mid-edit.
    // wireRowSharing reads this after each repaint and re-opens + re-populates the
    // panel WITHOUT any network call, so the staged selection survives.
    var openGrantsPanel = null;

`;
