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

    // File drag-drop. The drop TARGET depends on the view:
    //   • Analytics (the Gladys chat dock is on screen): the drop zone is JUST the
    //     chat window (#ask-dock). The overlay is scoped over it, and a file dropped
    //     onto it is STAGED into the composer (removable chips above the chat box) for
    //     review + send. A drop elsewhere (over the dashboards) is ignored. Stay put.
    //   • Configure (no chat here): the whole window is the drop zone; a drop INGESTS
    //     immediately (auto-start) and stays in Configure — never yanks to the chat.
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
      // The chat window to scope the drop to — only in Analytics (where it's on
      // screen). null in Configure ⇒ whole-window drop.
      function chatDock() {
        return isAnalyticsHash(location.hash) ? document.getElementById('ask-dock') : null;
      }
      // Position the overlay over the chat window (Analytics) or full-window (Configure).
      function positionOverlay() {
        var dock = chatDock();
        if (dock) {
          var r = dock.getBoundingClientRect();
          overlay.classList.add('scoped');
          overlay.style.top = r.top + 'px';
          overlay.style.left = r.left + 'px';
          overlay.style.width = r.width + 'px';
          overlay.style.height = r.height + 'px';
        } else {
          overlay.classList.remove('scoped');
          overlay.style.top = ''; overlay.style.left = ''; overlay.style.width = ''; overlay.style.height = '';
        }
      }
      var depth = 0;
      function show() {
        document.body.classList.add('dragging-file');
        positionOverlay();
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
        var dock = chatDock();
        if (dock) {
          // Analytics: the drop zone is the chat window. Only stage a file dropped
          // ONTO it (the scoped overlay shows where); a drop over the dashboards is
          // ignored. Staged as removable chips above the chat box for review + send.
          var r = dock.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
          stageFiles(files);
        } else {
          // Configure: whole-window drop — ingest immediately and STAY here (never
          // switch to the Analytics chat).
          uploadFiles(files);
        }
      });
      window.addEventListener('dragend', hide);
    }
`;
