// Auto-composed segment of the GUI client script (see modules/index.ts). The
// assistant lives in the ANALYTICS view's docked panel (see analytics-view.ts);
// the old floating upper-right panel is gone. This segment keeps two things:
// the boot hook that wires the header view-toggle buttons (initAskLattice, kept
// under its historical name so boot.ts is untouched) and the whole-window file
// drag-drop, which now switches to Analytics before staging the drop — the chat
// composer is there. Must stay INSIDE the client IIFE (uses stageFiles +
// analytics-view.ts helpers); inserted before createDatabaseWizardJs.
export const askLatticeJs = `
    function initAskLattice() {
      initAnalyticsView();
      initFileDropZone();
    }

    // File drag-drop over the WHOLE WINDOW — a full-window overlay ("Drop a file to
    // ingest it") appears wherever you drag a file, and the drop stages it into
    // Gladys for review + ingest, switching to the Analytics view (where the chat
    // dock lives) if the user was in Configure.
    function initFileDropZone() {
      if (window.__fileDropWired) return;
      window.__fileDropWired = true;
      var overlay = document.createElement('div');
      overlay.className = 'file-drop-overlay';
      overlay.innerHTML = '<div class="file-drop-inner"><div class="file-drop-emoji">📎</div>Drop a file to ingest it</div>';
      document.body.appendChild(overlay);
      function isFileDrag(e) {
        var t = e.dataTransfer && e.dataTransfer.types;
        return !!t && Array.prototype.indexOf.call(t, 'Files') !== -1;
      }
      var depth = 0;
      function show() { document.body.classList.add('dragging-file'); }
      function hide() { depth = 0; document.body.classList.remove('dragging-file'); }
      document.addEventListener('dragenter', function (e) {
        if (!isFileDrag(e)) return;
        e.preventDefault(); depth++; show();
      });
      document.addEventListener('dragover', function (e) {
        if (!isFileDrag(e)) return;
        e.preventDefault(); show();
      });
      document.addEventListener('dragleave', function () {
        depth = Math.max(0, depth - 1);
        if (depth === 0) hide();
      });
      document.addEventListener('drop', function (e) {
        if (!isFileDrag(e)) { hide(); return; }
        e.preventDefault();
        hide();
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          // The #rail-* nodes are static shell DOM, so staging works regardless
          // of which view is showing — the switch is so the user SEES the staged
          // file in the dock.
          if (!isAnalyticsHash(location.hash)) location.hash = lastAnalyticsHash;
          stageFiles(e.dataTransfer.files);
        }
      });
      window.addEventListener('dragend', hide);
    }
`;
