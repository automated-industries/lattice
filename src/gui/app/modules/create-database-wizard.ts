// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const createDatabaseWizardJs = `    // ────────────────────────────────────────────────────────────
    // File ingest — drag a file onto the rail or use the paperclip.
    // Browsers can't expose the local path, so we POST the bytes; the
    // server extracts + summarizes, then discards them (path stays null).
    // ────────────────────────────────────────────────────────────
    // Cap how many uploads are in flight at once. A browser allows only ~6
    // HTTP/1.1 connections per host, so a bulk drop of N files would fire N
    // upload POSTs in parallel and saturate that budget — every other data
    // request (entities, rows, navigation) then queues for minutes behind the
    // multi-minute ingests and the GUI looks frozen. Holding uploads to a few
    // at a time leaves connections free for the rest of the app (and eases the
    // AI rate limit each ingest hits server-side). The realtime/feed streams are
    // already off this budget — they share one WebSocket — so this is the last
    // place a big batch could starve the connection pool.
    var INGEST_MAX_CONCURRENCY = 3;
    // Run a batch of upload thunks with at most \`limit\` in flight, calling
    // onProgress(done, total) as each settles. One failure never stalls the
    // batch — uploadFile surfaces its own error and resolves.
    function runIngestBatch(thunks, limit, onProgress) {
      return new Promise(function (resolve) {
        var total = thunks.length, idx = 0, done = 0;
        function startNext() {
          if (idx >= total) return;
          var thunk = thunks[idx++];
          Promise.resolve().then(thunk).catch(function () { /* already surfaced */ }).then(function () {
            done++;
            if (onProgress) onProgress(done, total);
            if (done === total) resolve(); else startNext();
          });
        }
        for (var i = 0; i < Math.min(limit, total); i++) startNext();
      });
    }
    // A batch-upload progress bar pinned to the top of the rail feed
    // ("Analyzing N of M…"). The per-file "Analyzing <name>…" cards still
    // appear, but only INGEST_MAX_CONCURRENCY at a time; this gives the
    // whole-batch view that the individual cards can't. Returns
    // { update(done, total), done() }.
    function ingestProgress(total) {
      var feedEl = document.getElementById('rail-feed');
      if (!feedEl) return { update: function () {}, done: function () {} };
      railEmptyGone();
      var wrap = document.createElement('div');
      wrap.className = 'ingest-progress';
      wrap.innerHTML =
        '<div class="ingest-progress-label">Analyzing 0 of ' + total + '…</div>' +
        '<div class="ingest-progress-track"><div class="ingest-progress-fill"></div></div>';
      feedEl.insertBefore(wrap, feedEl.firstChild);
      var label = wrap.querySelector('.ingest-progress-label');
      var fill = wrap.querySelector('.ingest-progress-fill');
      return {
        update: function (n, t) {
          if (label) label.textContent = 'Analyzing ' + n + ' of ' + t + '…';
          if (fill) fill.style.width = Math.round((n / t) * 100) + '%';
        },
        done: function () {
          if (fill) fill.style.width = '100%';
          if (label) label.textContent = 'Analyzed ' + total + ' file' + (total === 1 ? '' : 's');
          setTimeout(function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 2500);
        },
      };
    }
    // Append a transient "Analyzing <file>…" row to the feed so the user sees
    // the ingest is processing in the background; returns a disposer. The real
    // create/link feed events stream in over SSE as the server materializes them.
    function pendingIngestItem(label) {
      railEmptyGone();
      var feedEl = document.getElementById('rail-feed');
      if (!feedEl) return function () {};
      var item = document.createElement('div');
      item.className = 'feed-item feed-pending';
      item.innerHTML =
        '<div class="feed-icon"><span class="feed-spinner"></span></div>' +
        '<div class="feed-body"><div class="feed-summary">Analyzing ' + escapeHtml(label) + '…</div></div>' +
        '<div class="feed-time">0s</div>';
      // Same bottom-pin rule as renderFeedItem: don't bury a streaming chat
      // turn's typing bubble beneath this card.
      var anchor = feedTypingAnchor(feedEl);
      if (anchor) feedEl.insertBefore(item, anchor); else feedEl.appendChild(item);
      feedEl.scrollTop = feedEl.scrollHeight;
      // Live elapsed-time counter while the upload + server-side extraction run.
      // Previously the time element was left empty (rendered as a stuck "0s")
      // because nothing tracked or updated it. Tick once a second; the cleanup
      // returned below clears the interval (and self-clears if the node is gone).
      var started = Date.now();
      var timeEl = item.querySelector('.feed-time');
      var tick = setInterval(function () {
        if (!item.parentNode || !timeEl) { clearInterval(tick); return; }
        timeEl.textContent = formatElapsed(Date.now() - started);
      }, 1000);
      return function () {
        clearInterval(tick);
        if (item.parentNode) item.parentNode.removeChild(item);
      };
    }
    function uploadFile(file) {
      var done = pendingIngestItem(file.name || 'file');
      // Carry the composer's "Private mode" intent so an upload made while the
      // box is checked is stamped private at insert, instead of inheriting the
      // files-table default (which can be shared-to-everyone on a cloud). Read
      // the checkbox defensively — it may not be rendered. On a local workspace
      // the box is checked+disabled, so this is '1' there too; forced visibility
      // is a harmless no-op on the single-user SQLite path.
      var pv = document.getElementById('chat-private');
      var priv = pv && pv.checked ? '1' : '0';
      return fetch('/api/ingest/upload', {
        method: 'POST',
        // Percent-encode the filename: HTTP header values must be ISO-8859-1,
        // so a Unicode filename (emoji, smart quote, accent, em-dash) would
        // otherwise make fetch() throw "String contains non ISO-8859-1 code
        // point". The server decodeURIComponent()s it back.
        headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name || 'file'), 'x-lattice-private': priv },
        body: file,
      })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
        .catch(function (e) { showToast('Ingest failed: ' + e.message, {}); })
        .finally(function () { done(); });
    }
    function uploadFiles(files) {
      if (!files || !files.length) return;
      gaTrack('file_ingest', { count: files.length }); // count only — never file names
      // Single-file drop: open the resulting record once it lands (the dedup
      // survivor if it was a duplicate). Multi-file drops do not navigate.
      if (files.length === 1) {
        uploadFile(files[0]).then(function (j) {
          // A structured source the server flagged as confirmable comes back with
          // an autoImport proposal — render the inline confirm card instead of
          // navigating to the file record. A silent import (autoImport.imported,
          // no reason) or a plain file keeps the open-the-record behavior.
          if (j && j.autoImport && j.autoImport.reason) { renderInlineImportCard(j.autoImport); return; }
          if (j && (j.duplicateOf || j.id)) openSearchHit('files', j.duplicateOf || j.id);
        });
        return;
      }
      // Multi-file: drain through the bounded-concurrency queue (so a big drop
      // can't saturate the connection budget) with a batch progress bar.
      var bar = ingestProgress(files.length);
      var thunks = [];
      for (var i = 0; i < files.length; i++) {
        (function (f) {
          thunks.push(function () {
            return uploadFile(f).then(function (j) {
              // A structured source within a batch still gets its own inline
              // confirm card (the batch as a whole does not navigate).
              if (j && j.autoImport && j.autoImport.reason) renderInlineImportCard(j.autoImport);
            });
          });
        })(files[i]);
      }
      runIngestBatch(thunks, INGEST_MAX_CONCURRENCY, bar.update).then(bar.done);
    }
    // Mobile: tapping the handle expands/collapses the bottom drawer.
    function initRailDrawer() {
      var handle = document.getElementById('rail-handle');
      var rail = document.getElementById('assistant-rail');
      if (handle && rail) handle.addEventListener('click', function () { rail.classList.toggle('expanded'); });
    }
    function initRailDragDrop() {
      var rail = document.getElementById('assistant-rail'); if (!rail) return;
      // Only react to FILE drags (not text/selection drags).
      function isFileDrag(e) {
        var t = e.dataTransfer && e.dataTransfer.types;
        return !!t && Array.prototype.indexOf.call(t, 'Files') !== -1;
      }
      // enter/leave counter: leaving via a child element fires dragleave then a
      // dragenter, so the depth stays > 0 until the cursor actually exits the rail.
      var depth = 0;
      function clearOverlay() { depth = 0; rail.classList.remove('dragging-file'); }
      rail.addEventListener('dragenter', function (e) {
        if (!isFileDrag(e)) return;
        e.preventDefault(); depth++; rail.classList.add('dragging-file');
      });
      rail.addEventListener('dragover', function (e) {
        if (!isFileDrag(e)) return;
        e.preventDefault(); rail.classList.add('dragging-file');
      });
      rail.addEventListener('dragleave', function () {
        depth = Math.max(0, depth - 1);
        if (depth === 0) rail.classList.remove('dragging-file');
      });
      rail.addEventListener('drop', function (e) {
        e.preventDefault();
        clearOverlay();
        if (e.dataTransfer && e.dataTransfer.files) uploadFiles(e.dataTransfer.files);
      });
      // Backstops: a drag cancelled outside the window, or a drop anywhere, must
      // clear the overlay — the per-element dragleave can miss those exits.
      window.addEventListener('dragend', clearOverlay);
      window.addEventListener('drop', clearOverlay);
    }

    // Surface a notice when files/secrets aren't bound as native objects — the
    // assistant key storage + ingest need them. Normally they auto-create on
    // open; this only shows in the edge case where a pre-existing plaintext
    // secrets table was skipped (the adopt flow won't silently encrypt it).
    function checkNativeSetup() {
      fetchJson('/api/native-entities').then(function (d) {
        var bound = {};
        ((d && d.bindings) || []).forEach(function (b) { if (b.origin !== 'skipped') bound[b.entity] = true; });
        var missing = ['files', 'secrets'].filter(function (e) { return !bound[e]; });
        if (missing.length === 0) return;
        var feedEl = railFeedEl(); if (!feedEl) return;
        railEmptyGone();
        var card = document.createElement('div');
        card.className = 'feed-item';
        var note = 'Set up native ' + missing.join(' + ') + ' to enable the assistant’s key storage and file ingest.';
        if (missing.indexOf('secrets') >= 0) {
          note += ' A pre-existing plaintext “secrets” table is left untouched — move its rows to an encrypted native secrets store to use it here.';
        }
        card.innerHTML = '<div class="feed-icon">⚠️</div><div class="feed-body"><div class="feed-summary">' +
          escapeHtml(note) + '</div></div>';
        feedEl.insertBefore(card, feedEl.firstChild);
      }).catch(function () { /* ignore */ });
    }

    function renderComposer() {
      var host = document.getElementById('rail-composer'); if (!host) return;
      fetchJson('/api/assistant/config').then(function (cfg) {
        if (cfg && cfg.hasClaudeAuth) {
          var micHtml = cfg.hasVoiceKey
            ? '<button class="composer-mic" id="chat-mic" title="Record voice">🎙</button>'
            : '';
          host.innerHTML =
            '<div class="composer-row">' +
              '<button class="composer-clip" id="chat-clip" title="Upload files" aria-label="Upload files">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
                  '<polyline points="17 8 12 3 7 8"/>' +
                  '<line x1="12" y1="3" x2="12" y2="15"/>' +
                '</svg>' +
              '</button>' +
              micHtml +
              '<textarea id="chat-input" rows="1" placeholder="Ask or instruct… (Enter to send)"></textarea>' +
              '<button class="composer-send" id="chat-send">Send</button>' +
            '</div>' +
            // Private mode — when checked, items the assistant adds on this send
            // stay private to me (passed as privateMode in the /api/chat body).
            // Local workspaces are inherently single-user/private, so on local we
            // force the box checked + disabled as a read-only indicator (cloudMode
            // is set from the workspace kind before the composer renders).
            '<label class="composer-private' + (cloudMode ? '' : ' is-disabled') + '">' +
              '<input type="checkbox" id="chat-private"' + (cloudMode ? '' : ' checked disabled') + ' /> Private mode ' +
              '<span class="composer-private-hint">' +
                (cloudMode ? 'New items I add stay private to you' : 'Local workspaces are always private') +
              '</span>' +
            '</label>' +
            '<input type="file" id="chat-file" multiple style="display:none">';
          var input = document.getElementById('chat-input');
          var sendBtn = document.getElementById('chat-send');
          var clipBtn = document.getElementById('chat-clip');
          var fileInput = document.getElementById('chat-file');
          if (clipBtn && fileInput) {
            clipBtn.addEventListener('click', function () { fileInput.click(); });
            fileInput.addEventListener('change', function () { uploadFiles(fileInput.files); fileInput.value = ''; });
          }
          // Grow the textarea to fit its content (wrapped lines included), capped
          // so it never swallows the feed. Recompute on input AND whenever the
          // textarea's width changes (rail resize / mobile drawer) — re-wrapping
          // at a new width changes how many lines the same text needs.
          function autoGrowInput() {
            input.style.height = 'auto';
            input.style.height = Math.min(COMPOSER_MAX_H, input.scrollHeight) + 'px';
          }
          input._autoGrow = autoGrowInput;
          input.addEventListener('input', autoGrowInput);
          if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(function () { autoGrowInput(); }).observe(input);
          }
          autoGrowInput(); // fit the initial height
          input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(input.value.trim()); }
          });
          sendBtn.addEventListener('click', function () { sendChat(input.value.trim()); });
          var micBtn = document.getElementById('chat-mic');
          if (micBtn) {
            micBtn.addEventListener('click', function () {
              // Faded/unavailable mic → clicking is a no-op (no error dialog).
              if (micBtn.classList.contains('composer-mic-unavailable')) return;
              toggleRecording(micBtn, input);
            });
            refreshMicAvailability(micBtn);
          }
        } else {
          host.innerHTML = '<div class="composer-setup">Set a Claude API token in ' +
            '<a href="#/settings/user-config">User Settings → Assistant</a> to chat.</div>';
        }
      }).catch(function () {
        host.innerHTML = '<div class="composer-setup">Assistant unavailable.</div>';
      });
    }

    /** Reload column meta after a secret-flag change. */
    function refreshColumnMeta() {
      return fetchJson('/api/gui-meta/columns').then(function (d) {
        state.columnMeta = d || {};
      });
    }


    init();
  })();
  `;
