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

    // File drag-drop over the WHOLE WINDOW — a full-window overlay appears wherever
    // you drag a file. The DROP behaves differently by view:
    //   • Analytics (the Gladys chat dock is here): stage the file into the
    //     composer (removable chips above the chat box) for review + send. Stay put.
    //   • Configure (no chat here): ingest IMMEDIATELY (auto-start) and stay in
    //     Configure — never yank the user over to the Analytics chat.
    function initFileDropZone() {
      if (window.__fileDropWired) return;
      window.__fileDropWired = true;
      var overlay = document.createElement('div');
      overlay.className = 'file-drop-overlay';
      overlay.innerHTML = '<div class="file-drop-inner"><div class="file-drop-emoji">📎</div><span class="file-drop-label">Drop a file to ingest it</span></div>';
      document.body.appendChild(overlay);
      var overlayLabel = overlay.querySelector('.file-drop-label');
      function isFileDrag(e) {
        var t = e.dataTransfer && e.dataTransfer.types;
        return !!t && Array.prototype.indexOf.call(t, 'Files') !== -1;
      }
      var depth = 0;
      function show() {
        document.body.classList.add('dragging-file');
        if (overlayLabel) {
          overlayLabel.textContent = isAnalyticsHash(location.hash)
            ? 'Drop to attach to Gladys'
            : 'Drop a file to ingest it';
        }
      }
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
        var files = e.dataTransfer && e.dataTransfer.files;
        if (!files || !files.length) return;
        if (isAnalyticsHash(location.hash)) {
          // Analytics: stage into the Gladys composer for review (the #rail-*
          // dock is here). The user sees the removable chips above the chat box.
          stageFiles(files);
        } else {
          // Configure: ingest immediately and STAY here — dropping in Configure
          // starts ingestion automatically, it does not switch to the chat.
          uploadFiles(files);
        }
      });
      window.addEventListener('dragend', hide);
    }
`;
