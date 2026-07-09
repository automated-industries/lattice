// Auto-composed segment of the GUI client script (see modules/index.ts). The
// MARKDOWN column (right side): ONE tree of every entity's rendered markdown,
// grouped in the same tier categories as the model, with Artifacts as another
// category. Must stay INSIDE the client IIFE (uses fetchJson/escapeHtml),
// inserted before createDatabaseWizardJs.
export const outputsJs = `
    // Orchestrator for the Markdown column (the single Outputs view). Called at
    // boot and by refresh hooks; self-fetches everything it shows.
    function renderOutputs() {
      renderOutputsMarkdown();
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
      renderMarkdownTreeInto(document.getElementById('out-markdown-tree'));
    }
    // Render the rendered-markdown tree (one node per non-junction table + lazy
    // per-record folders) INTO a given host, so the SAME tree serves the old
    // Outputs rail AND the left-sidebar MARKDOWN section. Leaf clicks resolve to a
    // record/collection hash, which the router normalizes to the #/w/* tab.
    function renderMarkdownTreeInto(host) {
      if (!host) return;
      Promise.all([
        fetchJson('/api/context/tree'),
        // Artifacts (Lattice-created markdown/html) are just another category of
        // markdown here — files rows carrying artifact_type, bounded projection.
        fetchJson('/api/tables/files/rows?exclude=' + encodeURIComponent('extracted_text,description'))
          .then(function (d) {
            return ((d && d.rows) || []).filter(function (r) { return !r.deleted_at && r.artifact_type; });
          })
          .catch(function () { return []; }),
      ])
        .then(function (both) {
          var data = both[0];
          var artifacts = both[1];
          var tables = (data && data.tables) || [];
          if (!tables.length && !artifacts.length) {
            host.innerHTML = '<div class="src-empty">No rendered context yet.</div>';
            return;
          }
          var html = MT_LAYERS.map(function (l) {
            var ts = tables.filter(function (t) { return t.tier === l.id; });
            if (!ts.length) return '';
            return '<div class="out-tier"><div class="out-tier-head">' + escapeHtml(l.name) + '</div>' +
              '<ul class="src-tree">' + ts.map(function (t) { return mdTableNodeHtml(t); }).join('') + '</ul></div>';
          }).join('');
          if (artifacts.length) {
            html += '<div class="out-tier"><div class="out-tier-head">Artifacts</div>' +
              '<ul class="src-tree">' + artifacts.map(function (r) {
                var nm = r.name || r.original_name || 'Untitled';
                var ic = r.artifact_type === 'html' ? '\ud83c\udf10' : '\ud83d\udcdd';
                return '<li class="mdt-node mdt-artifact" data-id="' + escapeHtml(r.id) +
                  '"><div class="mdt-row" style="padding-left:14px"><span class="src-ic">' + ic +
                  '</span><span class="src-name">' + escapeHtml(nm) + '</span></div></li>';
              }).join('') + '</ul></div>';
          }
          // Unclaimed root entries (junction leftovers, system dirs, stale
          // cruft) are deliberately NOT displayed — they are implementation
          // detail, not user documents, and only confuse. The server still
          // reports them for diagnostics.
          host.innerHTML = html + (data && data.truncated ? '<div class="src-note">\u2026more not shown</div>' : '');
          wireMdTree(host);
          // The rebuild wiped any in-flight render overlays; repaint them from
          // the client-global render state.
          if (typeof reapplyTreeProgress === 'function') reapplyTreeProgress();
          host.querySelectorAll('.mdt-artifact > .mdt-row').forEach(function (row) {
            if (row.__wired) return;
            row.__wired = true;
            row.addEventListener('click', function () {
              location.hash = '#/tables/files/' + encodeURIComponent(row.parentNode.getAttribute('data-id'));
            });
          });
        })
        .catch(function () { host.innerHTML = '<div class="src-empty">No rendered context yet.</div>'; });
    }

    function mdTableNodeHtml(t) {
      var icon = (typeof displayFor === 'function' ? displayFor(t.table).icon : '\ud83d\udcc1');
      var label = (typeof displayFor === 'function' ? displayFor(t.table).label : t.table);
      if (t.empty) {
        // A table with nothing rendered yet (typically no records). Show it calmly
        // rather than flagging "no rendered context" as if something failed.
        return '<li class="mdt-node mdt-empty" data-table="' + escapeHtml(t.table) +
          '"><div class="mdt-row mdt-row-empty" style="padding-left:0px" title="no records yet">' +
          '<span class="src-ic">' + icon + '</span><span class="src-name">' + escapeHtml(label) + '</span>' +
          '<span class="mdt-note">no records yet</span></div></li>';
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
                // A .md file click means "show me the MARKDOWN": land the
                // collection page in markdown (rollup) mode, not the rows view.
                if (typeof collectionViewMode !== 'undefined') collectionViewMode[r.table] = 'markdown';
                location.hash = '#/tables/' + encodeURIComponent(r.table);
                if (typeof renderRoute === 'function') renderRoute({ soft: true });
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

`;
