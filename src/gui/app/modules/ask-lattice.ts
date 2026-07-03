// Auto-composed segment of the GUI client script (see modules/index.ts). The
// floating "Ask Lattice" assistant: a header trigger drops down a chat panel in the
// upper-right. The chat composer/feed/threads inside the panel reuse the same
// element IDs the old docked rail used, so renderComposer/sendChat/initThreadControls
// (defined elsewhere) work unchanged — this segment only opens/closes the panel and
// re-houses the file drag-drop onto it. Must stay INSIDE the client IIFE (uses
// stageFiles); inserted before createDatabaseWizardJs.
export const askLatticeJs = `
    function askLatticePanel() { return document.getElementById('ask-lattice-panel'); }
    function askLatticeOpen() { var p = askLatticePanel(); return !!p && p.classList.contains('open'); }
    function openAskLattice() {
      var panel = askLatticePanel(); if (!panel) return;
      panel.classList.add('open'); // CSS animates it in from the top-right
      var trig = document.getElementById('ask-lattice-trigger');
      if (trig) trig.setAttribute('aria-expanded', 'true');
      var input = document.getElementById('chat-input');
      if (input) setTimeout(function () { input.focus(); }, 0);
      // The dot means "questions are waiting and the panel is closed" — an open
      // panel shows the cards themselves, so opening clears it.
      if (typeof updateQuestionDot === 'function') updateQuestionDot();
    }
    function closeAskLattice() {
      var panel = askLatticePanel(); if (panel) panel.classList.remove('open'); // animates out
      var trig = document.getElementById('ask-lattice-trigger');
      if (trig) trig.setAttribute('aria-expanded', 'false');
      // Closing with questions still pending re-arms the trigger dot.
      if (typeof updateQuestionDot === 'function') updateQuestionDot();
    }
    function toggleAskLattice() {
      if (askLatticeOpen()) closeAskLattice(); else openAskLattice();
    }

    function initAskLattice() {
      var trig = document.getElementById('ask-lattice-trigger');
      if (trig && !trig.__wired) {
        trig.__wired = true;
        trig.addEventListener('click', function (e) { e.stopPropagation(); toggleAskLattice(); });
      }
      var close = document.getElementById('ask-lattice-close');
      if (close && !close.__wired) {
        close.__wired = true;
        close.addEventListener('click', closeAskLattice);
      }
      // Esc closes the panel when it's open.
      if (!window.__askLatticeEsc) {
        window.__askLatticeEsc = true;
        document.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && askLatticeOpen()) closeAskLattice();
        });
      }
      // Clicking anywhere outside the panel (and not on the trigger) collapses it.
      if (!window.__askLatticeOutside) {
        window.__askLatticeOutside = true;
        document.addEventListener('pointerdown', function (e) {
          if (!askLatticeOpen()) return;
          var panel = askLatticePanel();
          var trigEl = document.getElementById('ask-lattice-trigger');
          if (panel && panel.contains(e.target)) return;
          if (trigEl && trigEl.contains(e.target)) return;
          closeAskLattice();
        });
      }
      initFileDropZone();
    }

    // File drag-drop over the WHOLE WINDOW — a full-window overlay ("Drop a file to
    // ingest it") appears wherever you drag a file, and the drop stages it into
    // Gladys for review + ingest (opening her panel if it's closed). Not scoped to
    // the Gladys panel anymore.
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
          if (typeof openAskLattice === 'function' && !askLatticeOpen()) openAskLattice();
          stageFiles(e.dataTransfer.files);
        }
      });
      window.addEventListener('dragend', hide);
    }
`;
