// Auto-composed segment of the GUI client script (see modules/index.ts). The
// Inputs > Databases section: connect an external database (Postgres-family) and
// import its tables. renderInputsDatabases() is called from renderSources() so the
// section refreshes alongside Files/Connectors. Must stay INSIDE the client IIFE
// (uses fetchJson/escapeHtml/showToast), inserted right after sourcesJs.
//
// Step 1 ships the section shell + empty state; the connect flow + live list are
// wired against /api/db-sources later in the release.
export const inputsJs = `
    function renderInputsDatabases() {
      var host = document.getElementById('src-databases-list');
      if (host) {
        // Empty state until the connect flow is wired. A failed/absent
        // /api/db-sources endpoint must degrade quietly to this same state.
        host.innerHTML = '<div class="src-empty">No databases connected.</div>';
      }
      wireInputsDatabasesButton();
    }

    function wireInputsDatabasesButton() {
      var add = document.getElementById('src-add-database');
      if (add && !add.__wired) {
        add.__wired = true;
        add.addEventListener('click', function () {
          showToast('Connecting an external database is coming soon.', {});
        });
      }
    }
`;
