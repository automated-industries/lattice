// Auto-composed segment of the GUI client script (see modules/index.ts). The
// floating "Ask Lattice" assistant: a header trigger drops down a chat panel in the
// upper-right. The chat composer/feed/threads inside the panel reuse the same
// element IDs the old docked rail used, so renderComposer/sendChat/initThreadControls
// (defined elsewhere) work unchanged — this segment only opens/closes the panel and
// re-houses the file drag-drop onto it. Must stay INSIDE the client IIFE (uses
// stageFiles); inserted before createDatabaseWizardJs.
export const askLatticeJs = `
    function askLatticePanel() { return document.getElementById('ask-lattice-panel'); }
    function openAskLattice() {
      var panel = askLatticePanel(); if (!panel) return;
      panel.hidden = false;
      var trig = document.getElementById('ask-lattice-trigger');
      if (trig) trig.setAttribute('aria-expanded', 'true');
      var input = document.getElementById('chat-input');
      if (input) setTimeout(function () { input.focus(); }, 0);
    }
    function closeAskLattice() {
      var panel = askLatticePanel(); if (panel) panel.hidden = true;
      var trig = document.getElementById('ask-lattice-trigger');
      if (trig) trig.setAttribute('aria-expanded', 'false');
    }
    function toggleAskLattice() {
      var panel = askLatticePanel(); if (!panel) return;
      if (panel.hidden) openAskLattice(); else closeAskLattice();
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
          if (e.key === 'Escape') { var p = askLatticePanel(); if (p && !p.hidden) closeAskLattice(); }
        });
      }
      initAskLatticeDragDrop();
    }

    // File drag-drop onto the chat panel — stage dropped files for review (same flow
    // the docked rail used; re-housed here onto the floating panel).
    function initAskLatticeDragDrop() {
      var panel = askLatticePanel(); if (!panel || panel.__dndWired) return;
      panel.__dndWired = true;
      function isFileDrag(e) {
        var t = e.dataTransfer && e.dataTransfer.types;
        return !!t && Array.prototype.indexOf.call(t, 'Files') !== -1;
      }
      var depth = 0;
      function clearOverlay() { depth = 0; panel.classList.remove('dragging-file'); }
      panel.addEventListener('dragenter', function (e) {
        if (!isFileDrag(e)) return;
        e.preventDefault(); depth++; panel.classList.add('dragging-file');
      });
      panel.addEventListener('dragover', function (e) {
        if (!isFileDrag(e)) return;
        e.preventDefault(); panel.classList.add('dragging-file');
      });
      panel.addEventListener('dragleave', function () {
        depth = Math.max(0, depth - 1);
        if (depth === 0) panel.classList.remove('dragging-file');
      });
      panel.addEventListener('drop', function (e) {
        e.preventDefault();
        clearOverlay();
        if (e.dataTransfer && e.dataTransfer.files) stageFiles(e.dataTransfer.files);
      });
      window.addEventListener('dragend', clearOverlay);
      window.addEventListener('drop', clearOverlay);
    }
`;
