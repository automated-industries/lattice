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
`;
