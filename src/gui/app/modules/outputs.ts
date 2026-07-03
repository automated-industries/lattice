// Auto-composed segment of the GUI client script (see modules/index.ts). The
// Outputs column (right side): Artifacts (Lattice-created files, moved here from
// the left Inputs sidebar), plus Markdown / Tables / Server Docs / API Docs / MCP
// sections wired in later steps. Must stay INSIDE the client IIFE (uses
// fetchJson/escapeHtml), inserted before createDatabaseWizardJs.
export const outputsJs = `
    // Paint the Artifacts list into the Outputs column. renderSources() passes the
    // already-fetched artifact rows (so we never double-fetch /api/tables/files);
    // a direct call with no argument self-fetches (bounded — projects out the heavy
    // text columns) for callers that don't have the rows in hand.
    function renderOutputsArtifacts(artifacts) {
      var host = document.getElementById('out-artifacts-tree');
      if (!host) return;
      if (artifacts) { paintOutputsArtifacts(host, artifacts); return; }
      fetchJson('/api/tables/files/rows?exclude=' + encodeURIComponent('extracted_text,description'))
        .then(function (data) {
          var rows = ((data && data.rows) || []).filter(function (r) { return !r.deleted_at && r.artifact_type; });
          paintOutputsArtifacts(host, rows);
        })
        .catch(function () { paintOutputsArtifacts(host, []); });
    }

    function paintOutputsArtifacts(host, artifacts) {
      if (!artifacts || !artifacts.length) { host.innerHTML = '<div class="src-empty">Nothing created yet.</div>'; return; }
      host.innerHTML = '<ul class="src-tree">' + artifacts.map(function (r) {
        var name = r.name || r.original_name || 'Untitled';
        var ic = r.artifact_type === 'html' ? '🌐' : '📝';
        return '<li class="src-node src-file" data-id="' + escapeHtml(r.id) +
          '"><div class="src-row" style="padding-left:14px"><span class="src-ic">' + ic +
          '</span><span class="src-name">' + escapeHtml(name) + '</span></div></li>';
      }).join('') + '</ul>';
      host.querySelectorAll('.src-file > .src-row').forEach(function (row) {
        row.addEventListener('click', function () {
          location.hash = '#/fs/files/' + encodeURIComponent(row.parentNode.getAttribute('data-id'));
        });
      });
    }

    // Orchestrator for the parts of the Outputs column that aren't fed by
    // renderSources (Artifacts is). Called at boot. Markdown self-fetches the
    // rendered context tree; the Tables mirror reads the in-memory entities.
    function renderOutputs() {
      renderOutputsMarkdown();
      renderOutputsTables();
    }

    // ── Outputs > Markdown ────────────────────────────────────────────────
    // ONE node per (non-junction) table, grouped in the SAME tier categories as
    // the Tables mirror below — the two lists are identical in what they list.
    // A table node lazily expands to its rendered context: the whole-table
    // rollup .md + the per-record folders (/api/context/list?table=). Deeper
    // folders keep the lazy ?path= listing. Clicking a .md resolves it to its
    // record and opens the record page (the single markdown surface, with the
    // Formatted | Markdown toggle) — the old separate read-only viewer is gone.
    function renderOutputsMarkdown() {
      var host = document.getElementById('out-markdown-tree');
      if (!host) return;
      fetchJson('/api/context/tree')
        .then(function (data) {
          var tables = (data && data.tables) || [];
          var ungrouped = (data && data.ungrouped) || [];
          if (!tables.length && !ungrouped.length) {
            host.innerHTML = '<div class="src-empty">No rendered context yet.</div>';
            return;
          }
          var html = MT_LAYERS.map(function (l) {
            var ts = tables.filter(function (t) { return t.tier === l.id; });
            if (!ts.length) return '';
            return '<div class="out-tier"><div class="out-tier-head">' + escapeHtml(l.name) + '</div>' +
              '<ul class="src-tree">' + ts.map(function (t) { return mdTableNodeHtml(t); }).join('') + '</ul></div>';
          }).join('');
          if (ungrouped.length) {
            html += '<div class="out-tier"><div class="out-tier-head">Other files</div>' +
              '<ul class="src-tree">' + ungrouped.map(function (e) { return mdNodeHtml(e, 0); }).join('') + '</ul></div>';
          }
          host.innerHTML = html + (data.truncated ? '<div class="src-note">\u2026more not shown</div>' : '');
          wireMdTree(host);
        })
        .catch(function () { host.innerHTML = '<div class="src-empty">No rendered context yet.</div>'; });
    }

    function mdTableNodeHtml(t) {
      var icon = (typeof displayFor === 'function' ? displayFor(t.table).icon : '\ud83d\udcc1');
      var label = (typeof displayFor === 'function' ? displayFor(t.table).label : t.table);
      if (t.empty) {
        return '<li class="mdt-node mdt-empty" data-table="' + escapeHtml(t.table) +
          '"><div class="mdt-row mdt-row-empty" style="padding-left:0px" title="no rendered context">' +
          '<span class="src-ic">' + icon + '</span><span class="src-name">' + escapeHtml(label) + '</span>' +
          '<span class="mdt-note">no rendered context</span></div></li>';
      }
      return '<li class="mdt-node mdt-folder mdt-table" data-table="' + escapeHtml(t.table) +
        '" data-depth="0" data-loaded="0"><div class="mdt-row" style="padding-left:0px">' +
        '<span class="mdt-caret">\u25b8</span><span class="src-ic">' + icon + '</span>' +
        '<span class="src-name">' + escapeHtml(label) + '</span></div>' +
        '<ul class="mdt-children" hidden></ul></li>';
    }

    function mdNodeHtml(e, depth) {
      var pad = depth * 12;
      if (e.kind === 'dir') {
        return '<li class="mdt-node mdt-folder" data-path="' + escapeHtml(e.path) + '" data-depth="' + depth +
          '" data-loaded="0"><div class="mdt-row" style="padding-left:' + pad + 'px">' +
          '<span class="mdt-caret">\u25b8</span><span class="src-ic">\ud83d\udcc1</span>' +
          '<span class="src-name">' + escapeHtml(e.name) + '</span></div>' +
          '<ul class="mdt-children" hidden></ul></li>';
      }
      return '<li class="mdt-node mdt-file" data-path="' + escapeHtml(e.path) + '" data-name="' + escapeHtml(e.name) +
        '"><div class="mdt-row" style="padding-left:' + (pad + 14) + 'px">' +
        '<span class="src-ic">\ud83d\udcc4</span><span class="src-name">' + escapeHtml(e.name) + '</span></div></li>';
    }

    function wireMdTree(scope) {
      scope.querySelectorAll('.mdt-folder > .mdt-row').forEach(function (row) {
        if (row.__wired) return;
        row.__wired = true;
        row.addEventListener('click', function () { toggleMdFolder(row.parentNode); });
      });
      scope.querySelectorAll('.mdt-file > .mdt-row').forEach(function (row) {
        if (row.__wired) return;
        row.__wired = true;
        row.addEventListener('click', function () {
          // Resolve the file to its record and open the record page in the
          // TABLES section (kind table lands on the object page). A stray file
          // no table claims is inert.
          var path = row.parentNode.getAttribute('data-path');
          fetchJson('/api/context/resolve?path=' + encodeURIComponent(path))
            .then(function (r) {
              if (r && r.kind === 'record') {
                location.hash = '#/tables/' + encodeURIComponent(r.table) + '/' + encodeURIComponent(r.rowId);
              } else if (r && r.kind === 'table') {
                location.hash = '#/tables/' + encodeURIComponent(r.table);
              }
            })
            .catch(function () {});
        });
      });
    }

    function toggleMdFolder(li) {
      var ul = li.querySelector(':scope > .mdt-children');
      var caret = li.querySelector(':scope > .mdt-row > .mdt-caret');
      if (!ul) return;
      if (!ul.hidden) { ul.hidden = true; if (caret) caret.textContent = '\u25b8'; return; }
      if (li.getAttribute('data-loaded') === '1') {
        ul.hidden = false; if (caret) caret.textContent = '\u25be'; return;
      }
      var depth = Number(li.getAttribute('data-depth') || '0') + 1;
      var table = li.getAttribute('data-table');
      var q = table
        ? '/api/context/list?table=' + encodeURIComponent(table)
        : '/api/context/list?path=' + encodeURIComponent(li.getAttribute('data-path'));
      fetchJson(q)
        .then(function (data) {
          var entries = (data && data.entries) || [];
          ul.innerHTML = entries.map(function (e) { return mdNodeHtml(e, depth); }).join('') +
            (data && data.truncated ? '<li class="src-note">\u2026more not shown</li>' : '');
          li.setAttribute('data-loaded', '1');
          ul.hidden = false;
          if (caret) caret.textContent = '\u25be';
          wireMdTree(ul);
        })
        .catch(function () {});
    }

    // ── Outputs > Tables (mirror) ─────────────────────────────────────────
    // The same tiered model as the center Model > Tables view, compacted into the
    // narrow Outputs column (tiers stacked; each table links to its object). Reuses
    // mtBuildModel from the model-tables segment so the classification is identical.
    function renderOutputsTables() {
      var host = document.getElementById('out-tables-mount');
      if (!host || typeof mtBuildModel !== 'function') return;
      var entities = mtBuildModel();
      if (!entities.length) { host.innerHTML = '<div class="src-empty">No tables yet.</div>'; return; }
      var html = MT_LAYERS.map(function (l) {
        var ents = entities.filter(function (e) { return e.tier === l.id; });
        if (!ents.length) return '';
        return '<div class="out-tier"><div class="out-tier-head">' + escapeHtml(l.name) + '</div>' +
          ents.map(function (e) {
            // The Outputs "Tables" mirror opens each object in the TABLES section
            // (#/tables/<obj>) so clicking it keeps the Tables tab highlighted.
            return '<a class="out-tier-row" href="#/tables/' + encodeURIComponent(e.name) + '">' +
              '<span class="src-ic">' + e.icon + '</span><span class="src-name">' + escapeHtml(e.label) + '</span></a>';
          }).join('') + '</div>';
      }).join('');
      host.innerHTML = html || '<div class="src-empty">No tables yet.</div>';
    }
`;
