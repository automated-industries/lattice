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
    // A LAZY collapsible tree mirroring the on-disk Context/ layout (folders +
    // .md files, arbitrary depth). Folders fetch their children on expand
    // (/api/context/list) so a workspace with tens of thousands of context files
    // never loads them all at once. Clicking a .md leaf opens it in the slide-in
    // detail panel (which sits LEFT of the Outputs column, so the column stays
    // visible + browsable).
    function renderOutputsMarkdown() {
      var host = document.getElementById('out-markdown-tree');
      if (!host) return;
      fetchJson('/api/context/tree')
        .then(function (data) {
          var entries = (data && data.entries) || [];
          if (!entries.length) { host.innerHTML = '<div class="src-empty">No rendered context yet.</div>'; return; }
          host.innerHTML = '<ul class="src-tree">' + entries.map(function (e) { return mdNodeHtml(e, 0); }).join('') +
            (data.truncated ? '<li class="src-note">\\u2026more not shown</li>' : '');
          wireMdTree(host);
        })
        .catch(function () { host.innerHTML = '<div class="src-empty">No rendered context yet.</div>'; });
    }

    function mdNodeHtml(e, depth) {
      var pad = depth * 12;
      if (e.kind === 'dir') {
        return '<li class="mdt-node mdt-folder" data-path="' + escapeHtml(e.path) + '" data-depth="' + depth +
          '" data-loaded="0"><div class="mdt-row" style="padding-left:' + pad + 'px">' +
          '<span class="mdt-caret">\\u25b8</span><span class="src-ic">\\ud83d\\udcc1</span>' +
          '<span class="src-name">' + escapeHtml(e.name) + '</span></div>' +
          '<ul class="mdt-children" hidden></ul></li>';
      }
      return '<li class="mdt-node mdt-file" data-path="' + escapeHtml(e.path) + '" data-name="' + escapeHtml(e.name) +
        '"><div class="mdt-row" style="padding-left:' + (pad + 14) + 'px">' +
        '<span class="src-ic">\\ud83d\\udcc4</span><span class="src-name">' + escapeHtml(e.name) + '</span></div></li>';
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
          // Open in the CENTER pane (not a slide-in drawer) so the Outputs column
          // stays visible + browsable.
          location.hash = '#/md/' + encodeURIComponent(row.parentNode.getAttribute('data-path'));
        });
      });
    }

    function toggleMdFolder(li) {
      var ul = li.querySelector(':scope > .mdt-children');
      var caret = li.querySelector(':scope > .mdt-row > .mdt-caret');
      if (!ul) return;
      if (!ul.hidden) { ul.hidden = true; if (caret) caret.textContent = '\\u25b8'; return; }
      if (li.getAttribute('data-loaded') === '1') {
        ul.hidden = false; if (caret) caret.textContent = '\\u25be'; return;
      }
      var depth = Number(li.getAttribute('data-depth') || '0') + 1;
      fetchJson('/api/context/list?path=' + encodeURIComponent(li.getAttribute('data-path')))
        .then(function (data) {
          var entries = (data && data.entries) || [];
          ul.innerHTML = entries.map(function (e) { return mdNodeHtml(e, depth); }).join('') +
            (data && data.truncated ? '<li class="src-note">\\u2026more not shown</li>' : '');
          li.setAttribute('data-loaded', '1');
          ul.hidden = false;
          if (caret) caret.textContent = '\\u25be';
          wireMdTree(ul);
        })
        .catch(function () {});
    }

    // ── #/md/<path> — a context Markdown file opened in the CENTER pane ──────
    // Replaces the old slide-in drawer: the markdown renders in #content (the
    // middle column) with a breadcrumb, so the Outputs column stays visible.
    function renderMarkdownDoc(content, path) {
      if (!content) content = document.getElementById('content');
      if (!content) return;
      var name = String(path).split('/').pop() || path;
      content.innerHTML =
        '<nav class="fs-crumbs"><a href="#/tables">Tables</a><span class="fs-sep">\\u25b8</span>' +
          '<span class="fs-crumb-cur">Markdown</span><span class="fs-sep">\\u25b8</span>' +
          '<span class="fs-crumb-cur">' + escapeHtml(name) + '</span></nav>' +
        '<div class="view-header"><span class="entity-icon">\\ud83d\\udcc4</span>' +
          '<h1>' + escapeHtml(name) + '</h1></div>' +
        '<div class="md-doc" id="md-doc"><div class="muted" style="padding:12px">Loading\\u2026</div></div>';
      fetchJson('/api/context/file?path=' + encodeURIComponent(path))
        .then(function (d) {
          var md = stripFrontmatter((d && d.content) || '');
          var el = document.getElementById('md-doc');
          if (el) el.innerHTML = md.trim()
            ? '<div class="md-body">' + mdToHtml(md) + '</div>'
            : '<div class="src-empty">This file is empty — it renders once the entity has data.</div>';
        })
        .catch(function () {
          var el = document.getElementById('md-doc');
          if (el) el.innerHTML = '<div class="src-empty">Could not load this file.</div>';
        });
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
