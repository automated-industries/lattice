// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const systemTablesJs = `    // ────────────────────────────────────────────────────────────
    // Data Model — entity graph + entity editor
    // (row-level link/unlink lives on the row detail page now)
    // ────────────────────────────────────────────────────────────
    var dmActiveTable = null;
    // The last rendered brain-graph model, kept so the ingest animation can feed
    // the live renderer the authoritative node/edge set as data streams in.
    var graphModelCache = null;
    // The live force-graph handle (from the out-of-band /gui-assets renderer) and a
    // cached dynamic import of it, so the asset is fetched once per session.
    var schemaGraphHandle = null;
    var _forceGraphModule = null;
    // Bumped on every schema-graph render so an in-flight progressive reveal from a
    // previous render (or a navigation) cancels instead of feeding a stale handle.
    var graphRevealGen = 0;
    // What a plain (non-wire/merge) schema-graph node click does. The Graph Configure tab
    // sets this to drill into that table's rows; null falls back to opening the row view.
    var schemaNodeDrill = null;

    /** Columns that are structurally part of every entity and shouldn't be
     * renamed or removed from the GUI. id is the primary key; deleted_at is
     * the soft-delete column whose semantics undo/redo depends on. */
    var LOCKED_COLUMNS = ['id', 'deleted_at'];

    /** System columns the API treats as immutable — name + type are fixed and
     * the columns editor renders them read-only (mirrors SCHEMA_SYSTEM_COLUMNS
     * on the server, which enforces it). */
    var SYSTEM_COLUMNS = ['id', 'created_at', 'updated_at', 'deleted_at'];

    /** Curated emoji set for entity icons. Click one to select. */
    var EMOJI_PALETTE = [
      '📋', '📅', '👥', '✉️', '📦', '💿', '📄', '🔐',
      '🗂️', '📁', '📓', '📕', '📗', '📘', '📙', '📒',
      '📊', '📈', '📌', '📍', '🧾', '🧰', '🧪', '🧬',
      '🛒', '💼', '💳', '💰', '🏢', '🏬', '🏛️', '🚀',
      '🎯', '🎨', '🛠️', '🔧', '⚙️', '⚡', '🌟', '🔔',
      '🔖', '🔍', '❤️', '🌐', '🌎', '🐙', '🦄', '👤',
    ];

    // Edge styling for the schema graph: a real foreign key vs a many-to-many
    // join (via a junction). Colors live here, not in CSS, because they're
    // drawn into the SVG per edge.
    var DM_FK_COLOR = '#3b82f6'; // belongsTo — an enforced reference
    var DM_M2M_COLOR = '#3b82f6'; // every relationship is many-to-many now (FK deprecated) — green

    // The Model view (center pane): a Graph | Tables toggle over one of two
    // renderings of the same schema — the live force-directed brain graph, or the
    // tiered Tables explorer. The choice persists across renders. Schema/column
    // editing still lives in Settings → Data Model. Clicking a graph node opens
    // that object's tab; clicking a Tables card opens its detail panel.
    // Graph vs Tables is a top-level tab (a route — #/graph and #/tables), NOT an
    // in-pane toggle. So the center pane renders a SINGLE view (no nested toggle
    // bar / div-in-div); the tab strip in the Model header switches between them.
    function renderBrainGraph(content) {
      if (!content) content = document.getElementById('content');
      if (!content) return;
      dmActiveTable = null; // no inline editor in the center view
      // Graph view — keep the #graph-mount id the live renderer + ingest animation expect.
      // A neutral spinner (no placeholder copy) shows until the graph has settled +
      // centred; the force renderer keeps its own spinner once it takes over the mount.
      content.innerHTML =
        '<div class="brain-graph"><div id="graph-mount">' +
          '<div class="graph-loading"><div class="graph-spinner"></div></div>' +
        '</div></div>';
      renderSchemaGraph();
    }

    // Graph section, Object Page: the DRILLED-DOWN graph for one entity — its rows
    // as nodes (labeled by name/id), each linked to the related rows it points at
    // (forward belongsTo). Click a node → that record's entity page. A breadcrumb
    // (rooted at "Graph") keeps the Graph section highlighted, mirroring the folder
    // drill-in. Reuses the same force renderer + wave reveal as the entity graph.
    function renderEntityGraph(content, table) {
      if (!content) content = document.getElementById('content');
      if (!content) return;
      if (!tableByName(table)) {
        content.innerHTML = '<div class="brain-graph"><div class="empty-state">Unknown object: ' + escapeHtml(table) + '</div></div>';
        return;
      }
      var d = displayFor(table);
      content.innerHTML =
        '<div class="brain-graph entity-graph">' +
          '<div class="folders-crumbs graph-crumbs"><a href="#/graph">Graph</a>' +
            '<span class="folders-crumb-sep">/</span>' +
            '<span class="folders-crumb-cur">' + d.icon + ' ' + escapeHtml(d.label) + '</span>' +
          '</div>' +
          '<div id="graph-mount"><div class="graph-loading"><div class="graph-spinner"></div></div></div>' +
        '</div>';
      renderEntityGraphInto(document.getElementById('graph-mount'), table, {});
    }
    // Render one entity's rows as nodes into the given mount (each row linked to the parent
    // rows its FKs name). opts.onRecord(table,id) overrides a row-node click.
    function renderEntityGraphInto(mount, table, opts) {
      opts = opts || {};
      if (!mount) return;
      dmActiveTable = null;
      if (!tableByName(table)) { mount.innerHTML = '<div class="empty-state">Unknown object: ' + escapeHtml(table) + '</div>'; return; }
      var myGen = ++graphRevealGen;
      var d = displayFor(table);
      var modP = loadForceGraph();
      var t = tableByName(table);
      var belongs = [];
      var rels = (t && t.relations) || {};
      for (var k in rels) { if (Object.prototype.hasOwnProperty.call(rels, k) && rels[k] && rels[k].type === 'belongsTo' && rels[k].foreignKey) belongs.push(rels[k]); }
      fetchRowsPage(table, { limit: 150 }).then(function (page) {
        if (myGen !== graphRevealGen) return;
        var rows = page.rows;
        var mount = document.getElementById('graph-mount');
        if (!rows.length) { if (mount) mount.innerHTML = '<div class="empty-state">No items yet in ' + escapeHtml(d.label) + '.</div>'; return; }
        // This entity's rows are the primary nodes (id encodes table:rowId).
        var nodes = rows.map(function (r) {
          return { id: table + ':' + r.id, label: fsDisplayName(r) || String(r.id).slice(0, 8), icon: d.icon, radius: 16, cls: '', title: fsDisplayName(r) };
        });
        var have = {}; nodes.forEach(function (n) { have[n.id] = true; });
        // Forward belongsTo → an edge from each row to the parent row its FK names.
        var edges = [];
        var parentIds = {}; // relTable → { parentId: true }
        belongs.forEach(function (rel) {
          rows.forEach(function (r) {
            var pid = r[rel.foreignKey];
            if (pid == null || pid === '') return;
            edges.push({ source: table + ':' + r.id, target: rel.table + ':' + pid, marker: 'fk', cls: 'dm-edge-fk', title: '' });
            (parentIds[rel.table] = parentIds[rel.table] || {})[pid] = true;
          });
        });
        // Label the linked parent rows (bounded fetch per related table).
        var relTables = Object.keys(parentIds);
        Promise.all(relTables.map(function (rt) {
          return fetchRowsPage(rt, { limit: 300 }).then(function (pp) { return { rt: rt, rows: pp.rows }; }).catch(function () { return { rt: rt, rows: [] }; });
        })).then(function (pages) {
          if (myGen !== graphRevealGen) return;
          var labelOf = {};
          pages.forEach(function (pg) {
            pg.rows.forEach(function (pr) { labelOf[pg.rt + ':' + pr.id] = fsDisplayName(pr) || String(pr.id).slice(0, 8); });
          });
          // Add a node for each referenced parent that isn't already present.
          var added = {};
          edges.forEach(function (e) {
            if (have[e.target] || added[e.target]) return;
            added[e.target] = true;
            var sep = e.target.indexOf(':');
            var pt = e.target.slice(0, sep), pid = e.target.slice(sep + 1);
            nodes.push({ id: e.target, label: labelOf[e.target] || String(pid).slice(0, 8), icon: displayFor(pt).icon, radius: 13, cls: 'gnode-linked', title: displayFor(pt).label });
          });
          modP.then(function (mod) {
            if (myGen !== graphRevealGen) return;
            var liveMount = document.getElementById('graph-mount');
            if (!liveMount) return;
            if (schemaGraphHandle) { schemaGraphHandle.stop(); schemaGraphHandle = null; }
            liveMount.innerHTML = '';
            schemaGraphHandle = mod.createForceGraph(liveMount, {
              nodes: [], edges: [],
              reducedMotion: graphReducedMotion(),
              onNode: function (node) {
                // Click a row node → that record. opts.onRecord overrides the target (the
                // Graph tab opens the record's row view); default is the #/graph record route.
                var sep = node.id.indexOf(':');
                if (sep < 0) return;
                var nt = node.id.slice(0, sep), nid = node.id.slice(sep + 1);
                if (typeof opts.onRecord === 'function') opts.onRecord(nt, nid);
                else location.hash = '#/graph/' + encodeURIComponent(nt) + '/' + encodeURIComponent(nid);
              },
            });
            revealGraphInWaves(nodes, edges, myGen);
          });
        });
      }).catch(function (err) {
        var m = document.getElementById('graph-mount');
        if (m) m.innerHTML = '<div class="empty-state">Failed to load graph: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</div>';
      });
    }

    // The Model > Tables route: the tiered Tables explorer (Source/Model/Derived/
    // Surface). Mounted directly in #content — no toggle wrapper.
    function renderModelTablesView(content) {
      if (!content) content = document.getElementById('content');
      if (!content) return;
      dmActiveTable = null;
      content.innerHTML = '<div class="model-tables-view" id="model-tables-host"></div>';
      renderModelTables(document.getElementById('model-tables-host'));
    }

    // Settings → Data Model: an entity list + the entity editor panel (the schema
    // graph itself moved to the center brain view). Clicking an entity opens its
    // editor in #dm-panel; "+ New entity" opens the create form.
    function renderEntityEditorInto(host) {
      if (!host) return;
      host.innerHTML =
        '<div class="dbconfig-panel panel" style="margin-top:18px">' +
          '<div class="u-spread" style="margin-bottom:10px">' +
            '<h3 class="u-m-0">Data Model</h3>' +
            '<button class="btn primary" id="new-entity-btn">+ New entity</button>' +
          '</div>' +
          '<div class="dm-layout">' +
            '<div id="dm-entity-list"></div>' +
            '<aside id="dm-panel" hidden></aside>' +
          '</div>' +
        '</div>';
      document.getElementById('new-entity-btn').addEventListener('click', function () {
        dmShowEntityEditor(null);
      });
      renderEntityList();
    }

    // The clickable list of entities shown in Settings → Data Model.
    function renderEntityList() {
      var host = document.getElementById('dm-entity-list');
      if (!host) return;
      var tables = ((state.entities && state.entities.tables) || []).filter(function (t) {
        return !isJunction(t);
      });
      tables.sort(function (a, b) {
        return displayFor(a.name).label.toLowerCase().localeCompare(displayFor(b.name).label.toLowerCase());
      });
      host.innerHTML = tables.length
        ? '<ul class="dm-entity-list">' + tables.map(function (t) {
            var d = displayFor(t.name);
            return '<li><button type="button" class="dm-entity-item' +
              (t.name === dmActiveTable ? ' active' : '') + '" data-table="' + escapeHtml(t.name) + '">' +
              '<span class="dm-entity-icon">' + d.icon + '</span>' +
              '<span class="dm-entity-label">' + escapeHtml(d.label) + '</span></button></li>';
          }).join('') + '</ul>'
        : '<div class="empty-state-sm">No entities yet — use “+ New entity”.</div>';
      host.querySelectorAll('.dm-entity-item').forEach(function (b) {
        b.addEventListener('click', function () { dmShowEntityEditor(b.getAttribute('data-table')); });
      });
    }

    // Live force-directed schema graph. Nodes are tables (sized by row count),
    // edges are foreign keys + many-to-many joins. The renderer is loaded out of
    // band (an ESM module under /gui-assets) so the heavy SVG/interaction code
    // stays out of the inline host script; it owns the continuous layout, drag,
    // pan, and zoom. Click a node to open its object; click an edge to edit it.
    function loadForceGraph() {
      if (!_forceGraphModule) _forceGraphModule = import('/gui-assets/force-graph.mjs');
      return _forceGraphModule;
    }
    // Map the internal schema model to the renderer's generic node/edge shape,
    // preserving cloud share-status classes, icons, sizes, and tooltips.
    function schemaGraphData(model) {
      var nodes = model.nodes.map(function (n) {
        var shareCls = n.cloudWorkspace ? (n.shared ? 'gnode-shared' : 'gnode-private') : '';
        var shareTitle = n.cloudWorkspace ? ' · ' + (n.shared ? 'shared' : 'private') : '';
        return {
          id: n.name, label: n.label, icon: n.icon, radius: n.r, cls: shareCls,
          title: n.label + ' · ' + n.rowCount + ' rows · ' + n.cols + ' columns' + shareTitle,
        };
      });
      var edges = model.links.map(function (l) {
        var title = l.kind === 'fk'
          ? l.s + ' → ' + l.t + (l.via ? ' · via ' + l.via : '') + ' (foreign key)'
          : l.s + ' ↔ ' + l.t + ' (many-to-many)';
        return { source: l.s, target: l.t, marker: l.kind, cls: 'dm-edge-' + l.kind, title: title };
      });
      return { nodes: nodes, edges: edges };
    }
    function renderSchemaGraph() {
      var mount = document.getElementById('graph-mount');
      if (!mount) return;
      var myGen = ++graphRevealGen; // cancels any prior render's in-flight reveal
      // Load the renderer module IN PARALLEL with the data fetch so the canvas can
      // paint the instant EITHER resolves — neither waits on the other.
      var modP = loadForceGraph();
      fetchJson('/api/graph?schema=1').then(function (graph) {
        if (myGen !== graphRevealGen) return; // superseded
        var model = buildSchemaModel(graph);
        if (!model.nodes.length) {
          mount.innerHTML = '<div class="empty-state">No objects with data yet. Add files or connect a source to populate the graph.</div>';
          return;
        }
        graphModelCache = model; // baseline for the live ingest animation
        modP.then(function (mod) {
          if (myGen !== graphRevealGen) return; // navigated away / re-rendered
          var liveMount = document.getElementById('graph-mount');
          if (!liveMount) return;
          if (schemaGraphHandle) { schemaGraphHandle.stop(); schemaGraphHandle = null; }
          liveMount.innerHTML = '';
          var data = schemaGraphData(model);
          // Mount EMPTY so the canvas is up instantly, then reveal the nodes in
          // waves so they fly in progressively (the same delta animation the live
          // file-ingest uses) instead of all appearing at once.
          schemaGraphHandle = mod.createForceGraph(liveMount, {
            nodes: [],
            edges: [],
            reducedMotion: graphReducedMotion(),
            onNode: function (node) {
              // In Wire/Merge mode a node click picks a source then a target (drag
              // stays off the graph, which owns node repositioning). Otherwise drill
              // into that table's rows (the Graph tab sets schemaNodeDrill); with no
              // drill hook, open the table's row view.
              if (typeof wmModeClick === 'function' && wmModeClick(node.id)) return;
              if (schemaGraphHandle) schemaGraphHandle.setSelected(node.id);
              if (typeof schemaNodeDrill === 'function' && schemaNodeDrill) schemaNodeDrill(node.id);
              else location.hash = '#/w/table/' + encodeURIComponent(node.id);
            },
            onEdge: function (edge) {
              // m2m → drill the junction table; FK → drill the child (source) table.
              var target = edge.source;
              if (edge.marker === 'm2m') {
                var j = junctionsFor(edge.source).find(function (x) { return x.remoteRel.table === edge.target; }) ||
                        junctionsFor(edge.target).find(function (x) { return x.remoteRel.table === edge.source; });
                target = j ? j.junction : edge.source;
              }
              if (typeof schemaNodeDrill === 'function' && schemaNodeDrill) schemaNodeDrill(target);
              else location.hash = '#/w/table/' + encodeURIComponent(target);
            },
          });
          revealGraphInWaves(data.nodes, data.edges, myGen);
        }).catch(function (err) {
          var m = document.getElementById('graph-mount');
          if (m) m.innerHTML = '<div class="empty-state">Failed to load the graph renderer: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</div>';
        });
      }).catch(function (err) {
        mount.innerHTML = '<div class="empty-state">Failed to load schema graph: ' +
          escapeHtml(err.message) + '</div>';
      });
    }

    // Reveal a freshly-mounted schema graph in waves: hand the live handle a growing
    // prefix of the nodes on a short timer so each batch's new nodes fly in (setData
    // is a diff — it animates the delta and skips edges whose endpoints aren't in
    // yet, so passing ALL edges every wave is safe). Big hubs first (by radius) reads
    // as the graph "building out". Reduced motion or a tiny graph → one shot.
    function revealGraphInWaves(allNodes, allEdges, myGen) {
      if (!schemaGraphHandle) return;
      if (graphReducedMotion() || allNodes.length <= 8) {
        schemaGraphHandle.setData(allNodes, allEdges);
        return;
      }
      var ordered = allNodes.slice().sort(function (a, b) { return (b.radius || 0) - (a.radius || 0); });
      var step = Math.max(3, Math.ceil(ordered.length / 10)); // ~10 waves
      var shown = 0;
      function wave() {
        if (myGen !== graphRevealGen || !schemaGraphHandle) return; // superseded
        shown = Math.min(shown + step, ordered.length);
        schemaGraphHandle.setData(ordered.slice(0, shown), allEdges);
        if (shown < ordered.length) window.setTimeout(wave, 90);
      }
      wave();
    }

    // Build {nodes, links} from /api/graph: table nodes (junctions already
    // collapsed into m2m edges by the server) + belongsTo/manyToMany edges.
    function buildSchemaModel(graph) {
      var byName = {};
      ((state.entities && state.entities.tables) || []).forEach(function (t) { byName[t.name] = t; });
      var nodes = [];
      var index = {};
      (graph.nodes || []).filter(function (n) { return n.type === 'table'; }).forEach(function (n) {
        var name = n.table || n.label;
        if (index[name] != null) return;
        var meta = byName[name] || {};
        var rc = (meta.rowCount != null) ? meta.rowCount : 0;
        if (rc <= 0) return; // only show objects that have items in them (non-empty)
        // SOURCE-tier tables (files, connector-synced, imported databases) are raw
        // inputs — excluded from the graph (like the Objects grid); they live in
        // the Inputs column + the Tables explorer's Source column only.
        if (mtClassifyTier(meta) === 'source') return;
        index[name] = nodes.length;
        nodes.push({
          name: name,
          label: displayFor(name).label,
          icon: displayFor(name).icon,
          rowCount: rc,
          cols: (meta.columns || []).length,
          // Bubble size scales with row count on a LOG scale (row counts span orders
          // of magnitude, so linear/sqrt would swamp small tables). Clamped between a
          // min + max radius: rc≈0 → 10, rc≳5000 → 30.
          r: Math.round(10 + 20 * Math.min(1, Math.log(rc + 1) / Math.log(5000))),
          // Share status (cloud workspaces only). ownedByMe is set by the
          // server solely on cloud workspaces, so its presence flags a cloud
          // DB; on local DBs share status is N/A (no coloring).
          shared: meta.shared === true,
          cloudWorkspace: meta.ownedByMe !== undefined,
          x: 0, y: 0, vx: 0, vy: 0,
        });
      });
      var seen = {};
      var links = [];
      (graph.edges || []).forEach(function (e) {
        var kind = e.type === 'belongsTo' ? 'fk' : (e.type === 'manyToMany' ? 'm2m' : null);
        if (!kind) return;
        var s = String(e.source).replace(/^table:/, '');
        var t = String(e.target).replace(/^table:/, '');
        if (index[s] == null || index[t] == null || s === t) return;
        var key = kind + ':' + s + '|' + t;
        if (seen[key]) return;
        seen[key] = true;
        links.push({ s: s, t: t, si: index[s], ti: index[t], kind: kind, via: e.label || '' });
      });
      return { nodes: nodes, links: links, index: index };
    }

    /**
     * Show the editor for a selected entity. Pass null to render the
     * 'create new entity' form (same controls, different submit endpoint).
     * Until the user clicks a graph node or '+ New entity', the side panel
     * stays hidden.
     */
    function dmShowEntityEditor(tableName) {
      dmActiveTable = tableName;
      var panel = document.getElementById('dm-panel');
      if (!panel) return; // the editor panel only exists in Settings → Data Model
      panel.hidden = false;
      var creating = !tableName;
      if (creating) {
        // New entities are PRIVATE by default — on a team cloud you own
        // a table you create, and sharing it with the team is a separate,
        // explicit toggle on the entity below (no auto-share-on-create).
        panel.innerHTML =
          '<h3>+ New entity</h3>' +
          '<div class="dm-edit-grid">' +
            '<label>Name</label>' +
            '<div class="dm-row-inline">' +
              '<input id="dm-create-name" placeholder="e.g. invoices" autofocus />' +
            '</div>' +
            '<label>Icon</label>' +
            '<div>' +
              emojiPickerHtml('dm-create-icon', '📋') +
            '</div>' +
            '<label></label>' +
            '<div class="dm-row-inline">' +
              '<button class="btn primary" id="dm-create-btn">Create entity</button>' +
            '</div>' +
          '</div>' +
          '<div class="hint" style="margin-top:14px">' +
            'New entities get id (uuid PK), name, and deleted_at columns. ' +
            'Add more columns once the entity exists. On a cloud workspace the ' +
            'entity is private to you until you share it.' +
          '</div>';
        wireEmojiPicker(panel, 'dm-create-icon');
        var createBtn = panel.querySelector('#dm-create-btn');
        createBtn.addEventListener('click', function () {
          var name = panel.querySelector('#dm-create-name').value.trim();
          var icon = panel.querySelector('#dm-create-icon').value.trim();
          if (!name) { panel.querySelector('#dm-create-name').focus(); return; }
          withBusy(createBtn, function () {
            return fetchJson('/api/schema/entities', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: name, icon: icon || undefined }),
            }).then(function () {
              gaTrack('table_create', {}); // event only — never the table name
              // New node not in the current graph → rebuild it (in place, no
              // route change so the drawer scroll is preserved).
              return dmRefreshPanel(name, true);
            }).then(function () {
              showToast('Entity "' + name + '" created', {});
            }).catch(function (err) { showToast('Create failed: ' + err.message, {}); });
          });
        });
        return;
      }

      var t = tableByName(tableName);
      if (!t) {
        panel.innerHTML = '<div class="muted">Unknown entity.</div>';
        return;
      }
      var d = displayFor(tableName);
      // Team cloud: only the table's owner may edit its schema/relationships
      // (the server enforces this too). A table shared by another member is
      // shown read-only here, rather than offering controls that would 403.
      if (t.ownedByMe === false) {
        var roCols = (t.columns || []).map(function (c) {
          var tgt = belongsToColumns(t).find(function (b) { return b.rel.foreignKey === c; });
          return '<div class="dm-col-row"><div class="dm-locked">' + escapeHtml(c) +
            (tgt ? '<span class="dm-locked-label">→ ' + escapeHtml(displayFor(tgt.rel.table).label) + '</span>' : '') +
            '</div></div>';
        }).join('');
        panel.innerHTML =
          '<h3>' + d.icon + ' ' + escapeHtml(d.label) + '</h3>' +
          '<div class="hint u-mb-3">Shared by another member — read-only. Only the table owner can edit its columns and relationships.</div>' +
          '<div class="dm-cols">' + (roCols || '<span class="muted">No columns</span>') + '</div>';
        return;
      }
      // Pre-fill the picker with the effective icon (override > built-in
      // default > generic fallback) so the dropdown reflects what's actually
      // rendered elsewhere in the GUI.
      var overrideIcon = d.icon;
      // Prefer the canonical Lattice field type (text/uuid/datetime/…) surfaced
      // on the payload; fall back to the SQL spec with modifiers stripped for
      // code-defined tables (e.g. native entities) that carry no field types.
      function dmShortType(c) {
        if (t.fieldTypes && t.fieldTypes[c]) {
          var canon = String(t.fieldTypes[c]).toLowerCase();
          return ({ int: 'integer', bool: 'boolean', float: 'real' })[canon] || canon;
        }
        var raw = (t.columnTypes && t.columnTypes[c]) || '';
        return String(raw)
          .replace(/\\s+(primary key|not null|default\\b.*)/gi, '')
          .trim()
          .toLowerCase() || 'text';
      }
      // The editor is UNIFORM for every table (links-only model — no special
      // junction branch, which is what previously exposed the table-dropping
      // "Delete relationship" button). Columns and links are different things
      // and edit differently:
      //   • system  — id/created_at/updated_at/deleted_at: name + type fixed,
      //               read-only (the server enforces this too).
      //   • link    — a foreign-key column. Created via "Add link"; can't be
      //               edited once created, only deleted individually (drops the
      //               FK column only, never a table).
      //   • scalar  — editable name + secret flag, staged behind ONE Save.
      // Whole-table deletion is a separate, typed-confirmation danger-zone
      // action below — never a side effect of editing a relationship.
      var fkByCol = {};
      belongsToColumns(t).forEach(function (b) { fkByCol[b.rel.foreignKey] = b.rel.table; });
      var systemCols = [], scalarCols = [], linkCols = [];
      (t.columns || []).forEach(function (c) {
        if (SYSTEM_COLUMNS.indexOf(c) !== -1) systemCols.push(c);
        else if (fkByCol[c]) linkCols.push(c);
        else scalarCols.push(c);
      });

      // ── Columns section (system read-only + editable scalars) ──
      var sysRows = systemCols.map(function (c) {
        return '<div class="dm-col-row">' +
          '<div class="dm-locked">' + escapeHtml(c) +
            '<span class="dm-locked-label">system</span></div>' +
          '<span class="dm-col-type">' + escapeHtml(dmShortType(c)) + '</span>' +
          '<span></span>' +
          '</div>';
      }).join('');
      var scalarRows = scalarCols.map(function (c) {
        var secret = isSecretColumn(tableName, c);
        return '<div class="dm-col-row">' +
          '<input class="dm-col-name" data-orig="' + escapeHtml(c) + '" value="' + escapeHtml(c) + '" />' +
          '<span class="dm-col-type">' + escapeHtml(dmShortType(c)) + '</span>' +
          '<label class="dm-secret-toggle" title="Mask values in the GUI">' +
            '<input type="checkbox" class="dm-col-secret" data-orig="' + escapeHtml(c) + '"' +
              ' data-was="' + (secret ? '1' : '0') + '"' + (secret ? ' checked' : '') + ' /> secret</label>' +
          '</div>';
      }).join('');
      var columnsHtml = sysRows + scalarRows;

      // ── Links section — every relationship is bidirectional and many-to-many.
      // A link between A and B is one thing: it shows in BOTH editors and
      // deleting it from either side removes it from both. "Add link" creates a
      // junction table (the M2M representation). For backward compatibility we
      // also surface legacy 1:N foreign-key columns (this entity's own, and any
      // pointing AT it) as links so they're visible and deletable from either
      // side — but new links are always M2M.
      var dmLinks = collectEntityLinks(tableName);
      var linkRows = dmLinks.map(function (lk, i) {
        return '<div class="dm-link-row">' +
          '<span class="dm-link-name">' + escapeHtml(displayFor(lk.other).label) + '</span>' +
          '<span class="dm-link-arrow' + (lk.kind === 'fk' ? ' legacy' : '') + '" ' +
            (lk.kind === 'fk' ? 'title="Legacy one-to-many link. New links are many-to-many; this is kept for back-compat and will be migrated in 2.0."' : '') +
            '>' + (lk.kind === 'fk' ? '→ one-to-many (legacy)' : '↔ many-to-many') + '</span>' +
          '<button class="btn danger dm-link-destroy" data-link="' + i +
            '" title="Delete this link — removes it from both tables">Delete link</button>' +
          '</div>';
      }).join('');
      // Add-link target picker. Excludes self, junction tables, and any entity
      // already linked (either direction) — one link per pair. Recomputed on
      // every in-place re-render so a target disappears the moment you link it.
      var linkedTargets = {};
      dmLinks.forEach(function (lk) { linkedTargets[lk.other] = 1; });
      var linkTargets = ((state.entities && state.entities.tables) || []).filter(function (rt) {
        return !isJunction(rt) && rt.name !== tableName && !linkedTargets[rt.name];
      }).sort(function (a, b) {
        return displayFor(a.name).label.toLowerCase().localeCompare(displayFor(b.name).label.toLowerCase());
      });
      var addLinkHtml = linkTargets.length
        ? '<div class="dm-row-inline u-mt-2">' +
            '<select id="dm-newlink-target" title="Link to entity (many-to-many)">' +
              linkTargets.map(function (rt) {
                return '<option value="' + escapeHtml(rt.name) + '">↔ ' + escapeHtml(displayFor(rt.name).label) + '</option>';
              }).join('') +
            '</select>' +
            '<button class="btn primary" id="dm-newlink-btn">Add link</button>' +
          '</div>'
        : '<span class="hint">No other entities to link to.</span>';

      // Cloud sharing row — only the owner of a table may toggle its
      // visibility (t.ownedByMe is set by the server only for cloud
      // workspaces). Tables shared to me by others, and all local-DB
      // tables, show no sharing control.
      var canShare = !!(t && t.ownedByMe === true);
      var isShared = !!(t && t.shared);
      var neverShare = !!(t && t.neverShare);
      // A never-share table (e.g. secrets) can NEVER be shared — its rows are a
      // hard-private floor — so the "Share with workspace" button must not exist
      // for it; show a static note instead.
      var shareRow = !canShare
        ? ''
        : neverShare
          ? '<label>Cloud sharing</label>' +
            '<div class="u-row-wrap">' +
              '<span class="hint">🔒 Private to you — this table is never shared.</span>' +
            '</div>'
          : '<label>Cloud sharing</label>' +
            '<div class="u-row-wrap">' +
              '<button class="btn' + (isShared ? '' : ' primary') + '" id="dm-share-btn">' +
                (isShared ? 'Make private' : 'Share with workspace') +
              '</button>' +
              '<span class="hint">' +
                (isShared ? 'Visible to everyone on this cloud workspace.' : 'Private to you. Share to make it visible to everyone on this cloud workspace.') +
              '</span>' +
            '</div>';
      // Owner-only "new rows default to" control, shown for a shared table.
      // A never-share table's rows are always private, so the default-visibility
      // select is disabled while never-share is on.
      var defaultVis = (t && t.defaultRowVisibility) || 'private';
      var defaultVisRow = canShare && isShared
        ? '<label>New rows default to</label>' +
          '<div class="u-row-wrap">' +
            '<select id="dm-rowvis-select"' + (neverShare ? ' disabled' : '') + '>' +
              '<option value="private"' + (defaultVis === 'private' ? ' selected' : '') + '>Private (owner only)</option>' +
              '<option value="everyone"' + (defaultVis === 'everyone' ? ' selected' : '') + '>Everyone on the workspace</option>' +
            '</select>' +
            '<span class="hint">Visibility new rows in this table are created with.</span>' +
          '</div>'
        : '';
      // Owner-only "Never share" control, shown for a shared table. When on, the
      // table's rows are always private to their owner regardless of the default
      // visibility above — a hard floor the owner can set per shared table.
      var neverShareRow = canShare && isShared
        ? '<label>Never share</label>' +
          '<div class="u-row-wrap">' +
            '<label class="dm-secret-toggle">' +
              '<input type="checkbox" id="dm-nevershare-check"' + (neverShare ? ' checked' : '') + ' /> Keep all rows private' +
            '</label>' +
            '<span class="hint">When on, rows in this table are always private to their owner, ignoring the default above.</span>' +
          '</div>'
        : '';
      panel.innerHTML =
        '<h3>' + d.icon + ' ' + escapeHtml(d.label) + '</h3>' +
        '<div class="dm-edit-grid">' +
          '<label>Name</label>' +
          '<div class="dm-row-inline">' +
            '<input id="dm-rename-input" value="' + escapeHtml(tableName) + '" />' +
            '<button class="btn" id="dm-rename-btn">Save</button>' +
          '</div>' +
          '<label>Icon</label>' +
          '<div>' +
            emojiPickerHtml('dm-icon-input', overrideIcon) +
            '<button class="btn" id="dm-icon-btn" style="margin-top:6px;">Save</button>' +
          '</div>' +
          shareRow +
          defaultVisRow +
          neverShareRow +
          '<label>Columns</label>' +
          '<div>' +
            '<div class="dm-cols">' + (columnsHtml || '<span class="muted">No columns</span>') + '</div>' +
            (scalarCols.length
              ? '<button class="btn primary u-mt-2" id="dm-cols-save" disabled>Save changes</button>'
              : '') +
          '</div>' +
          '<label>Add column</label>' +
          '<div class="dm-row-inline">' +
            '<input id="dm-newcol-name" placeholder="column_name" />' +
            '<select id="dm-newcol-type">' +
              '<option value="text">text</option>' +
              '<option value="integer">integer</option>' +
              '<option value="real">real</option>' +
              '<option value="boolean">boolean</option>' +
            '</select>' +
            '<label class="dm-secret-toggle">' +
              '<input type="checkbox" id="dm-newcol-secret" /> secret' +
            '</label>' +
            '<button class="btn primary" id="dm-newcol-btn">Add</button>' +
          '</div>' +
          '<label>Links</label>' +
          '<div>' +
            '<div class="dm-links">' + (linkRows || '<span class="hint">No links.</span>') + '</div>' +
            addLinkHtml +
          '</div>' +
          '<label>Danger zone</label>' +
          '<div class="dm-danger">' +
            '<button class="btn danger" id="dm-delete-table">Delete table</button>' +
            '<span class="hint">Permanently drops this table and all its rows. ' +
              'You\\'ll be asked to type the name to confirm. Refused while other tables link to it.</span>' +
          '</div>' +
        '</div>';
      wireEmojiPicker(panel, 'dm-icon-input');
      wireEntityEditPanel(panel, tableName);
      var shareBtn = panel.querySelector('#dm-share-btn');
      if (shareBtn) shareBtn.addEventListener('click', function () {
        // "Shared" maps to the table's default row visibility = everyone (vs
        // owner-private) under the 3.1 RLS model, so the toggle drives the
        // existing default-row-visibility endpoint. (The old /share endpoint was
        // removed in the RLS rewrite — calling it 404'd, which is why the control
        // appeared dead.)
        var nextVis = isShared ? 'private' : 'everyone';
        gaTrack('data_model_share', { visibility: nextVis }); // coarse enum only, no table name
        withBusy(shareBtn, function () {
          return fetchJson('/api/schema/entities/' + encodeURIComponent(tableName) + '/default-row-visibility', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ visibility: nextVis }),
          }).then(function () {
            // Rebuild the graph (not just the panel) so the node's share-status
            // colour (gnode-shared/gnode-private) recolours immediately from the
            // refreshed entities — otherwise the swatch stayed stale until a
            // manual reload. The editor re-shows for the same table.
            return dmRefreshPanel(tableName, true);
          }).then(function () {
            showToast(isShared ? 'Unshared "' + tableName + '" from workspace' : 'Shared "' + tableName + '" with workspace', {});
          }).catch(function (e) { showToast('Share update failed: ' + e.message, {}); });
        });
      });

      var rowvisSelect = panel.querySelector('#dm-rowvis-select');
      if (rowvisSelect) rowvisSelect.addEventListener('change', function () {
        var next = rowvisSelect.value;
        withBusy(rowvisSelect, function () {
          return fetchJson('/api/schema/entities/' + encodeURIComponent(tableName) + '/default-row-visibility', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ visibility: next }),
          }).then(function () {
            return dmRefreshPanel(tableName, false);
          }).then(function () {
            showToast(next === 'everyone' ? 'New rows now default to everyone' : 'New rows now default to private', {});
          }).catch(function (e) { showToast('Default visibility update failed: ' + e.message, {}); });
        });
      });

      var neverShareCheck = panel.querySelector('#dm-nevershare-check');
      if (neverShareCheck) neverShareCheck.addEventListener('change', function () {
        var on = neverShareCheck.checked;
        // Disable while the round-trip is in flight; dmRefreshPanel rebuilds the
        // panel (and the default-visibility select's disabled state) on success.
        neverShareCheck.disabled = true;
        fetchJson('/api/schema/entities/' + encodeURIComponent(tableName) + '/never-share', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ on: on }),
        }).then(function () {
          return dmRefreshPanel(tableName, false);
        }).then(function () {
          showToast(on ? 'Rows in "' + tableName + '" are now always private' : 'Rows in "' + tableName + '" follow the default visibility', {});
        }).catch(function (e) {
          neverShareCheck.disabled = false;
          neverShareCheck.checked = !on;
          showToast('Never-share update failed: ' + e.message, {});
        });
      });
    }

    /**
     * Render a collapsed emoji-picker: a button showing the currently selected
     * emoji (with a ▾ caret) and a hidden grid that drops down when clicked.
     * Selecting a tile updates the hidden input and the button, then closes
     * the dropdown.
     *
     * currentValue is the emoji to pre-fill (saved override OR the inherited
     * default — callers pass displayFor(table).icon so the dropdown reflects
     * what the user actually sees on the rest of the page).
     */
    function emojiPickerHtml(inputId, currentValue) {
      var current = currentValue || '📋';
      var tiles = EMOJI_PALETTE.map(function (e) {
        var active = e === current ? ' active' : '';
        return '<button type="button" class="emoji-tile' + active +
          '" data-emoji="' + escapeHtml(e) + '" aria-label="' + escapeHtml(e) + '">' + e + '</button>';
      }).join('');
      return '<div class="emoji-picker" data-input-id="' + escapeHtml(inputId) + '">' +
        '<button type="button" class="emoji-trigger" aria-haspopup="grid" aria-expanded="false">' +
          '<span class="emoji-preview">' + escapeHtml(current) + '</span>' +
          '<span class="emoji-caret">▾</span>' +
        '</button>' +
        '<div class="emoji-grid" hidden>' + tiles + '</div>' +
        '<input type="hidden" id="' + escapeHtml(inputId) + '" value="' + escapeHtml(current) + '" />' +
      '</div>';
    }

    function wireEmojiPicker(panel, inputId) {
      var picker = panel.querySelector('.emoji-picker[data-input-id="' + inputId + '"]');
      if (!picker) return;
      var input = picker.querySelector('input[type="hidden"]');
      var trigger = picker.querySelector('.emoji-trigger');
      var preview = picker.querySelector('.emoji-preview');
      var grid = picker.querySelector('.emoji-grid');

      function open() {
        grid.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
      }
      function close() {
        grid.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
      }

      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        if (grid.hidden) open(); else close();
      });

      // Click anywhere outside the picker closes it.
      document.addEventListener('click', function (e) {
        if (grid.hidden) return;
        if (!picker.contains(e.target)) close();
      });

      picker.querySelectorAll('.emoji-tile').forEach(function (tile) {
        tile.addEventListener('click', function () {
          var v = tile.getAttribute('data-emoji');
          input.value = v;
          preview.textContent = v;
          picker.querySelectorAll('.emoji-tile').forEach(function (t) {
            t.classList.toggle('active', t === tile);
          });
          close();
        });
      });
    }

    /** Wire up the edit-entity controls in the Data Model side panel. */
    function wireEntityEditPanel(panel, tableName) {
      // Rename entity — schema change, not in the audit log, so we keep
      // a confirm (the only kind of warning left in the app).
      panel.querySelector('#dm-rename-btn').addEventListener('click', function () {
        var to = panel.querySelector('#dm-rename-input').value.trim();
        if (!to || to === tableName) return;
        if (!confirm('Rename entity "' + tableName + '" to "' + to + '"? This is irreversible from the GUI.')) return;
        fetchJson('/api/schema/entities/' + encodeURIComponent(tableName) + '/rename', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ to: to }),
        }).then(function () {
          return dmRefreshPanel(to, true);
        }).then(function () {
          showToast('Entity renamed to "' + to + '"', {});
        }).catch(function (err) { showToast('Rename failed: ' + err.message, {}); });
      });
      // Edit icon
      panel.querySelector('#dm-icon-btn').addEventListener('click', function () {
        var icon = panel.querySelector('#dm-icon-input').value.trim();
        fetchJson('/api/gui-meta/' + encodeURIComponent(tableName), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ icon: icon }),
        }).then(function () {
          return dmRefreshPanel(tableName, false);
        }).then(function () {
          showToast('Icon saved', {});
        }).catch(function (err) { showToast('Icon save failed: ' + err.message, {}); });
      });
      // Add column — scalar data columns only (text/integer/real/boolean).
      // uuid is reserved for keys and relationships ("links") are created via
      // "Add link" below — neither is offered here.
      var newcolBtn = panel.querySelector('#dm-newcol-btn');
      if (newcolBtn) newcolBtn.addEventListener('click', function () {
        var name = panel.querySelector('#dm-newcol-name').value.trim();
        var type = panel.querySelector('#dm-newcol-type').value;
        var secret = !!panel.querySelector('#dm-newcol-secret').checked;
        if (!name) return;
        withBusy(newcolBtn, function () {
          return fetchJson('/api/schema/entities/' + encodeURIComponent(tableName) + '/columns', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: name, type: type }),
          }).then(function () {
            if (!secret) return;
            // Persist the secret flag for the new column.
            return fetchJson(
              '/api/gui-meta/columns/' + encodeURIComponent(tableName) + '/' + encodeURIComponent(name),
              {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ secret: true }),
              },
            );
          }).then(function () {
            return dmRefreshPanel(tableName, false);
          }).then(function () {
            showToast('Column "' + name + '" added', {});
          }).catch(function (err) { showToast('Add column failed: ' + err.message, {}); });
        });
      });
      // Save staged column changes (renames + secret flags) in ONE shot.
      // Column names and secret flags are edited inline and nothing persists
      // until "Save changes". We diff against the originals (data-orig /
      // data-was) and POST only the deltas; the server enforces the real
      // rules (no system rename, scalar types only) so a bad edit 400s loudly.
      var colsSaveBtn = panel.querySelector('#dm-cols-save');
      function colsDirty() {
        var dirty = false;
        panel.querySelectorAll('input.dm-col-name').forEach(function (inp) {
          if (inp.value.trim() !== inp.getAttribute('data-orig')) dirty = true;
        });
        panel.querySelectorAll('input.dm-col-secret').forEach(function (cb) {
          if ((cb.checked ? '1' : '0') !== cb.getAttribute('data-was')) dirty = true;
        });
        return dirty;
      }
      function refreshColsSaveState() { if (colsSaveBtn) colsSaveBtn.disabled = !colsDirty(); }
      panel.querySelectorAll('input.dm-col-name, input.dm-col-secret').forEach(function (el) {
        el.addEventListener('input', refreshColsSaveState);
        el.addEventListener('change', refreshColsSaveState);
      });
      if (colsSaveBtn) colsSaveBtn.addEventListener('click', function () {
        if (colsSaveBtn.disabled) return;
        withBusy(colsSaveBtn, function () {
          var ops = [];
          panel.querySelectorAll('input.dm-col-name').forEach(function (inp) {
            var orig = inp.getAttribute('data-orig');
            var to = inp.value.trim();
            var cb = panel.querySelector('input.dm-col-secret[data-orig="' + orig + '"]');
            var secretChanged = !!cb && (cb.checked ? '1' : '0') !== cb.getAttribute('data-was');
            ops.push({
              orig: orig,
              to: to,
              rename: !!to && to !== orig,
              secretChanged: secretChanged,
              secret: cb ? !!cb.checked : false,
            });
          });
          var chain = Promise.resolve();
          ops.forEach(function (op) {
            chain = chain.then(function () {
              if (!op.rename) return;
              return fetchJson('/api/schema/entities/' + encodeURIComponent(tableName) +
                '/columns/' + encodeURIComponent(op.orig) + '/rename', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ to: op.to }),
              });
            }).then(function () {
              if (!op.secretChanged) return;
              var name = op.rename ? op.to : op.orig;
              return fetchJson('/api/gui-meta/columns/' + encodeURIComponent(tableName) +
                '/' + encodeURIComponent(name), {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ secret: op.secret }),
              });
            });
          });
          return chain.then(function () { return dmRefreshPanel(tableName, false); })
            .then(function () {
              showToast('Column changes saved', {});
            }).catch(function (err) { showToast('Save failed: ' + err.message, {}); });
        });
      });
      // Add link — creates a many-to-many junction between this entity and the
      // chosen one. The relationship is bidirectional: it appears in both
      // editors and is deletable from either side.
      var newlinkBtn = panel.querySelector('#dm-newlink-btn');
      if (newlinkBtn) newlinkBtn.addEventListener('click', function () {
        var target = panel.querySelector('#dm-newlink-target').value;
        if (!target) return;
        withBusy(newlinkBtn, function () {
          return fetchJson('/api/schema/junctions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ left: tableName, right: target }),
          }).then(function () { return dmRefreshPanel(tableName, true); })
            .then(function () {
              showToast('Linked ' + displayFor(tableName).label + ' ↔ ' + displayFor(target).label, {});
            }).catch(function (err) { showToast('Add link failed: ' + err.message, {}); });
        });
      });
      // Delete a link — bidirectional. A many-to-many link drops its junction
      // table (removing it from both sides at once); a legacy 1:N link drops
      // its foreign-key column. Never drops a first-class entity's data. The
      // link list is recomputed here so the index matches the rendered rows.
      var dmLinksNow = collectEntityLinks(tableName);
      panel.querySelectorAll('.dm-link-destroy').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var lk = dmLinksNow[Number(btn.getAttribute('data-link'))];
          if (!lk) return;
          if (!confirm('Delete the link between "' + tableName + '" and "' + lk.other +
            '"? It is removed from both tables. This is irreversible from the GUI.')) return;
          var url = lk.kind === 'junction'
            ? '/api/schema/entities/' + encodeURIComponent(lk.delTable)
            : '/api/schema/entities/' + encodeURIComponent(lk.delTable) +
                '/links/' + encodeURIComponent(lk.delCol);
          withBusy(btn, function () {
            return fetchJson(url, { method: 'DELETE' })
              .then(function () { return dmRefreshPanel(tableName, true); })
              .then(function () {
                showToast('Link to "' + lk.other + '" deleted', {});
              }).catch(function (err) { showToast('Delete link failed: ' + err.message, {}); });
          });
        });
      });
      // Delete the whole table — the single, explicit table-drop path. Gated
      // behind a type-the-name confirmation; the server additionally refuses
      // while another table links to this one (no broken data models).
      var delTable = panel.querySelector('#dm-delete-table');
      if (delTable) delTable.addEventListener('click', function () {
        // The name is shown with text-transform:none so the user types the
        // real case; the match is case-insensitive anyway so the label's
        // uppercase styling can't trip them up.
        var nameTag = '<code style="text-transform:none;font-weight:600">' +
          escapeHtml(tableName) + '</code>';
        var matches = function (v) {
          return (v || '').trim().toLowerCase() === tableName.toLowerCase();
        };
        showModal('Delete table "' + tableName + '"',
          '<p class="u-m-0 u-mb-2">This permanently drops the table ' + nameTag +
            ' and all its rows. This cannot be undone.</p>' +
          '<p class="hint u-m-0 u-mb-3">' +
            'You can\\'t delete a table while another table links to it — delete those links first ' +
            '(they show in this table\\'s Links section).</p>' +
          '<div class="field"><label>Type ' + nameTag +
            ' to confirm</label><input id="dm-del-confirm" autocomplete="off" ' +
            'autocapitalize="off" autocorrect="off" spellcheck="false" /></div>',
        {
          primaryLabel: 'Delete table',
          primaryClass: 'danger',
          onBody: function (bd) {
            var ok = bd.querySelector('[data-act="ok"]');
            var inp = bd.querySelector('#dm-del-confirm');
            if (ok) ok.disabled = true;
            if (inp) {
              inp.addEventListener('input', function () {
                if (ok) ok.disabled = !matches(inp.value);
              });
              inp.focus();
            }
          },
          onSubmit: function (bd) {
            if (!matches(bd.querySelector('#dm-del-confirm').value)) {
              throw new Error('Name does not match');
            }
            return fetchJson('/api/schema/entities/' + encodeURIComponent(tableName), {
              method: 'DELETE',
            }).then(function () {
              gaTrack('table_delete', {}); // event only — never the table name
              return dmRefreshPanel(null, true);
            }).then(function () {
              showToast('Table "' + tableName + '" deleted', {});
            });
          },
        });
      });
    }

`;
