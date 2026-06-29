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
    function mtHiddenTiers() {
      try { return new Set(JSON.parse(window.localStorage.getItem('lattice.modeltables.hidden') || '[]')); }
      catch (e) { return new Set(); }
    }
    function mtSetHiddenTiers(set) {
      try { window.localStorage.setItem('lattice.modeltables.hidden', JSON.stringify(Array.prototype.slice.call(set))); } catch (e) {}
    }

    function renderModelTables(host) {
      if (!host) return;
      var entities = mtBuildModel();
      var caveats = mtCaveats(entities);
      var level = mtLevel();
      var hidden = mtHiddenTiers();

      if (!entities.length) {
        host.innerHTML = '<div class="mt"><div class="muted" style="padding:24px">No tables yet. Add files, connect a source, or connect a database to populate the model.</div></div>';
        return;
      }

      var chips = MT_LAYERS.map(function (l) {
        return '<button type="button" class="mt-chip mt-chip-' + l.id + (hidden.has(l.id) ? '' : ' on') +
          '" data-mt-tier="' + l.id + '">' + escapeHtml(l.short) + '</button>';
      }).join('');

      var tiers = MT_LAYERS.filter(function (l) { return !hidden.has(l.id); }).map(function (l) {
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
            '<span class="mt-bar-label">Show</span>' +
            '<div class="mt-chips">' + chips + '</div>' +
          '</div>' +
          '<div class="mt-main">' +
            '<div class="mt-tiers">' + tiers + '</div>' +
            '<aside class="mt-detail" id="mt-detail" hidden></aside>' +
          '</div>' +
        '</div>';

      host.querySelectorAll('.mt-seg-btn').forEach(function (b) {
        b.addEventListener('click', function () { mtSetLevel(b.getAttribute('data-mt-level')); renderModelTables(host); });
      });
      host.querySelectorAll('.mt-chip').forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.getAttribute('data-mt-tier');
          var h = mtHiddenTiers();
          if (h.has(id)) h.delete(id); else h.add(id);
          mtSetHiddenTiers(h);
          renderModelTables(host);
        });
      });
      host.querySelectorAll('.mt-card').forEach(function (b) {
        b.addEventListener('click', function () { mtOpenDetail(b.getAttribute('data-table'), entities, caveats); });
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
        return '<li class="mt-field mt-c-' + f.cls + '"><span class="mt-field-name">' + escapeHtml(f.name) + '</span>' +
          (f.type ? '<span class="mt-field-type">' + escapeHtml(f.type) + '</span>' : '') + '</li>';
      }).join('');
      return head + '<ul class="mt-fields">' + rows + '</ul>';
    }

    function mtOpenDetail(name, entities, caveats) {
      var panel = document.getElementById('mt-detail');
      if (!panel) return;
      var e = entities.filter(function (x) { return x.name === name; })[0];
      if (!e) { panel.hidden = true; return; }
      var mine = (caveats || []).filter(function (c) { return c.affects.indexOf(name) !== -1; });
      var fields = e.fields.map(function (f) {
        return '<div class="mt-detail-field mt-c-' + f.cls + '"><span class="mt-field-name">' + escapeHtml(f.name) + '</span>' +
          (f.type ? '<span class="mt-field-type">' + escapeHtml(f.type) + '</span>' : '') + '</div>';
      }).join('');
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
        '<div class="mt-detail-sec"><h4>Fields</h4>' + fields + '</div>' +
        caveatHtml +
        '<a class="mt-detail-open" href="#/fs/' + encodeURIComponent(e.name) + '">Open object \\u2192</a>';
      panel.hidden = false;
      var close = document.getElementById('mt-detail-close');
      if (close) close.addEventListener('click', function () { panel.hidden = true; });
    }
`;
