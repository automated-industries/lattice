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
    // A collapsible view of the rendered LLM context tree (the transformed .md
    // files under the workspace output dir). Clicking a leaf opens its content in
    // the right-hand detail slide-over.
    function renderOutputsMarkdown() {
      var host = document.getElementById('out-markdown-tree');
      if (!host) return;
      fetchJson('/api/context/tree')
        .then(function (data) {
          var entries = (data && data.entries) || [];
          if (!entries.length) { host.innerHTML = '<div class="src-empty">No rendered context yet.</div>'; return; }
          host.innerHTML = '<ul class="src-tree">' + entries.map(outputsMdNodeHtml).join('') + '</ul>';
          // Leaf (.md file) click → open in the detail slide-over.
          host.querySelectorAll('.out-md-file').forEach(function (li) {
            var row = li.querySelector(':scope > .src-row');
            if (row) row.addEventListener('click', function () { openOutputsMarkdown(li.getAttribute('data-path'), li.getAttribute('data-name')); });
          });
          // Directory toggle (expand/collapse its .md children).
          host.querySelectorAll('.out-md-folder > .src-row').forEach(function (row) {
            row.addEventListener('click', function () {
              var li = row.parentNode;
              var ul = li.querySelector(':scope > .src-children');
              var caret = row.querySelector('.src-caret');
              if (!ul) return;
              ul.hidden = !ul.hidden;
              if (caret) caret.textContent = ul.hidden ? '\\u25b8' : '\\u25be';
            });
          });
        })
        .catch(function () { host.innerHTML = '<div class="src-empty">No rendered context yet.</div>'; });
    }

    function outputsMdNodeHtml(e) {
      if (e.kind === 'dir') {
        var kids = (e.children || []).map(function (c) {
          return '<li class="src-node out-md-file" data-path="' + escapeHtml(c.path) + '" data-name="' + escapeHtml(c.name) +
            '"><div class="src-row" style="padding-left:26px"><span class="src-ic">\\ud83d\\udcc4</span>' +
            '<span class="src-name">' + escapeHtml(c.name) + '</span></div></li>';
        }).join('');
        return '<li class="src-node out-md-folder"><div class="src-row" style="padding-left:0">' +
          '<span class="src-caret">\\u25b8</span><span class="src-ic">\\ud83d\\udcc1</span>' +
          '<span class="src-name">' + escapeHtml(e.name) + '</span></div>' +
          '<ul class="src-children" hidden>' + kids + '</ul></li>';
      }
      return '<li class="src-node out-md-file" data-path="' + escapeHtml(e.path) + '" data-name="' + escapeHtml(e.name) +
        '"><div class="src-row" style="padding-left:14px"><span class="src-ic">\\ud83d\\udcc4</span>' +
        '<span class="src-name">' + escapeHtml(e.name) + '</span></div></li>';
    }

    function openOutputsMarkdown(path, name) {
      var panel = document.getElementById('outputs-detail');
      var title = document.getElementById('outputs-detail-title');
      var body = document.getElementById('outputs-detail-body');
      if (!panel || !body) return;
      if (title) title.textContent = name || path;
      body.innerHTML = '<div class="muted" style="padding:12px">Loading…</div>';
      panel.hidden = false;
      var close = document.getElementById('outputs-detail-close');
      if (close && !close.__wired) { close.__wired = true; close.addEventListener('click', function () { panel.hidden = true; }); }
      fetchJson('/api/context/file?path=' + encodeURIComponent(path))
        .then(function (d) {
          var content = stripFrontmatter((d && d.content) || '');
          body.innerHTML = content.trim()
            ? '<div class="md-body">' + mdToHtml(content) + '</div>'
            : '<div class="src-empty">This context file is empty — it renders once the entity has data.</div>';
        })
        .catch(function () { body.innerHTML = '<div class="src-empty">Could not load this file.</div>'; });
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
            return '<a class="out-tier-row" href="#/fs/' + encodeURIComponent(e.name) + '">' +
              '<span class="src-ic">' + e.icon + '</span><span class="src-name">' + escapeHtml(e.label) + '</span></a>';
          }).join('') + '</div>';
      }).join('');
      host.innerHTML = html || '<div class="src-empty">No tables yet.</div>';
    }
`;
