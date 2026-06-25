// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const systemTablesJs = `    // ────────────────────────────────────────────────────────────
    // Data Model — entity graph + entity editor
    // (row-level link/unlink lives on the row detail page now)
    // ────────────────────────────────────────────────────────────
    var dmActiveTable = null;
    // The last rendered brain-graph model, so the ingest animation can diff the
    // delta (new nodes/edges) and seed their start positions from the prior layout.
    var graphModelCache = null;

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

    // The brain graph as the center pane's main view — the schema graph, full
    // size, with no inline entity editor (schema/column editing lives in
    // Settings → Data Model). Clicking a node opens that object's tab.
    function renderBrainGraph(content) {
      if (!content) content = document.getElementById('content');
      if (!content) return;
      dmActiveTable = null; // no inline editor in the center view
      content.innerHTML =
        '<div class="brain-graph"><div id="graph-mount">' +
          '<div class="muted" style="padding:24px">A live force-directed graph that builds as Claude streams.</div>' +
        '</div></div>';
      renderSchemaGraph();
    }

    // Settings → Data Model: an entity list + the entity editor panel (the schema
    // graph itself moved to the center brain view). Clicking an entity opens its
    // editor in #dm-panel; "+ New entity" opens the create form.
    function renderEntityEditorInto(host) {
      if (!host) return;
      host.innerHTML =
        '<div class="dbconfig-panel" style="margin-top:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
            '<h3 style="margin:0">Data Model</h3>' +
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
        : '<div class="muted" style="padding:12px">No entities yet — use “+ New entity”.</div>';
      host.querySelectorAll('.dm-entity-item').forEach(function (b) {
        b.addEventListener('click', function () { dmShowEntityEditor(b.getAttribute('data-table')); });
      });
    }

    // Force-directed schema graph (vanilla — no external lib). Nodes are
    // tables, sized by row count; edges are foreign keys (belongsTo) and
    // many-to-many joins (junctions surface as a single m2m edge). Drag a node
    // to reposition, scroll to zoom, drag the background to pan, click a node
    // to edit the entity.
    function renderSchemaGraph() {
      var mount = document.getElementById('graph-mount');
      if (!mount) return;
      fetchJson('/api/graph').then(function (graph) {
        var model = buildSchemaModel(graph);
        if (!model.nodes.length) {
          mount.innerHTML = '<div class="muted" style="padding:24px">No objects with data yet. Add files or connect a source to populate the graph.</div>';
          return;
        }
        forceLayout(model.nodes, model.links);
        mount.innerHTML = schemaGraphSvg(model);
        wireSchemaGraph(mount, model);
        graphModelCache = model; // seed the delta baseline for the ingest animation
        if (dmActiveTable) {
          dmShowEntityEditor(dmActiveTable);
          highlightGraphNode(dmActiveTable);
        }
      }).catch(function (err) {
        mount.innerHTML = '<div class="muted" style="padding:24px">Failed to load schema graph: ' +
          escapeHtml(err.message) + '</div>';
      });
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
        index[name] = nodes.length;
        nodes.push({
          name: name,
          label: displayFor(name).label,
          icon: displayFor(name).icon,
          rowCount: rc,
          cols: (meta.columns || []).length,
          r: Math.max(11, Math.min(26, 11 + Math.sqrt(rc))),
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

    // A small deterministic force simulation: ~500 settle ticks of pairwise
    // repulsion + link springs + center gravity. O(n²) repulsion is fine for
    // schema-scale graphs (tens of tables).
    function forceLayout(nodes, links, iters) {
      var n = nodes.length;
      var W = 1000, H = 700, cx = W / 2, cy = H / 2;
      var ringR = Math.min(W, H) * 0.32;
      for (var i = 0; i < n; i++) {
        var a = (i / Math.max(1, n)) * 2 * Math.PI;
        nodes[i].x = cx + Math.cos(a) * ringR;
        nodes[i].y = cy + Math.sin(a) * ringR;
        nodes[i].vx = 0; nodes[i].vy = 0;
      }
      var REPULSION = 9000, SPRING_LEN = 140, SPRING_K = 0.02, GRAVITY = 0.012, DAMP = 0.85;
      var ticks = iters || 500;
      for (var it = 0; it < ticks; it++) {
        for (var p = 0; p < n; p++) {
          for (var q = p + 1; q < n; q++) {
            var dx = nodes[p].x - nodes[q].x, dy = nodes[p].y - nodes[q].y;
            var d2 = dx * dx + dy * dy + 0.01, d = Math.sqrt(d2);
            var rep = REPULSION / d2;
            var fx = (dx / d) * rep, fy = (dy / d) * rep;
            nodes[p].vx += fx; nodes[p].vy += fy;
            nodes[q].vx -= fx; nodes[q].vy -= fy;
          }
        }
        links.forEach(function (l) {
          var a2 = nodes[l.si], b2 = nodes[l.ti];
          var dx2 = b2.x - a2.x, dy2 = b2.y - a2.y, d3 = Math.sqrt(dx2 * dx2 + dy2 * dy2) + 0.01;
          var f = (d3 - SPRING_LEN) * SPRING_K, fx2 = (dx2 / d3) * f, fy2 = (dy2 / d3) * f;
          a2.vx += fx2; a2.vy += fy2; b2.vx -= fx2; b2.vy -= fy2;
        });
        for (var m = 0; m < n; m++) {
          nodes[m].vx += (cx - nodes[m].x) * GRAVITY;
          nodes[m].vy += (cy - nodes[m].y) * GRAVITY;
          nodes[m].vx *= DAMP; nodes[m].vy *= DAMP;
          nodes[m].x += nodes[m].vx; nodes[m].y += nodes[m].vy;
        }
      }
    }

    function schemaGraphSvg(model) {
      var nodes = model.nodes, links = model.links;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      nodes.forEach(function (nd) {
        minX = Math.min(minX, nd.x - nd.r); minY = Math.min(minY, nd.y - nd.r);
        maxX = Math.max(maxX, nd.x + nd.r); maxY = Math.max(maxY, nd.y + nd.r);
      });
      var pad = 50;
      var vb = [minX - pad, minY - pad, (maxX - minX) + 2 * pad, (maxY - minY) + 2 * pad];
      var defs =
        '<defs>' +
          '<marker id="dm-arrow-fk" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
            '<path d="M0,0 L10,5 L0,10 z" fill="' + DM_FK_COLOR + '"/></marker>' +
          '<marker id="dm-arrow-m2m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
            '<path d="M0,0 L10,5 L0,10 z" fill="' + DM_M2M_COLOR + '"/></marker>' +
        '</defs>';
      var edgeSvg = links.map(function (l, i) {
        var a = nodes[l.si], b = nodes[l.ti];
        var color = DM_FK_COLOR; // green for every relationship
        var dash = ''; // solid lines for all (m2m is the only relationship now)
        var markEnd = ' marker-end="url(#dm-arrow-' + l.kind + ')"';
        var markStart = l.kind === 'm2m' ? ' marker-start="url(#dm-arrow-m2m)"' : '';
        var title = l.kind === 'fk'
          ? l.s + ' → ' + l.t + (l.via ? ' · via ' + l.via : '') + ' (foreign key)'
          : l.s + ' ↔ ' + l.t + ' (many-to-many)';
        return '<line class="dm-edge" data-edge="' + i + '" data-s="' + escapeHtml(l.s) + '" data-t="' +
          escapeHtml(l.t) + '" x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' +
          b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '" stroke="' + color + '" stroke-width="1.6"' +
          dash + markStart + markEnd + ' opacity="0.7"><title>' + escapeHtml(title) + '</title></line>';
      }).join('');
      var nodeSvg = nodes.map(function (nd) {
        // Share-status coloring applies only on cloud workspaces (G). On a
        // local DB share status is N/A, so no extra class → neutral stroke.
        var shareCls = nd.cloudWorkspace ? (nd.shared ? ' gnode-shared' : ' gnode-private') : '';
        var shareTitle = nd.cloudWorkspace ? ' · ' + (nd.shared ? 'shared' : 'private') : '';
        return '<g class="gnode' + shareCls + '" data-table="' + escapeHtml(nd.name) + '" transform="translate(' +
          nd.x.toFixed(1) + ',' + nd.y.toFixed(1) + ')">' +
          '<circle class="gnode-glow" r="' + (nd.r + 8).toFixed(1) + '"/>' +
          '<circle class="gnode-dot" r="' + nd.r.toFixed(1) + '"/>' +
          '<text class="gnode-icon" y="' + (nd.r * 0.34).toFixed(1) + '" text-anchor="middle" font-size="' +
            (nd.r * 0.95).toFixed(1) + '">' + nd.icon + '</text>' +
          '<text class="gnode-label" y="' + (nd.r + 15).toFixed(1) + '" text-anchor="middle">' +
            escapeHtml(nd.label) + '</text>' +
          '<title>' + escapeHtml(nd.label + ' · ' + nd.rowCount + ' rows · ' + nd.cols + ' columns' + shareTitle) + '</title>' +
          '</g>';
      }).join('');
      // No legend: every relationship is a green many-to-many link now (foreign
      // keys are deprecated), so there's nothing to disambiguate.
      return '<svg class="dm-graph" viewBox="' + vb.join(' ') + '" preserveAspectRatio="xMidYMid meet">' +
        defs + '<g class="dm-stage">' + edgeSvg + nodeSvg + '</g></svg>';
    }

    function highlightGraphNode(tableName) {
      document.querySelectorAll('#graph-mount g.gnode').forEach(function (g) {
        g.classList.toggle('active', g.getAttribute('data-table') === tableName);
      });
    }

    // Wire interactions on the rendered schema graph: node click → editor,
    // node drag → reposition (live edge updates), background drag → pan, wheel
    // → zoom. Pan/zoom are done by mutating the SVG viewBox.
    function wireSchemaGraph(mount, model) {
      var svg = mount.querySelector('svg.dm-graph');
      if (!svg) return;
      var nodeEls = {};
      mount.querySelectorAll('g.gnode').forEach(function (g) { nodeEls[g.getAttribute('data-table')] = g; });
      var edgeEls = mount.querySelectorAll('line.dm-edge');

      function vb() { return svg.getAttribute('viewBox').split(' ').map(Number); }
      function setVb(a) { svg.setAttribute('viewBox', a.join(' ')); }
      // The initial viewBox fits all entities — that's the maximum zoom-out;
      // don't let the user zoom out past it into empty space.
      var fitVb = vb();
      function toData(ev) {
        var rect = svg.getBoundingClientRect();
        var b = vb();
        return {
          x: b[0] + ((ev.clientX - rect.left) / rect.width) * b[2],
          y: b[1] + ((ev.clientY - rect.top) / rect.height) * b[3],
        };
      }
      function nodeByName(name) {
        for (var i = 0; i < model.nodes.length; i++) if (model.nodes[i].name === name) return model.nodes[i];
        return null;
      }
      function updateNode(name) {
        var nd = nodeByName(name); var g = nodeEls[name];
        if (!nd || !g) return;
        g.setAttribute('transform', 'translate(' + nd.x.toFixed(1) + ',' + nd.y.toFixed(1) + ')');
        edgeEls.forEach(function (ln) {
          if (ln.getAttribute('data-s') === name) { ln.setAttribute('x1', nd.x.toFixed(1)); ln.setAttribute('y1', nd.y.toFixed(1)); }
          if (ln.getAttribute('data-t') === name) { ln.setAttribute('x2', nd.x.toFixed(1)); ln.setAttribute('y2', nd.y.toFixed(1)); }
        });
      }

      // Wheel zoom toward the cursor. Zooming out is capped at the fit view
      // (snap back to it) so the graph can't shrink into empty space.
      svg.addEventListener('wheel', function (ev) {
        ev.preventDefault();
        var b = vb(); var pt = toData(ev);
        // Smooth, proportional zoom — scale by the (clamped) scroll delta instead
        // of a fixed 12% step, which felt jumpy. A trackpad sends many small deltas
        // → continuous; a mouse notch is clamped so it can't lurch.
        var d = Math.max(-50, Math.min(50, ev.deltaY));
        var factor = Math.pow(1.0018, d);
        var nw = b[2] * factor, nh = b[3] * factor;
        // Cap zoom-OUT at the fit view (outermost objects + their padding) so the
        // graph can never shrink into empty space.
        if (nw >= fitVb[2] || nh >= fitVb[3]) { setVb(fitVb.slice()); return; }
        setVb([pt.x - (pt.x - b[0]) * (nw / b[2]), pt.y - (pt.y - b[1]) * (nh / b[3]), nw, nh]);
      }, { passive: false });

      // Click an edge to edit the relationship in the columns editor: an m2m
      // edge opens its junction table (its two ref columns are editable there);
      // a foreign-key edge opens the child entity that holds the FK column.
      edgeEls.forEach(function (ln) {
        ln.style.cursor = 'pointer';
        ln.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var s = ln.getAttribute('data-s'), t = ln.getAttribute('data-t');
          var edge = model.links[Number(ln.getAttribute('data-edge'))];
          if (edge && edge.kind === 'm2m') {
            var j = junctionsFor(s).find(function (x) { return x.remoteRel.table === t; }) ||
                    junctionsFor(t).find(function (x) { return x.remoteRel.table === s; });
            dmShowEntityEditor(j ? j.junction : s);
          } else {
            dmShowEntityEditor(s); // FK lives on the source (child) table
          }
        });
      });

      // Drag: a node repositions it; the background pans.
      var drag = null;
      svg.addEventListener('pointerdown', function (ev) {
        var g = ev.target.closest && ev.target.closest('g.gnode');
        if (g) {
          drag = { kind: 'node', name: g.getAttribute('data-table'), moved: false };
        } else {
          var b = vb();
          drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, vb: b };
        }
        svg.setPointerCapture(ev.pointerId);
      });
      svg.addEventListener('pointermove', function (ev) {
        if (!drag) return;
        if (drag.kind === 'node') {
          var pt = toData(ev); var nd = nodeByName(drag.name);
          if (nd) { nd.x = pt.x; nd.y = pt.y; updateNode(drag.name); drag.moved = true; }
        } else {
          var rect = svg.getBoundingClientRect();
          var b = drag.vb;
          setVb([b[0] - (ev.clientX - drag.sx) * (b[2] / rect.width),
                 b[1] - (ev.clientY - drag.sy) * (b[3] / rect.height), b[2], b[3]]);
        }
      });
      svg.addEventListener('pointerup', function (ev) {
        if (drag && drag.kind === 'node' && !drag.moved) {
          // Open the clicked object's table in a tab — schema/column editing now
          // lives in Settings → Data Model, not the graph.
          location.hash = (advancedMode() ? '#/objects/' : '#/fs/') + encodeURIComponent(drag.name);
        }
        drag = null;
        try { svg.releasePointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
      });
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
          '<div class="muted" style="margin-top:14px;font-size:12px;">' +
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
          '<div class="muted" style="font-size:12px;margin-bottom:12px">Shared by another member — read-only. Only the table owner can edit its columns and relationships.</div>' +
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
        ? '<div class="dm-row-inline" style="margin-top:8px">' +
            '<select id="dm-newlink-target" title="Link to entity (many-to-many)">' +
              linkTargets.map(function (rt) {
                return '<option value="' + escapeHtml(rt.name) + '">↔ ' + escapeHtml(displayFor(rt.name).label) + '</option>';
              }).join('') +
            '</select>' +
            '<button class="btn primary" id="dm-newlink-btn">Add link</button>' +
          '</div>'
        : '<span class="muted" style="font-size:12px">No other entities to link to.</span>';

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
            '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
              '<span style="font-size:12px;color:var(--text-muted)">🔒 Private to you — this table is never shared.</span>' +
            '</div>'
          : '<label>Cloud sharing</label>' +
            '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
              '<button class="btn' + (isShared ? '' : ' primary') + '" id="dm-share-btn">' +
                (isShared ? 'Make private' : 'Share with workspace') +
              '</button>' +
              '<span style="font-size:12px;color:var(--text-muted)">' +
                (isShared ? 'Visible to everyone on this cloud workspace.' : 'Private to you. Share to make it visible to everyone on this cloud workspace.') +
              '</span>' +
            '</div>';
      // Owner-only "new rows default to" control, shown for a shared table.
      // A never-share table's rows are always private, so the default-visibility
      // select is disabled while never-share is on.
      var defaultVis = (t && t.defaultRowVisibility) || 'private';
      var defaultVisRow = canShare && isShared
        ? '<label>New rows default to</label>' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
            '<select id="dm-rowvis-select"' + (neverShare ? ' disabled' : '') + '>' +
              '<option value="private"' + (defaultVis === 'private' ? ' selected' : '') + '>Private (owner only)</option>' +
              '<option value="everyone"' + (defaultVis === 'everyone' ? ' selected' : '') + '>Everyone on the workspace</option>' +
            '</select>' +
            '<span style="font-size:12px;color:var(--text-muted)">Visibility new rows in this table are created with.</span>' +
          '</div>'
        : '';
      // Owner-only "Never share" control, shown for a shared table. When on, the
      // table's rows are always private to their owner regardless of the default
      // visibility above — a hard floor the owner can set per shared table.
      var neverShareRow = canShare && isShared
        ? '<label>Never share</label>' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
            '<label class="dm-secret-toggle">' +
              '<input type="checkbox" id="dm-nevershare-check"' + (neverShare ? ' checked' : '') + ' /> Keep all rows private' +
            '</label>' +
            '<span style="font-size:12px;color:var(--text-muted)">When on, rows in this table are always private to their owner, ignoring the default above.</span>' +
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
              ? '<button class="btn primary" id="dm-cols-save" style="margin-top:8px" disabled>Save changes</button>'
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
            '<div class="dm-links">' + (linkRows || '<span class="muted" style="font-size:12px">No links.</span>') + '</div>' +
            addLinkHtml +
          '</div>' +
          '<label>Danger zone</label>' +
          '<div class="dm-danger">' +
            '<button class="btn danger" id="dm-delete-table">Delete table</button>' +
            '<span style="font-size:12px;color:var(--text-muted)">Permanently drops this table and all its rows. ' +
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
          '<p style="margin:0 0 8px">This permanently drops the table ' + nameTag +
            ' and all its rows. This cannot be undone.</p>' +
          '<p style="margin:0 0 12px;font-size:12px;color:var(--text-muted)">' +
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
