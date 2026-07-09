// Auto-composed segment of the GUI client script (see modules/index.ts). The
// full-page computed-table builder (#/computed/new to create, #/computed/<name>
// to edit): define a live, read-only view over a base table — copied fields,
// calculations, AI-derived values, and per-link totals — dry-run it against live
// data (POST /api/computed-tables/preview), then save it through the audited
// /api/computed-tables surface. Must stay INSIDE the client IIFE (uses
// state/fetchJson/escapeHtml/displayFor/isJunction/tableByName/showToast/
// refreshEntities/renderGen/setContent, and drops the Tables explorer's
// mtEdgesCache after a schema change); iiStreamNdjson (a top-level function in
// the same script) streams the AI-refresh NDJSON progress. Like every segment,
// ONE template literal — no raw backticks or dollar-brace inside; HTML built
// with single-quoted string concatenation.
export const computedBuilderJs = `
    // ── Computed-table builder (#/computed/new | #/computed/<name>) ─────────
    // The five field kinds with their user-facing labels (the kind <select>).
    var CB_KINDS = [
      { id: 'alias', label: 'Copy a field' },
      { id: 'calc', label: 'Calculation' },
      { id: 'ai_classify', label: 'AI category' },
      { id: 'ai_transform', label: 'AI text' },
      { id: 'aggregate', label: 'Total across links' },
    ];
    var CB_AGG_FNS = ['count', 'sum', 'avg', 'min', 'max', 'concat'];
    // The GUI-facing name rule (a strict slug; the server accepts a superset).
    var CB_NAME_RE = /^[a-z][a-z0-9_]*$/;
    // Builder state — rebuilt from scratch on every route entry, so navigating
    // away (or switching workspaces) can never leak a stale definition back in.
    var cbS = null;

    function cbNewRow() {
      return {
        name: '', kind: 'alias', source: '', expr: '', calcType: undefined,
        input: '', prompt: '', labels: [], inputs: [],
        via: '', fn: 'count', column: '', model: undefined, status: null,
      };
    }

    // One editable row from a saved field definition. Kind-specific properties
    // the form does not edit (calc display type, AI model tier) are carried
    // through so a round-trip save never drops them.
    function cbRowFromDef(name, f) {
      var r = cbNewRow();
      r.name = name;
      r.kind = f.kind;
      if (f.kind === 'alias') r.source = f.source || '';
      else if (f.kind === 'calc') { r.expr = f.expr || ''; r.calcType = f.type; }
      else if (f.kind === 'ai_classify') {
        r.input = f.input || ''; r.prompt = f.prompt || '';
        r.labels = (f.labels || []).slice(); r.model = f.model;
      } else if (f.kind === 'ai_transform') {
        r.inputs = (f.inputs || []).slice(); r.prompt = f.prompt || ''; r.model = f.model;
      } else if (f.kind === 'aggregate') {
        r.via = f.via || ''; r.fn = f.fn || 'count'; r.column = f.column || '';
      }
      return r;
    }

    // True while the location still targets THIS builder+name. The edit-mode load
    // commits on this rather than on a renderGen match: a background soft render
    // bumps renderGen but leaves the hash put, so keying on renderGen would let it
    // orphan an in-flight edit load (stuck spinner). A real navigation-away DOES
    // change the hash, so a stale load is still dropped.
    function cbRouteMatches(nameArg) {
      var m = /^#\\/computed\\/([^/]+)$/.exec(location.hash || '');
      return !!m && decodeURIComponent(m[1]) === nameArg;
    }
    // Route entry. 'new' renders the empty create form; any other name loads
    // that definition for editing (the reserved word costs nothing: the server
    // refuses "new" only if no such computed table exists, which 404s here).
    function renderComputedBuilder(content, nameArg) {
      if (nameArg === 'new') {
        cbS = {
          mode: 'create', name: '', base: '', description: undefined,
          rows: [cbNewRow()], fieldsByBase: {}, previewOk: false, busy: false,
          status: 'unsaved',
        };
        cbPaint(content);
        return;
      }
      fetchJson('/api/computed-tables/' + encodeURIComponent(nameArg))
        .then(function (d) {
          var def = (d && d.def) || {};
          var defFields = def.fields || {};
          cbS = {
            mode: 'edit', name: nameArg, base: def.base || '',
            description: def.description,
            rows: Object.keys(defFields).map(function (f) { return cbRowFromDef(f, defFields[f]); }),
            fieldsByBase: {}, previewOk: false, busy: false, status: 'saved',
          };
          if (!cbS.rows.length) cbS.rows.push(cbNewRow());
          return cbLoadFields(cbS.base).then(function () {
            if (!cbRouteMatches(nameArg)) return;
            cbPaint(content);
          });
        })
        .catch(function (err) {
          if (!content || !cbRouteMatches(nameArg)) return;
          content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
        });
    }

    // Base tables the picker offers: first-class entities only — no junctions
    // (relationship tables), no computed tables, and not the files/secrets
    // natives (raw inputs / credentials, not modeling bases).
    function cbEligibleBases() {
      var names = ((state.entities && state.entities.tables) || [])
        .filter(function (t) {
          return !isJunction(t) && !t.computedTable && t.name !== 'files' && t.name !== 'secrets';
        })
        .map(function (t) { return t.name; });
      // A saved definition may use a base the picker would not offer (e.g. a
      // config-authored computed-on-computed chain) — keep it selectable.
      if (cbS.base && names.indexOf(cbS.base) < 0) names.unshift(cbS.base);
      return names;
    }

    // Reachable-field cache, keyed by base. Errors surface in the strip (the
    // pickers render empty rather than the whole page failing).
    function cbLoadFields(base) {
      if (!base) return Promise.resolve();
      if (cbS.fieldsByBase[base]) return Promise.resolve();
      var s = cbS;
      return fetchJson('/api/computed-tables/fields?base=' + encodeURIComponent(base))
        .then(function (d) { s.fieldsByBase[base] = (d && d.fields) || []; })
        .catch(function (err) {
          s.fieldsByBase[base] = [];
          if (s === cbS) cbShowError('Could not load the fields of "' + base + '": ' + err.message);
        });
    }
    function cbFields() { return (cbS && cbS.fieldsByBase[cbS.base]) || []; }
    function cbValuePaths() { return cbFields().filter(function (f) { return f.via !== 'aggregate'; }); }
    function cbAggPaths() { return cbFields().filter(function (f) { return f.via === 'aggregate'; }); }

    function cbShowError(msg) {
      var el = document.getElementById('cb-error');
      if (!el) return;
      el.textContent = msg;
      el.hidden = false;
    }
    function cbClearError() {
      var el = document.getElementById('cb-error');
      if (el) { el.hidden = true; el.textContent = ''; }
    }

    // Any edit invalidates the last preview: clear the per-field marks in place
    // (no row re-render — typing must not lose focus) and re-gate Create.
    function cbMarkDirty() {
      cbS.previewOk = false;
      cbS.status = 'unsaved';
      cbS.rows.forEach(function (r) { r.status = null; });
      document.querySelectorAll('#cb-fields .cb-mark').forEach(function (m) {
        m.className = 'cb-mark';
        m.textContent = '\\u00b7';
      });
      cbSyncStatus();
    }

    function cbSyncStatus() {
      var el = document.getElementById('cb-status');
      if (el) {
        var map = { unsaved: 'Unsaved changes', previewed: 'Previewed \\u2713', saving: 'Saving\\u2026', saved: 'Saved \\u2713' };
        el.textContent = map[cbS.status] || '';
      }
      var save = document.getElementById('cb-save-btn');
      if (save) {
        // Create is gated on a successful preview of the CURRENT definition
        // (any edit re-disables it); an edit's Save re-validates server-side.
        save.disabled = cbS.busy ||
          (cbS.mode === 'create' && (!cbS.previewOk || !CB_NAME_RE.test(cbS.name)));
      }
      var prev = document.getElementById('cb-preview-btn');
      if (prev) prev.disabled = cbS.busy || !cbS.base;
      ['cb-refresh-btn', 'cb-delete-btn'].forEach(function (id) {
        var b = document.getElementById(id);
        if (b) b.disabled = cbS.busy;
      });
    }

    function cbPaint(content) {
      var edit = cbS.mode === 'edit';
      var title = edit
        ? '<h1>' + escapeHtml(cbS.name) + '</h1><span class="fs-computed-badge" title="A live, read-only view">Computed</span>'
        : '<input class="cb-name-input" id="cb-name" placeholder="e.g. ticket_summary" value="' + escapeHtml(cbS.name) + '"' +
          ' spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Computed view name" />';
      var baseOptions = '<option value="">Choose a table\\u2026</option>' + cbEligibleBases().map(function (n) {
        return '<option value="' + escapeHtml(n) + '"' + (n === cbS.base ? ' selected' : '') + '>' + escapeHtml(displayFor(n).label) + '</option>';
      }).join('');
      content.innerHTML =
        '<div class="computed-builder">' +
          '<nav class="fs-crumbs"><a href="#/tables">Tables</a><span class="fs-sep">\\u25b8</span>' +
            '<span class="fs-crumb-cur">' + (edit ? escapeHtml(cbS.name) : 'New computed view') + '</span></nav>' +
          '<div class="view-header">' +
            '<span class="entity-icon">\\u0192</span>' + title +
            '<span class="cb-status" id="cb-status"></span>' +
          '</div>' +
          '<div class="cb-error" id="cb-error" hidden></div>' +
          '<div class="cb-card">' +
            '<label class="cb-label" for="cb-base">Built from</label>' +
            '<select id="cb-base">' + baseOptions + '</select>' +
            '<div class="cb-hint">Fields can come from this table and anything linked to it.</div>' +
          '</div>' +
          '<div class="cb-card">' +
            '<div class="cb-fields-head">Fields</div>' +
            '<div id="cb-fields"></div>' +
            '<button type="button" class="btn" id="cb-add-field">+ Add field</button>' +
          '</div>' +
          '<div class="cb-actions">' +
            '<button type="button" class="btn" id="cb-preview-btn">Preview</button>' +
            '<button type="button" class="btn primary" id="cb-save-btn">' + (edit ? 'Save' : 'Create') + '</button>' +
            (edit
              ? '<button type="button" class="btn" id="cb-refresh-btn">Refresh values</button>' +
                '<button type="button" class="btn danger" id="cb-delete-btn">Remove</button>'
              : '') +
          '</div>' +
          '<pre class="cb-refresh-log" id="cb-refresh-log" hidden></pre>' +
          '<div id="cb-preview-out"></div>' +
          '<details class="cb-sql" id="cb-sql" hidden><summary>Definition (SQL)</summary><pre id="cb-sql-pre"></pre></details>' +
        '</div>';

      var nameIn = document.getElementById('cb-name');
      if (nameIn) nameIn.addEventListener('input', function () {
        cbS.name = nameIn.value.trim();
        nameIn.classList.toggle('cb-invalid', !!cbS.name && !CB_NAME_RE.test(cbS.name));
        cbMarkDirty();
      });
      var baseSel = document.getElementById('cb-base');
      if (baseSel) baseSel.addEventListener('change', function () {
        cbS.base = baseSel.value;
        cbMarkDirty();
        cbLoadFields(cbS.base).then(function () { cbRenderFields(); });
      });
      document.getElementById('cb-add-field').addEventListener('click', function () {
        cbS.rows.push(cbNewRow());
        cbMarkDirty();
        cbRenderFields();
      });
      document.getElementById('cb-preview-btn').addEventListener('click', cbPreview);
      document.getElementById('cb-save-btn').addEventListener('click', cbSave);
      var rfr = document.getElementById('cb-refresh-btn');
      if (rfr) rfr.addEventListener('click', cbRefresh);
      var del = document.getElementById('cb-delete-btn');
      if (del) del.addEventListener('click', cbDelete);

      cbRenderFields();
      cbSyncStatus();
    }

    // A <select> over string values or { path, type } field candidates. A saved
    // value the option list no longer offers stays selectable (marked as-is) so
    // opening an old definition never silently rewrites it.
    function cbSelectHtml(cls, options, current, placeholder) {
      var cur = current || '';
      var seen = cur === '';
      var opts = '<option value=""' + (cur ? '' : ' selected') + '>' + escapeHtml(placeholder) + '</option>';
      options.forEach(function (o) {
        var v = typeof o === 'string' ? o : o.path;
        var label = typeof o === 'string'
          ? o
          : o.path + (o.type && o.type !== 'aggregate' ? ' \\u00b7 ' + o.type : '');
        if (v === cur) seen = true;
        opts += '<option value="' + escapeHtml(v) + '"' + (v === cur ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
      });
      if (!seen) opts += '<option value="' + escapeHtml(cur) + '" selected>' + escapeHtml(cur) + '</option>';
      return '<select class="' + cls + '">' + opts + '</select>';
    }

    // The remote table an aggregate 'junction.relation' via lands on — for the
    // column picker. Resolvable only when the junction's relations are in the
    // entities payload (owner view); otherwise the column falls back to a text
    // input (a cloud member never receives the owner's relation config).
    function cbAggRemoteTable(via) {
      var dot = (via || '').indexOf('.');
      if (dot < 0) return null;
      var j = tableByName(via.slice(0, dot));
      var rel = j && j.relations && j.relations[via.slice(dot + 1)];
      return rel ? tableByName(rel.table) : null;
    }
    function cbAggColumnHtml(row) {
      var remote = cbAggRemoteTable(row.via);
      if (remote && remote.columns && remote.columns.length) {
        var cols = remote.columns.filter(function (c) { return c !== 'deleted_at'; });
        return cbSelectHtml('cb-f-column', cols, row.column, 'Choose a column\\u2026');
      }
      return '<input class="cb-f-column" placeholder="column" value="' + escapeHtml(row.column) + '" spellcheck="false" />';
    }

    function cbRowBodyHtml(row) {
      if (row.kind === 'alias') {
        return cbSelectHtml('cb-f-source', cbValuePaths(), row.source, 'Choose a field\\u2026');
      }
      if (row.kind === 'calc') {
        return '<textarea class="cb-expr" placeholder="e.g. priority >= 3" spellcheck="false">' + escapeHtml(row.expr) + '</textarea>' +
          '<div class="cb-hint">Functions: coalesce, nullif, lower, upper, trim, length, substr, replace, abs, round \\u2014 plus arithmetic, comparisons, and/or/not, case\\u2026when, cast.</div>';
      }
      if (row.kind === 'ai_classify') {
        var lchips = row.labels.map(function (l, i) {
          return '<span class="cb-chip">' + escapeHtml(l) +
            '<button type="button" class="cb-chip-x" data-chip="' + i + '" title="Remove">\\u2715</button></span>';
        }).join('');
        return cbSelectHtml('cb-f-input', cbValuePaths(), row.input, 'Choose the input field\\u2026') +
          '<textarea class="cb-prompt" placeholder="Tell the AI how to pick a label\\u2026" spellcheck="false">' + escapeHtml(row.prompt) + '</textarea>' +
          '<div class="cb-chips">' + lchips +
            '<input class="cb-chip-input" placeholder="Add a label, press Enter" spellcheck="false" />' +
          '</div>';
      }
      if (row.kind === 'ai_transform') {
        var chips = row.inputs.map(function (p, i) {
          return '<span class="cb-chip"><span class="cb-chip-n">' + (i + 1) + '</span>' + escapeHtml(p) +
            '<button type="button" class="cb-chip-x" data-chip="' + i + '" title="Remove">\\u2715</button></span>';
        }).join('');
        var addable = cbValuePaths().filter(function (f) { return row.inputs.indexOf(f.path) < 0; });
        return '<div class="cb-chips">' + (chips || '<span class="cb-hint">No inputs yet.</span>') + '</div>' +
          cbSelectHtml('cb-f-add-input', addable, '', '+ Add an input field\\u2026') +
          '<textarea class="cb-prompt" placeholder="Tell the AI what to write from the inputs\\u2026" spellcheck="false">' + escapeHtml(row.prompt) + '</textarea>';
      }
      // aggregate
      var fnOpts = CB_AGG_FNS.map(function (f) {
        return '<option value="' + f + '"' + (row.fn === f ? ' selected' : '') + '>' + f + '</option>';
      }).join('');
      return '<div class="cb-inline">' +
          cbSelectHtml('cb-f-via', cbAggPaths(), row.via, 'Choose a link\\u2026') +
          '<select class="cb-f-fn">' + fnOpts + '</select>' +
          (row.fn === 'count' ? '' : cbAggColumnHtml(row)) +
        '</div>' +
        '<div class="cb-hint">Folds the linked rows into one value per base row.</div>';
    }

    function cbRowHtml(row, idx) {
      var kindOpts = CB_KINDS.map(function (k) {
        return '<option value="' + k.id + '"' + (row.kind === k.id ? ' selected' : '') + '>' + k.label + '</option>';
      }).join('');
      var mark = row.status === 'ok'
        ? '<span class="cb-mark cb-mark-ok" title="Previewed">\\u2713</span>'
        : row.status === 'err'
          ? '<span class="cb-mark cb-mark-err" title="This field failed the preview">\\u2715</span>'
          : '<span class="cb-mark" aria-hidden="true">\\u00b7</span>';
      return '<div class="cb-field" data-idx="' + idx + '">' +
        '<div class="cb-field-main">' + mark +
          '<input class="cb-field-name" placeholder="field_name" value="' + escapeHtml(row.name) + '"' +
            ' spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Field name" />' +
          '<select class="cb-field-kind" aria-label="Field kind">' + kindOpts + '</select>' +
          '<button type="button" class="cb-field-del" title="Remove this field">\\u2715</button>' +
        '</div>' +
        '<div class="cb-field-body">' + cbRowBodyHtml(row) + '</div>' +
      '</div>';
    }

    // Re-render the field rows from state and re-wire them. Structural edits
    // (kind change, chips, add/remove) re-render; plain typing only writes state.
    function cbRenderFields() {
      var host = document.getElementById('cb-fields');
      if (!host) return;
      host.innerHTML = cbS.rows.map(cbRowHtml).join('');
      host.querySelectorAll('.cb-field').forEach(function (el) {
        var idx = parseInt(el.getAttribute('data-idx'), 10);
        var row = cbS.rows[idx];
        if (!row) return;
        function q(sel) { return el.querySelector(sel); }
        function rerenderKeepChipFocus() {
          cbRenderFields();
          var again = document.querySelector('#cb-fields .cb-field[data-idx="' + idx + '"] .cb-chip-input');
          if (again) again.focus();
        }
        var nameIn = q('.cb-field-name');
        nameIn.addEventListener('input', function () { row.name = nameIn.value; cbMarkDirty(); });
        var kindSel = q('.cb-field-kind');
        kindSel.addEventListener('change', function () { row.kind = kindSel.value; cbMarkDirty(); cbRenderFields(); });
        q('.cb-field-del').addEventListener('click', function () {
          cbS.rows.splice(idx, 1);
          if (!cbS.rows.length) cbS.rows.push(cbNewRow());
          cbMarkDirty();
          cbRenderFields();
        });
        var srcSel = q('.cb-f-source');
        if (srcSel) srcSel.addEventListener('change', function () { row.source = srcSel.value; cbMarkDirty(); });
        var expr = q('.cb-expr');
        if (expr) expr.addEventListener('input', function () { row.expr = expr.value; cbMarkDirty(); });
        var inSel = q('.cb-f-input');
        if (inSel) inSel.addEventListener('change', function () { row.input = inSel.value; cbMarkDirty(); });
        var promptTa = q('.cb-prompt');
        if (promptTa) promptTa.addEventListener('input', function () { row.prompt = promptTa.value; cbMarkDirty(); });
        var chipIn = q('.cb-chip-input');
        if (chipIn) chipIn.addEventListener('keydown', function (ev) {
          if (ev.key !== 'Enter') return;
          ev.preventDefault();
          var v = chipIn.value.trim();
          if (!v || row.labels.indexOf(v) >= 0) return;
          row.labels.push(v);
          cbMarkDirty();
          rerenderKeepChipFocus();
        });
        el.querySelectorAll('.cb-chip-x').forEach(function (x) {
          x.addEventListener('click', function () {
            var i = parseInt(x.getAttribute('data-chip'), 10);
            if (row.kind === 'ai_classify') row.labels.splice(i, 1);
            else row.inputs.splice(i, 1);
            cbMarkDirty();
            cbRenderFields();
          });
        });
        var addIn = q('.cb-f-add-input');
        if (addIn) addIn.addEventListener('change', function () {
          if (!addIn.value) return;
          row.inputs.push(addIn.value);
          cbMarkDirty();
          cbRenderFields();
        });
        var viaSel = q('.cb-f-via');
        if (viaSel) viaSel.addEventListener('change', function () {
          row.via = viaSel.value;
          row.column = '';
          cbMarkDirty();
          cbRenderFields();
        });
        var fnSel = q('.cb-f-fn');
        if (fnSel) fnSel.addEventListener('change', function () { row.fn = fnSel.value; cbMarkDirty(); cbRenderFields(); });
        var colCtl = q('.cb-f-column');
        if (colCtl) colCtl.addEventListener(colCtl.tagName === 'SELECT' ? 'change' : 'input', function () {
          row.column = colCtl.value;
          cbMarkDirty();
        });
      });
    }

    // The definition the current form state describes (the request body's def).
    function cbBuildDef() {
      var fields = {};
      cbS.rows.forEach(function (r) {
        var name = (r.name || '').trim();
        if (!name) return;
        var f;
        if (r.kind === 'alias') f = { kind: 'alias', source: r.source };
        else if (r.kind === 'calc') {
          f = { kind: 'calc', expr: r.expr };
          if (r.calcType) f.type = r.calcType;
        } else if (r.kind === 'ai_classify') {
          f = { kind: 'ai_classify', input: r.input, prompt: r.prompt, labels: r.labels.slice() };
          if (r.model) f.model = r.model;
        } else if (r.kind === 'ai_transform') {
          f = { kind: 'ai_transform', inputs: r.inputs.slice(), prompt: r.prompt };
          if (r.model) f.model = r.model;
        } else {
          f = { kind: 'aggregate', via: r.via, fn: r.fn };
          if (r.column && r.fn !== 'count') f.column = r.column;
        }
        fields[name] = f;
      });
      var def = { base: cbS.base, fields: fields };
      if (cbS.description) def.description = cbS.description;
      return def;
    }

    // Friendly pre-flight checks (the server re-validates everything). Returns
    // the first problem as a message, marking the offending row; null when clean.
    function cbValidateRows() {
      if (!cbS.base) return 'Choose the table this view is built from.';
      var seen = {};
      for (var i = 0; i < cbS.rows.length; i++) {
        var r = cbS.rows[i];
        var n = (r.name || '').trim();
        var problem = null;
        if (!n || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(n)) {
          problem = 'Every field needs a name \\u2014 letters, numbers, and underscores, starting with a letter.';
        } else if (n === 'id') {
          problem = 'The name "id" is reserved for the view\\u2019s key.';
        } else if (seen[n]) {
          problem = 'Two fields are named "' + n + '" \\u2014 field names must be unique.';
        } else if (r.kind === 'alias' && !r.source) {
          problem = 'Field "' + n + '": pick the field to copy.';
        } else if (r.kind === 'calc' && !(r.expr || '').trim()) {
          problem = 'Field "' + n + '": write the calculation expression.';
        } else if (r.kind === 'ai_classify' && (!r.input || !(r.prompt || '').trim() || !r.labels.length)) {
          problem = 'Field "' + n + '": pick an input, write a prompt, and add at least one label.';
        } else if (r.kind === 'ai_transform' && (!r.inputs.length || !(r.prompt || '').trim())) {
          problem = 'Field "' + n + '": add at least one input and write a prompt.';
        } else if (r.kind === 'aggregate' && !r.via) {
          problem = 'Field "' + n + '": pick the link to total across.';
        } else if (r.kind === 'aggregate' && r.fn !== 'count' && !r.column) {
          problem = 'Field "' + n + '": pick the column to ' + r.fn + '.';
        }
        if (problem) {
          r.status = 'err';
          cbRenderFields();
          return problem;
        }
        seen[n] = 1;
      }
      return null;
    }

    // Dry-run the definition (no DDL, nothing persisted): sample rows, per-field
    // marks, and the compiled SQL into the collapsed details block.
    function cbPreview() {
      var problem = cbValidateRows();
      if (problem) { cbShowError(problem); return; }
      cbClearError();
      cbS.busy = true;
      cbSyncStatus();
      fetchJson('/api/computed-tables/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ def: cbBuildDef(), limit: 20 }),
      }).then(function (res) {
        cbS.busy = false;
        cbS.previewOk = true;
        cbS.status = 'previewed';
        cbS.rows.forEach(function (r) { r.status = 'ok'; });
        cbRenderFields();
        cbRenderPreview(res);
        cbSyncStatus();
      }).catch(function (err) {
        cbS.busy = false;
        cbS.previewOk = false;
        cbS.status = 'unsaved';
        // Compile errors name the failing field ('field "x": …') — mark it.
        var m = /field "([^"]+)"/.exec(err.message || '');
        cbS.rows.forEach(function (r) {
          r.status = m && r.name.trim() === m[1] ? 'err' : null;
        });
        cbRenderFields();
        cbShowError(err.message);
        cbSyncStatus();
      });
    }

    function cbRenderPreview(res) {
      var out = document.getElementById('cb-preview-out');
      if (!out) return;
      var cols = res.columns || [];
      var rows = res.rows || [];
      var thead = cols.map(function (c) { return '<th>' + escapeHtml(c) + '</th>'; }).join('');
      var body = rows.map(function (r) {
        var cells = cols.map(function (c) {
          var v = r[c];
          if (v == null || v === '') return '<td><span class="fs-empty-val">\\u2014</span></td>';
          var s = String(v).replace(/\\s+/g, ' ').trim();
          if (s.length > 90) s = s.slice(0, 88) + '\\u2026';
          return '<td>' + escapeHtml(s) + '</td>';
        }).join('');
        return '<tr>' + cells + '</tr>';
      }).join('');
      var pending = res.pendingAi || {};
      var pendingNames = Object.keys(pending).filter(function (k) { return pending[k] > 0; });
      var aiNote = pendingNames.length
        ? '<div class="cb-hint">AI fields fill in the background after you save: ' +
            pendingNames.map(function (k) { return escapeHtml(k) + ' (' + pending[k] + ')'; }).join(', ') + '.</div>'
        : '';
      out.innerHTML =
        '<div class="cb-preview-head">Sample \\u00b7 ' + rows.length + (rows.length === 1 ? ' row' : ' rows') + '</div>' +
        aiNote +
        (rows.length
          ? '<div class="cb-preview-wrap"><table class="pv-table cb-preview-table"><thead><tr>' + thead + '</tr></thead><tbody>' + body + '</tbody></table></div>'
          : '<div class="fs-empty" style="padding:16px">The base table has no rows yet \\u2014 the view compiles, but there is nothing to show.</div>');
      var sqlEl = document.getElementById('cb-sql');
      var sqlPre = document.getElementById('cb-sql-pre');
      if (sqlEl && sqlPre) {
        sqlPre.textContent = res.sql || '';
        sqlEl.hidden = false;
      }
    }

    // Create (POST) or save (PUT), then refresh the entities payload like every
    // other schema mutation and land on the new view's rows.
    function cbSave() {
      var problem = cbValidateRows();
      if (!problem && cbS.mode === 'create' && !CB_NAME_RE.test(cbS.name)) {
        problem = 'Name the view first \\u2014 lowercase letters, numbers, and underscores, starting with a letter.';
      }
      if (problem) { cbShowError(problem); return; }
      cbClearError();
      cbS.busy = true;
      cbS.status = 'saving';
      cbSyncStatus();
      var create = cbS.mode === 'create';
      var name = cbS.name;
      fetchJson(create ? '/api/computed-tables' : '/api/computed-tables/' + encodeURIComponent(name), {
        method: create ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(create ? { name: name, def: cbBuildDef() } : { def: cbBuildDef() }),
      }).then(function () {
        cbS.busy = false;
        cbS.status = 'saved';
        mtEdgesCache = null; // the schema-graph edges now include this view
        return refreshEntities().then(function () {
          showToast((create ? 'Created ' : 'Saved ') + name + ' \\u00b7 undo from history', {});
          location.hash = '#/fs/' + encodeURIComponent(name);
        });
      }).catch(function (err) {
        cbS.busy = false;
        cbS.status = 'unsaved';
        cbShowError(err.message);
        cbSyncStatus();
      });
    }

    // Run the AI fill now, streaming per-field progress into the log block.
    function cbRefresh() {
      var log = document.getElementById('cb-refresh-log');
      if (!log) return;
      log.hidden = false;
      log.textContent = 'Refreshing\\u2026\\n';
      iiStreamNdjson('/api/computed-tables/' + encodeURIComponent(cbS.name) + '/refresh', {}, function (evt) {
        var line = '';
        if (evt.phase === 'field') line = evt.message || ('Filling ' + evt.field + '\\u2026');
        else if (evt.phase === 'field-done') {
          line = evt.field + ': ' + (evt.error
            ? 'failed \\u2014 ' + evt.error
            : 'filled ' + (evt.filled || 0) + (evt.pending ? ' \\u00b7 ' + evt.pending + ' pending' : ''));
        } else if (evt.phase === 'error') line = 'Refresh failed: ' + (evt.message || 'error');
        else if (evt.done) line = 'Done.';
        if (line) log.textContent += line + '\\n';
      });
    }

    // Delete the view (refused by the server while other computed tables are
    // built on it — that refusal lands in the error strip verbatim).
    function cbDelete() {
      // Confirm before the irreversible-looking DELETE (the after-the-fact undo
      // toast still applies, but a stray click shouldn't remove the view).
      if (typeof confirm === 'function' &&
          !confirm('Remove ' + cbS.name + '? You can undo this from history.')) return;
      cbClearError();
      cbS.busy = true;
      cbSyncStatus();
      var name = cbS.name;
      fetchJson('/api/computed-tables/' + encodeURIComponent(name), { method: 'DELETE' })
        .then(function () {
          mtEdgesCache = null;
          return refreshEntities().then(function () {
            showToast('Removed ' + name + ' \\u00b7 undo from history', {});
            location.hash = '#/tables';
          });
        })
        .catch(function (err) {
          cbS.busy = false;
          cbShowError(err.message);
          cbSyncStatus();
        });
    }
`;
