// Auto-composed segment of the GUI client script (see modules/index.ts). The
// Configure drawer's two new tabs — Data Model (Tables explorer + schema editor |
// Graph) and Inputs (Files | Connectors | Databases) — dispatched from
// selectDrawerTab (table-view.ts). Reuses the existing renderers + element ids so
// their render/wire fns work unchanged. Must stay INSIDE the client IIFE (uses
// fetchJson/renderModelTables/renderSchemaGraph/…);
// registered before createDatabaseWizardJs.
export const configureDrawerJs = `
    // Open the Configure drawer to a tab. Guarded call to openSettingsDrawer (the drawer
    // machinery), which then calls selectDrawerTab. The subtab arg is legacy — Graph is now
    // its own top-level Configure tab, so a caller asking for the graph opens that tab.
    function openConfigureDrawer(tab, subtab) {
      if (typeof openSettingsDrawer === 'function') {
        openSettingsDrawer(subtab === 'graph' ? 'graph' : tab || 'datamodel');
      }
    }

    // ── Data Model tab: the tiered Tables explorer, FULL WIDTH. Graph is now its own
    // Configure tab (renderGraphTab). Selecting a table shows its read-only detail in the
    // explorer's own panel; the column/relationship editor stays an opt-in button, so
    // "selecting an object is enough". No 340px side panel eats the width.
    // ── Data-model planner panel (#dm-panel): the deterministic planner's
    // auto-applied fixes + reviewable suggestions, fetched from /api/data-model/plan
    // (the same route the on-open sweep hits). Apply/Dismiss post back to the planner.
    function renderDataModelPlan(host) {
      if (!host) return;
      host.hidden = false;
      host.innerHTML = '<div class="dm-plan-note">Analyzing data model\\u2026</div>';
      var toast = typeof showToast === 'function' ? showToast : function () {};
      var post = function (url, id) {
        return fetchJson(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: id }),
        });
      };
      var reRender = function () {
        renderDataModelPlan(host);
        if (typeof renderModelTables === 'function') renderModelTables(document.getElementById('model-tables-host'));
      };
      fetchJson('/api/data-model/plan')
        .then(function (plan) {
          var html = '';
          var applied = (plan.autoApplied || []).filter(function (a) { return a && a.ok; });
          if (applied.length) {
            html += '<div class="dm-plan-head">Applied automatically</div>';
            applied.forEach(function (a) {
              html += '<div class="dm-plan-applied">' + escapeHtml(a.summary) + '</div>';
            });
          }
          var props = plan.proposals || [];
          if (props.length) {
            html += '<div class="dm-plan-head">Suggestions (' + props.length + ')</div>';
            props.forEach(function (p) {
              html += '<div class="dm-plan-card" data-id="' + escapeHtml(p.id) + '">' +
                '<div class="dm-plan-why">' + escapeHtml(p.rationale) + '</div>' +
                '<button type="button" class="btn btn-sm dm-apply-btn">Apply</button> ' +
                '<button type="button" class="btn btn-sm btn-ghost dm-dismiss-btn">Dismiss</button>' +
                '</div>';
            });
          }
          // A clean model → hide the panel entirely rather than leave an empty box.
          if (!html) { host.hidden = true; host.innerHTML = ''; return; }
          host.innerHTML = html;
          Array.prototype.forEach.call(host.querySelectorAll('.dm-apply-btn'), function (btn) {
            btn.addEventListener('click', function () {
              var card = btn.closest('.dm-plan-card'); if (!card) return;
              withBusy(btn, function () {
                return post('/api/data-model/apply', card.getAttribute('data-id')).then(function (body) {
                  var a = body && body.applied && body.applied[0];
                  if (a && !a.ok) { toast('Could not apply: ' + (a.error || 'failed'), {}); renderDataModelPlan(host); return; }
                  toast((a && a.summary) || 'Applied', {});
                  if (typeof refreshEntities === 'function') refreshEntities().then(reRender, reRender); else reRender();
                }).catch(function () { toast('Could not apply', {}); renderDataModelPlan(host); });
              });
            });
          });
          Array.prototype.forEach.call(host.querySelectorAll('.dm-dismiss-btn'), function (btn) {
            btn.addEventListener('click', function () {
              var card = btn.closest('.dm-plan-card'); if (!card) return;
              withBusy(btn, function () {
                return post('/api/data-model/dismiss', card.getAttribute('data-id'))
                  .then(function () { renderDataModelPlan(host); })
                  .catch(function () { renderDataModelPlan(host); });
              });
            });
          });
        })
        .catch(function () { host.hidden = true; host.innerHTML = ''; });
    }

    function renderDataModelTab(body) {
      if (!body) return;
      body.innerHTML =
        '<div class="dm-fullwidth"><div id="model-tables-host"></div>' +
        '<div id="dm-panel" class="dm-panel"></div></div>';
      if (typeof renderModelTables === 'function') {
        renderModelTables(document.getElementById('model-tables-host'));
      }
      renderDataModelPlan(document.getElementById('dm-panel'));
    }

    // ── Graph tab: the force-directed schema graph, FULL WIDTH, with a Link / Merge
    // toolbar. Link/Merge is a click-to-pick flow (click the button, then two nodes) —
    // the only mode that works on the graph, whose nodes own their own drag. Clicking a
    // table node drills into that table's rows shown visually as a graph; Back returns.
    function graphToolbarHtml(lead) {
      return (
        '<div class="graph-toolbar">' +
        (lead || '') +
        '<span class="graph-tools-spacer"></span>' +
        '<button type="button" class="btn btn-sm" id="wm-wire-btn">Link</button>' +
        '<button type="button" class="btn btn-sm" id="wm-merge-btn">Merge</button>' +
        '</div>'
      );
    }
    function wireGraphToolbar() {
      var w = document.getElementById('wm-wire-btn');
      if (w) w.addEventListener('click', function () { if (typeof wmSetMode === 'function') wmSetMode('wire'); });
      var m = document.getElementById('wm-merge-btn');
      if (m) m.addEventListener('click', function () { if (typeof wmSetMode === 'function') wmSetMode('merge'); });
      if (typeof wmRenderButtons === 'function') wmRenderButtons();
    }
    function renderGraphTab(body) {
      if (body) renderGraphSchema(body);
    }
    function renderGraphSchema(body) {
      if (!body) return;
      body.innerHTML =
        '<div class="graph-tab">' +
        graphToolbarHtml('') +
        '<div class="brain-graph"><div id="graph-mount">' +
        '<div class="graph-loading"><div class="graph-spinner"></div></div></div></div>' +
        '</div>';
      wireGraphToolbar();
      // A plain node click drills into that table's rows (shown visually as a graph).
      schemaNodeDrill = function (table) { renderGraphEntity(body, table); };
      if (typeof renderSchemaGraph === 'function') renderSchemaGraph();
    }
    function renderGraphEntity(body, table) {
      if (!body) return;
      var d = typeof displayFor === 'function' ? displayFor(table) : { icon: '', label: table };
      body.innerHTML =
        '<div class="graph-tab">' +
        graphToolbarHtml(
          '<button type="button" class="btn btn-sm" id="graph-back">\\u2190 All objects</button>' +
            '<span class="graph-drill-label">' + d.icon + ' ' + escapeHtml(d.label) + '</span>',
        ) +
        '<div class="brain-graph entity-graph"><div id="graph-mount">' +
        '<div class="graph-loading"><div class="graph-spinner"></div></div></div></div>' +
        '</div>';
      var back = document.getElementById('graph-back');
      if (back) back.addEventListener('click', function () { renderGraphSchema(body); });
      wireGraphToolbar();
      schemaNodeDrill = null; // at row level, a node click opens that record (below)
      if (typeof renderEntityGraphInto === 'function') {
        renderEntityGraphInto(document.getElementById('graph-mount'), table, {
          onRecord: function (t, id) {
            location.hash = '#/w/table/' + encodeURIComponent(t) + '/' + encodeURIComponent(id);
          },
        });
      }
    }

    // ── Inputs tab: Files | Connectors | Databases (existing ids, existing fns) ──
    // The Files tab is GRID-ONLY (the old list/grid toggle is retired). The grid keeps
    // the nested folder structure (folder roots expand to nested tile grids) and
    // inherits the ✕ remove control + de-dupe from the shared data prep. A stale
    // "list" preference in storage is ignored — everyone gets the grid.
    function renderInputsFiles(rows) {
      var host = document.getElementById('inputs-files-tree');
      if (!host) return;
      if (typeof renderSourcesGridInto === 'function') renderSourcesGridInto(host, rows);
      else if (typeof renderSourcesFilesInto === 'function') renderSourcesFilesInto(host, rows);
    }
    // Files / Connectors / Databases are now three separate Configure tabs (the tab
    // name IS the heading, so the old .inputs-group-head subheadings are dropped). Each
    // reuses the same element ids + wiring fns as the former single Inputs tab.
    function renderFilesTab(body) {
      if (!body) return;
      body.innerHTML =
        '<div class="inputs-group">' +
        '<div id="inputs-files-tree" class="inputs-files-grid-host"></div>' +
        '<div class="src-add-row src-add-files-wrap">' +
        '<button class="src-add" id="src-add-files" type="button" aria-haspopup="menu" aria-expanded="false">＋ Add files or folder</button>' +
        '<div class="src-add-menu" id="src-add-files-menu" role="menu" hidden>' +
        '<button type="button" class="src-add-menu-item" data-pick="file" role="menuitem">Add file(s)…</button>' +
        '<button type="button" class="src-add-menu-item" data-pick="folder" role="menuitem">Add a folder…</button>' +
        '</div></div>' +
        '<div class="src-note"><span class="src-note-ic">🔒</span>Secured: files never leave your computer.</div>' +
        '</div>';
      if (typeof wireSourcesButtons === 'function') wireSourcesButtons();
      var loadFiles = function () {
        fetchJson('/api/tables/files/rows?exclude=' + encodeURIComponent('extracted_text,description'))
          .then(function (data) {
            renderInputsFiles(((data && data.rows) || []).filter(function (r) { return !r.deleted_at && !r.artifact_type; }));
          })
          .catch(function () { renderInputsFiles([]); });
      };
      loadFiles();
    }
    function renderConnectorsTab(body) {
      if (!body) return;
      // Full-width (the body carries dm-wide for this tab). Inline, no drawer.
      // The connected-servers TABLE (#mcp-connectors-list) and the add form
      // (#mcp-connectors-form) are separate mounts: the table can refresh while
      // the form persists, so a half-typed URL is never wiped.
      body.innerHTML =
        '<div class="db-panel">' +
        '<p class="db-lead">Pick a service below for a guided connect, or add any MCP server by URL. ' +
        'You authorize each server directly with its own sign-in; tokens are stored encrypted on this ' +
        'machine and synced data stays local.</p>' +
        '<div id="mcp-catalog"></div>' +
        '<div id="mcp-connectors-list"></div>' +
        '<div id="mcp-connectors-form" class="db-form-host"></div></div>';
      if (typeof renderConnectorsPanel === 'function') renderConnectorsPanel();
    }
    function renderDatabasesTab(body) {
      if (!body) return;
      // Full-width (the body carries dm-wide for this tab). Inline, no drawer.
      // The connected-databases TABLE (#src-databases-list) and the add/edit FORM
      // (#db-form-host) are separate mounts: the table refreshes on realtime ticks
      // while the form persists, so a half-typed connection is never wiped.
      body.innerHTML =
        '<div class="db-panel">' +
        '<p class="db-lead">Connect an external Postgres database (AWS RDS, Supabase, or generic ' +
        'Postgres). Its tables are imported as a READ-ONLY data source — Lattice never writes to ' +
        'it. Use a read-only database user where possible.</p>' +
        '<div id="src-databases-list"></div>' +
        '<div id="db-form-host" class="db-form-host"></div></div>';
      if (typeof renderDatabasesPanel === 'function') renderDatabasesPanel();
    }
`;
