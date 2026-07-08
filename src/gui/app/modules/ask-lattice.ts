// Auto-composed segment of the GUI client script (see modules/index.ts). The
// assistant lives in the ANALYTICS view's docked panel (see analytics-view.ts);
// the old floating upper-right panel is gone. This segment keeps two things:
// the boot hook that wires the header view-toggle buttons (initAskLattice, kept
// under its historical name so boot.ts is untouched) and the scoped file
// drag-drop, which switches to Analytics before staging the drop — the chat
// composer is there. Must stay INSIDE the client IIFE (uses stageFiles +
// analytics-view.ts helpers); inserted before createDatabaseWizardJs.
export const askLatticeJs = `
    function initAskLattice() {
      initAnalyticsView();
      initFileDropZone();
    }

    // File drag-drop. The drop is ALWAYS scoped to one surface — there is no
    // whole-window drop — and the surface depends on the view:
    //   • Analytics (the Gladys chat dock is on screen): the surface is the chat
    //     window (#ask-dock). A file dropped onto it is STAGED into the composer
    //     (removable chips above the chat box) for review + send.
    //   • Configure: the surface is the Inputs column (nav.sidebar) only. A drop
    //     there INGESTS immediately and stays in Configure. A drop anywhere else
    //     in Configure (Model / Outputs / header) is ignored.
    // A dropped FOLDER is expanded into its files via the Entries API before
    // staging/uploading (a raw folder entry has no bytes and fails to ingest).
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
      // The single element the drop is scoped to for the current view: the chat
      // dock in Analytics, the Inputs column in Configure. null ⇒ no valid drop
      // surface on screen (ignore the drop, hide the overlay).
      function dropTarget() {
        return isAnalyticsHash(location.hash)
          ? document.getElementById('ask-dock')
          : document.querySelector('nav.sidebar');
      }
      // Position the overlay over the active drop surface. Always scoped now.
      function positionOverlay() {
        var el = dropTarget();
        if (!el) { overlay.classList.remove('scoped'); return; }
        var r = el.getBoundingClientRect();
        overlay.classList.add('scoped');
        overlay.style.top = r.top + 'px';
        overlay.style.left = r.left + 'px';
        overlay.style.width = r.width + 'px';
        overlay.style.height = r.height + 'px';
      }
      var depth = 0;
      function show() {
        if (!dropTarget()) return; // no surface here — do not flash the overlay
        document.body.classList.add('dragging-file');
        positionOverlay();
        if (overlayLabel) {
          overlayLabel.textContent = isAnalyticsHash(location.hash)
            ? 'Drop to attach to Gladys'
            : 'Drop a file or folder to ingest it';
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
        var target = dropTarget();
        if (!target) return; // no valid drop surface in this view
        // Only accept a drop that landed ON the scoped surface (the overlay shows
        // where). A drop over the dashboards / Model / Outputs is ignored.
        var r = target.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
        var toComposer = isAnalyticsHash(location.hash);
        collectDroppedFiles(e.dataTransfer).then(function (files) {
          if (!files.length) return;
          if (toComposer) stageFiles(files); // Analytics: review + send
          else uploadFiles(files);           // Configure/Inputs: ingest now
        });
      });
      window.addEventListener('dragend', hide);
    }

    // Resolve a drop's DataTransfer into a flat File[] — expanding any dropped
    // FOLDER into its files via the Entries API (webkitGetAsEntry). Dropping a
    // folder used to hand ingest a bogus zero-byte entry that failed with
    // "Load failed"; walking the directory yields the real files instead.
    function collectDroppedFiles(dt) {
      var items = dt && dt.items;
      // The plain, always-available file list — the fallback whenever the Entries
      // API is absent or yields nothing (a synthetic DataTransfer, or a browser that
      // returns null from webkitGetAsEntry). Files must NEVER be silently dropped.
      var flat = dt && dt.files ? Array.prototype.slice.call(dt.files) : [];
      var canEntries = !!(items && items.length && typeof items[0].webkitGetAsEntry === 'function');
      if (!canEntries) return Promise.resolve(flat);
      // DataTransferItems are only valid DURING the drop event, so capture every
      // entry synchronously now; the recursion below is async.
      var entries = [];
      for (var i = 0; i < items.length; i++) {
        var en = items[i].webkitGetAsEntry();
        if (en) entries.push(en);
      }
      // No entry resolved (synthetic transfer, or webkitGetAsEntry returned null for
      // every item) — the folder walk would yield nothing, so use the flat list.
      if (!entries.length) return Promise.resolve(flat);
      var out = [];
      function readEntry(entry) {
        if (entry.isFile) {
          return new Promise(function (resolve) {
            entry.file(function (f) { out.push(f); resolve(); }, function () { resolve(); });
          });
        }
        if (entry.isDirectory) {
          var reader = entry.createReader();
          return new Promise(function (resolve) {
            var kids = [];
            // readEntries returns a bounded batch (~100), so keep calling until it
            // returns empty, THEN recurse into everything collected.
            function readBatch() {
              reader.readEntries(function (batch) {
                if (!batch.length) { Promise.all(kids.map(readEntry)).then(function () { resolve(); }); return; }
                for (var j = 0; j < batch.length; j++) kids.push(batch[j]);
                readBatch();
              }, function () { resolve(); });
            }
            readBatch();
          });
        }
        return Promise.resolve();
      }
      return Promise.all(entries.map(readEntry)).then(function () { return out.length ? out : flat; });
    }
`;
